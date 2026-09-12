// lib/css.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly.
//
// CONTRACT CHANGE (2026-09-05): fetchCssFiles() now returns { css, status } instead
// of a bare string. It used to return '' on failure and say nothing, which meant a
// stylesheet timeout was indistinguishable from a site that genuinely has no CSS.
// Both produced a confident, well-formatted spec full of zeros. Callers must be
// able to tell "we failed" from "there was nothing there" — see uidconstruct's
// silent-degradation bug class.

const cheerio = require('cheerio');
const { BROWSER_UA, safeFetch, sanitizeUrl } = require('./net.js');

// The site declares stylesheets and we retrieved none of them. This is OUR
// failure (timeout, CDN throttling, TLS), not a property of the target site,
// and it must never be reported to a user as a finished spec.
class CssUnavailableError extends Error {
    constructor(status) {
        super('Could not read this site\'s stylesheets (all '
            + (status && status.linked) + ' timed out or failed). '
            + 'The design tokens are the point of the result, so we would rather '
            + 'say nothing than guess. Try again in a moment.');
        this.name = 'CssUnavailableError';
        this.status = status;
    }
}

// Both of these were measured, not guessed, on 2026-09-12. The old values
// (4 links / 400KB) were chosen as generic safety numbers and silently became
// the dominant accuracy limit:
//   linear.app   declares 55 stylesheets. Files 1-4 = 4KB and ZERO colours.
//                Files 5-55 = 318KB and 161 colours. We were reading the 4KB.
//   stripe.com   first 4 files = 395KB of 473KB, so the byte cap truncated it.
// 24 links is the measured sweet spot: beyond it the TOKEN_TOTAL quota is
// already saturated, so extra files buy latency and nothing else.
// Env-overridable so a benchmark can vary them WITHOUT editing source -- a
// hardcoded limit cannot be A/B tested, and an env a test claims to vary but
// reads from a literal is how a suite passes for the wrong reason.
const CSS_LINK_LIMIT = Number(process.env.CSS_LINK_LIMIT) || 24;

// Ceiling so a huge site can't blow memory. It is also the CPU budget: the
// miner is regex over the whole text, so 5x the bytes is 5x the scan.
const CSS_MAX_BYTES = Number(process.env.CSS_MAX_BYTES) || 2000000;

const CSS_FETCH_MS = 10000;     // generous; a failed CSS fetch is non-fatal

// The per-file ceiling above is the WORST case, and it is only safe while there
// is time left to use the result. Files fetch concurrently via allSettled, so 24
// stylesheets cost about the same wall clock as 4 -- but a page fetch that ate
// 40s of a 50s budget must not then spend 10 more on CSS the model will never
// see, plus seconds of regex mining on top of that.
const CSS_RESERVE_MS = 15000;   // mining + the shortest AI call worth making
const CSS_FETCH_MIN_MS = 2000;  // below this, don't pretend to try

// Pure and exported so it can be tested without a network: a deadline in the
// past must shrink the budget, an absent deadline must change nothing.
function cssFetchBudget(deadlineAt, now) {
    if (!deadlineAt) return CSS_FETCH_MS;
    const left = deadlineAt - (now || Date.now()) - CSS_RESERVE_MS;
    return Math.min(CSS_FETCH_MS, Math.max(CSS_FETCH_MIN_MS, left));
}


// The blind spot this fixes: a site can ship its ENTIRE design system in inline
// <style> tags and link zero stylesheets. Reading only link[rel=stylesheet]
// made that look like "no design tokens exist", and because the early return for
// a site with no links reported degraded:false, the failure was SILENT — we
// served a confident spec containing zero hex values. Measured on framer.com:
// 0 linked stylesheets, 7 <style> tags, 492KB of CSS, 1,263 custom properties.
function extractInlineCss($) {
    let out = '';
    $('style').each((_, el) => {
        // Empty/whitespace-only and non-CSS types carry no design values.
        const type = (el.attribs && el.attribs.type) || '';
        if (type && !/text\/css|stylesheet/i.test(type)) return;
        const t = ($(el).text() || '').trim();
        if (t) out += '\n' + t;
    });
    return out;
}

function extractCssHrefs($, baseUrl) {
    const hrefs = [];
    const seen = new Set();
    $('link[rel="stylesheet"]').each((_, el) => {
        const raw = $(el).attr('href');
        if (!raw) return;
        let abs;
        try { abs = new URL(raw, baseUrl).href; } catch { return; }
        const safe = sanitizeUrl(abs);              // SSRF guard applies to CSS too
        if (!safe || seen.has(safe)) return;
        seen.add(safe);
        hrefs.push(safe);
    });
    return hrefs.slice(0, CSS_LINK_LIMIT);
}

