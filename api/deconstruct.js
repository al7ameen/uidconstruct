/**
 * uidconstruct — Vercel Serverless API
 * ----------------------------------------
 * Extracts visual specs from any website URL.
 *
 * Environment variables (set in Vercel dashboard):
 *   OPENAI_API_KEY   — your API key
 *   OPENAI_BASE_URL  — custom endpoint (e.g. https://api.b.ai/v1)
 *   OPENAI_MODEL     — model name (e.g. glm-5.3-flash)
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
    MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    TIMEOUT_MS: 52000
};

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

function sanitizeUrl(url) {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        if (parsed.username || parsed.password) return null;                 // no embedded credentials
        if (isPrivateHost(parsed.hostname)) return null;                     // SSRF guard
        return parsed.href;
    } catch {
        return null;
    }
}

// ============================================================
// RATE LIMIT — per-IP, in-memory (resets on cold start; burst guard)
// ============================================================
const RATE_LIMIT = 10;          // requests
const RATE_WINDOW_MS = 3600e3;  // per hour
const hits = new Map();         // ip -> [timestamps]

function rateLimit(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return false; }
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
            if (isFlex || isGrid) {
            layouts.push(`${tag}.${className.split(' ')[0]} { display:${display}; flex:${flexDir || 'row'}; grid:${gridCols !== 'none' ? gridCols : 'none'}; max:${maxW}; pad:${padding}; }`);
        }
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

        components.push(`${tag}${className ? '.' + className.split(' ')[0] : ''} { radius:${borderRadius}; pad:${padding}; bg:${bg}; color:${color}; border:${border}; shadow:${boxShadow} }`);
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

function buildAnalysisPrompt(html, $, url, domain) {
    const styles = extractStyles($);
    const inlineStyles = extractInlineStyles($);
    const typography = extractTypography($);
    const colors = extractColors($);
    const layouts = extractLayout($);
    const components = extractComponents($);
    const responsive = extractResponsive($);
    const cleanHtml = stripStyles(html).substring(0, 2500);

    return {
        domain,
        url,
        extracted: {
            fonts: typography.fonts,
            fontSizes: typography.sizes,
            colors: colors.slice(0, 20),
            layoutPatterns: layouts,
            componentPatterns: components,
            responsiveBreakpoints: responsive
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

HARD LIMIT: 500 words. Be maximally dense — compact lines, tables over prose, no filler, no explanations. Include every distinct hex code, px value and font size found, but state each once. Priority order: design tokens > layout > components > interactions. If something is not detectable, write 'not detectable' in 2 words — never guess at length. A developer copying this into Cursor or v0 must be able to rebuild the UI accurately.`;
const USER_PROMPT = (data) => `Analyze this website and produce a detailed UI specification.

Website URL: ${data.url}
Domain: ${data.domain}

## Extracted Design Data

### Typography:
Fonts: ${data.extracted.fonts.join(', ') || 'Not detected'}
Font Sizes: ${data.extracted.fontSizes.slice(0, 10).join(', ') || 'Not detected'}

### Colors Found: ${data.extracted.colors.join(', ') || 'Not detected'}

### Layout Patterns:
${data.extracted.layoutPatterns.join('\n') || 'Not detected'}

### Component Patterns:
${data.extracted.componentPatterns.join('\n') || 'Not detected'}

### Responsive Breakpoints:
${data.extracted.responsiveBreakpoints.join('\n') || 'Not detected'}

### Raw HTML Structure (first 3000 chars):
${data.rawHtml}

### CSS Styles (first 5000 chars):
${data.cssStyles}

Please produce the full specification following the format above. Be thorough and include every design detail you can extract.`;

// ============================================================
// MAIN HANDLER
// ============================================================
async function callAI(messages) {
    const url = `${CONFIG.BASE_URL}/chat/completions`;
    const body = {
        model: CONFIG.MODEL,
        messages,
        temperature: 0.3,
        reasoning_effort: 'low',
        max_tokens: 8000
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.API_KEY}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONFIG.TIMEOUT_MS)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AI API error ${res.status}: ${text}`);
    }

    const data = await res.json();
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

    const { url } = req.body || {};

    if (!url) {
        return res.status(400).json({ error: 'Missing "url" in request body.' });
    }

    const cleanUrl = sanitizeUrl(url);
    if (!cleanUrl) {
        return res.status(400).json({ error: 'Invalid URL. Must start with http:// or https://' });
    }

    if (!rateLimit(getClientIp(req))) {
            return res.status(429).json({ error: "Hourly limit reached (10 analyses). Try again later." });
        }

        const domain = extractDomain(cleanUrl);

    try {
        const timings = { start: Date.now(), fetchMs: 0, aiMs: 0, aiChars: 0 };

        // 1. Fetch the target page
        // Browser-like UA: many sites (and CDNs) block non-browser agents outright
        let pageRes;
        try {
            pageRes = await fetch(cleanUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                signal: AbortSignal.timeout(10000),
                redirect: 'follow'
            });
        } catch (fetchErr) {
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
        const analysis = buildAnalysisPrompt(html, $, cleanUrl, domain);

        // 3. Call AI
        const prompt = USER_PROMPT(analysis);

        const tAI0 = Date.now();
        const aiResponse = await callAI([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
        ]);
        timings.aiMs = Date.now() - tAI0;
        timings.aiChars = aiResponse.length;
        console.log('perf:', JSON.stringify({ domain, ...timings, totalMs: Date.now() - timings.start }));

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
        console.error('Deconstruct error:', err.message, JSON.stringify(timings || {}));
        return res.status(500).json({ error: (err && err.name === 'TimeoutError') ? 'The website or AI took too long to respond (60s). Please try again or use a faster site.' : (err.message || 'Internal server error.') });
    }
};

// Allow up to 60s on Vercel (reasoning models are slow)
module.exports.maxDuration = 60;
