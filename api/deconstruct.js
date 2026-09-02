/**
 * uidconstruct — Backend API
 * ----------------------------------------
 * Extracts visual specs from any website URL.
 *
 * Setup:
 *   1. npm install express node-fetch@2 cheerio cors
 *   2. Add your API key in the CONFIG section below
 *   3. node api/deconstruct.js
 *   4. Update API_ENDPOINT in app.js to point to this server
 *
 * API:
 *   POST /api/deconstruct
 *   Body: { url: "https://example.com" }
 *   Returns: { url, domain, prompt, raw }
 */

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ============================================================
// CONFIG — paste your custom API key here
// ============================================================
const CONFIG = {
    // API key
    API_KEY: process.env.OPENAI_API_KEY || process.env.UID_API_KEY || 'YOUR_CUSTOM_API_KEY_HERE',

    // Custom base URL (for OpenAI-compatible providers)
    BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',

    // Model to use
    MODEL: process.env.OPENAI_MODEL || process.env.UID_MODEL || 'gpt-4o-mini',

    // Which provider: 'openai' | 'anthropic' | 'html-extract'
    PROVIDER: process.env.UID_PROVIDER || 'openai',

    // Request timeout
    TIMEOUT_MS: 15000
};

// ============================================================
// UTILITIES
// ============================================================
function extractDomain(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

function rgbToHex(rgb) {
    if (!rgb) return null;
    const match = rgb.match(/\d+/g);
    if (!match || match.length < 3) return null;
    const [r, g, b] = match.slice(0, 3).map(Number);
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function isValidUrl(string) {
    try {
        const u = new URL(string);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

// ============================================================
// HTML EXTRACTION — no external API needed (default fallback)
// ============================================================
function extractStyles(html) {
    const $ = cheerio.load(html);
    const signals = {
        colors: new Set(),
        fontFamilies: new Set(),
        fontSizes: new Set(),
        borderRadii: new Set(),
        maxWidths: new Set()
    };

    // Inline styles
    $('[style]').each((_, el) => {
        const style = $(el).attr('style') || '';
        const colorMatch = style.match(/color:\s*([^;]+)/i);
        const bgMatch = style.match(/background-color:\s*([^;]+)/i);
        const fontMatch = style.match(/font-family:\s*([^;]+)/i);
        if (colorMatch) signals.colors.add(rgbToHex(colorMatch[1]) || colorMatch[1].trim());
        if (bgMatch) signals.colors.add(rgbToHex(bgMatch[1]) || bgMatch[1].trim());
        if (fontMatch) signals.fontFamilies.add(fontMatch[1].trim());
    });

    // <style> blocks
    $('style').each((_, el) => {
        const css = $(el).html() || '';
        const colorMatches = css.match(/#[0-9a-f]{3,6}\b/gi) || [];
        colorMatches.forEach(c => signals.colors.add(c.toUpperCase()));
        const rgbMatches = css.match(/rgb\([^)]+\)/gi) || [];
        rgbMatches.forEach(c => signals.colors.add(rgbToHex(c) || c));
        const fontMatches = css.match(/font-family:\s*([^;}]+)/gi) || [];
        fontMatches.forEach(f => {
            const family = f.replace(/font-family:\s*/i, '').trim();
            signals.fontFamilies.add(family);
        });
        const radiusMatches = css.match(/border-radius:\s*([^;}]+)/gi) || [];
        radiusMatches.forEach(r => {
            const val = r.replace(/border-radius:\s*/i, '').trim();
            if (val !== '0' && val !== '50%') signals.borderRadii.add(val);
        });
        const maxWidthMatches = css.match(/max-width:\s*([^;}]+)/gi) || [];
        maxWidthMatches.forEach(m => {
            const val = m.replace(/max-width:\s*/i, '').trim();
            signals.maxWidths.add(val);
        });
    });

    // Meta theme color
    $('meta[name="theme-color"]').each((_, el) => {
        const c = $(el).attr('content');
        if (c) signals.colors.add(c);
    });

    // Title
    const title = $('title').text() || '';

    return {
        title,
        colors: [...signals.colors].filter(Boolean).slice(0, 8),
        fontFamilies: [...signals.fontFamilies].filter(Boolean).slice(0, 5),
        borderRadii: [...signals.borderRadii].filter(Boolean).slice(0, 5),
        maxWidths: [...signals.maxWidths].filter(Boolean).slice(0, 5)
    };
}

function buildPrompt(spec, url) {
    const domain = extractDomain(url);
    const colors = spec.colors.length
        ? spec.colors.slice(0, 4).join(', ')
        : 'background #0A0A0A, surface #111111, primary #5E6AD2';
    const fonts = spec.fontFamilies.length
        ? spec.fontFamilies[0].replace(/['"]/g, '').split(',')[0].trim()
        : 'Inter';
    const radius = spec.borderRadii[0] || '8px';
    const maxW = spec.maxWidths[0] || '1200px';

    return `"Replicate the UI of ${domain} with:\n\n` +
        `• Layout: 12‑column grid, 24px gutters, max‑width ${maxW}\n` +
        `• Colors: ${colors}\n` +
        `• Typography: ${fonts}, 14px base, 24px line‑height\n` +
        `• Components: ${radius} radius, 1px subtle borders\n` +
        `• Navigation: fixed top, transparent, backdrop blur on scroll\n` +
        `• Responsive: sidebar collapses below 768px`;
}

// ============================================================
// AI PROVIDER (optional — for richer prompts)
// ============================================================
async function callOpenAI(url, spec) {
    const prompt = `Analyze the website ${url} and produce a concise UI build spec (max 200 words) covering layout, colors, typography, components, navigation, and responsive behavior. Use bullet points.`;
    const endpoint = `${CONFIG.BASE_URL.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.API_KEY}`
        },
        body: JSON.stringify({
            model: CONFIG.MODEL,
            messages: [
                { role: 'system', content: 'You are a UI design analyst. Output concise, actionable build specs.' },
                { role: 'user', content: prompt }
            ],
            max_tokens: 400,
            temperature: 0.3
        })
    });
    if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
    const data = await res.json();
    return data.choices[0].message.content.trim();
}