// A timeout is a different fact from an HTTP 403, and the user-facing message has
// to be different too: "try again" is right for one and pointless for the other.
const looksLikeTimeout = (err) => {
    const name = err && err.name ? err.name : '';
    const msg = String((err && err.message) || '');
    return name === 'TimeoutError' || /timeout|timed out|abort/i.test(msg);
};

// Fetch every linked stylesheet and report what actually happened.
//
// `status` is the point of this function as much as `css` is:
//   linked    how many stylesheets the page declares
//   ok        how many we got usable bytes from
//   timedOut  how many blew the per-file deadline
//   failed    how many errored for another reason (HTTP status, DNS, TLS, body stall)
//   bytes     total characters of CSS returned
//   truncated whether CSS_MAX_BYTES cut the concatenation short
//
// `degraded` is the one the caller should branch on: the site HAS stylesheets and
// we got NONE of them. That is our failure, not the site's, and it must not be
// presented as a result.
async function fetchCssFiles($, baseUrl, opts) {
    const hrefs = extractCssHrefs($, baseUrl);
    const inlineCss = extractInlineCss($);
    const status = { linked: hrefs.length, inline: inlineCss.length, ok: 0, timedOut: 0, failed: 0, bytes: 0, truncated: false, fetchMs: CSS_FETCH_MS };
    // No linked files is NOT the same as no CSS. If the page carries inline
    // styles we return them; only a page with neither is genuinely blank, and
    // that stays degraded:false so example.com keeps working as before.
    if (!hrefs.length) {
        // The cap applies here too. Measured: a 5.5MB inline blob returned
        // whole through this path, and the miner is regex over the entire text,
        // so "no linked files" was an unbounded CPU path on a user-supplied URL.
        let only = inlineCss;
        if (only.length > CSS_MAX_BYTES) {
            only = only.slice(0, CSS_MAX_BYTES);
            status.truncated = true;
        }
        status.bytes = only.length;
        return { css: only, status, degraded: false };
    }

    const perFileMs = cssFetchBudget(opts && opts.deadlineAt);
    status.fetchMs = perFileMs;   // observable seam: proves the budget is WIRED, not just computed
    const results = await Promise.allSettled(hrefs.map(h =>
        safeFetch(h, {
            headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/css,*/*;q=0.1' },
            signal: AbortSignal.timeout(perFileMs)
        }, 2).then(async (r) => {
            // Non-2xx used to resolve to '' and count as success-with-nothing.
            // Rejecting keeps it out of `ok` and lands it in `failed`.
            if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
            // The body read is its own await; a mid-body stall must be classified
            // here rather than escaping as an unhandled rejection.
            return await r.text();
        })
    ));

    let out = '';
    for (const r of results) {
        // Tally EVERY settled result before deciding to stop appending. The
        // original `break` exited the loop mid-tally, so ok+timedOut+failed
        // silently disagreed with `linked` on any site whose first stylesheet
        // crossed CSS_MAX_BYTES — and a wrong denominator is how a health
        // signal starts lying about degraded-ness.
        if (r.status === 'fulfilled' && r.value) status.ok++;
        else if (looksLikeTimeout(r.reason)) status.timedOut++;
        else status.failed++;

        if (r.status === 'fulfilled' && r.value && !status.truncated) {
            out += '\n' + r.value;
            if (out.length > CSS_MAX_BYTES) status.truncated = true;
        }
    }

    // Appended, never prepended: linked stylesheets keep the precedence that
    // fixed linear.app and stripe.com. Strictly additive, so those sites cannot
    // regress because of this.
    if (inlineCss) {
        if (out.length + inlineCss.length > CSS_MAX_BYTES) status.truncated = true;
        else out += '\n' + inlineCss;
    }

    status.bytes = out.length;
    // Partial read beats a thrown error: we DID read the site's CSS, just not
    // all of it. Only claim total failure when neither source produced anything.
    // `degraded` is what triggers the loud throw, so it must mean "we learned
    // nothing", NOT "we fetched nothing". A failed link fetch on a site whose
    // inline CSS is only `body{color:red}` must STILL throw — otherwise this
    // fix re-creates the silent-zero bug it was written to close. Presence of
    // mineable custom properties is the test, not presence of bytes.
    const inlineYields = /--[A-Za-z][\w-]*\s*:/.test(inlineCss);
    status.inlineYields = inlineYields;
    return { css: out, status, degraded: status.ok === 0 && !inlineYields };
}

// Mine named design tokens from the FULL stylesheet.
// Order matters: real design tokens first, and Tailwind's internal --tw-*
// plumbing (translate/scale/content/gradient) is deliberately excluded —
// those are implementation details, not design values.

module.exports = { CssUnavailableError, CSS_FETCH_MS, CSS_FETCH_MIN_MS, CSS_LINK_LIMIT, CSS_MAX_BYTES, CSS_RESERVE_MS, cssFetchBudget, extractCssHrefs, fetchCssFiles, looksLikeTimeout };
