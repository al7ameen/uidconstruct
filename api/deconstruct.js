/**
 * uidconstruct — Vercel Serverless API
 * ----------------------------------------
 * Extracts visual specs from any website URL.
 *
 * Environment variables (set in Vercel dashboard):
 *   OPENAI_API_KEY   — your API key
 *   OPENAI_BASE_URL  — custom endpoint (e.g. https://api.b.ai/v1)
 *   OPENAI_MODEL     — model name (e.g. qwen3.8-flash)
 *
 * API:
 *   POST /api/deconstruct
 *   Body: { url: "https://example.com" }
 *   Returns: { url, domain, prompt }
 */

// native fetch (Node 18+)
const cheerio = require('cheerio');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
    API_KEY: process.env.OPENAI_API_KEY || '',
    BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    MODEL: process.env.OPENAI_MODEL || 'qwen3.8-flash',
    TIMEOUT_MS: 52000
};

// BYOK providers we will proxy to. Deliberately an allowlist: if we accepted
// an arbitrary base URL, any user could turn this function into an SSRF proxy
// (or point it at internal metadata endpoints) using our server as the client.
const BYOK_PROVIDERS = {
    openai: {
        endpoint: 'https://api.openai.com/v1/chat/completions',
        auth: (key) => ({ 'Authorization': `Bearer ${key}` })
    },
    anthropic: {
        endpoint: 'https://api.anthropic.com/v1/messages',
        auth: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' })
    }
};

function normalizeByok(raw) {
    if (!raw || typeof raw.key !== 'string') return null;
    const key = raw.key.trim();
    // OpenAI keys are ~20-120 chars; Anthropic similar. Cap to keep logs/bodies sane.
    if (key.length < 20 || key.length > 200) return null;
    const provider = BYOK_PROVIDERS[raw.provider] ? raw.provider : null;
    if (!provider) return null;
    // Model is REQUIRED. We deliberately do not guess a default: model IDs
    // change, entitlements differ per account, and a wrong default produces a
    // confusing provider error. Conservative charset = no URL/injection surface.
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!/^[\w.\-:]{1,80}$/.test(model)) return null;
    return { provider, model, key };
}

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
class BlockedUrlError extends Error {}

// Signals a caller-correctable problem (bad key / quota), so the handler can
// answer 4xx instead of 500 and the user doesn't think we are down.
class ByokAuthError extends Error {}

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
const RATE_LIMIT = 10;          // requests
const RATE_WINDOW_MS = 3600e3;  // per hour
const hits = new Map();         // ip -> [timestamps]

function rateLimit(ip, limit) {
    const cap = limit || RATE_LIMIT;
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (arr.length >= cap) { hits.set(ip, arr); return false; }
    arr.push(now);
    hits.set(ip, arr);
    return true;
}

function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
           req.headers['x-real-ip'] || 'unknown';
}

function stripStyles(html) {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractStyles($) {
    const styles = [];
    $('style').each((_, el) => {
        const content = $(el).html() || '';
        if (content.trim()) styles.push(content.trim());
    });
    return styles.join('\n\n');
}

function extractInlineStyles($) {
    const styles = [];
    $('[style]').each((_, el) => {
        const style = $(el).attr('style');
        if (style) {
            const tag = $(el).get(0).tagName.toLowerCase();
            styles.push(`${tag} { ${style} }`);
        }
    });
    return styles.join('\n');
}

function extractTypography($) {
    const fonts = new Set();
    const sizes = new Set();

    $('link[rel="stylesheet"], link[rel="preconnect"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.includes('fonts.googleapis') || href.includes('fonts.gstatic')) {
            const match = href.match(/family=([^&:]+)/);
            if (match) fonts.add(decodeURIComponent(match[1].replace(/\+/g, ' ')));
        }
    });

    $('*').each((_, el) => {
        const fontFamily = $(el).css('font-family') || '';
        if (fontFamily && fontFamily !== 'inherit') fonts.add(fontFamily);
        const fontSize = $(el).css('font-size') || '';
        if (fontSize && fontSize !== 'inherit') sizes.add(fontSize);
        const lineHeight = $(el).css('line-height') || '';
        if (lineHeight && lineHeight !== 'inherit') sizes.add(`lh:${lineHeight}`);
        const fontWeight = $(el).css('font-weight') || '';
        if (fontWeight && fontWeight !== 'inherit') sizes.add(`fw:${fontWeight}`);
    });

    return {
        fonts: Array.from(fonts).slice(0, 10),
        sizes: Array.from(sizes).slice(0, 20)
    };
}

