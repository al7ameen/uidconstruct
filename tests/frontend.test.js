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

(async () => {
    const unhandled = [];
    process.on('unhandledRejection', r => unhandled.push(String((r && r.message) || r)));
    let fail = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('  ok  ' + name); }
        catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
    }
    if (unhandled.length) { fail++; console.log('FAIL  no unhandled rejections\n      ' + unhandled.join(' | ')); }
    else console.log('  ok  no unhandled rejections');
    console.log(`\n${tests.length - fail}/${tests.length} frontend tests passed`);
    process.exit(fail ? 1 : 0);
})();
