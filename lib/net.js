// lib/net.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.


// ============================================================
// UTILITIES
// ============================================================
function extractDomain(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}


function isPrivateHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    // Hostnames
    if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h.endsWith('.local') || h === 'metadata.google.internal') return true;
    // IPv6 literals (::1, fc00::/7 unique-local, fe80::/10 link-local)
    if (h.includes(':')) {
        return h === '::' || h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab]/.test(h);
    }
    // IPv4 literals
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const o = m.slice(1).map(Number);
        if (o.some(x => x > 255)) return true; // malformed
        const [a, b] = o;
        if (a === 0 || a === 10 || a === 127 || a >= 224) return true;       // this-network, private, loopback, multicast/reserved
        if (a === 169 && b === 254) return true;                             // link-local (cloud metadata)
        if (a === 172 && b >= 16 && b <= 31) return true;                    // private
        if (a === 192 && b === 168) return true;                             // private
        if (a === 100 && b >= 64 && b <= 127) return true;                   // CGNAT
    }
    return false;
}

// Same affordance as the frontend: a bare host is what people type. Adding the
// scheme here means curl/scripts behave like the UI. It does NOT weaken the
// SSRF guard — the result still goes through the full URL parse + isPrivateHost
// check below, so "127.0.0.1" becomes https://127.0.0.1 and is then blocked.

// Same affordance as the frontend: a bare host is what people type. Adding the
// scheme here means curl/scripts behave like the UI. It does NOT weaken the
// SSRF guard — the result still goes through the full URL parse + isPrivateHost
// check below, so "127.0.0.1" becomes https://127.0.0.1 and is then blocked.
function ensureScheme(url) {
    const u = String(url || '').trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[^\s/]+\.[^\s/.]+(:\d+)?([/?#]\S*)?$/.test(u)) return 'https://' + u;
    return u;
}


function sanitizeUrl(url) {
    try {
        const parsed = new URL(ensureScheme(url));
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        if (parsed.username || parsed.password) return null;                 // no embedded credentials
        if (isPrivateHost(parsed.hostname)) return null;                     // SSRF guard
        return parsed.href;
    } catch {
        return null;
    }
}


// sanitizeUrl only checks the URL WE were given. A public URL can 302 to an
// internal one, so every hop must be re-validated. redirect:'manual' + our
// own loop is the only way to do that with fetch().

// sanitizeUrl only checks the URL WE were given. A public URL can 302 to an
// internal one, so every hop must be re-validated. redirect:'manual' + our
// own loop is the only way to do that with fetch().
class BlockedUrlError extends Error {}

// Signals a caller-correctable problem (bad key / quota), so the handler can
// answer 4xx instead of 500 and the user doesn't think we are down.

async function safeFetch(url, options = {}, maxHops = 3) {
    let current = sanitizeUrl(url);
    if (!current) throw new BlockedUrlError('Blocked URL');
    for (let i = 0; i <= maxHops; i++) {
        const r = await fetch(current, { ...options, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(r.status)) {
            const loc = r.headers.get('location');
            if (!loc) return r;
            let next;
            try { next = new URL(loc, current).href; } catch { return r; }
            current = sanitizeUrl(next);
            if (!current) throw new BlockedUrlError('Redirect to private address blocked');
            continue;
        }
        return r;
    }
    throw new Error('Too many redirects');
}

// ============================================================
// RATE LIMIT — per-IP, in-memory (resets on cold start; burst guard)
// ============================================================

// ============================================================
// REAL CSS EXTRACTION
// cheerio has no computed-style engine (it is a parser, not a browser),
// so $(el).css() only ever sees inline style="" attributes. Modern sites
// put every value in EXTERNAL stylesheets (Tailwind v4: @theme tokens),
// which we never fetched — hence "not detectable". Fix: fetch + mine them.
// ============================================================
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

module.exports = { BROWSER_UA, BlockedUrlError, ensureScheme, extractDomain, isPrivateHost, safeFetch, sanitizeUrl };
