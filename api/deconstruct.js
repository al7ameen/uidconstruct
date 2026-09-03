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
    TIMEOUT_MS: 50000
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

function sanitizeUrl(url) {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('Invalid protocol');
        }
        return parsed.href;
    } catch {
        return null;
    }
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
        const display = $el.css('display');
        const flexDir = $el.css('flex-direction');
        const gridCols = $el.css('grid-template-columns');
        const maxW = $el.css('max-width');
        const padding = $el.css('padding');
        const margin = $el.css('margin');

        if (display === 'flex' || display === 'grid' || display.includes('flex') || gridCols !== 'none') {
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
        const borderRadius = $el.css('border-radius');
        const padding = $el.css('padding');
        const bg = $el.css('background-color');
        const color = $el.css('color');
        const border = $el.css('border');
        const boxShadow = $el.css('box-shadow');

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
    const cleanHtml = stripStyles(html).substring(0, 3000);

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
        cssStyles: styles.substring(0, 5000)
    };
}

const SYSTEM_PROMPT = `You are a senior UI/UX engineer and design system expert. Given raw HTML, CSS, and extracted design data from a website, produce an exhaustive, pixel-perfect UI specification that any AI coding assistant (Cursor, v0, Bolt, Claude Code) can use to rebuild the UI 1:1.

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

Be exhaustive. Include every pixel value, hex code, and CSS property found. The goal is that someone copying this spec into Cursor or v0 should be able to reproduce the UI accurately.`;
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

    const domain = extractDomain(cleanUrl);

    try {
        // 1. Fetch the target page
        const pageRes = await fetch(cleanUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; UIDConstruct/1.0)',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 10000
        });

        if (!pageRes.ok) {
            return res.status(502).json({ error: `Failed to fetch URL (status ${pageRes.status}). The site may be blocking requests.` });
        }

        const html = await pageRes.text();
        const $ = cheerio.load(html);

        // 2. Build analysis data
        const analysis = buildAnalysisPrompt(html, $, cleanUrl, domain);

        // 3. Call AI
        const prompt = USER_PROMPT(analysis);

        const aiResponse = await callAI([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
        ]);

        // 4. Return result
        return res.status(200).json({
            url: cleanUrl,
            domain,
            prompt: aiResponse,
            signals: analysis.extracted
        });

    } catch (err) {
        console.error('Deconstruct error:', err.message);
        return res.status(500).json({ error: err.message || 'Internal server error.' });
    }
};

// Allow up to 60s on Vercel (reasoning models are slow)
module.exports.maxDuration = 60;
