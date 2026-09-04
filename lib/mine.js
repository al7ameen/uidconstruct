// lib/mine.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.


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


module.exports = { COLOR_VALUE, COMPONENT_OUT_CAP, CSS_RULE_CAP, INTERNAL_TOKEN, MAX_SELECTOR_LEN, RULE_PROPS, TOKEN_CEIL, TOKEN_FLOOR, TOKEN_PRIORITY, TOKEN_TOTAL, VALUE_RE, allocateTokenQuota, collectTokens, evalCalc, mineBreakpoints, mineComponentStyles, mineDesignTokens, mineFonts, parseCssRules, priorityRank, resolveVars, selectorClasses, stripCssComments, tokenCategory, tokenRank };
