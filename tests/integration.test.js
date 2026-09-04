// tests/integration.test.js — the burst-test regression suite.
//
// WHY THIS FILE EXISTS. Measured on 2026-09-04: 12 concurrent analyses of one
// URL returned ZERO successes (7x HTTP 500, 5 timeouts). Every prior test in
// this repo fired exactly one request at a time, which is why the defect
// survived until the day before launch. These tests fire many.
//
// HOW. global.fetch is replaced with a counting stub, so "how many AI calls did
// we make" is directly observable. Without that counter, a cache that is read
// but never written looks identical to a working one -- and that exact bug was
// present in this codebase mid-refactor.

const assert = require('assert');
const handler = require('../api/deconstruct.js');
const { clear } = (() => { try { return require('../lib/cache.js'); } catch { return {}; } })();

const PAGE = '<html><head><style>:root{--color-primary:#123456}</style></head><body><h1 class="text-primary">Hi</h1></body></html>';
const SPEC = 'BUILD PROMPT\nRebuild example.com with #123456.\n\n## 1. Design Tokens\n\n| Token | Hex |\n|-------|-----|\n| primary | #123456 |\n';

let calls = { page: 0, ai: 0, css: 0 };
let aiStatus = 200;      // flip to 429 to simulate the saturated free tier
let aiDelay = 0;
let aiModels = [];       // which model each attempt asked for
let statusByModel = {};  // per-model status, to exercise the fallback chain

function installFetch() {
    global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/chat/completions') || u.includes('/v1/messages')) {
            calls.ai++;
            let askedModel = '';
            try { askedModel = JSON.parse(opts.body).model; } catch (_) {}
            aiModels.push(askedModel);
            if (aiDelay) await new Promise(r => setTimeout(r, aiDelay));
            const st = (askedModel in statusByModel) ? statusByModel[askedModel] : aiStatus;
            if (st === 401 || st === 403) {
                return { ok: false, status: st, headers: { get: () => null }, text: async () => 'unauthorized' };
            }
            if (st === 429) {
                return { ok: false, status: 429, headers: { get: () => '17' }, text: async () => 'slow down' };
            }
            return {
                ok: true, status: 200,
                json: async () => ({ choices: [{ message: { content: SPEC } }], content: [{ text: SPEC }] })
            };
        }
        if (/\.css(\?|$)/.test(u)) { calls.css++; return { ok: true, status: 200, headers: { get: (k) => k === 'content-type' ? 'text/css' : null }, text: async () => ':root{--color-primary:#123456}' }; }
        calls.page++;
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => PAGE };
    };
}

