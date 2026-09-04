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
const apiSrc = fs.readFileSync(path.join(ROOT, 'api', 'deconstruct.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// Serverless modules can't be require()d and unit-tested (they run the handler
// shape on load), so we slice the pure functions out of the real source and
// eval them. That tests the shipped code, not a copy of it.
function slice(src, startMark, endMark, exports) {
    const a = src.indexOf(startMark), b = src.indexOf(endMark);
    assert.ok(a >= 0, 'missing start marker: ' + startMark);
    assert.ok(b > a, 'missing end marker: ' + endMark);
    return new Function('cheerio', src.slice(a, b) + '\nreturn {' + exports + '};')(cheerio);
}

const API = slice(apiSrc, 'const INTERNAL_TOKEN', 'async function buildAnalysisPrompt',
    'collectTokens,mineDesignTokens,mineComponentStyles,evalCalc,resolveVars,parseCssRules,collectUsedClasses,tokenCategory');

const FE = slice(appSrc, 'function escapeHtml', '// ============================================================\n    // COPY TO CLIPBOARD',
    'renderMarkdown,escapeHtml,inlineMd');

// ---- SSRF / safety: these must never regress ------------------------------
const SEC = slice(apiSrc, 'function isPrivateHost', '// sanitizeUrl only checks',
    'isPrivateHost,sanitizeUrl');

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n         ' + e.message.split('\n')[0]); }
}
function section(s) { console.log('\n' + s); }

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
    const sys = apiSrc.slice(apiSrc.indexOf('const SYSTEM_PROMPT'), apiSrc.indexOf('const USER_PROMPT'));
    assert.ok(!/write 'not detectable'/.test(sys), 'system prompt still requests the placeholder');
    assert.ok(/DO NOT write "not detectable"/.test(sys), 'system prompt lacks the prohibition');
});
t('USER_PROMPT omits empty sections instead of printing Not detected', () => {
    const up = apiSrc.slice(apiSrc.indexOf('const USER_PROMPT'), apiSrc.indexOf('// ============================================================\n// MAIN HANDLER'));
    assert.ok(!/\|\| 'Not detected'/.test(up), 'still emits literal "Not detected"');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
