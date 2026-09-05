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

const CSS_LINK_LIMIT = 4;

const CSS_MAX_BYTES = 400000;   // ceiling so a huge file can't blow memory

const CSS_FETCH_MS = 10000;     // generous; a failed CSS fetch is non-fatal


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
async function fetchCssFiles($, baseUrl) {
    const hrefs = extractCssHrefs($, baseUrl);
    const status = { linked: hrefs.length, ok: 0, timedOut: 0, failed: 0, bytes: 0, truncated: false };
    if (!hrefs.length) return { css: '', status, degraded: false };

    const results = await Promise.allSettled(hrefs.map(h =>
        safeFetch(h, {
            headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/css,*/*;q=0.1' },
            signal: AbortSignal.timeout(CSS_FETCH_MS)
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

    status.bytes = out.length;
    return { css: out, status, degraded: status.ok === 0 };
}

// Mine named design tokens from the FULL stylesheet.
// Order matters: real design tokens first, and Tailwind's internal --tw-*
// plumbing (translate/scale/content/gradient) is deliberately excluded —
// those are implementation details, not design values.

module.exports = { CssUnavailableError, CSS_FETCH_MS, CSS_LINK_LIMIT, CSS_MAX_BYTES, extractCssHrefs, fetchCssFiles, looksLikeTimeout };