async function callAnthropic(url, spec) {
    const prompt = `Analyze the website ${url} and produce a concise UI build spec (max 200 words) covering layout, colors, typography, components, navigation, and responsive behavior. Use bullet points.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': CONFIG.API_KEY,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 400,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);
    const data = await res.json();
    return data.content[0].text.trim();
}

// ============================================================
// ROUTES
// ============================================================
app.post('/api/deconstruct', async (req, res) => {
    const { url } = req.body || {};

    if (!url || !isValidUrl(url)) {
        return res.status(400).json({ error: 'Please provide a valid http(s) URL' });
    }

    try {
        // Fetch the target page
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);

        const pageRes = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 uidconstruct/2.2'
            }
        });
        clearTimeout(timeout);

        if (!pageRes.ok) {
            return res.status(502).json({ error: `Failed to fetch page: ${pageRes.status}` });
        }

        const html = await pageRes.text();
        const spec = extractStyles(html);

        // Generate the prompt
        let prompt;
        const hasApiKey = CONFIG.API_KEY && CONFIG.API_KEY !== 'YOUR_CUSTOM_API_KEY_HERE';

        if (CONFIG.PROVIDER === 'openai' && hasApiKey) {
            try {
                prompt = await callOpenAI(url, spec);
            } catch (e) {
                console.warn('AI fallback:', e.message);
                prompt = buildPrompt(spec, url);
            }
        } else if (CONFIG.PROVIDER === 'anthropic' && hasApiKey) {
            try {
                prompt = await callAnthropic(url, spec);
            } catch (e) {
                console.warn('AI fallback:', e.message);
                prompt = buildPrompt(spec, url);
            }
        } else {
            prompt = buildPrompt(spec, url);
        }

        res.json({
            url,
            domain: extractDomain(url),
            prompt,
            spec
        });

    } catch (err) {
        console.error(err);
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'Request timed out' });
        }
        res.status(500).json({ error: err.message || 'Internal error' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '2.2' });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`uidconstruct API running on http://localhost:${PORT}`);
    console.log(`Provider: ${CONFIG.PROVIDER}`);
    console.log(`Model: ${CONFIG.MODEL}`);
    console.log(`Base URL: ${CONFIG.BASE_URL}`);
    console.log(`API key: ${CONFIG.API_KEY === 'YOUR_CUSTOM_API_KEY_HERE' ? '⚠️  not set' : '✓ loaded'}`);
});