function mockRes() {
    const res = { statusCode: 0, body: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.end = () => res;
    return res;
}

function post(url, ip) {
    const req = { method: 'POST', headers: { 'x-forwarded-for': ip || '10.0.0.1' }, body: { url } };
    const res = mockRes();
    return handler(req, res).then(() => res);
}

const results = [];
function check(name, fn) {
    try { fn(); results.push([true, name, '']); }
    catch (e) { results.push([false, name, e.message]); }
}

(async () => {
    installFetch();
    process.env.OPENAI_API_KEY = 'test-key-aaaaaaaaaaaaaaaaaaaa';

    // ---- 1. the cache must actually be WRITTEN, not just read ----
    await post('https://example.com');
    check('first analysis makes exactly one AI call', () =>
        assert.strictEqual(calls.ai, 1, 'AI calls=' + calls.ai));

    calls = { page: 0, ai: 0, css: 0 };
    const second = await post('https://example.com');
    check('repeat analysis makes ZERO AI calls (cache is populated, not read-only)', () => {
        assert.strictEqual(calls.ai, 0, 'AI calls=' + calls.ai + ' -- cache never written');
        assert.strictEqual(second.statusCode, 200);
        assert.ok(second.body.cached === true, 'expected cached:true flag');
    });

    // ---- 2. the actual launch-day shape: N simultaneous duplicates ----
    calls = { page: 0, ai: 0, css: 0 };
    if (clear) clear();
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        post('https://vercel.com', '203.0.113.' + i)));   // distinct IPs: defeat the per-IP limiter, exercise coalescing
    const okCount = burst.filter(r => r.statusCode === 200).length;
    check('12 concurrent duplicates all succeed', () =>
        assert.strictEqual(okCount, 12, 'successes=' + okCount + ' of 12'));
    check('12 concurrent duplicates collapse to ONE AI call', () =>
        assert.strictEqual(calls.ai, 1, 'AI calls=' + calls.ai + ' (expected 1 via coalescing)'));

    // ---- 3. a saturated provider must not look like our outage ----
    calls = { page: 0, ai: 0, css: 0 };
    if (clear) clear();
    aiStatus = 429;
    const limited = await post('https://stripe.com');
    check('upstream 429 becomes HTTP 429, never 500', () =>
        assert.strictEqual(limited.statusCode, 429, 'got ' + limited.statusCode));
    check('429 carries a Retry-After the client can honour', () =>
        assert.ok(limited.headers['Retry-After'], 'no Retry-After header'));
    check('429 message tells the user what to do, not that we are broken', () =>
        assert.ok(/try again|own API key/i.test(limited.body.error), limited.body.error));
    aiStatus = 200;

    // ---- 4. failures must not be cached ----
    calls = { page: 0, ai: 0, css: 0 };
    if (clear) clear();
    aiStatus = 429;
    await post('https://github.com');
    aiStatus = 200;
    const after = await post('https://github.com');
    check('a failed analysis is not cached (next visitor gets a real attempt)', () => {
        assert.strictEqual(after.statusCode, 200, 'got ' + after.statusCode);
        assert.strictEqual(after.body.cached, false, 'served a cached failure');
    });

    // ---- 5. BYOK results must never leak to free-tier visitors ----
    calls = { page: 0, ai: 0, css: 0 };
    if (clear) clear();
    await post('https://news.ycombinator.com');
    const byokRes = await (() => {
        const req = { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.9' }, body: {
            url: 'https://news.ycombinator.com',
            byok: { provider: 'openai', model: 'gpt-5.2', key: 'sk-' + 'x'.repeat(40) }
        } };
        const res = mockRes();
        return handler(req, res).then(() => res);
    })();
    check('BYOK run is not served from the free-tier cache entry', () => {
        assert.strictEqual(byokRes.body.cached, false, 'BYOK reused a free-tier cached spec');
    });

    // ---- 6. free-tier fallback: primary saturated, spare model saves the run ----
    calls = { page: 0, ai: 0, css: 0 }; aiModels = []; statusByModel = {};
    if (clear) clear();
    process.env.OPENAI_MODEL = 'qwen3.8-flash';
    delete require.cache[require.resolve('../lib/ai.js')];   // CONFIG.MODEL is read at module load
    const freshHandler = (() => { delete require.cache[require.resolve('../api/deconstruct.js')]; return require('../api/deconstruct.js'); })();
    const postFresh = (url, ip) => {
        const req = { method: 'POST', headers: { 'x-forwarded-for': ip || '10.0.0.1' }, body: { url } };
        const res = mockRes();
        return freshHandler(req, res).then(() => res);
    };
    statusByModel['qwen3.8-flash'] = 429;      // primary bucket saturated
    statusByModel['glm-5.3-flash'] = 200;      // different bucket, still free
    const fb = await postFresh('https://fallback-test.example');
    check('free tier falls back to the second model and still returns 200', () => {
        assert.strictEqual(fb.statusCode, 200, 'got ' + fb.statusCode + ': ' + JSON.stringify(fb.body));
        assert.deepStrictEqual(aiModels, ['qwen3.8-flash', 'glm-5.3-flash'], 'attempted ' + JSON.stringify(aiModels));
    });

    // ---- 7. every free model saturated -> honest 429, never a 500 ----
    calls = { page: 0, ai: 0, css: 0 }; aiModels = []; statusByModel = {};
    if (clear) clear();
    aiStatus = 429;
    const allDead = await postFresh('https://all-busy.example');
    check('all free models 429 -> HTTP 429 (not 500)', () =>
        assert.strictEqual(allDead.statusCode, 429, 'got ' + allDead.statusCode));
    check('we tried more than one model before giving up', () =>
        assert.ok(aiModels.length >= 2, 'only tried ' + JSON.stringify(aiModels)));
    check('giving up still tells the user how to proceed', () =>
        assert.ok(/try again|own API key/i.test(allDead.body.error), allDead.body.error));
    aiStatus = 200; statusByModel = {};

    // ---- 8. BYOK must NEVER be silently swapped to another model ----
    calls = { page: 0, ai: 0, css: 0 }; aiModels = []; statusByModel = {};
    if (clear) clear();
    aiStatus = 429;
    const byokReq = { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.55' }, body: {
        url: 'https://byok-busy.example',
        byok: { provider: 'openai', model: 'gpt-5.2', key: 'sk-' + 'x'.repeat(40) }
    } };
    const byokRes2 = mockRes();
    await freshHandler(byokReq, byokRes2);
    check('BYOK 429 does NOT fall back to a different model', () => {
        assert.deepStrictEqual(aiModels, ['gpt-5.2'], 'attempted ' + JSON.stringify(aiModels) + ' -- silently changing a user-chosen model is a lie about provenance');
    });
    check('BYOK 429 returns 429 with Retry-After', () => {
        assert.strictEqual(byokRes2.statusCode, 429, 'got ' + byokRes2.statusCode);
        assert.ok(byokRes2.headers['Retry-After'], 'no Retry-After');
    });
    check('BYOK message is about THEIR key, not our queue', () => {
        assert.ok(/your ai provider|your key/i.test(byokRes2.body.error), byokRes2.body.error);
        assert.ok(!/our free/i.test(byokRes2.body.error), 'blamed our queue for the user\'s own quota');
    });
    aiStatus = 200;

    // ---- 9. OUR key being bad must never be reported as the visitor's fault.
    // Regression: a 401 from the relay threw ByokAuthError regardless of
    // whether the user had supplied a key, so an unconfigured or rotated
    // free-tier key made every visitor read "Your API key was rejected" about a
    // key they never entered.
    const reload = () => {
        delete require.cache[require.resolve('../lib/ai.js')];
        delete require.cache[require.resolve('../lib/cache.js')];
        delete require.cache[require.resolve('../api/deconstruct.js')];
        return require('../api/deconstruct.js');
    };
    const KEY = process.env.OPENAI_API_KEY;

    // 9a. key absent -> refuse before spending a network round trip
    process.env.OPENAI_API_KEY = '';
    calls = { page: 0, ai: 0, css: 0 };
    const noKeyH = reload();
    const noKey = await (() => {
        const res = mockRes();
        return noKeyH({ method: 'POST', headers: { 'x-forwarded-for': '10.0.0.71' }, body: { url: 'https://nokey.example' } }, res).then(() => res);
    })();
    check('missing free-tier key returns 503, not a 401 blaming the visitor', () =>
        assert.strictEqual(noKey.statusCode, 503, 'got ' + noKey.statusCode + ': ' + JSON.stringify(noKey.body)));
    check('missing key is caught before any AI request is made', () =>
        assert.strictEqual(calls.ai, 0, 'made ' + calls.ai + ' AI calls with no key configured'));
    check('missing-key message never mentions the visitor having a key', () => {
        assert.ok(!/your api key was rejected/i.test(noKey.body.error), noKey.body.error);
        assert.ok(/own api key/i.test(noKey.body.error), 'should offer BYOK as the way out: ' + noKey.body.error);
    });

    // 9b. key present but REJECTED by the provider (rotation / expiry)
    process.env.OPENAI_API_KEY = KEY;
    calls = { page: 0, ai: 0, css: 0 }; aiStatus = 401;
    const rejH = reload();
    const rejected = await (() => {
        const res = mockRes();
        return rejH({ method: 'POST', headers: { 'x-forwarded-for': '10.0.0.72' }, body: { url: 'https://rejected.example' } }, res).then(() => res);
    })();
    check('provider 401 on the FREE tier becomes 503, not 401', () =>
        assert.strictEqual(rejected.statusCode, 503, 'got ' + rejected.statusCode + ': ' + JSON.stringify(rejected.body)));
    check('free-tier 401 does not tell the visitor their key was rejected', () =>
        assert.ok(!/your api key was rejected/i.test(rejected.body.error), rejected.body.error));
    aiStatus = 200;

    // 9c. a genuine BYOK 401 must STILL be a 401 about their key -- the fix
    // must not swallow the case it was originally written for.
    calls = { page: 0, ai: 0, css: 0 }; aiStatus = 401;
    const byokBad = await (() => {
        const res = mockRes();
        return rejH({ method: 'POST', headers: { 'x-forwarded-for': '10.0.0.73' }, body: {
            url: 'https://byok-bad.example',
            byok: { provider: 'openai', model: 'gpt-5.2', key: 'sk-bad-' + 'y'.repeat(36) }
        } }, res).then(() => res);
    })();
    check('BYOK 401 still returns 401 about THEIR key', () => {
        assert.strictEqual(byokBad.statusCode, 401, 'got ' + byokBad.statusCode);
        assert.ok(/your api key was rejected/i.test(byokBad.body.error), byokBad.body.error);
    });
    aiStatus = 200;
    process.env.OPENAI_API_KEY = KEY;

    let failed = 0;
    for (const [ok, name, msg] of results) {
        console.log((ok ? '  ok  ' : ' FAIL ') + name + (ok ? '' : '  <-- ' + msg));
        if (!ok) failed++;
    }
    console.log('\n' + (results.length - failed) + '/' + results.length + ' integration tests passed');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e && e.stack || e); process.exit(1); });
