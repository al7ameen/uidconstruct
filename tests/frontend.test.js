/**
 * Frontend tests WITHOUT a browser.
 *
 * jsdom takes >30s to require inside this sandbox, which is slower than the
 * tool timeout, so it is unusable as a test dependency. app.js only touches a
 * small DOM surface (getElementById, classList, innerHTML/textContent, hidden),
 * so we shim that instead: ids are harvested from index.html, and the rendered
 * markdown is asserted as a STRING, which is stricter than querying a DOM.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
// specs.css was never loaded here until 05-Sep: two shipped layout bugs were
// invisible to every test in the repo because of it.
const SPECCSS = fs.readFileSync(path.join(ROOT, 'specs', 'specs.css'), 'utf8');

function makeEl(id) {
    const cls = new Set();
    return {
        id, tagName: 'DIV', hidden: false, value: '', textContent: '', innerHTML: '',
        disabled: false, checked: false, style: {}, scrollTop: 0, offsetTop: 0,
        classList: {
            add: (...c) => c.forEach(x => cls.add(x)),
            remove: (...c) => c.forEach(x => cls.delete(x)),
            toggle: (c, f) => (f ? cls.add(c) : cls.delete(c)),
            contains: c => cls.has(c)
        },
        setAttribute() {}, removeAttribute() {}, getAttribute: () => null, focus() {}, blur() {}, click() {},
        appendChild() {}, removeChild() {}, scrollIntoView() {},
        querySelectorAll: () => [], querySelector: () => null,
        addEventListener(type, fn) { (this._h ||= {})[type] = fn; },
        _fire(type, ev) { this._h && this._h[type] && this._h[type](ev || {}); }
    };
}

function boot(opts = {}) {
    const els = new Map();
    for (const m of HTML.matchAll(/id="([^"]+)"/g)) els.set(m[1], makeEl(m[1]));
    const errors = [];
    const store = {};
    const doc = {
        documentElement: makeEl('html'), body: makeEl('body'),
        getElementById: id => els.get(id) || null,
        querySelector: () => null, querySelectorAll: () => [],
        createElement: () => makeEl('tmp'), addEventListener() {},
        execCommand: () => true, createRange: () => ({ selectNodeContents() {} })
    };
    const sel = { removeAllRanges() {}, addRange() {} };
    const sandbox = {
        document: doc,
        localStorage: {
            getItem: k => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: k => { delete store[k]; }
        },
        navigator: { clipboard: { writeText: t => { sandbox.__copied = t; return Promise.resolve(); } }, userAgent: 'node' },
        matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
        requestAnimationFrame: fn => setTimeout(fn, 0),
        addEventListener(type, fn) { (sandbox.__winH ||= {})[type] = fn; },
        getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
        scroll: () => {}, alert: () => {},
        setTimeout, clearTimeout, setInterval, clearInterval,
        console: { log() {}, error: (...a) => errors.push(a.join(' ')), warn() {} },
        fetch: opts.fetch || (() => Promise.reject(new Error('fetch not configured'))),
        __copied: null, __errors: errors
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    sandbox.innerWidth = 1280; sandbox.pageYOffset = 0; sandbox.location = { href: 'https://uidconstruct.vercel.app/' };
    let thrown = null;
    try { vm.runInNewContext(APP, sandbox, { timeout: 5000, filename: 'app.js' }); }
    catch (e) { thrown = e; }
    return { els, sandbox, thrown, errors };
}

const SPEC = [
    '# UI Specification: x.com', '',
    '## 1. Design Tokens', '',
    '| Token | Hex | Use |', '|---|---|---|', '| bg | `#030712` | page |', '',
    'BUILD PROMPT', 'Rebuild x.com as a dark landing page.', '',
    '- <img src=x onerror=alert(1)>', '- <script>window.__pwn=1</script>',
    '- **bold** and `code`'
].join('\n');

function withSpec(spec, fetch) {
    const b = boot({ fetch: fetch || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ prompt: spec, domain: 'x.com', signals: {} }) })) });
    b.els.get('urlInput').value = 'https://x.com';
    b.els.get('deconstructBtn').click = function () { this._fire('click'); };
    b.els.get('deconstructBtn')._fire('click');
    return b;
}

const tests = [];
const NOTICE = 'Not affiliated with or endorsed by the sites analysed; all trademarks belong to their owners.';

const test = (name, fn) => tests.push([name, fn]);

test('app.js boots without throwing', () => {
    const { thrown } = boot();
    assert.strictEqual(thrown, null, 'threw: ' + (thrown && thrown.message));
});
test('no console.error during boot', () => {
    const { errors } = boot();
    assert.deepStrictEqual(errors, []);
});
test('build-prompt elements are declared, not implicit globals', () => {
    for (const id of ['buildPromptCard', 'buildPromptText', 'copyPromptBtn']) {
        assert.ok(HTML.includes(`id="${id}"`), `missing id in html: ${id}`);
        assert.ok(/const\s+buildPromptCard\s*=|const\s+copyPromptBtn\s*=|const\s+buildPromptText\s*=/.test(APP), 'not declared in app.js');
    }
});
test('analysis flow renders without throwing', async () => {
    const b = withSpec(SPEC);
    assert.strictEqual(b.thrown, null, 'boot threw');
    await new Promise(r => setTimeout(r, 30));
    assert.ok(b.els.get('resultPanel').classList.contains('visible'), 'panel never became visible');
});
test('build-prompt card is populated (feature is not silently dead)', async () => {
    const b = withSpec(SPEC);
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(b.els.get('buildPromptCard').hidden, false, 'card hidden => extractor found nothing');
    assert.strictEqual(b.els.get('buildPromptText').textContent.trim(), 'Rebuild x.com as a dark landing page.');
});
test('build prompt stops at blank line, does not swallow the spec', async () => {
    // Real-world shape: model writes BUILD PROMPT, then a bullet list, and never
    // emits another heading. The old regex captured to end-of-string.
    const leaky = [
        'BUILD PROMPT', 'Rebuild acme.com as a bright SaaS landing page.', '',
        '- hero with gradient', '- three feature cards', '- sticky nav',
        '## Not A Heading That Follows Later', '', '- more stuff'
    ].join('\n');
    const b = withSpec(leaky);
    await new Promise(r => setTimeout(r, 30));
    const got = b.els.get('buildPromptText').textContent.trim();
    assert.strictEqual(got, 'Rebuild acme.com as a bright SaaS landing page.', 'leaked: ' + got);
    assert.ok(!got.includes('sticky nav'), 'spec bullets leaked into the prompt');
});
test('markdown renders to headings + table', async () => {
    const b = withSpec(SPEC);
    await new Promise(r => setTimeout(r, 30));
    const h = b.els.get('promptContent').innerHTML;
    assert.ok(h.includes('<h1>'), 'no h1');
    assert.ok(h.includes('<table>'), 'no table');
    assert.ok(h.includes('<code>#030712</code>'), 'no inline code');
});
test('XSS: no script/onerror/img survive the renderer', async () => {
    const b = withSpec(SPEC);
    await new Promise(r => setTimeout(r, 30));
    const h = b.els.get('promptContent').innerHTML;
    assert.ok(!/<script/i.test(h), 'script tag injected');
    assert.ok(!/onerror/i.test(h.split('&lt;')[0]), 'raw handler injected');
    assert.ok(!/<img/i.test(h), 'img injected');
    assert.ok(h.includes('&lt;img'), 'escaped markup lost');
});
test('every table gets its own horizontal scroller', async () => {
    const b = withSpec(SPEC);
    await new Promise(r => setTimeout(r, 30));
    const h = b.els.get('promptContent').innerHTML;
    assert.ok(h.includes('<div class="md-table-wrap"><table>'), 'table not wrapped');
    assert.ok(CSS.includes('.md-table-wrap'), 'no CSS for wrapper');
    assert.ok(/\.result-panel \.prompt-box\.is-rendered \{[^}]*overflow-x: hidden/.test(CSS), 'prompt-box still lacks overflow-x:hidden');
});
test('copy spec sends markdown, not rendered text', async () => {
    const b = withSpec(SPEC);
    await new Promise(r => setTimeout(r, 30));
    b.els.get('copyBtn')._fire('click');
    await new Promise(r => setTimeout(r, 10));
    assert.ok(b.sandbox.__copied.includes('| Token | Hex | Use |'), 'copied: ' + b.sandbox.__copied);
});
test('copy build-prompt sends ONLY the prompt', async () => {
    const b = withSpec(SPEC);
    await new Promise(r => setTimeout(r, 30));
    b.els.get('copyPromptBtn')._fire('click');
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(b.sandbox.__copied.trim(), 'Rebuild x.com as a dark landing page.');
});
test('API error surfaces a message and does not throw', async () => {
    const b = withSpec('', () => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'boom' }) }));
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(b.els.get('buildPromptCard').hidden, true, 'stale card left visible');
    assert.ok(b.els.get('url-error').textContent.includes('boom'), 'err=' + b.els.get('url-error').textContent);
});
test('bare host is accepted by the client validator', () => {
    const b = boot();
    b.els.get('urlInput').value = 'linear.app';
    b.els.get('deconstructBtn')._fire('click');
    assert.strictEqual(b.els.get('url-error').textContent, '', 'rejected bare host');
});
test('javascript: URL is rejected client-side', () => {
    const b = boot();
    b.els.get('urlInput').value = 'javascript:alert(1)';
    b.els.get('deconstructBtn')._fire('click');
    assert.ok(b.els.get('url-error').textContent.length > 0, 'no error shown for javascript:');
});


/* ---- theme contrast: the invisible-text bug class ------------------------ */
/* Parses the real token blocks out of style.css and computes WCAG contrast
   for the inverted pricing card in BOTH themes. A hardcoded alpha that only
   reads on one card colour fails here, which is exactly how this shipped. */
