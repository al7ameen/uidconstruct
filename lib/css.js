// lib/css.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.

const cheerio = require('cheerio');
const { BROWSER_UA, safeFetch, sanitizeUrl } = require('./net.js');

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


async function fetchCssFiles($, baseUrl) {
    const hrefs = extractCssHrefs($, baseUrl);
    if (!hrefs.length) return '';
    const results = await Promise.allSettled(hrefs.map(h =>
        safeFetch(h, {
            headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/css,*/*;q=0.1' },
            signal: AbortSignal.timeout(CSS_FETCH_MS)
        }, 2).then(r => (r && r.ok ? r.text() : ''))
    ));
    let out = '';
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
            out += '\n' + r.value;
            if (out.length > CSS_MAX_BYTES) break;
        }
    }
    return out;
}

// Mine named design tokens from the FULL stylesheet.
// Order matters: real design tokens first, and Tailwind's internal --tw-*
// plumbing (translate/scale/content/gradient) is deliberately excluded —
// those are implementation details, not design values.

module.exports = { CSS_FETCH_MS, CSS_LINK_LIMIT, CSS_MAX_BYTES, extractCssHrefs, fetchCssFiles };