function extractColors($) {
    const colors = new Set();
    const bgs = new Set();

    $('*').each((_, el) => {
        const color = $(el).css('color') || '';
        const bg = $(el).css('background-color') || '';
        const border = $(el).css('border-color') || '';

        [color, bg, border].forEach(val => {
            if (val && val !== 'transparent' && val !== 'rgba(0, 0, 0, 0)' && val !== 'inherit' && val !== 'initial') {
                if (/^rgb|^#[0-9a-f]/i.test(val)) colors.add(val);
            }
        });
    });

    return Array.from(colors).slice(0, 30);
}

function extractLayout($) {
    const layouts = [];

    $('[class*="container"], [class*="grid"], [class*="flex"], [class*="layout"], [class*="wrapper"], [class*="main"], [class*="section"]').each((_, el) => {
        const $el = $(el);
        const tag = $(el).get(0).tagName.toLowerCase();
        const className = $el.attr('class') || '';
        const id = $el.attr('id') || '';
        const display = $el.css('display') || '';
        const flexDir = $el.css('flex-direction') || '';
        const gridCols = $el.css('grid-template-columns') || '';
        const maxW = $el.css('max-width') || '';
        const padding = $el.css('padding') || '';
        const margin = $el.css('margin') || '';

        const isFlex = display.includes('flex');
        const isGrid = display.includes('grid') || (gridCols && gridCols !== 'none');
        if (!isFlex && !isGrid) return;
        const found = { display, flex: flexDir, grid: gridCols, max: maxW, pad: padding };
        const real = Object.entries(found).filter(([, v]) => v && v !== 'none' && v !== 'inherit');
        if (!real.length) return;
        layouts.push(`${tag}.${(className.split(' ')[0] || '')} { ${real.map(([k, v]) => k + ':' + String(v).replace(/\s+/g, ' ').slice(0, 40)).join('; ')} }`);
    });

    return layouts.slice(0, 15);
}

function extractComponents($) {
    const components = [];

    $('button, input, textarea, select, a[class*="btn"], [class*="button"], [class*="card"], [class*="modal"], [class*="dropdown"], [class*="input"]').each((_, el) => {
        const $el = $(el);
        const tag = $(el).get(0).tagName.toLowerCase();
        const className = $el.attr('class') || '';
        const borderRadius = $el.css('border-radius') || '';
        const padding = $el.css('padding') || '';
        const bg = $el.css('background-color') || '';
        const color = $el.css('color') || '';
        const border = $el.css('border') || '';
        const boxShadow = $el.css('box-shadow') || '';

        // Only worth a line if at least one value actually resolved. On a
        // class-based site every one of these is '' (cheerio cannot compute
        // styles), and emitting "button.x { radius:; pad:; }" teaches the model
        // that the site is undetectable when it simply uses stylesheets.
        const found = { radius: borderRadius, pad: padding, bg, color, border, shadow: boxShadow };
        const real = Object.entries(found).filter(([, v]) => v && v !== 'none' && v !== 'inherit');
        if (!real.length) return;
        components.push(`${tag}${className ? '.' + className.split(' ')[0] : ''} { ${real.map(([k, v]) => k + ':' + v).join('; ')} }`);
    });

    return components.slice(0, 20);
}

function extractResponsive($) {
    const breakpoints = [];

    $('style').each((_, el) => {
        const content = $(el).html() || '';
        const mediaMatches = content.match(/@media[^{]+/g) || [];
        breakpoints.push(...mediaMatches);
    });

    return [...new Set(breakpoints)].slice(0, 10);
}

// ============================================================
// REAL CSS EXTRACTION
// cheerio has no computed-style engine (it is a parser, not a browser),
// so $(el).css() only ever sees inline style="" attributes. Modern sites
// put every value in EXTERNAL stylesheets (Tailwind v4: @theme tokens),
// which we never fetched — hence "not detectable". Fix: fetch + mine them.
// ============================================================
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
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
const INTERNAL_TOKEN = /^--(tw|el|ant|chakra|mui|radix|sh-|dl-|vs-)/i;
const TOKEN_PRIORITY = [
    /^--(color|colour|bg|text|border|ring|fill|stroke|accent|primary|secondary|muted|surface|foreground|background)/i,
    /^--(font|text|leading|tracking|letter)/i,
    /^--(spacing|radius|rounded|shadow|blur|opacity|z|size|width|height|gap|inset|padding|margin)/i
];
const VALUE_RE = /(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(|\blch\(|\blab\(|\bcolor-mix\(|\b\d+(?:\.\d+)?(?:px|rem|em|%)\b|['"][^'"]{1,30}['"]|^\d+(?:\.\d+)?$)/i;


// Which utility classes does the page ACTUALLY use? This is what turns a
// 690KB Tailwind palette into the ~15 colours the site really displays.
function collectUsedClasses($) {
    const set = new Set();
    $('[class]').each((_, el) => {
        const c = (el.attribs && el.attribs.class) || '';
        c.split(/\s+/).forEach(x => { if (x) set.add(x); });
    });
    return set;
}

function tokenRank(name, usedClasses) {
    if (!usedClasses || !usedClasses.size) return priorityRank(name);
    // A token can be referenced by several class shapes:
    //   --color-gray-950 -> used by "bg-gray-950", "text-gray-950", "dark:hover:bg-gray-950"
    //   --text-xs        -> used by "text-xs"
    //   --shadow-sm      -> used by "shadow-sm"
    const keys = [name.replace(/^--/, '')];
    if (/^--color-/.test(name)) keys.push(name.replace(/^--color-/, ''));
    for (const cls of usedClasses) {
        const bare = cls.split(':').pop().replace(/^[!\-]/, '').split('/').shift();
        for (const k of keys) {
            if (bare === k || bare.endsWith('-' + k)) return -1;
        }
    }
    return priorityRank(name);
}

function priorityRank(name) {
    for (let i = 0; i < TOKEN_PRIORITY.length; i++) {
        if (TOKEN_PRIORITY[i].test(name)) return i;
    }
    return 9;
}

// A single global slice is the wrong shape for this problem: on a Tailwind
// site the colour tokens are numerous AND rank highest (they're referenced by
// real classes), so they consumed all 40 slots and the spec came back with no
// radius, shadow or spacing values at all. Fix: bucket by category, then give
// every non-empty category a guaranteed floor and share the rest proportionally.
const TOKEN_TOTAL = 44;
const TOKEN_FLOOR = 3;
const TOKEN_CEIL = { color: 24, type: 12, geometry: 12 };
const COLOR_VALUE = /(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\(|lch\(|lab\(|color-mix\(|\btransparent\b)/i;

function tokenCategory(name, val) {
    // Value beats name: --text-primary is a colour, --text-xl is a type size.
    if (COLOR_VALUE.test(val)) return 'color';
    if (/^--(font|leading|tracking|letter|text|heading|body|caption)/i.test(name)) return 'type';
    return 'geometry';
}

function allocateTokenQuota(buckets) {
    const active = Object.keys(buckets).filter(k => buckets[k].length);
    const quota = {};
    active.forEach(k => { quota[k] = Math.min(TOKEN_FLOOR, buckets[k].length); });

    let spare = TOKEN_TOTAL - active.reduce((n, k) => n + quota[k], 0);
    // Largest-first so a category that is genuinely rich (36 real colours)
    // still gets most of the page, but never all of it.
    const bySize = active.slice().sort((a, b) => buckets[b].length - buckets[a].length);
    while (spare > 0) {
        let grew = false;
        for (const k of bySize) {
            if (spare === 0) break;
            if (quota[k] >= TOKEN_CEIL[k] || quota[k] >= buckets[k].length) continue;
            quota[k]++; spare--; grew = true;
        }
        if (!grew) break;   // every bucket is saturated or capped
    }
    return quota;
}

// Token map is the shared substrate: the design-token section AND the
// component-rule resolver below both need it, so build it once.
function collectTokens(css) {
    const found = new Map();   // name -> first value
    const re = /(--[a-zA-Z][\w-]*)\s*:\s*([^;{}]{1,60})/g;
    let m;
    while ((m = re.exec(css))) {
        const name = m[1];
        if (found.has(name) || INTERNAL_TOKEN.test(name)) continue;
        const val = m[2].trim().replace(/\s+/g, ' ');
        if (!val || !VALUE_RE.test(val)) continue;
        found.set(name, val);
    }
    return found;
}

function mineDesignTokens(css, usedClasses, tokens) {
    const found = tokens || collectTokens(css);
    const buckets = {};
    Array.from(found.entries())
        .sort((a, b) => tokenRank(a[0], usedClasses) - tokenRank(b[0], usedClasses))
        .forEach(([name, val]) => {
            const cat = tokenCategory(name, val);
            (buckets[cat] = buckets[cat] || []).push([name, val]);
        });

    const quota = allocateTokenQuota(buckets);
    const out = [];
    Object.keys(quota).sort().forEach(cat => {
        if (!buckets[cat]) return;
        out.push('[' + cat + ']');
        buckets[cat].slice(0, quota[cat]).forEach(([k, v]) => out.push('  ' + k + ': ' + v));
    });
    return out;
}

function mineFonts(css) {
    const GENERIC = /^(system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica|arial|sans-serif|serif|monospace|ui-monospace|cursive|fantasy|emoji|math|fangsong|songti|pingfang)/i;
    const fonts = new Set();
    const re = /font-family\s*:\s*([^;{}!]{1,120})/g;
    let m;
    while ((m = re.exec(css))) {
        m[1].split(',').forEach(f => {
            f = f.trim().replace(/^['"]|['"]$/g, '');
            if (!f || f.length > 40 || /^var\(/i.test(f)) return;
            if (/^<.*>$/.test(f) || /^(liberation mono|courier new|menlo|monaco|dejavu|noto sans mono|andale mono)/i.test(f)) return;
            if (GENERIC.test(f)) return;
            fonts.add(f);
        });
    }
    return Array.from(fonts).slice(0, 10);
}

function mineBreakpoints(css) {
    const bps = new Set();
    const re = /@media[^{]*?\(\s*(?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|rem)/g;
    let m;
    while ((m = re.exec(css))) bps.add(m[1] + m[2]);
    return Array.from(bps).slice(0, 12);
}

// ============================================================
// COMPONENT RULE RESOLVER
// The old extractComponents/extractLayout/extractColors all called
// $(el).css(), which on a class-based site returns '' for every property
// (cheerio parses, it does not compute). Result: 17 lines of
// "button.x { radius:; pad:; bg:; }" and a spec that says "not detectable".
// We can do better without a browser: parse the stylesheet into rules, keep
// the ones whose class is actually present in the HTML, and resolve
// var(--token) through the token map. That is a mini-cascade, and it recovers
// the real per-component values Tailwind hides behind utility classes.
// ============================================================
// Prefix match, so margin-top / padding-left / border-bottom-color count too.
const RULE_PROPS = /^(background|color|border|padding|margin|gap|row-gap|column-gap|box-shadow|font|line-height|letter-spacing|width|height|min-|max-|display|flex|grid|justify-|align-|place-|position|top|right|bottom|left|inset|z-index|opacity|backdrop-filter|filter|transition|transform|cursor|text-|overflow|outline|ring|shadow)/i;
// Scanning is cheap (regex over a string); only the OUTPUT needs a budget.
// Capping the scan was a real bug: on tailwindcss.com the first 900 rules are
// all .prose plugin noise, so every utility class sat beyond the cut.
const CSS_RULE_CAP = 20000;
const COMPONENT_OUT_CAP = 3000;
const MAX_SELECTOR_LEN = 44;     // .prose :where(:not(.not-prose *)) is noise, .btn is signal

function stripCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function parseCssRules(css) {
    const clean = stripCssComments(css);
    // [selector, declarations] for every top-level rule. Nested blocks
    // (@media bodies) are matched by this same regex one level in, which is
    // what we want: a rule inside @media(min-width:768px) still tells us the
    // value, and the selector text keeps the class we need to match on.
    const blocks = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean)) && blocks.length < CSS_RULE_CAP) {
        const sel = m[1].trim();
        const body = m[2].trim();
        if (!sel || !body || sel.startsWith('@') && !sel.includes(':')) continue;
        if (/^@/.test(sel)) continue;              // at-rule wrappers carry no decls
        blocks.push([sel, body]);
    }
    return blocks;
}

function resolveVars(value, tokens, depth) {
    depth = depth || 0;
    if (depth > 3) return value;
    let out = value;
    if (/var\(/.test(out)) {
        out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?))?\s*\)/g, (whole, name, fallback) => {
            const hit = tokens.get(name);
            const next = hit !== undefined ? hit : (fallback || '').trim();
            // Unresolvable: return the ORIGINAL MATCH, never the whole string.
            // Returning the full value here re-inserted the entire expression in
            // place of one var(), so each recursion pass grew the string and the
            // loop never converged (observed: request hang > 45s).
            return next || whole;
        });
    }
    // Tailwind spacing is calc(var(--spacing) * 3). Once the var is gone the
    // calc is pure arithmetic, and a spec that says "calc(0.25rem*3)" makes the
    // reader do our work — so evaluate the simple cases and pass the rest on.
    if (/calc\(/.test(out)) out = evalCalc(out);
    if (out !== value) return resolveVars(out, tokens, depth + 1);
    return out;
}

// Only handles + - * / between absolute lengths (px/rem/em) and plain numbers.
// Anything it can't prove safe (mixed units, env(), nested funcs) is returned
// untouched rather than guessed at — a wrong number is worse than none.
function evalCalc(expr) {
    return expr.replace(/calc\(([^()]*)\)/g, (whole, inner) => {
        // Normalise operators to spaced tokens: Tailwind emits calc(0.25rem*3)
        // with no whitespace, which a naive split would read as one term.
        const terms = inner
            .replace(/\s+/g, ' ')
            .replace(/([+\-*/])/g, ' $1 ')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        if (terms.length < 3 || terms.length % 2 === 0) return whole;
        const NUM = /^(-?\d*\.?\d+)(px|rem|em|%)$/i;
        const unitOf = (t) => { const m = t.match(NUM); return m ? m[2].toLowerCase() : null; };
        const valOf = (t) => { const m = t.match(NUM); if (m) return parseFloat(m[1]); return /^-?\d*\.?\d+$/.test(t) ? parseFloat(t) : null; };

        let acc = valOf(terms[0]);
        const accUnit = unitOf(terms[0]);
        if (acc === null || accUnit === '%') return whole;
        for (let i = 1; i < terms.length; i += 2) {
            const op = terms[i], rhs = terms[i + 1];
            const rv = valOf(rhs), ru = unitOf(rhs);
            if (rv === null) return whole;
            if (op === '*' || op === '/') {
                if (ru) return whole;                       // length * length is meaningless
                acc = op === '*' ? acc * rv : (rv === 0 ? NaN : acc / rv);
            } else if (op === '+' || op === '-') {
                if (ru && ru !== accUnit) return whole;     // cannot mix px and rem
                if (!ru && accUnit) return whole;           // bare number +/- length
                acc = op === '+' ? acc + rv : acc - rv;
            } else return whole;
        }
        if (!isFinite(acc)) return whole;
        const rounded = Math.round(acc * 1000) / 1000;
        return rounded + (accUnit || '');
    });
}

// Which classes does a selector need for us to care about it?
function selectorClasses(sel) {
    const out = [];
    const re = /\.(-?[_a-zA-Z][\w-]*)/g;
    let m;
    while ((m = re.exec(sel))) out.push(m[1]);
    return out;
}

function mineComponentStyles(css, usedClasses, tokens) {
    if (!css) return [];
    const blocks = parseCssRules(css);
    const candidates = [];
    for (const [sel, body] of blocks) {
        const classes = selectorClasses(sel);
        // Skip pure-element or unknown-class rules: on a Tailwind build the
        // classes in the selector are exactly the utilities the page uses.
        if (!classes.length) continue;
        if (sel.length > MAX_SELECTOR_LEN) continue;
        const used = classes.some(c => usedClasses.has(c));
        if (!used) continue;
        const decls = [];
        for (const part of body.split(';')) {
            const idx = part.indexOf(':');
            if (idx < 0) continue;
            const prop = part.slice(0, idx).trim();
            let val = part.slice(idx + 1).trim();
            if (!prop || !val || !RULE_PROPS.test(prop)) continue;
            if (/^var\(--[\w-]+\)$/.test(val) && !tokens.has(val.slice(4, -1))) continue;
            val = resolveVars(val, tokens);
            if (!val || val === 'initial' || val === 'inherit') continue;
            // --tw-* / --el-* etc. are internal plumbing we deliberately do not
            // mine, so an unresolved reference is pure noise to the model.
            if (/var\(--(tw|el|ant|radix|sh|chakra|mui)-/.test(val)) continue;
            decls.push(prop + ':' + val.replace(/\s+/g, ' ').slice(0, 60));
        }
        if (!decls.length) continue;
        candidates.push({
            sel, decls,
            // Prefer rules that carry many real values, then simple selectors.
            score: decls.length * 2 + (classes.length ? 1 : 0) - Math.floor(sel.length / 20)
        });
    }

    candidates.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const familyCount = new Map();
    const picked = [];
    let chars = 0;
    for (const c of candidates) {
        // Numeric utility families (.size-2/.size-3/.size-4, .mt-1/.mt-2) are
        // one pattern, not eight facts. Two examples teach the model more than
        // eight lines of near-duplicates that crowd out real components.
        const fam = c.sel.replace(/\d+/g, '#');
        const n = familyCount.get(fam) || 0;
        if (n >= 2) continue;
        familyCount.set(fam, n + 1);
        // The same utility appears in several @media blocks; one line is enough
        // unless it adds a declaration we have not already shown.
        const key = c.decls.map(d => d.split(':')[0]).sort().join(',');
        if (seen.has(key) && picked.length > 12) continue;
        seen.add(key);
        const line = c.sel.replace(/\s*,\s*/g, ', ') + ' { ' + c.decls.join('; ') + ' }';
        if (chars + line.length > COMPONENT_OUT_CAP) break;
        chars += line.length;
        picked.push(line);
    }
    return picked;
}

async function buildAnalysisPrompt(html, $, url, domain) {
    const styles = extractStyles($);
    const inlineStyles = extractInlineStyles($);
    const typography = extractTypography($);
    const colors = extractColors($);
    const layouts = extractLayout($);
    const components = extractComponents($);
    const responsive = extractResponsive($);
    const css = await fetchCssFiles($, url);
    const usedClasses = collectUsedClasses($);
    const tokens = collectTokens(css);
    const designTokens = mineDesignTokens(css, usedClasses, tokens);
    const cssFonts = mineFonts(css);
    const cssBreakpoints = mineBreakpoints(css);
    const cleanHtml = stripStyles(html).substring(0, 2500);
    // Real per-component values, recovered from the stylesheet instead of the
    // (always-empty) computed-style calls.
    const componentRules = mineComponentStyles(css, usedClasses, tokens);

    return {
        domain,
        url,
        extracted: {
            fonts: typography.fonts,
            fontSizes: typography.sizes,
            colors: colors.slice(0, 20),
            layoutPatterns: layouts,
            componentPatterns: components,
            responsiveBreakpoints: responsive,
            designTokens: designTokens,
            cssFonts: cssFonts,
            cssBreakpoints: cssBreakpoints,
            componentRules: componentRules
        },
        rawHtml: cleanHtml,
        cssStyles: styles.substring(0, 3500)
    };
}

const SYSTEM_PROMPT = `You are a senior UI/UX engineer and design system expert. Given raw HTML, CSS, and extracted design data from a website, produce a dense, pixel-accurate UI specification that any AI coding assistant (Cursor, v0, Bolt, Claude Code) can use to rebuild the UI 1:1.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

# UI Specification: [domain]

## 1. Design Tokens

### Color Palette
List EVERY color found with exact hex/rgb values and their use (background, surface, text, border, accent, etc.)

### Typography
For EACH font found: family name, fallbacks, and then create a type scale:
- xs: [size] / [line-height] / [weight] — used for: [where]
- sm: ...
- base: ...
- md: ...
- lg: ...
- xl: ...
- 2xl: ...
- 3xl: ...

### Spacing Scale
Use a 4px or 8px base. List all values in px:
- [name]: [value]px

### Border Radius
List every radius value found and what components use it.

### Shadows
List every box-shadow with exact values.

## 2. Layout System
Describe the overall page structure:
- Container: max-width, padding, centering
- Grid/flex system: columns, gap, gutter
- Section stacking: how content is organized vertically
- Breakpoints found: [list] and what changes at each

## 3. Global Structure
Describe the full page shell:
- Header: position (sticky/fixed/static), height, background, blur effect, what's inside
- Sidebar/Navigation: width, placement, what's inside, responsive behavior
- Main content area: width, padding, overflow behavior
- Footer: height, content, styling

## 4. Component Specifications

For EACH distinct component found (buttons, inputs, cards, modals, dropdowns, badges, avatars, etc.):

### [Component Name]
- Dimensions: height, width, min/max
- Padding: top/right/bottom/left
- Border: width, style, color
- Border radius: [value]
- Background: [value]
- Text: size, weight, color
- Shadow: [value] or none
- States:
  - Hover: [changes]
  - Active/focus: [changes]
  - Disabled: [changes]
- Spacing between multiple: [value]

## 5. Animation & Interaction
List every animation/transition found:
- [Element]: [property] [duration] [easing]
- Hover effects not captured above
- Loading states
- Page transitions

## 6. Accessibility Notes
- Focus ring styling
- Color contrast concerns
- Keyboard navigation patterns
- ARIA patterns used

## 7. Asset Inventory
- Icons: style (outline/filled), size, library if identifiable
- Images: aspect ratios, border radius, shadow
- Avatars: size, shape, fallback treatment
- Logo: placement, size

## 8. Dark Mode (if detected)
- Are there separate dark styles?
- What's different in dark mode?

## 9. Build Instructions for AI Editor
Give a numbered, actionable checklist:
1. [First thing to build]
2. [Second thing]
3. etc.

HARD LIMIT: 500 words. Be maximally dense — compact lines, tables over prose, no filler, no explanations. Include every distinct hex code, px value and font size found, but state each once. Priority order: design tokens > layout > components > interactions.
DO NOT write "not detectable", "not found", "unknown", or any other placeholder for data that is missing. If a section has no data, either omit it or fill it with what the evidence DOES support — a reader copying this into Cursor gets nothing from a placeholder, and a page full of them makes a readable site look unreadable. Never invent values. A developer copying this into Cursor or v0 must be able to rebuild the UI accurately.`;
// Two independent sources for the same fact: compiled stylesheets give us
// min/max-width values, inline <style> blocks give us raw @media text. Pull
// the numbers out of both and de-duplicate.
function mergeBreakpoints(fromCss, fromInline) {
    const out = new Set();
    (fromCss || []).forEach(b => out.add(String(b)));
    (fromInline || []).forEach(line => {
        const re = /(\d+(?:\.\d+)?)(px|rem)/g;
        let m;
        while ((m = re.exec(String(line)))) out.add(m[1] + m[2]);
    });
    return Array.from(out).slice(0, 14).join(', ');
}

const USER_PROMPT = (data) => {
    // Build the data block from ONLY the sections that have content. Five
    // literal "Not detected" lines used to sit in front of the model like
    // evidence that the site was unreadable, and it dutifully wrote
    // "not detectable" into the spec. Absence of a section is neutral;
    // an explicit "Not detected" is a conclusion.
    const e = data.extracted;
    const sections = [];
    const add = (title, body, note) => {
        const text = typeof body === 'string' ? body.trim() : (body || []).join('\n').trim();
        if (!text) return;
        sections.push(`### ${title}${note ? ' — ' + note : ''}:\n${text}`);
    };

    add('Fonts (from stylesheets)', e.cssFonts.join(', '));
    add('Font sizes / weights / line-heights', e.fontSizes.slice(0, 12).join(', '));
    add('Colors (inline styles)', e.colors.join(', '));
    add('Layout patterns (inline styles)', e.layoutPatterns);
    add('Component styles (inline styles)', e.componentPatterns);
    // Inline <style> @media queries are a separate source: sites that ship no
    // external stylesheet still expose them, so merge rather than choose.
    add('Breakpoints', mergeBreakpoints(e.cssBreakpoints, e.responsiveBreakpoints));
    add('Design Tokens — parsed from the site\'s real stylesheets (AUTHORITATIVE, use these exact values)', e.designTokens);
    add('Component rules — resolved from the site\'s CSS with var()/calc() evaluated (AUTHORITATIVE, use these exact values)', e.componentRules);
    add('CSS (inline <style>, excerpt)', data.cssStyles);

    return `Analyze this website and produce a detailed UI specification.

Website URL: ${data.url}
Domain: ${data.domain}

## Extracted Design Data
${sections.join('\n\n')}

## Raw HTML Structure (excerpt)
${data.rawHtml}

## How to read this data
Sections marked AUTHORITATIVE were parsed from the site's own compiled
stylesheets and are exact. Anything not listed was genuinely absent from the
page source — do NOT write "not detectable"; describe what IS present and
infer conventional values only where a component clearly needs one.
Produce the specification now. Hard cap: 500 words, maximally dense, tables
over prose, state each value once.`;
};

// ============================================================
// MAIN HANDLER
// ============================================================
async function callAI(messages, byok) {
    let url, headers, body;

    if (byok) {
        const p = BYOK_PROVIDERS[byok.provider];
        url = p.endpoint;
        headers = { 'Content-Type': 'application/json', ...p.auth(byok.key) };

        if (byok.provider === 'anthropic') {
            // Anthropic takes the system prompt as a sibling field, not a message
            const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
            body = {
                model: byok.model,
                system,
                messages: messages.filter(m => m.role !== 'system'),
                temperature: 0.3,
                max_tokens: 8000
            };
        } else {
            // No reasoning_effort here: it is rejected by non-reasoning models,
            // and the user chose this model, so we send only universal params.
            body = {
                model: byok.model,
                messages,
                temperature: 0.3,
                max_tokens: 4000
            };
        }
    } else {
        url = `${CONFIG.BASE_URL}/chat/completions`;
        headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.API_KEY}`
        };
        body = {
            model: CONFIG.MODEL,
            messages,
            temperature: 0.3,
            reasoning_effort: 'low',
            max_tokens: 8000
        };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONFIG.TIMEOUT_MS)
    });

    if (!res.ok) {
        // Truncate + never echo the request headers: the provider's error body
        // can contain fragments of the request, and we must not surface a key.
        const text = (await res.text()).slice(0, 300);
        if (res.status === 401 || res.status === 403) {
            throw new ByokAuthError('Your API key was rejected by the provider. Check the key and the model name, then try again.');
        }
        if (res.status === 429) {
            throw new Error('Your provider quota is rate-limited right now. Try again shortly.');
        }
        throw new Error(`AI provider error (${res.status}). ${byok ? 'Check your key, model name, and quota.' : 'Please try again.'} ${text.replace(/<[^>]*>/g, '')}`.slice(0, 400));
    }

    const data = await res.json();
    if (byok && byok.provider === 'anthropic') {
        return data.content?.map(c => c.text || '').join('') || 'No response from AI.';
    }
    return data.choices?.[0]?.message?.content || 'No response from AI.';
}

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    const { url, byok: byokRaw } = req.body || {};

    // Validate before anything else: an invalid key shape just falls back to
    // the free tier rather than erroring, so a half-filled form can't wedge us.
    const byok = normalizeByok(byokRaw);

    if (!url) {
        return res.status(400).json({ error: 'Missing "url" in request body.' });
    }

    const cleanUrl = sanitizeUrl(url);
    if (!cleanUrl) {
        return res.status(400).json({ error: 'That does not look like a website address. Try something like example.com' });
    }

    // Free tier is capped because it spends OUR credits. BYOK spends THEIRS,
    // so it gets a much higher ceiling — kept non-zero so one browser tab
    // can't use our function as an unlimited proxy to the providers.
    const ip = getClientIp(req);
    const limit = byok ? 60 : RATE_LIMIT;
    if (!rateLimit(ip, limit)) {
        return res.status(429).json({
            error: byok
                ? 'Too many requests this hour (60). Slow down and try again.'
                : 'Hourly limit reached (10 analyses). Try again later, or use your own AI key for unlimited runs.'
        });
    }

        const domain = extractDomain(cleanUrl);

    const timings = { start: Date.now(), fetchMs: 0, aiMs: 0, aiChars: 0 };
    try {

        // 1. Fetch the target page
        // Browser-like UA: many sites (and CDNs) block non-browser agents outright
        let pageRes;
        try {
            pageRes = await safeFetch(cleanUrl, {
                headers: {
                    'User-Agent': BROWSER_UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                signal: AbortSignal.timeout(10000)
            });
        } catch (fetchErr) {
            if (fetchErr instanceof BlockedUrlError) {
                return res.status(400).json({ error: 'That URL resolves to a private or internal address, which is not allowed.' });
            }
            const isTimeout = fetchErr.name === 'TimeoutError' || /abort|timeout/i.test(String(fetchErr.message));
            return res.status(504).json({
                error: isTimeout
                    ? 'That site took too long to respond. It may be down or blocking automated access. Try another URL.'
                    : 'Could not reach that site. Check the URL and try again.'
            });
        }

        if (!pageRes.ok) {
            const status = pageRes.status;
            const friendly = {
                401: 'That page requires a login, so it can\'t be analyzed. Try a public page.',
                403: 'That site blocks automated analysis. Try a different page on the same site.',
                404: 'Page not found — check the URL for typos.',
                429: 'That site is rate-limiting us right now. Try again in a few minutes.',
                999: 'That site blocks automated analysis (LinkedIn-style protection).'
            }[status] || `The site responded with an error (HTTP ${status}). Try another URL.`;
            return res.status(502).json({ error: friendly });
        }

        const html = await pageRes.text();
        timings.fetchMs = Date.now() - timings.start;
        const $ = cheerio.load(html);

        // 2. Build analysis data
        const analysis = await buildAnalysisPrompt(html, $, cleanUrl, domain);

        // 3. Call AI
        const prompt = USER_PROMPT(analysis);

        const tAI0 = Date.now();
        const aiResponse = await callAI([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
        ], byok);
        timings.aiMs = Date.now() - tAI0;
        timings.aiChars = aiResponse.length;
        console.log('perf:', JSON.stringify({ domain, byok: byok ? byok.provider : 'free', ...timings, totalMs: Date.now() - timings.start }));

        // 4. Return result
        return res.status(200).json({
            url: cleanUrl,
            domain,
            prompt: aiResponse,
            signals: analysis.extracted,
            timings: {
                fetchMs: timings.fetchMs,
                aiMs: timings.aiMs,
                totalMs: Date.now() - timings.start,
                outputChars: timings.aiChars
            }
        });

    } catch (err) {
        if (err instanceof ByokAuthError) {
            return res.status(401).json({ error: err.message });
        }
        console.error('Deconstruct error:', err.message, JSON.stringify(timings || {}));
        return res.status(500).json({ error: (err && err.name === 'TimeoutError') ? 'The website or AI took too long to respond (60s). Please try again or use a faster site.' : (err.message || 'Internal server error.') });
    }
};

// Allow up to 60s on Vercel (reasoning models are slow)
module.exports.maxDuration = 60;
