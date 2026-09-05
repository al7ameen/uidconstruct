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

const { ByokAuthError, FreeTierUnavailableError, ProviderRateLimitError, callAIWithFallback, diagnoseByok, normalizeByok } = require('../lib/ai.js');
const { BROWSER_UA, BlockedUrlError, extractDomain, safeFetch, sanitizeUrl } = require('../lib/net.js');
const { CssUnavailableError } = require('../lib/css.js');
const { buildAnalysisPrompt } = require('../lib/pipeline.js');
const { SYSTEM_PROMPT, USER_PROMPT } = require('../lib/prompts.js');
const { RATE_LIMIT, getClientIp, rateLimit } = require('../lib/rate.js');
const { cacheKey, get: cacheGet, remember } = require('../lib/cache.js');
const { GateFullError, stats: gateStats, withAiGate } = require('../lib/gate.js');

// An expected, already-explained upstream failure that must reach the client
// with its original status. Thrown from inside the cached producer so that
// remember() never stores a failure — a 504 from a slow site must not be
// served to the next visitor for six hours.
class UpstreamError extends Error {
    constructor(status, message, retryAfterSec) {
        super(message);
        this.name = 'UpstreamError';
        this.status = status;
        this.retryAfterSec = retryAfterSec;
    }
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
    // If a key WAS entered but rejected, say so. Without this the request
    // silently becomes a free-tier run and the user believes their key worked.
    // Computed per request and deliberately NOT stored in the cache: the cache
    // key for a rejected BYOK is the free-tier key, so a warning inside the
    // cached value would be served to people who never touched the panel.
    const byokWarning = byok ? null : diagnoseByok(byokRaw);

    if (!url) {
        return res.status(400).json({ error: 'Missing "url" in request body.' });
    }

    const cleanUrl = sanitizeUrl(url);
    if (!cleanUrl) {
        return res.status(400).json({ error: 'That does not look like a website address. Try something like example.com' });
    }