function block(re) { const m = CSS.match(re); return m ? m[0] : ''; }
function tokens(css) {
    const t = {};
    for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) t[m[1]] = m[2].trim();
    return t;
}
function resolve(v, scope) {
    for (let i = 0; i < 8 && /^var\(/.test(v); i++) {
        const m = v.match(/^var\((--[\w-]+)\)$/); if (!m) return v;
        v = scope[m[1]]; if (v === undefined) return null;
    }
    return v;
}
function toRGB(c) {
    c = c.trim();
    let m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) { const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255, 1]; }
    m = c.match(/^rgba?\(([^)]+)\)$/i);
    if (m) { const p = m[1].split(',').map(x => parseFloat(x)); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    return null;
}
function over(fg, bg) { // composite rgba over opaque rgb
    const a = fg[3];
    return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a));
}
function lum(c) {
    const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}
function proCardIn(theme) {
    const base = theme === 'dark'
        ? Object.assign(tokens(block(/:root\s*{[^}]*}/)), tokens(block(/\[data-theme="dark"\]\s*{[^}]*}/)))
        : tokens(block(/:root\s*{[^}]*}/));
    let card = tokens(block(/\.pricing-card\.pro\s*{[^}]*}/));
    if (theme === 'dark') card = Object.assign({}, card, tokens(block(/\[data-theme="dark"\]\s*\.pricing-card\.pro\s*{[^}]*}/)));
    const scope = Object.assign({}, base, card);
    const bg = toRGB(resolve(card['--card-bg'], scope));
    const muted = resolve(card['--card-muted'], scope);
    const border = resolve(card['--card-border'], scope);
    return { bg, muted: toRGB(muted), border: toRGB(border), text: toRGB(resolve(card['--card-text'], scope)) };
}
test('inverted pricing card: muted text passes WCAG AA in both themes', () => {
    for (const theme of ['light', 'dark']) {
        const c = proCardIn(theme);
        assert.ok(c.bg && c.muted, theme + ': could not resolve card colours');
        const ratio = contrast(over(c.muted, c.bg), c.bg);
        assert.ok(ratio >= 4.5,
            theme + ' theme: muted text on card is ' + ratio.toFixed(2) + ':1 (needs 4.5:1) — invisible text');
    }
});
test('inverted pricing card: body text + dividers are visible in both themes', () => {
    for (const theme of ['light', 'dark']) {
        const c = proCardIn(theme);
        const body = contrast(over(c.text, c.bg), c.bg);
        const line = contrast(over(c.border, c.bg), c.bg);
        assert.ok(body >= 4.5, theme + ': body text ' + body.toFixed(2) + ':1');
        assert.ok(line >= 1.2, theme + ': divider ' + line.toFixed(2) + ':1 — border not perceptible');
    }
});
test('every white-alpha declaration has a dark-theme override', () => {
    // The real invariant: a white alpha is only safe if the dark theme either
    // redefines that same custom property, or re-declares the same selector.
    // This is the bug class that shipped twice (--accent text, then this card).
    const WHITE = /rgba\(\s*255\s*,\s*255\s*,\s*255/;
    const darkTokenProps = new Set();
    const darkSelectors = new Set();
    for (const m of CSS.matchAll(/\[data-theme="dark"\]([^{]*){([^}]*)}/g)) {
        darkSelectors.add(m[1].trim());
        for (const d of m[2].matchAll(/(--[\w-]+)\s*:/g)) darkTokenProps.add(d[1]);
    }
    const offenders = [];
    for (const r of CSS.split(/(?<=})/)) {
        if (!WHITE.test(r)) continue;
        const sel = ((r.match(/^([^{}]*){/) || ['', ''])[1]).trim();
        if (!sel || sel.includes('data-theme="dark"')) continue;
        // only the declarations that are themselves white need covering
        const whiteProps = [...r.matchAll(/(--[\w-]+)\s*:\s*([^;]*rgba\(\s*255\s*,\s*255\s*,\s*255[^;]*)/g)]
            .map(x => x[1]);
        if (whiteProps.length) {
            const uncovered = whiteProps.filter(prop => !darkTokenProps.has(prop));
            if (uncovered.length) offenders.push(sel + ' {' + uncovered.join(',') + '}');
        } else if (!darkSelectors.has(sel)) {
            offenders.push(sel + ' [literal white, no dark rule]');
        }
    }
    assert.deepStrictEqual(offenders, [], 'white alphas without a dark override: ' + offenders.join(', '));
});


// ============================================================
// Custom BYOK endpoint wiring. This panel previously had NO frontend coverage,
// which is how a model-ID regex excluding '/' could ship: the server silently
// fell back to the free tier, so the UI looked like it worked.
// ============================================================
function bootByok() {
    const b = boot();
    const els = b.els;
    assert.ok(els.has('byokBaseUrl'), 'index.html is missing id="byokBaseUrl"');
    assert.ok(els.has('byokBaseUrlField'), 'index.html is missing id="byokBaseUrlField"');
    assert.ok(els.has('byokCustomHint'), 'index.html is missing id="byokCustomHint"');
    return b;
}
function setByok(els, vals) {
    Object.assign(els.get('byokProvider'), { value: vals.provider });
    els.get('byokProvider')._fire('change');
    if ('baseUrl' in vals) Object.assign(els.get('byokBaseUrl'), { value: vals.baseUrl });
    if ('model' in vals) Object.assign(els.get('byokModel'), { value: vals.model });
    if ('key' in vals) Object.assign(els.get('byokKey'), { value: vals.key });
    els.get('byokBaseUrl')._fire('change');
    els.get('byokModel')._fire('change');
    els.get('byokKey')._fire('change');
}

test('custom fields are hidden on boot', () => {
    const { els } = bootByok();
    assert.strictEqual(els.get('byokBaseUrlField').hidden, true, 'base URL field visible for openai');
    assert.strictEqual(els.get('byokCustomHint').hidden, true, 'hint visible for openai');
});
test('choosing Custom URL reveals the base-URL field and hint', () => {
    const { els } = bootByok();
    setByok(els, { provider: 'custom' });
    assert.strictEqual(els.get('byokBaseUrlField').hidden, false, 'field stayed hidden');
    assert.strictEqual(els.get('byokCustomHint').hidden, false, 'hint stayed hidden');
});
test('switching back to OpenAI re-hides them', () => {
    const { els } = bootByok();
    setByok(els, { provider: 'custom' });
    setByok(els, { provider: 'openai' });
    assert.strictEqual(els.get('byokBaseUrlField').hidden, true, 'field left visible after switching away');
});
test('.byok-field[hidden] CSS override exists (display:flex outranks UA [hidden])', () => {
    assert.ok(/\.byok-field\[hidden\]\s*\{\s*display:\s*none/.test(CSS),
        'missing .byok-field[hidden] rule: .byok-field sets display:flex, so hidden would be ignored');
    assert.ok(/\.byok-hint\[hidden\]\s*\{\s*display:\s*none/.test(CSS), 'missing .byok-hint[hidden] rule');
});

test('custom provider without a URL does NOT silently fall back to free tier', async () => {
    const bodies = [];
    const b = boot({ fetch: (u, o) => { bodies.push(o && o.body); return Promise.resolve({ ok: true, json: () => Promise.resolve({ prompt: 'x', domain: 'd', signals: {} }) }); } });
    setByok(b.els, { provider: 'custom', baseUrl: '', model: 'openai/gpt-4o-mini', key: 'sk-or-v1-' + 'a'.repeat(40) });
    b.els.get('urlInput').value = 'https://x.com';
    b.els.get('deconstructBtn')._fire('click');
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(bodies.length, 1, 'no request sent');
    const payload = JSON.parse(bodies[0]);
    // Half-filled custom form must be treated as "not using BYOK" explicitly,
    // and must not send a baseUrl-less custom object the server rejects.
    assert.ok(!payload.byok || payload.byok.provider !== 'custom',
        'sent custom with empty baseUrl -> server normalises to null -> silent free tier');
});
test('a complete custom form sends baseUrl and a slashed model', async () => {
    const bodies = [];
    const b = boot({ fetch: (u, o) => { bodies.push(o && o.body); return Promise.resolve({ ok: true, json: () => Promise.resolve({ prompt: 'x', domain: 'd', signals: {} }) }); } });
    setByok(b.els, { provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct', key: 'sk-or-v1-' + 'a'.repeat(40) });
    b.els.get('urlInput').value = 'https://x.com';
    b.els.get('deconstructBtn')._fire('click');
    await new Promise(r => setTimeout(r, 50));
    const payload = JSON.parse(bodies[0]);
    assert.ok(payload.byok, 'byok missing entirely');
    assert.strictEqual(payload.byok.provider, 'custom');
    assert.strictEqual(payload.byok.baseUrl, 'https://openrouter.ai/api/v1');
    assert.strictEqual(payload.byok.model, 'meta-llama/llama-3.3-70b-instruct');
});
test('remember round-trips baseUrl through localStorage', () => {
    const b = bootByok();
    b.els.get('byokRemember').checked = true;
    setByok(b.els, { provider: 'custom', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', key: 'gsk_' + 'b'.repeat(40) });
    const saved = JSON.parse(b.sandbox.localStorage.getItem('uid-byok'));
    assert.strictEqual(saved.baseUrl, 'https://api.groq.com/openai/v1', 'baseUrl not persisted');
    assert.strictEqual(saved.provider, 'custom');
});
test('usage badge does not claim unlimited (BYOK is capped at 60/hr)', () => {
    assert.ok(!/∞/.test(APP), 'the ∞ badge is still in app.js; api/deconstruct.js caps BYOK at 60/hr');
});
test('custom option is actually offered in the provider select', () => {
    assert.ok(/<option value="custom"/.test(HTML), 'no custom option in #byokProvider');
});

// ---- BYOK REJECTION NOTICE (rendering). Backend already proves the field
// exists and cannot cross the cache. These prove the browser path: it shows,
// it hides, it escapes, and it is readable on both themes.
const warnFetch = (body) => () => Promise.resolve({
    ok: true, json: () => Promise.resolve(Object.assign({ prompt: SPEC, domain: 'x.com', signals: {} }, body))
});
test('a rejected key shows the notice', async () => {
    const b = boot({ fetch: warnFetch({ byokWarning: 'Your base URL must start with https:// - your key was NOT sent anywhere.' }) });
    b.els.get('urlInput').value = 'https://x.com';
    b.els.get('deconstructBtn')._fire('click');
    await new Promise(r => setTimeout(r, 30));
    const el = b.els.get('byokWarning');
    assert.ok(el, 'no #byokWarning element');
    assert.strictEqual(el.hidden, false, 'notice stayed hidden');
    assert.ok(/NOT sent/i.test(el.textContent), 'text: ' + JSON.stringify(el.textContent));
});
test('a normal result shows no notice', async () => {
    const b = boot({ fetch: warnFetch({}) });
    b.els.get('urlInput').value = 'https://x.com';
    b.els.get('deconstructBtn')._fire('click');
    await new Promise(r => setTimeout(r, 30));
    const el = b.els.get('byokWarning');
    assert.strictEqual(el.hidden, true, 'notice shown with nothing to say');
    assert.strictEqual(el.textContent, '', 'stale text: ' + el.textContent);
});
test('the notice cannot persist from one run into the next', async () => {
    // Same page, two analyses: warned then clean. A warning that survives reads
    // as a permanent defect and is worse than no warning.
    let n = 0;
    const b = boot({ fetch: () => { n++; return warnFetch(n === 1 ? { byokWarning: 'first run warning' } : {})(); } });
    b.els.get('urlInput').value = 'https://x.com';
    b.els.get('deconstructBtn')._fire('click');
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(b.els.get('byokWarning').hidden, false, 'run 1 should warn');
    b.els.get('deconstructBtn')._fire('click');
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(b.els.get('byokWarning').hidden, true, 'run 2 inherited run 1\'s warning');
});
test('the notice is text, never markup (it interpolates user input)', async () => {
    // baseUrl and model are user-supplied and land inside this string. If the
    // render path ever switches to innerHTML this payload becomes an executor.
    const b = boot({ fetch: warnFetch({ byokWarning: '<img src=x onerror=alert(1)><b>bold</b>' }) });
    b.els.get('urlInput').value = 'https://x.com';
    b.els.get('deconstructBtn')._fire('click');
    await new Promise(r => setTimeout(r, 30));
    const el = b.els.get('byokWarning');
    assert.strictEqual(el.innerHTML, '', 'innerHTML was written — XSS surface reopened');
    assert.ok(el.textContent.includes('<img'), 'textContent should hold the raw string');
});
test('byok-warning: notice text passes WCAG AA in both themes', () => {
    const rule = block(/\.byok-warning\s*{[^}]*}/);
    const dark = block(/\[data-theme="dark"\]\s*\.byok-warning\s*{[^}]*}/);
    assert.ok(rule, 'no .byok-warning rule in style.css');
    for (const theme of ['light', 'dark']) {
        const base = theme === 'dark'
            ? Object.assign(tokens(block(/:root\s*{[^}]*}/)), tokens(block(/\[data-theme="dark"\]\s*{[^}]*}/)))
            : tokens(block(/:root\s*{[^}]*}/));
        // tokens() only captures --custom-props; this rule uses plain
        // declarations, so read them with decl() instead.
        const pick = (blk, prop) => { const m = blk.match(new RegExp('(?:^|[;\\s])' + prop + '\\s*:\\s*([^;]+)')); return m ? m[1].trim() : null; };
        // dark override must WIN in dark theme, not fall behind the base rule
        const color = (theme === 'dark' ? pick(dark, 'color') : null) || pick(rule, 'color');
        const bgs = (theme === 'dark' && pick(dark, 'background')) || pick(rule, 'background');
        assert.ok(color, theme + ': no color declaration found for .byok-warning');
        const bg = toRGB(resolve(base['--bg'], base));
        const fg = toRGB(color);
        const tint = bgs ? toRGB(bgs) : null;
        assert.ok(bg && fg, theme + ': could not resolve colours');
        // text sits on the tinted background, so composite the alpha first
        const surface = (tint && tint[3] < 1) ? over(tint, bg) : bg;
        const ratio = contrast(fg, surface);
        assert.ok(ratio >= 4.5, theme + ' theme: notice is ' + ratio.toFixed(2) + ':1 (needs 4.5:1)');
    }
});
test('the notice is wired, not just declared', () => {
    assert.ok(/byokWarning/.test(APP), 'app.js never reads the field');
    assert.ok(/showResult\(result\.prompt, result\.timings, result\.byokWarning\)/.test(APP),
        'call site does not pass the warning through');
    assert.ok(/id="byokWarning"/.test(HTML), 'no element in index.html');
});

/* ---- fake-bold bug class --------------------------------------------------
   A font-weight the family was never loaded at is not ignored by the browser:
   it synthesises a faux bold from the 400 outline. At small sizes that reads
   muddy, which is how the three card headings looked. The bug is invisible in
   the CSS (the declaration is perfectly legal) — you can only catch it by
   cross-checking every declared weight against the weights the Google Fonts
   link actually requests. So: parse the link, then audit the stylesheet. */
const FAMILY = { sans: 'DM Sans', serif: 'Instrument Serif', mono: 'JetBrains Mono' };

function loadedWeights() {
    const link = HTML.match(/fonts\.googleapis\.com\/css2\?[^"]*/);
    assert.ok(link, 'no Google Fonts stylesheet link in index.html');
    const loaded = {};
    for (const m of link[0].matchAll(/family=([^:&]+)(?::([^&]*))?/g)) {
        const name = decodeURIComponent(m[1]).replace(/\+/g, ' ');
        const weights = [...(m[2] || '').matchAll(/wght@([\d;.,a-z]+)/gi)]
            .flatMap(x => x[1].split(';').map(s => parseInt(s.split(',').pop(), 10)))
            .filter(Number.isFinite);
        // a family with no wght axis is served at its single default weight
        loaded[name] = weights.length ? weights : [400];
    }
    return loaded;
}

test('no rule asks for a font weight the family was not loaded at', () => {
    const loaded = loadedWeights();
    // Instrument Serif ships ONE weight — that constraint is the whole bug
    assert.ok(loaded['Instrument Serif'], 'Instrument Serif is not loaded at all');
    assert.deepStrictEqual(loaded['Instrument Serif'], [400],
        'serif now ships extra weights; revisit the 400-only assumption below');

    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');   // comments outrank selectors
    const offenders = [];
    for (const [, sel, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const fam = body.match(/font-family:\s*var\(--font-(sans|serif|mono)\)/);
        const w = body.match(/font-weight:\s*(\d+)/);
        if (!fam || !w) continue;
        const name = FAMILY[fam[1]];
        if (!loaded[name].includes(parseInt(w[1], 10))) {
            offenders.push(name + ' ' + w[1] + ' @ ' + sel.trim().replace(/\s+/g, ' ').slice(0, 50));
        }
    }
    assert.deepStrictEqual(offenders, [], 'browser will synthesise these:\n      ' + offenders.join('\n      '));
});

test('a heading never inherits a weight its serif cannot render', () => {
    // The audit above only sees rules declaring BOTH properties. But h1-h6 carry
    // a UA default of font-weight:700, so a rule like `h2 { font-family:
    // var(--font-serif) }` -- weight nowhere -- synthesises the same fake bold
    // that shipped on the card headings. Check inherited weight too.
    const loaded = loadedWeights();
    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders = [];
    for (const [, sel, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const fam = body.match(/font-family:\s*var\(--font-(sans|serif|mono)\)/);
        if (!fam) continue;
        const weights = loaded[FAMILY[fam[1]]];
        if (!/(^|[\s,>+~])h[1-6](?![\w-])/.test(sel)) continue;   // not a heading
        if (/font-weight:\s*\d/.test(body)) continue;             // weight is explicit
        // no declared weight -> UA default 700 for headings
        if (!weights.includes(700)) {
            offenders.push(fam[1] + ' heading with no font-weight (UA 700 not loaded) @ '
                + sel.trim().replace(/\s+/g, ' ').slice(0, 50));
        }
    }
    assert.deepStrictEqual(offenders, [], '\n      ' + offenders.join('\n      '));
});

test('a rule that only sets font-weight inherits a family it may not fit', () => {
    // Both audits above read font-family from the SAME rule that sets the
    // weight. But inheritance does not work that way: a rule can set ONLY
    // font-weight and still land on a family its ancestor chose. This shipped
    // on the hero -- `.hero h1` sets var(--font-serif) (Instrument Serif, 400
    // ONLY) and a nested `.hero h1 .highlight` asked for 500. A synthesised
    // faux bold on the largest text on the page, invisible to both audits.
    const loaded = loadedWeights();
    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    // Flatten comma groups so `.a h1, .b h1 { font-family: ... }` registers
    // each selector -- otherwise a grouped ancestor silently escapes the audit.
    const flat = [];
    for (const [, sel, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const one of sel.split(',')) {
            const s = one.trim().replace(/\s+/g, ' ');
            if (s && !s.startsWith('@')) flat.push({ sel: s, body });
        }
    }
    const familyOf = new Map();
    for (const r of flat) {
        const fam = r.body.match(/font-family:\s*var\(--font-(sans|serif|mono)\)/);
        if (fam && !familyOf.has(r.sel)) familyOf.set(r.sel, FAMILY[fam[1]]);
    }
    const offenders = [];
    for (const r of flat) {
        if (/font-family:/.test(r.body)) continue;          // declares its own family
        const w = r.body.match(/font-weight:\s*(\d+)/);
        if (!w) continue;
        const toks = r.sel.split(/\s+/);
        const chain = [];
        for (let n = toks.length - 1; n >= 1; n--) chain.push(toks.slice(0, n).join(' '));
        const el = (toks[toks.length - 1] || '').replace(/[.#\[:].*/, '');
        if (el) chain.push(el);                             // element-name ancestor
        const src = chain.find(a => familyOf.has(a));
        if (!src) continue;
        const name = familyOf.get(src);
        if (!loaded[name].includes(parseInt(w[1], 10))) {
            offenders.push(`${name} @ ${w[1]} on "${r.sel}" (inherits family from "${src}")`);
        }
    }
    assert.deepStrictEqual(offenders, [], 'browser will synthesise these:\n      ' + offenders.join('\n      '));
});

test('card headings are not inline-styled (inline styles outrank the audit)', () => {
    // The bug survived for weeks because it lived in a style="" attribute, which
    // no stylesheet rule can override and this file's CSS parser cannot see.
    const inline = [...HTML.matchAll(/style="([^"]*)"/g)]
        .map(m => m[1])
        .filter(v => /font-family|font-weight/.test(v));
    assert.deepStrictEqual(inline, [],
        'typography belongs in style.css, not the markup: ' + inline.join(' | '));
});

(async () => {
    const unhandled = [];
    process.on('unhandledRejection', r => unhandled.push(String((r && r.message) || r)));
    let fail = 0;
// --- legal notice guard ----------------------------------------------------
// The non-affiliation / trademark notice is the cheapest insurance this site
// has: it publishes extracted design tokens for 16 named companies. It lives in
// a generated template AND in 17 already-rendered pages, so it can be lost in
// either place - a template edit drops it from every future regeneration, a
// hand edit to a page drops it from that page. Assert both.
test('trademark notice present in the generator template', () => {
    const gen = fs.readFileSync(path.join(ROOT, 'lib', 'gen-specs.js'), 'utf8');
    assert.ok(gen.includes(NOTICE), 'lib/gen-specs.js template is missing the notice');
});
test('trademark notice present in index.html', () => {
    assert.ok(HTML.includes(NOTICE), 'index.html is missing the notice');
});
test('trademark notice present in every published spec page, exactly once', () => {
    const dir = path.join(ROOT, 'specs');
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
    assert.ok(pages.length >= 16, 'expected >=16 spec pages, found ' + pages.length);
    for (const f of pages) {
        const body = fs.readFileSync(path.join(dir, f), 'utf8');
        const n = body.split(NOTICE).length - 1;
        assert.strictEqual(n, 1, f + ' has the notice ' + n + ' times (want exactly 1)');
    }
});

// Regression guard: CSS identifiers may contain escape sequences (\30d2 = a
// Japanese char). If the miner stops decoding them the published pages show raw
// backslash garbage where a font name should be. This shipped once, so assert it
// cannot ship again. Scoped to the typeface sentence because a legitimate
// content: "\2022" bullet elsewhere in a page must not trip it.
// Attribution must survive every regeneration. The generator template is the
// source of truth, so guard both it and the rendered pages: a regen that drops
// the credit line should fail here, not ship silently.
test('every published page and the generator template carry the Built-by credit', () => {
    const fs = require('fs');
    const gen = fs.readFileSync('lib/gen-specs.js', 'utf8');
    assert.ok(/Built by /.test(gen), 'generator template lost the Built-by credit');
    assert.ok(/name="author"/.test(gen), 'generator template lost the author meta');
    for (const f of fs.readdirSync('specs')) {
        if (!f.endsWith('.html')) continue;
        const t = fs.readFileSync('specs/' + f, 'utf8');
        assert.ok(/Built by <a href="https:\/\/github\.com\/al7ameen"/.test(t),
            'specs/' + f + ' lost the Built-by credit');
    }
    const home = fs.readFileSync('index.html', 'utf8');
    assert.ok(/Built by <a href="https:\/\/github\.com\/al7ameen"/.test(home), 'home lost the credit');
    assert.ok(/"creator":\{"@type":"Person","name":"al7ameen"/.test(home), 'home lost JSON-LD creator');
});

test('no published spec page shows an undecoded CSS escape in its typeface list', () => {
    const dir = path.join(ROOT, 'specs');
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
    const BS = String.fromCharCode(92);
    // The pattern SOURCE needs two backslash chars to match one literal backslash.
    // BS + '[0-9a-f...]' yields \[ - an escaped literal bracket that can
    // never match, which made this guard pass vacuously.
    const raw = new RegExp(BS + BS + '[0-9a-fA-F]{2,6}');
    assert.ok(pages.length >= 15, 'expected >=15 spec pages, found ' + pages.length);
    for (const f of pages) {
        const body = fs.readFileSync(path.join(dir, f), 'utf8');
        const i = body.indexOf('Typefaces named');
        if (i < 0) continue; // page has no typeface section (github: JS-injected fonts)
        const region = body.slice(i, i + 700).replace(/<[^>]+>/g, '');
        const m = region.match(raw);
        assert.ok(!m, f + ' has an undecoded CSS escape in its font list: ' + JSON.stringify((m || []).slice(0, 3)));
    }
});


// ---- spec-page layout guards -------------------------------------------------
// The last section of a spec page is the "Other specs" chip row. It had
// padding-top only, so it sat flush against the footer divider. A test that
// merely greps for the CSS rule would pass on a selector that matches nothing
// (my first two attempts did exactly that), so these verify the DOM too.
function lastSectionDirectChildOfSpecPage(body) {
    const m = body.match(/<div class="spec-page">([\s\S]*)<\/main>/);
    if (!m) return null;
    let depth = 0, last = null;
    for (const tok of m[1].matchAll(/<(\/?)(section|div)([^>]*?)>/g)) {
        if (tok[1] === '/') { depth--; continue; }
        if (depth === 0 && tok[2] === 'section') {
            last = (tok[3].match(/class="([^"]*)"/) || [, ''])[1];
        }
        if (!tok[0].endsWith('/>')) depth++;
    }
    return last;
}

test('spec pages: last section is a direct child of .spec-page (selector is not a no-op)', () => {
    const dir = path.join(ROOT, 'specs');
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && f !== 'index.html');
    assert.ok(pages.length >= 15, 'expected >=15 spec pages, found ' + pages.length);
    for (const f of pages) {
        const body = fs.readFileSync(path.join(dir, f), 'utf8');
        const last = lastSectionDirectChildOfSpecPage(body);
        assert.ok(last !== null, f + ': no section is a direct child of .spec-page - the spacing selector matches nothing');
        assert.ok(/(^| )spec-section( |$)/.test(last), f + ': last section is not .spec-section: "' + last + '"');
        assert.ok(!/(^| )spec-more( |$)/.test(last), f + ': last section IS .spec-more, so :not(.spec-more) no longer applies - recheck its bottom spacing');
    }
});

test('spec pages: the bottom-spacing rule exists and carries padding-bottom', () => {
    const r = SPECCSS.match(/\.spec-page\s*>\s*\.spec-section:last-child:not\(\.spec-more\)\s*\{([^}]*)\}/);
    assert.ok(r, 'no bottom-spacing rule for the last .spec-section - chip row sits flush on the footer divider');
    assert.ok(/padding-bottom/.test(r[1]), 'last-section rule lost its padding-bottom');
});

test('hub: .spec-more keeps its own bottom padding (must not be shrunk by the new rule)', () => {
    const body = fs.readFileSync(path.join(ROOT, 'specs', 'index.html'), 'utf8');
    const secs = [...body.matchAll(/<section class="([^"]*)"/g)];
    const last = secs[secs.length - 1][1];
    assert.ok(/(^| )spec-more( |$)/.test(last), 'hub last section is not .spec-more: "' + last + '" - it would lose 64px of bottom padding');
    const more = SPECCSS.match(/\.spec-more\s*\{([^}]*)\}/);
    assert.ok(more && /padding-bottom/.test(more[1]), '.spec-more lost its padding-bottom');
});

test('spec pages: sticky navbar is opaque (page text must not bleed through the wordmark)', () => {
    const body = fs.readFileSync(path.join(ROOT, 'specs', 'index.html'), 'utf8');
    assert.ok(!/app\.js/.test(body), 'spec pages now load app.js - the always-opaque navbar rule may be redundant, recheck');
    const r = SPECCSS.match(/\.navbar\s*\{([^}]*)\}/);
    assert.ok(r, 'no .navbar rule in specs.css - the transparent sticky bar lets content scroll under the wordmark');
    assert.ok(/background:\s*var\(--bg\)/.test(r[1]), '.navbar lost its solid background');
});


// ---- chip-row integrity -------------------------------------------------
// The launch-blocking bug this guards: otherSitesBlock built the "Other specs"
// row from the CURATED 25-site list and never intersected it with what was
// actually published, so 16 pages each linked 4 slugs that have no page behind
// them (linear/figma/framer/airbnb) = 64 live 404s. Nothing caught it because
// no test ever RESOLVED a link. A grep for the CSS rule would also pass on a
// no-op selector, so these parse the rendered DOM and hit the filesystem.

test('spec pages: every Other-specs chip resolves to a page on disk', () => {
    const dir = path.join(ROOT, 'specs');
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'slugs.json'), 'utf8'));
    const published = new Set(rows.map((r) => r.slug));
    assert.ok(published.size >= 10, 'slugs.json holds only ' + published.size + ' rows - merge regression?');
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && f !== 'index.html');
    assert.strictEqual(pages.length, published.size, 'pages on disk (' + pages.length + ') != slugs.json rows (' + published.size + ')');
    const dead = [];
    let links = 0;
    for (const f of pages) {
        const body = fs.readFileSync(path.join(dir, f), 'utf8');
        const sec = body.match(/<h2>Other specs<\/h2>[\s\S]*?<\/section>/);
        assert.ok(sec, f + ': has no Other-specs block at all');
        const chips = [...sec[0].matchAll(/\/specs\/([a-z0-9-]+)/g)].map((m) => m[1]);
        assert.ok(chips.length >= 6, f + ': only ' + chips.length + ' chips - the row looks empty');
        for (const slug of chips) {
            links++;
            if (!published.has(slug)) dead.push(f + ' -> ' + slug + ' (absent from slugs.json)');
            else if (!fs.existsSync(path.join(dir, slug + '.html'))) dead.push(f + ' -> ' + slug + ' (no file on disk)');
        }
    }
    assert.ok(links >= 150, 'only ' + links + ' chip links found across all pages - scan looks broken');
    assert.strictEqual(dead.length, 0, dead.length + ' dead chip link(s):\n      ' + dead.slice(0, 8).join('\n      '));
});

test('gen-specs: otherSitesBlock links only published slugs, never the curated list', () => {
    const gen = require(path.join(ROOT, 'lib', 'gen-specs.js'));
    assert.strictEqual(typeof gen.otherSitesBlock, 'function', 'otherSitesBlock is not exported - this guard cannot run');
    const SITES = require(path.join(ROOT, 'lib', 'spec-sites.js'));
    const published = [
        { slug: 'stripe', name: 'Stripe' },
        { slug: 'vercel', name: 'Vercel' },
        { slug: 'apple', name: 'Apple' },
        { slug: 'neon', name: 'Neon' },
    ];
    const html = gen.otherSitesBlock(published[0], published);
    const slugs = [...html.matchAll(/\/specs\/([a-z0-9-]+)/g)].map((m) => m[1]);
    assert.ok(slugs.includes('vercel'), 'a published slug is missing from the chip row');
    assert.ok(!slugs.includes('stripe'), 'the page links to itself');
    const unpublished = SITES.map((x) => x.slug).filter((c) => !published.some((x) => x.slug === c));
    assert.ok(unpublished.length > 5, 'curated list is unexpectedly small - this test assumes gated sites exist');
    const leaked = unpublished.filter((c) => slugs.includes(c));
    assert.strictEqual(leaked.length, 0, 'chip row links curated-but-unpublished slug(s): ' + leaked.join(', ') + ' - the 404 bug is back');
});

test('hub: every card link resolves to a page on disk', () => {
    const dir = path.join(ROOT, 'specs');
    const body = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const hrefs = [...body.matchAll(/class="spec-card"[\s\S]*?\/specs\/([a-z0-9-]+)/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 10, 'hub renders only ' + hrefs.length + ' cards');
    const dead = hrefs.filter((x) => !fs.existsSync(path.join(dir, x + '.html')));
    assert.strictEqual(dead.length, 0, 'hub cards point at missing pages: ' + dead.join(', '));
});


// ---- author note (self-promo slot) ---------------------------------------
// Deliberately guards the DECEPTION direction too: the label must not read
// "Sponsored" while the slot carries no sponsor and pays nothing. That would
// violate the same no-deception rule that requires disclosure for real ads.
const SPEC_PAGES = fs.readdirSync(path.join(ROOT, 'specs')).filter((f) => f.endsWith('.html'));

function authorNoteRule(prop) {
    const re = new RegExp('\\.author-note' + (prop === 'root' ? '\\s' : '') + '\\s*\\{([^}]*)\\}');
    const m = CSS.match(re);
    return m ? m[1] : null;
}

test('author-note: every page carries exactly one, including the generator template', () => {
    const gen = fs.readFileSync(path.join(ROOT, 'lib', 'gen-specs.js'), 'utf8');
    assert.strictEqual((gen.match(/class="author-note"/g) || []).length, 1,
        'generator template has ' + (gen.match(/class="author-note"/g) || []).length + ' author-note blocks - a regen would drop or duplicate it');
    const files = ['index.html', ...SPEC_PAGES.map((f) => path.join('specs', f))];
    for (const f of files) {
        const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const n = (body.match(/class="author-note"/g) || []).length;
        assert.strictEqual(n, 1, f + ' has ' + n + ' author-note blocks (expected 1)');
    }
});

test('author-note: label is honest - says "From the author", never "Sponsored"', () => {
    const files = ['index.html', ...SPEC_PAGES.map((f) => path.join('specs', f))];
    for (const f of files) {
        const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const m = body.match(/class="author-note-label"[^>]*>([^<]*)</);
        assert.ok(m, f + ': author-note has no label span');
        assert.strictEqual(m[1].trim(), 'From the author',
            f + ': label reads "' + m[1].trim() + '" - "Sponsored" is a lie while the slot is unpaid self-promo');
    }
});

test('author-note: contact link is external, nofollow-free but rel-protected', () => {
    const files = ['index.html', ...SPEC_PAGES.map((f) => path.join('specs', f))];
    for (const f of files) {
        const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const block = body.match(/<div class="author-note">[\s\S]*?<\/div>/);
        assert.ok(block, f + ': cannot isolate the author-note block');
        const a = block[0].match(/<a [^>]*>/g) || [];
        assert.strictEqual(a.length, 1, f + ': expected exactly 1 link in the note, found ' + a.length);
        assert.ok(/href="https:\/\//.test(a[0]), f + ': contact link is not an absolute https URL');
        assert.ok(/rel="[^"]*noopener/.test(a[0]), f + ': contact link lost rel="noopener" (tabnabbing)');
        assert.ok(/target="_blank"/.test(a[0]), f + ': external contact link has no target="_blank"');
    }
});

test('author-note: every colour is a var() - no hardcoded alpha (inverted-card bug class)', () => {
    const rule = authorNoteRule('root');
    assert.ok(rule, 'no .author-note rule in style.css');
    const label = CSS.match(/\.author-note-label\s*\{([^}]*)\}/);
    assert.ok(label, 'no .author-note-label rule in style.css');
    for (const [name, body] of [['.author-note', rule], ['.author-note-label', label[1]]]) {
        const colors = body.match(/(?:^|;|\s)(?:color|background|border[^:]*):[^;]*/g) || [];
        for (const decl of colors) {
            if (/var\(/.test(decl)) continue;
            if (/none|transparent|\d/.test(decl) && !/#|rgba?\(/.test(decl)) continue;
            assert.ok(!/#|rgba?\(/.test(decl),
                name + ' hardcodes a colour: "' + decl.trim() + '" - it will not survive a theme switch');
        }
    }
});

test('author-note: text, label and link all pass WCAG AA in both themes', () => {
    // tokens() only captures --custom-props; .author-note uses plain
    // declarations, so read them with a decl picker (same lesson as byok-warning).
    const decl = (blk, prop) => {
        const m = blk.match(new RegExp('(?:^|[;\\s])' + prop + '\\s*:([^;]+)'));
        return m ? m[1].trim() : null;
    };
    const scope = (theme) => theme === 'dark'
        ? Object.assign(tokens(block(/:root\s*{[^}]*}/)), tokens(block(/\[data-theme="dark"\]\s*{[^}]*}/)))
        : tokens(block(/:root\s*{[^}]*}/));
    const rule = authorNoteRule('root');
    const labelBlk = (CSS.match(/\.author-note-label\s*\{([^}]*)\}/) || [, ''])[1];
    const linkBlk = (CSS.match(/\.author-note\s+a\s*\{([^}]*)\}/) || [, ''])[1];
    assert.ok(rule && labelBlk && linkBlk, 'missing .author-note / -label / a rules to audit');
    for (const theme of ['light', 'dark']) {
        const sc = scope(theme);
        const bgRaw = decl(rule, 'background');
        assert.ok(bgRaw, theme + ': .author-note has no background declared');
        const bg = toRGB(resolve(bgRaw, sc));
        assert.ok(bg, theme + ': cannot resolve author-note background: ' + bgRaw);
        const cases = [['body text', decl(rule, 'color')],
                       ['label', decl(labelBlk, 'color')],
                       ['link', decl(linkBlk, 'color')]];
        for (const [what, raw] of cases) {
            assert.ok(raw, theme + ': ' + what + ' has no colour declared');
            assert.ok(!/var\(--accent\)/.test(raw),
                theme + ': ' + what + ' uses --accent, which is #f5f5f5 (near-white) in dark');
            const rgb = toRGB(resolve(raw, sc));
            assert.ok(rgb, theme + ': ' + what + ' colour unresolved: ' + raw);
            const surface = rgb[3] < 1 ? over(rgb, bg) : rgb;
            const ratio = contrast(surface, bg);
            assert.ok(ratio >= 4.5,
                theme + ' theme: author-note ' + what + ' is ' + ratio.toFixed(2) + ':1 (needs 4.5:1)');
        }
    }
});

    const registeredAtStart = tests.length;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('  ok  ' + name); }
        catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
    }
    if (unhandled.length) { fail++; console.log('FAIL  no unhandled rejections\n      ' + unhandled.join(' | ')); }
    else console.log('  ok  no unhandled rejections');

    if (tests.length !== registeredAtStart) {
        fail++;
        console.log('FAIL  ' + (tests.length - registeredAtStart) + ' test(s) registered AFTER the runner loop - they never ran');
    }
    console.log(`\n${tests.length - fail}/${tests.length} frontend tests passed`);
    process.exit(fail ? 1 : 0);
})();
