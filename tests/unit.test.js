#!/usr/bin/env node
/**
 * Offline regression tests for the parts of api/deconstruct.js that decide
 * spec quality, plus the frontend markdown renderer.
 *
 * Why this exists: three bugs in a row were introduced *while patching* this
 * file (a duplicate const, an exponential string growth in resolveVars, and a
 * SYSTEM_PROMPT that contradicted USER_PROMPT). None were caught by reading
 * the diff. These tests are the cheap net.
 *
 * Run: node tests/unit.test.js      (no network, no deps beyond cheerio)
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const cheerio = require('cheerio');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// Backend: the analysis engine now lives in lib/ as real CommonJS modules, so
// we require() it directly. (Before the split, api/deconstruct.js was one
// 1086-line file with no exports, which forced this suite to locate functions
// by string marker and eval() them — 17 brittle slices, and the reason three
// bugs shipped through that file unnoticed.)
const NET = require(path.join(ROOT, 'lib', 'net.js'));
const MINE = require(path.join(ROOT, 'lib', 'mine.js'));
const EXTRACT = require(path.join(ROOT, 'lib', 'extract.js'));
const PROMPTS = require(path.join(ROOT, 'lib', 'prompts.js'));
const AI = require(path.join(ROOT, 'lib', 'ai.js'));
const CACHE = require(path.join(ROOT, 'lib', 'cache.js'));

// Frontend is a browser IIFE with no module system, so it still has to be
// sliced. Kept deliberately narrow: escapeHtml/renderMarkdown/inlineMd and the
// URL helpers are pure and take/return strings.
function slice(src, startMark, endMark, exports) {
    const a = src.indexOf(startMark), b = src.indexOf(endMark);
    assert.ok(a >= 0, 'missing start marker: ' + startMark);
    assert.ok(b > a, 'missing end marker: ' + endMark);
    return new Function(src.slice(a, b) + '\nreturn {' + exports + '};')();
}
const FE = slice(appSrc, 'function escapeHtml', '// ============================================================\n    // COPY TO CLIPBOARD',
    'renderMarkdown,escapeHtml,inlineMd');
const SEC = NET;
const API = MINE;

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n         ' + e.message.split('\n')[0]); }
}
function section(s) { console.log('\n' + s); }

section('module structure (post-refactor contract)');
// api/deconstruct.js was 1086 lines with a single export (maxDuration), which
// made the analysis engine untestable. It is now lib/*.js. These assertions
// keep the split honest: if someone inlines a module back into the handler, or
// drops an export, this fails loudly instead of silently reducing coverage.
const LIB = ['net', 'rate', 'extract', 'css', 'mine', 'prompts', 'ai', 'pipeline'];
t('every lib module loads and exports something', () => {
    LIB.forEach(m => {
        const mod = require(path.join(ROOT, 'lib', m + '.js'));
        assert.ok(Object.keys(mod).length > 0, m + '.js exports nothing');
    });
});
t('the endpoint still exports maxDuration (Vercel kills the fn without it)', () => {
    const handler = require(path.join(ROOT, 'api', 'deconstruct.js'));
    assert.strictEqual(handler.maxDuration, 60);
    assert.strictEqual(typeof handler, 'function');
});
t('the handler is thin again (regression guard against re-inlining)', () => {
    const h = fs.readFileSync(path.join(ROOT, 'api', 'deconstruct.js'), 'utf8');
    assert.ok(h.split('\n').length < 400,
        'api/deconstruct.js is ' + h.split('\n').length + ' lines; analysis code belongs in lib/');
});
t('SSRF surface is reachable from exactly one module', () => {
    assert.strictEqual(typeof NET.sanitizeUrl, 'function');
    assert.strictEqual(typeof NET.safeFetch, 'function');
    assert.strictEqual(typeof NET.BlockedUrlError, 'function');
});

section('SSRF guard');
t('blocks loopback + private + metadata', () => {
    ['http://127.0.0.1/', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data/',
     'http://10.1.2.3/', 'http://192.168.0.1/', 'http://172.16.0.1/', 'http://[::1]/',
     'http://metadata.google.internal/'].forEach(u =>
        assert.strictEqual(SEC.sanitizeUrl(u), null, 'should block ' + u));
});
t('allows public http(s) and normalises without dropping the path', () => {
    assert.strictEqual(SEC.sanitizeUrl('https://example.com'), 'https://example.com/');
    assert.strictEqual(SEC.sanitizeUrl('http://tailwindcss.com/x'), 'http://tailwindcss.com/x');
    assert.strictEqual(SEC.sanitizeUrl('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
});
t('blocks embedded credentials', () =>
    assert.strictEqual(SEC.sanitizeUrl('https://u:p@example.com'), null));
t('blocks non-http protocols', () => {
    ['file:///etc/passwd', 'gopher://127.0.0.1/', 'javascript:alert(1)'].forEach(u =>
        assert.strictEqual(SEC.sanitizeUrl(u), null, 'should block ' + u));
});

section('calc evaluation');
const calc = [
    ['calc(0.25rem*3)', '0.75rem'],
    ['calc(0.25rem * 3)', '0.75rem'],
    ['calc(24px + 8px)', '32px'],
    ['calc(100px / 4)', '25px'],
    ['calc(100% - 2rem)', 'calc(100% - 2rem)'],
    ['calc(1rem + 8px)', 'calc(1rem + 8px)'],
    ['calc(1px * 2px)', 'calc(1px * 2px)'],
    ['calc(8px / 0)', 'calc(8px / 0)'],
    ['calc(env(safe) * 2)', 'calc(env(safe) * 2)'],
    ['calc(var(--x) * 4)', 'calc(var(--x) * 4)'],
];
calc.forEach(([inp, want]) =>
    t(inp + ' -> ' + want, () => assert.strictEqual(API.evalCalc(inp), want)));

section('var() resolution');
t('resolves a known token', () => {
    const tk = API.collectTokens(':root{--a:10px}');
    assert.strictEqual(API.resolveVars('var(--a)', tk, 0), '10px');
});
t('uses the fallback for an unknown token', () => {
    const tk = API.collectTokens(':root{--a:10px}');
    assert.strictEqual(API.resolveVars('var(--zzz, 5px)', tk, 0), '5px');
});
// Regression: this returned the whole accumulated string, so each recursion
// pass grew the value and the request hung past 45s.
t('unresolvable var returns the ORIGINAL MATCH, not the whole string', () => {
    const tk = API.collectTokens(':root{--a:10px}');
    const v = 'url(/x) var(--zzz) something-long-and-repeated-here';
    assert.strictEqual(API.resolveVars(v, tk, 0), v);
});
t('resolves var inside calc', () => {
    const tk = API.collectTokens(':root{--sp:.25rem}');
    assert.strictEqual(API.resolveVars('calc(var(--sp) * 4)', tk, 0), '1rem');
});

section('design-token mining');
const TAILWINDISH = `:root{
  --color-gray-950:#030712;--color-gray-900:#111827;--color-gray-800:#1f2937;--color-gray-300:#d1d5db;
  --color-sky-400:#00bcfe;--color-indigo-600:#4f39f6;--color-pink-400:#fb64b6;
  --text-xs:.75rem;--text-sm:.875rem;--text-base:1rem;--text-lg:1.125rem;--text-3xl:1.875rem;
  --radius-sm:.25rem;--radius-md:.375rem;--radius-lg:.5rem;
  --shadow-sm:0 1px 2px rgb(0 0 0/.05);--spacing:.25rem;--blur-sm:8px;
  --tw-translate-x:0;--el-color-primary:red;
}`;
const USED = new Set(['bg-gray-950', 'text-gray-300', 'text-sm', 'rounded-lg', 'shadow-sm', 'p-4', 'hover:bg-indigo-600', 'text-3xl', 'blur-sm']);
const mined = API.mineDesignTokens(TAILWINDISH, USED);
const flat = mined.join('\n');
t('every category gets representation (the old global slice gave colours all 40)', () => {
    ['[color]', '[type]', '[geometry]'].forEach(h => assert.ok(flat.includes(h), 'missing ' + h));
});
t('radius + shadow + spacing survive a colour-heavy site', () => {
    assert.ok(/--radius-lg/.test(flat), 'radius dropped');
    assert.ok(/--shadow-sm/.test(flat), 'shadow dropped');
    assert.ok(/--spacing/.test(flat), 'spacing dropped');
});
t('framework plumbing tokens are excluded', () => {
    assert.ok(!/--tw-/.test(flat), '--tw-* leaked');
    assert.ok(!/--el-/.test(flat), '--el-* leaked');
});
t('output stays within budget', () =>
    assert.ok(mined.filter(l => /--/.test(l)).length <= 44, 'too many tokens'));
t('--text-primary is classified as colour, --text-xl as type', () => {
    assert.strictEqual(API.tokenCategory('--text-primary', '#fff'), 'color');
    assert.strictEqual(API.tokenCategory('--text-xl', '1.25rem'), 'type');
});

section('component rule resolver');
const CSS2 = `
:root{--brand:#4f39f6;--r:.375rem;--sp:.25rem;--sh:0 1px 2px rgb(0 0 0/.05)}
.btn{background-color:var(--brand);border-radius:var(--r);padding:calc(var(--sp)*3);box-shadow:var(--sh)}
.card{background:#0a0a0a;padding:24px}
.widget-unused{background:#123456;padding:99px}
@media (min-width:768px){.btn{padding:32px}}
`;
const rules = API.mineComponentStyles(CSS2, new Set(['btn', 'card']), API.collectTokens(CSS2));
const rj = rules.join('\n');
t('resolves var() and calc() to concrete values', () => {
    assert.ok(/background-color:#4f39f6/.test(rj), 'brand not resolved');
    assert.ok(/border-radius:\.375rem/.test(rj), 'radius not resolved');
    assert.ok(/padding:0\.75rem/.test(rj), 'calc not evaluated');
    assert.ok(/box-shadow:0 1px 2px/.test(rj), 'shadow not resolved');
});
t('skips rules whose classes are not on the page', () =>
    assert.ok(!/widget-unused/.test(rj), 'unused class leaked'));
t('keeps @media overrides', () => assert.ok(/padding:32px/.test(rj), 'media rule lost'));
t('never emits empty-value junk lines', () =>
    assert.ok(!/:\s*;|:\s*\}/.test(rj), 'empty declaration present'));
t('numeric utility families are capped, not listed exhaustively', () => {
    const many = Array.from({ length: 30 }, (_, i) => `.size-${i}{width:${i}px;height:${i}px}`).join('\n');
    const out = API.mineComponentStyles(many, new Set(Array.from({ length: 30 }, (_, i) => 'size-' + i)), new Map());
    assert.ok(out.length <= 3, 'got ' + out.length + ' near-duplicates');
});

section('markdown renderer (frontend)');
const MD = `# UI Specification: example.com

## 1. Design Tokens

### Color Palette
| Token | Hex | Use |
|-------|-----|-----|
| bg | \`#030712\` | page background |

- first bullet
- second bullet

1. step one
2. step two

**bold** and \`code\`
`;
const html = FE.renderMarkdown(MD);
t('headings become h tags', () => {
    assert.ok(/<h1>UI Specification/.test(html));
    assert.ok(/<h2>1\. Design Tokens<\/h2>/.test(html));
    assert.ok(/<h3>Color Palette<\/h3>/.test(html));
});
t('no raw markdown markers left in output', () => {
    assert.ok(!/^#{1,6}\s/m.test(html), 'literal heading markers remain');
    assert.ok(!/<h\d>/.test(html.replace(/<h\d>[^<]*<\/h\d>/g, '')), 'stray heading text');
});
t('GFM table renders with thead/tbody', () => {
    assert.ok(/<table><thead><tr><th>Token<\/th>/.test(html), 'no thead');
    // Cells run through the inline pass, so a backticked value becomes <code>.
    assert.ok(/<td><code>#030712<\/code><\/td>/.test(html), 'no cell content');
    assert.ok(!/^\|/m.test(html), 'pipe rows leaked into output');
});
t('lists render', () => {
    assert.ok(/<ul><li>first bullet<\/li>/.test(html), 'ul missing');
    assert.ok(/<ol><li>step one<\/li>/.test(html), 'ol missing');
});
t('inline code and bold render', () => {
    assert.ok(/<code>#030712<\/code>/.test(html), 'code missing');
    assert.ok(/<strong>bold<\/strong>/.test(html), 'strong missing');
});
// The model's output is untrusted text rendered into the page.
t('escapes script tags (no HTML injection from model output)', () => {
    const evil = FE.renderMarkdown('# t\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>');
    // No input tag may survive as an ELEMENT. The escaped text form is the
    // correct, safe outcome, so assert on live markup rather than substrings.
    assert.ok(!/<script[\s>]/i.test(evil), 'raw <script> survived');
    assert.ok(!/<img[\s>]/i.test(evil), 'raw <img> survived');
    assert.ok(!/<[a-z]+[^>]*\sonerror\s*=/i.test(evil), 'live onerror attribute survived');
    assert.ok(/&lt;script&gt;/.test(evil), 'script was not escaped');
    // Only our own tags may appear as markup.
    const tags = (evil.match(/<\/?[a-zA-Z][^>]*>/g) || []).map(x => x.toLowerCase());
    tags.forEach(x => assert.ok(
        ['<h1>', '</h1>', '<p>', '</p>'].includes(x),
        'unexpected live tag: ' + x));
});
t('escapes attribute-breaking quotes in text', () =>
    assert.ok(/&quot;|&#39;/.test(FE.escapeHtml('a"b\'c')), 'quotes not escaped'));
t('empty input yields empty output', () => assert.strictEqual(FE.renderMarkdown(''), ''));

section('CSS custom properties resolve');
// I have now twice written var(--font-body), which does not exist in this
// stylesheet (the token is --font-sans). Both times it failed silently: the
// declaration is dropped and the element inherits the browser default font.
// Nothing in a build step or a visual diff catches it on a phone. So: every
// var(--x) reference must have a matching definition.
const cssText = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const defined = new Set((cssText.match(/--[a-zA-Z][\w-]*(?=\s*:)/g) || []));
const referenced = new Set((cssText.match(/var\((--[a-zA-Z][\w-]*)/g) || []).map(x => x.slice(4)));
t('every var(--x) used in style.css is defined somewhere', () => {
    const missing = [...referenced].filter(v => !defined.has(v));
    assert.strictEqual(missing.length, 0, 'undefined custom properties: ' + missing.join(', '));
});
t('the sanity check itself works (font-body is NOT a token, font-sans is)', () => {
    assert.ok(defined.has('--font-sans'), '--font-sans should be defined');
    assert.ok(!defined.has('--font-body'), '--font-body must not be reintroduced');
});

section('prompt <-> extractor agreement (cross-file invariant)');
// The system prompt tells the model to emit a BUILD PROMPT block; the frontend
// regex looks for it. These live in different files, so they drift: the format
// template once said "start with # UI Specification" while the instruction
// below it said "write BUILD PROMPT first", and the model would have obeyed the
// template, leaving the extractor finding nothing and the card permanently
// hidden. Assert the two ends of the contract still line up.
const BP = slice(appSrc, 'function extractBuildPrompt', 'function renderMarkdown(src) {', 'extractBuildPrompt');
const promptsSrc = fs.readFileSync(path.join(ROOT, 'lib', 'prompts.js'), 'utf8');
const sysPrompt = promptsSrc.slice(promptsSrc.indexOf('const SYSTEM_PROMPT'), promptsSrc.indexOf('const USER_PROMPT'));
t('the FORMAT TEMPLATE (not just the prose) puts BUILD PROMPT first', () => {
    const after = sysPrompt.slice(sysPrompt.indexOf('FORMAT YOUR RESPONSE EXACTLY LIKE THIS:'));
    const firstLine = after.split('\n').map(l => l.trim()).filter(Boolean)[1]; // [0] is the marker itself
    assert.strictEqual(firstLine, 'BUILD PROMPT',
        'template must open with BUILD PROMPT, got: ' + JSON.stringify(firstLine));
});
t('a spec shaped exactly like the template is parsed by the frontend', () => {
    const shaped = 'BUILD PROMPT\nBuild a dark-only Tailwind docs site: gray-950 bg, sky-400 accents, Inter + IBM Plex Mono, 4px spacing scale.\n\n# UI Specification: tailwindcss.com\n\n## 1. Design Tokens\n| a | b |';
    const got = BP.extractBuildPrompt(shaped);
    assert.ok(/gray-950/.test(got) && /sky-400/.test(got), 'build prompt not extracted: ' + JSON.stringify(got));
    assert.ok(!got.includes('UI Specification'), 'extraction ran past the spec heading');
});
t('extractor returns empty (not garbage) when the model omits the block', () =>
    assert.strictEqual(BP.extractBuildPrompt('# UI Specification: x\n## 1. Design Tokens'), ''));

section('bare-host input (the "linear.app" affordance)');
const BE = NET;
const FEURL = slice(appSrc, 'const URL_PATTERN', 'function extractDomain', 'normalizeURL,validateURL');
t('frontend adds https to a bare host', () => {
    assert.strictEqual(FEURL.normalizeURL('linear.app'), 'https://linear.app');
    assert.strictEqual(FEURL.normalizeURL('  vercel.com/docs  '), 'https://vercel.com/docs');
    assert.strictEqual(FEURL.normalizeURL('www.foo.com'), 'https://www.foo.com');
});
t('frontend leaves a full URL alone', () =>
    assert.strictEqual(FEURL.normalizeURL('https://ok.com/x'), 'https://ok.com/x'));
t('frontend still rejects junk (does not prepend https to nonsense)', () => {
    ['', 'not a url', 'hello world'].forEach(v =>
        assert.ok(!FEURL.validateURL(FEURL.normalizeURL(v)), 'accepted: ' + JSON.stringify(v)));
});
t('backend accepts a bare host too, so curl matches the UI', () =>
    assert.strictEqual(BE.sanitizeUrl('linear.app'), 'https://linear.app/'));
// The affordance must not become a bypass: normalising happens BEFORE the
// private-host check, so internal targets still resolve to null.
t('normalisation cannot be used to reach internal hosts', () => {
    ['127.0.0.1', 'localhost', '169.254.169.254', '10.0.0.5', 'metadata.google.internal',
     'file:///etc/passwd', '0.0.0.0'].forEach(u =>
        assert.strictEqual(BE.sanitizeUrl(u), null, 'reached: ' + u));
});

section('dark-mode accent: text uses must not pick up the brand --accent');
// Live bug found on production: --accent is #f5f5f5 in dark mode, and was used
// as a text color on links, badges, bullets, footer, and error messages, so
// every one of those became near-white on near-white and disappeared. Fix:
// route text-color uses of --accent through --link-text / --badge-text /
// --bullet-text, leave --accent for backgrounds, borders, and fills.
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
// --accent is #f5f5f5 in dark mode. Anywhere the CSS *color* property (not
// border-color / background-color / accent-color, which are fine) resolves to
// --accent, that text is invisible in dark mode. So the rule is global: no
// `color: var(--accent)` anywhere. The leading boundary excludes the
// hyphenated properties, which would otherwise match as substrings.
const textAccent = css.match(/(?:^|[{;\s])color\s*:\s*var\(--accent\)/gim) || [];
t('no `color: var(--accent)` anywhere (near-white in dark mode)', () =>
    assert.strictEqual(textAccent.length, 0,
        textAccent.length + ' text-color use(s) of --accent remain'));
// The dedicated text tokens must exist in BOTH themes, or the fix is a
// light-mode-only illusion.
t('link/badge/bullet/code text tokens defined in light and dark', () => {
    ['--link-text', '--badge-text', '--bullet-text', '--code-text'].forEach(tok => {
        const light = css.slice(css.indexOf(':root'), css.indexOf('[data-theme="dark"]'));
        const dark = css.slice(css.indexOf('[data-theme="dark"]'));
        assert.ok(light.includes(tok + ':'), tok + ' missing from light theme');
        assert.ok(dark.includes(tok + ':'), tok + ' missing from dark theme');
    });
});
// Non-text roles must keep using the brand swatch, or we have "fixed" the
// bug by deleting the brand.
const brandRoles = (css.match(/\b(?:background|background-color|border-color|outline|fill|accent-color)[^;]*var\(--accent\)/gi) || []).length;
t('--accent still drives backgrounds, borders and fills', () =>
    assert.ok(brandRoles >= 8, 'expected >=8 non-text uses of --accent, got ' + brandRoles));

section('prompt consistency');
t('SYSTEM_PROMPT no longer asks for "not detectable"', () => {
    const sys = promptsSrc.slice(promptsSrc.indexOf('const SYSTEM_PROMPT'), promptsSrc.indexOf('const USER_PROMPT'));
    assert.ok(!/write 'not detectable'/.test(sys), 'system prompt still requests the placeholder');
    assert.ok(/DO NOT write "not detectable"/.test(sys), 'system prompt lacks the prohibition');
});
t('USER_PROMPT omits empty sections instead of printing Not detected', () => {
    const up = promptsSrc.slice(promptsSrc.indexOf('const USER_PROMPT'));
    assert.ok(!/\|\| 'Not detected'/.test(up), 'still emits literal "Not detected"');
});

section("index.html integrity");
// cheerio is a parser, not a validator: it silently repairs unbalanced markup,
// so it once reported a broken page as "well-formed". This is a real stack-based
// balance check that will actually fail on a stray </div>.
const htmlSrc = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const VOID_TAGS = new Set(["br","hr","img","input","meta","link","source","path","rect","circle","line","polyline","polygon","use","area","base","col","embed","track","wbr"]);
function unbalanced(src) {
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
    const stack = []; let m; const errs = [];
    while ((m = re.exec(src))) {
        const closing = m[1] === "/", name = m[2].toLowerCase(), selfClose = m[3] === "/";
        if (VOID_TAGS.has(name) || selfClose) continue;
        if (!closing) stack.push(name);
        else { const top = stack.pop();
            if (!top) errs.push("extra </" + name + ">");
            else if (top !== name) errs.push("<" + top + "> closed by </" + name + ">"); }
    }
    stack.forEach(t => errs.push("never closed <" + t + ">"));
    return errs;
}
t("index.html tags balance (no stray/missing close)", () => {
    const errs = unbalanced(htmlSrc);
    assert.deepStrictEqual(errs, [], errs.slice(0, 4).join(" | "));
});
t("resting panel shows a real spec, not a hand-written mock", () => {
    assert.ok(!/Replicate the UI of linear\.app with/.test(htmlSrc), "fake hand-written sample is still on the page");
    assert.ok(/id="resultLabel">Real output/.test(htmlSrc), "idle label does not say it is real output");
    assert.ok(/class="prompt-box is-rendered" id="promptContent"/.test(htmlSrc), "sample is not marked is-rendered, so it renders as raw text");
});
t("no cherry-picked signal count claim", () => {
    assert.ok(!/~120<\/span> design signals/.test(htmlSrc), "still claims ~120 design signals (that was the best case only)");
    assert.ok(/design values per site/.test(htmlSrc), "missing the honest range label");
});
t("hideResult restores the honest idle label", () => {
    const hide = appSrc.slice(appSrc.indexOf("function hideResult"), appSrc.indexOf("function hideResult") + 400);
    assert.ok(!/= .Sample output./.test(hide), "hideResult overwrites the label with Sample output, undoing the honest caption");
    assert.ok(/IDLE_LABEL/.test(hide), "hideResult does not restore IDLE_LABEL");
    assert.ok(/const IDLE_LABEL/.test(appSrc), "IDLE_LABEL is not defined");
});


// ---- page outline: the fix for "the model never saw the page" ----------------
const { extractPageOutline } = require(path.join(ROOT, 'lib/extract.js'));

t('outline carries the visible content a head-slice never could', () => {
    // Deliberately head-heavy: 3000 chars of meta/preload before <body>, so a
    // naive substring(0,2500) would return nothing but head markup.
    const filler = '<meta name="x" content="' + 'a'.repeat(60) + '">' +
                   '<link rel="preload" href="/_next/static/media/f' + 'b'.repeat(60) + '.png" as="image">';
    const html = '<html><head><title>Acme — Ship faster</title>' + filler.repeat(20) +
        '</head><body><header><nav><a href="/pricing">Pricing</a><a href="/docs">Docs</a></nav></header>' +
        '<h1>Ship faster with Acme</h1><h2>Trusted by teams</h2><h3>Realtime sync</h3>' +
        '<button>Start free trial</button>' +
        '<main><p>Acme turns your spreadsheet into an API in under five minutes, no code.</p></main>' +
        '<footer><a href="/about">About</a><a href="/careers">Careers</a></footer></body></html>';
    const out = extractPageOutline(cheerio.load(html));

    assert.ok(/Ship faster with Acme/.test(out), 'missing H1 — the exact bug: model never saw page text');
    assert.ok(/Pricing/.test(out) && /Docs/.test(out), 'missing nav labels');
    assert.ok(/Start free trial/.test(out), 'missing button text');
    assert.ok(/spreadsheet into an API/.test(out), 'missing body copy');
    assert.ok(/About/.test(out) && /Careers/.test(out), 'missing footer links');
    assert.ok(/Title \/ description/.test(out), 'missing title line');
});

t('outline stays inside its token budget', () => {
    // A page with absurd repetition must not blow the prompt budget.
    let body = '';
    for (let i = 0; i < 400; i++) body += '<h2>Heading number ' + i + ' with a long tail of words to inflate it</h2>';
    const html = '<html><head><title>T</title></head><body>' + body + '</body></html>';
    const out = extractPageOutline(cheerio.load(html));
    assert.ok(out.length <= 2800, 'outline grew to ' + out.length + ' chars, budget is ~2600');
});

t('outline degrades quietly on a contentless page', () => {
    const out = extractPageOutline(cheerio.load('<html><head></head><body></body></html>'));
    assert.strictEqual(typeof out, 'string');
    assert.ok(out.length < 40, 'invented content for an empty page: ' + JSON.stringify(out.slice(0, 80)));
});

t('pipeline slices from <body>, not from char 0', () => {
    // Regression guard for the root cause: substring(0,2500) on a real page is
    // pure <head> markup, which is why specs described a theme instead of a page.
    const src = fs.readFileSync(path.join(ROOT, 'lib/pipeline.js'), 'utf8');
    assert.ok(/search\(\/<body/i.test(src), 'no body-first slice — reverted to head-prefix bug');
    assert.ok(!/stripStyles\(html\)\.substring\(0,\s*2500\)/.test(src), 'still slicing the document from char 0');
});

t('outline is actually sent to the model', () => {
    const { USER_PROMPT } = require(path.join(ROOT, 'lib/prompts.js'));
    const data = { url: 'https://x.com', domain: 'x.com', rawHtml: '<body></body>', cssStyles: '',
        extracted: { fonts: [], fontSizes: [], colors: [], layoutPatterns: [], componentPatterns: [],
                     responsiveBreakpoints: [], designTokens: ['--a: #fff'], cssFonts: [], cssBreakpoints: [],
                     componentRules: [], pageOutline: 'Headings in DOM order: H1 The real headline' } };
    const up = USER_PROMPT(data);
    assert.ok(/The real headline/.test(up), 'pageOutline not included in the user prompt');
    assert.ok(/what this site IS/i.test(up), 'outline is sent but not labelled as the identity source');
});

(async () => {

// ============================================================
// Custom BYOK endpoint. lib/ai.js and lib/cache.js previously had ZERO
// coverage, which is how a model-ID regex excluding '/' shipped: it silently
// rejected every OpenRouter/Together model, and a null normalisation falls back
// to the free tier, so the user saw a working result from the wrong engine.
// ============================================================
async function ta(name, fn) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n         ' + String(e && e.message || e).split('\n')[0]); }
}

section('custom BYOK endpoint - URL resolution');
t('base URL gets /chat/completions appended', () => {
    const r = AI.resolveCustomTarget('https://openrouter.ai/api/v1');
    assert.strictEqual(r.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(r.style, 'openai');
});
t('a full endpoint is NOT double-appended (most likely user error)', () => {
    const r = AI.resolveCustomTarget('https://api.groq.com/openai/v1/chat/completions');
    assert.strictEqual(r.endpoint, 'https://api.groq.com/openai/v1/chat/completions');
});
t('anthropic-shaped host uses /v1/messages', () => {
    const r = AI.resolveCustomTarget('https://api.anthropic.com/v1');
    assert.strictEqual(r.style, 'anthropic');
    assert.ok(/\/v1\/messages$/.test(r.endpoint), r.endpoint);
});
t('http is refused: the request carries a secret key', () => {
    assert.strictEqual(AI.resolveCustomTarget('http://openrouter.ai/api/v1'), null);
});
t('loopback / link-local metadata refused', () => {
    assert.strictEqual(AI.resolveCustomTarget('https://127.0.0.1:8080/v1'), null);
    assert.strictEqual(AI.resolveCustomTarget('https://169.254.169.254/latest/meta-data'), null);
});
t('embedded credentials refused', () => {
    assert.strictEqual(AI.resolveCustomTarget('https://user:pass@evil.example/v1'), null);
});

section('custom BYOK endpoint - normalisation');
const CKEY = 'sk-or-v1-' + 'a'.repeat(40);
t('REGRESSION: model IDs containing / are accepted (OpenRouter/Together)', () => {
    for (const m of ['openai/gpt-4o-mini', 'meta-llama/llama-3.3-70b-instruct', 'deepseek-ai/DeepSeek-V3']) {
        const r = AI.normalizeByok({ provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', model: m, key: CKEY });
        assert.ok(r, 'rejected ' + m);
        assert.strictEqual(r.model, m);
    }
});
t('custom without a base URL is rejected, not silently downgraded', () => {
    assert.strictEqual(AI.normalizeByok({ provider: 'custom', model: 'x/y', key: CKEY }), null);
});
t('model charset blocks URL/transport metacharacters', () => {
    // The model goes only into the JSON body, never into a URL, so '.' and '/'
    // are allowed by design (they are required for org/name model IDs).
    // What must stay blocked are characters that could break out of the string
    // context or smuggle a second request.
    for (const m of ['a/b?x=1', 'a#frag', 'a b', 'a\rb', 'a\nb', 'a[', 'a%00', 'a@b', 'a&b', '']) {
        assert.strictEqual(AI.normalizeByok({ provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', model: m, key: CKEY }), null, 'allowed ' + JSON.stringify(m));
    }
});
t('model longer than 80 chars is rejected (body-size guard)', () => {
    assert.strictEqual(AI.normalizeByok({ provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', model: 'a'.repeat(81), key: CKEY }), null);
});
t('unknown provider still rejected (allowlist intact)', () => {
    assert.strictEqual(AI.normalizeByok({ provider: 'evil', baseUrl: 'https://openrouter.ai/api/v1', model: 'a', key: CKEY }), null);
});

section('custom BYOK endpoint - cache isolation');
t('different custom hosts with the same model do NOT collide', () => {
    const mk = (host) => AI.normalizeByok({ provider: 'custom', baseUrl: 'https://' + host + '/v1', model: 'llama-3', key: CKEY });
    const a = CACHE.cacheKey('https://x.com', mk('openrouter.ai'));
    const b = CACHE.cacheKey('https://x.com', mk('groq.com'));
    assert.notStrictEqual(a, b, 'cache collision: ' + a);
});
t('the cache key never contains the API key', () => {
    const k = CACHE.cacheKey('https://x.com', AI.normalizeByok({ provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b', key: CKEY }));
    assert.ok(!k.includes(CKEY), 'key leaked into cache key');
    assert.ok(!k.includes('sk-or'), 'key fragment in cache key');
});

section('custom BYOK endpoint - request policy (fetch capture)');
async function capture(byok) {
    const real = globalThis.fetch;
    let cap = null;
    globalThis.fetch = async (u, o) => {
        cap = { u: String(u), o };
        return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
    };
    try { await AI.callAI([{ role: 'user', content: 'hi' }], byok, { timeoutMs: 2000 }); }
    catch (_) { /* response shape is irrelevant: we assert on the REQUEST */ }
    finally { globalThis.fetch = real; }
    assert.ok(cap, 'fetch was never called');
    return cap;
}
await ta('custom endpoints are fetched with redirect:manual', async () => {
    const cap = await capture(AI.normalizeByok({ provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b', key: CKEY }));
    assert.strictEqual(cap.o.redirect, 'manual', 'redirect=' + cap.o.redirect);
});
await ta('built-in providers keep redirect:follow (no regression)', async () => {
    const cap = await capture(AI.normalizeByok({ provider: 'openai', model: 'gpt-4o-mini', key: CKEY }));
    assert.strictEqual(cap.o.redirect, 'follow');
});
await ta('the key travels in a header, never in the URL', async () => {
    const cap = await capture(AI.normalizeByok({ provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b', key: CKEY }));
    assert.ok(!cap.u.includes(CKEY), 'key in URL: ' + cap.u);
    assert.strictEqual(cap.o.headers.Authorization, 'Bearer ' + CKEY);
});
await ta('a 307 from a custom endpoint is refused, not followed', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { status: 307, ok: false, headers: { get: () => null }, text: async () => '' }; };
    let err = null;
    try { await AI.callAI([{ role: 'user', content: 'hi' }], AI.normalizeByok({ provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b', key: CKEY }), { timeoutMs: 2000 }); }
    catch (e) { err = e; }
    finally { globalThis.fetch = real; }
    assert.strictEqual(calls, 1, 'followed the redirect (' + calls + ' calls)');
    assert.ok(err && /redirect/i.test(err.message), 'wrong error: ' + (err && err.message));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