    // A cached spec costs no fetch and no AI call, so it does not spend one of
    // the 10 free hourly analyses. Checked BEFORE the limiter for that reason:
    // re-reading a result you already generated is not new usage.
    const key = cacheKey(cleanUrl, byok);
    const cached = cacheGet(key);
    if (cached) {
        console.log('cache:', JSON.stringify({ domain: extractDomain(cleanUrl), source: 'hit' }));
        return res.status(200).json({ ...cached, cached: true, ...(byokWarning ? { byokWarning } : {}) });
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

    // Hard budget for everything downstream. maxDuration is 60s; stopping at 50s
    // leaves room to serialise and send a real 429 rather than being killed by
    // the platform, which is what turns a rate limit into an opaque 500.
    const AI_DEADLINE_AT = timings.start + Number(process.env.AI_DEADLINE_MS || 50000);

    // One analysis per URL, not one per request. remember() serves a stored spec
    // or awaits the in-flight attempt started by a concurrent duplicate -- which
    // is precisely the case that killed the burst test: 12 requests, 12 full AI
    // calls, 12 failures. Producers throw rather than return, so a failure is
    // never stored and a slow site cannot poison a URL for the whole TTL.
    let result;
    try {
        result = await remember(key, () => analyse(cleanUrl, domain, byok, timings, AI_DEADLINE_AT));
    } catch (err) {
        // Expected upstream conditions, mapped to their real status instead of
        // collapsing into 500. A 500 reads to a user as "uidconstruct is down",
        // which is both untrue and the worst message available on launch day.
        if (err instanceof UpstreamError) {
            return res.status(err.status).json({ error: err.message });
        }
        if (err instanceof ProviderRateLimitError) {
            const secs = err.retryAfterSec || 30;
            res.setHeader('Retry-After', String(secs));
            return res.status(429).json({ error: err.message, retryAfterSec: secs });
        }
        if (err instanceof GateFullError) {
            // The one number that decides the launch: how many visitors did we
            // refuse, and how deep was the queue when we did? The perf log cannot
            // show this because a refused request never reaches it.
            console.log('queue_full:', JSON.stringify({ domain, gate: gateStats(), retryAfterSec: err.retryAfterSec }));
            // We declined to ask rather than join a losing queue. Same status as
            // a provider 429 because the user action is identical: wait, or BYOK.
            res.setHeader('Retry-After', String(err.retryAfterSec));
            return res.status(429).json({ error: err.message, retryAfterSec: err.retryAfterSec });
        }
        if (err instanceof FreeTierUnavailableError) {
            // Our outage, not the visitor's mistake. 503 rather than 401 so the
            // message matches reality and nobody goes looking for a key they
            // never entered. Loud on stderr so it pages us, not them.
            console.error('FREE_TIER_OUTAGE:', JSON.stringify({ domain }));
            return res.status(503).json({ error: err.message });
        }
        if (err instanceof ByokAuthError) {
            return res.status(401).json({ error: err.message });
        }
        if (err instanceof CssUnavailableError) {
            // The page loaded fine; only its stylesheets eluded us. 502 because the
            // upstream (the site's CDN) is what failed us, with Retry-After because
            // the correct user action is to try again rather than pick another URL.
            // Logged loudly: before this, this exact condition returned HTTP 200
            // with a confident-looking empty spec, so we had no way to count it.
            console.error('CSS_UNAVAILABLE:', JSON.stringify({ domain, ...(err.status || {}) }));
            res.setHeader('Retry-After', '15');
            return res.status(502).json({ error: err.message, retryAfterSec: 15 });
        }
        if (err && err.name === 'TimeoutError') {
            // Reaching here means the MODEL ran out of time, not the site: the
            // page fetch has its own deadline and maps to UpstreamError above.
            // The old copy said "use a faster site", which sent users to fix the
            // wrong thing -- measured 2026-09-04, example.com analyzes in 17.3s
            // on the free tier but exceeds 55s through BYOK, because the BYOK
            // path omits reasoning_effort:'low' (non-reasoning models hard-400
            // on it) and so runs a reasoning model at full effort. The cause is
            // the model the user chose, and only they can change it.
            const secs = Math.round((Number(process.env.AI_DEADLINE_MS || 50000)) / 1000);
            return res.status(504).json({
                error: byok
                    ? 'Your model (' + byok.model + ') did not answer within ' + secs + 's. Reasoning models often need longer than this -- try a faster model, or leave the key fields empty to use the free tier.'
                    : 'Our AI did not finish within ' + secs + 's. The page may be very large, or the free queue is congested. Try again, or add your own API key for a dedicated run.'
            });
        }
        console.error('Deconstruct error:', err && err.message, JSON.stringify(timings || {}));
        return res.status(500).json({ error: (err && err.message) || 'Internal server error.' });
    }

    console.log('perf:', JSON.stringify({ domain, source: result.source, byok: byok ? byok.provider : 'free', ...timings, totalMs: Date.now() - timings.start }));
    return res.status(200).json({ ...result.value, cached: result.source !== 'miss', ...(byokWarning ? { byokWarning } : {}) });
};

// The work itself. Kept out of the handler so the handler's only job is status
// mapping, and so the cached unit is exactly one completed analysis payload.
async function analyse(cleanUrl, domain, byok, timings, deadlineAt) {

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
            signal: AbortSignal.timeout(Math.min(10000, Math.max(2000, deadlineAt - timings.start - 8000)))
        });
    } catch (fetchErr) {
        if (fetchErr instanceof BlockedUrlError) {
            throw new UpstreamError(400, 'That URL resolves to a private or internal address, which is not allowed.');
        }
        const isTimeout = fetchErr.name === 'TimeoutError' || /abort|timeout/i.test(String(fetchErr.message));
        throw new UpstreamError(504, isTimeout
            ? 'That site took too long to respond. It may be down or blocking automated access. Try another URL.'
            : 'Could not reach that site. Check the URL and try again.');
    }

    if (!pageRes.ok) {
        const status = pageRes.status;
        const friendly = {
            401: 'That page requires a login, so it can\'t be analyzed. Try a public page.',
            403: 'That site blocks automated analysis. Try a different page on the same site.',
            404: 'Page not found -- check the URL for typos.',
            429: 'That site is rate-limiting us right now. Try again in a few minutes.',
            999: 'That site blocks automated analysis (LinkedIn-style protection).'
        }[status] || `The site responded with an error (HTTP ${status}). Try another URL.`;
        throw new UpstreamError(502, friendly);
    }

    // The body read is a SEPARATE await from the request that produced it:
    // safeFetch's try/catch covers headers only. If the site stalls mid-body,
    // the abort surfaces here -- and without its own handler it falls through
    // to the AI-timeout branch below, blaming our model for the site's delay.
    let html;
    try {
        html = await pageRes.text();
    } catch (bodyErr) {
        const bodyTimeout = bodyErr && (bodyErr.name === 'TimeoutError'
            || /abort|timeout/i.test(String(bodyErr.message)));
        throw new UpstreamError(504, bodyTimeout
            ? 'The site started responding but stalled partway through. It may be throttling automated access. Try another URL.'
            : 'Could not read that page. Check the URL and try again.');
    }
    timings.fetchMs = Date.now() - timings.start;
    const $ = cheerio.load(html);

    // 2. Build analysis data
    const analysis = await buildAnalysisPrompt(html, $, cleanUrl, domain);

    // 3. Call AI
    const prompt = USER_PROMPT(analysis);
    const tAI0 = Date.now();
    // Gated, and only the AI call is inside the gate: fetching a page is cheap
    // and does not touch the rate-limited resource, so holding the slot across
    // it would make the queue longer for no benefit.
    const aiResponse = await withAiGate(() => callAIWithFallback([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
    ], byok, { deadlineAt }), { bypass: !!byok });
    timings.aiMs = Date.now() - tAI0;
    timings.aiChars = aiResponse.length;

    return {
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
    };
}

// Allow up to 60s on Vercel (reasoning models are slow)
module.exports.maxDuration = 60;

