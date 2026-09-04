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

const { ByokAuthError, callAI, normalizeByok } = require('../lib/ai.js');
const { BROWSER_UA, BlockedUrlError, extractDomain, safeFetch, sanitizeUrl } = require('../lib/net.js');
const { buildAnalysisPrompt } = require('../lib/pipeline.js');
const { SYSTEM_PROMPT, USER_PROMPT } = require('../lib/prompts.js');
const { RATE_LIMIT, getClientIp, rateLimit } = require('../lib/rate.js');

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

