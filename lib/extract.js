// lib/extract.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.

const cheerio = require('cheerio');

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
        if (!isFlex && !isGrid) return;
        const found = { display, flex: flexDir, grid: gridCols, max: maxW, pad: padding };
        const real = Object.entries(found).filter(([, v]) => v && v !== 'none' && v !== 'inherit');
        if (!real.length) return;
        layouts.push(`${tag}.${(className.split(' ')[0] || '')} { ${real.map(([k, v]) => k + ':' + String(v).replace(/\s+/g, ' ').slice(0, 40)).join('; ')} }`);
    });

    return layouts.slice(0, 15);
}


// Why this exists: the model was handed the first 2,500 chars of the document,
// which on a real site is entirely <head> markup - meta tags, font preloads,
// link rel=stylesheet. On tailwindcss.com <body> begins at char 8,707, so the
// model saw 0% of the page and was asked to describe it in detail. It guessed
// "dark-mode docs site" from colour tokens and invented the rest.
//
// This walks the BODY and emits what a human would call the page: its headings
// in DOM order, the words on its nav links and buttons, its copy, and element
// counts (counts matter - they are how you tell a 3-card grid from a 12-item
// list, which no amount of token data will tell you).
// Why this exists: the body excerpt shows classes verbatim, and on Tailwind
// sites that means "bg-white dark:bg-gray-950" appears on one line. qwen read
// the dark: half and reported the whole site as dark-mode with a gray-950
// background - wrong on both counts, and the error then propagated into every
// component spec. The evidence to settle it is in the document shell, not in
// the token list, so compute it once and state it plainly.
function detectDefaultTheme($, css) {
    const cls = (($('html').attr('class') || '') + ' ' + ($('body').attr('class') || '')).trim();
    const tokens = cls.split(/\s+/).filter(Boolean);
    const bare = (t) => tokens.indexOf(t) !== -1;
    const darkVariants = tokens.filter(c => /^dark:/.test(c)).length;
    const lightVariants = tokens.filter(c => /^light:/.test(c)).length;

    const meta = ($('meta[name="color-scheme"]').attr('content') || '').toLowerCase();
    const cssText = String(css || '');
    const schemeDark = /color-scheme\s*:\s*[^;}]*dark/.test(cssText);
    const schemeLightOnly = /color-scheme\s*:\s*light\s*[;}]/.test(cssText);
    const prefersDark = /@media[^{]*\(\s*prefers-color-scheme\s*:\s*dark/i.test(cssText);

    let theme;
    if (bare('dark') || meta === 'dark') theme = 'dark';
    else if (bare('light') || meta === 'light') theme = 'light';
    else if (schemeDark && !schemeLightOnly && !prefersDark) theme = 'dark';
    else theme = 'light';

    const parts = ['Default theme: ' + theme];
    if (bare('dark')) parts.push('<html>/<body> carries the bare "dark" class');
    else if (darkVariants) parts.push(darkVariants + ' dark:-variant utilities present but no dark class on <html>, so they apply only when the visitor opts into dark mode');
    if (lightVariants) parts.push(lightVariants + ' light:-variant utilities');
    if (prefersDark) parts.push('a prefers-color-scheme: dark block exists, so the alternate theme may follow the OS rather than a class');
    return parts.join(' — ') + '.';
}


const OUTLINE_BUDGET = 2600;

function extractPageOutline($, css) {
    const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const lines = [];
    let used = 0;

    // Dedupe + cap per group: sites repeat headings across cards, and one
    // unbounded group would starve every group after it.
    const push = (label, items, max) => {
        const seen = new Set();
        const list = [];
        for (const raw of items) {
            const t = clean(raw);
            if (!t || t.length > 180 || seen.has(t)) continue;
            seen.add(t);
            list.push(t);
            if (list.length >= max) break;
        }
        if (!list.length) return;
        const line = `${label}: ${list.join(' | ')}`;
        if (used + line.length > OUTLINE_BUDGET) return;
        used += line.length;
        lines.push(line);
    };

    // Theme first: it is one line and it corrects a whole-spec misreading.
    const themeLine = detectDefaultTheme($, css);
    if (themeLine) { lines.push(themeLine); used += themeLine.length; }

    const meta = [];
    const t = $('title').first().text();
    if (t) meta.push(t);
    const d = $('meta[name="description"]').attr('content')
        || $('meta[property="og:description"]').attr('content');
    if (d) meta.push(d);
    push('Title / description', meta, 2);

    const headings = [];
    $('h1, h2, h3').each((_, el) => {
        const tag = String(el.tagName || '').toUpperCase();
        const txt = clean($(el).text());
        if (txt) headings.push(`${tag} ${txt}`);
    });
    push('Headings in DOM order', headings, 24);

    const nav = [];
    $('nav a, header a, [role="navigation"] a').each((_, el) => nav.push($(el).text()));
    push('Navigation labels', nav, 20);

    const cta = [];
    $('button, [role="button"], a[class*="btn"], a[class*="button"], input[type="submit"]').each((_, el) => {
        cta.push($(el).text() || $(el).val() || $(el).attr('aria-label'));
    });
    push('Buttons / calls to action', cta, 16);

    const paras = [];
    $('main p, article p, section p').each((_, el) => {
        const txt = clean($(el).text());
        if (txt.length > 40) paras.push(txt.slice(0, 180));
    });
    push('Body copy', paras, 10);

    const fields = [];
    $('input, textarea, select').each((_, el) => {
        fields.push($(el).attr('placeholder') || $(el).attr('name') || $(el).attr('aria-label'));
    });
    push('Form fields', fields, 14);

    const foot = [];
    $('footer a').each((_, el) => foot.push($(el).text()));
    push('Footer links', foot, 16);

    const counts = [];
    [['sections', $('section').length], ['cards', $('[class*="card"]').length],
     ['links', $('a').length], ['images', $('img').length],
     ['buttons', $('button').length], ['forms', $('form').length],
     ['lists', $('ul, ol').length], ['videos', $('video, iframe').length]
    ].forEach(([k, n]) => { if (n) counts.push(`${n} ${k}`); });
    push('Element counts', counts, 99);

    return lines.join('\n');
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

        // Only worth a line if at least one value actually resolved. On a
        // class-based site every one of these is '' (cheerio cannot compute
        // styles), and emitting "button.x { radius:; pad:; }" teaches the model
        // that the site is undetectable when it simply uses stylesheets.
        const found = { radius: borderRadius, pad: padding, bg, color, border, shadow: boxShadow };
        const real = Object.entries(found).filter(([, v]) => v && v !== 'none' && v !== 'inherit');
        if (!real.length) return;
        components.push(`${tag}${className ? '.' + className.split(' ')[0] : ''} { ${real.map(([k, v]) => k + ':' + v).join('; ')} }`);
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

// ============================================================
// REAL CSS EXTRACTION
// cheerio has no computed-style engine (it is a parser, not a browser),
// so $(el).css() only ever sees inline style="" attributes. Modern sites
// put every value in EXTERNAL stylesheets (Tailwind v4: @theme tokens),
// which we never fetched — hence "not detectable". Fix: fetch + mine them.
// ============================================================

// Which utility classes does the page ACTUALLY use? This is what turns a
// 690KB Tailwind palette into the ~15 colours the site really displays.
function collectUsedClasses($) {
    const set = new Set();
    $('[class]').each((_, el) => {
        const c = (el.attribs && el.attribs.class) || '';
        c.split(/\s+/).forEach(x => { if (x) set.add(x); });
    });
    return set;
}


module.exports = { collectUsedClasses, detectDefaultTheme, extractColors, extractComponents, extractInlineStyles, extractLayout, extractPageOutline, extractResponsive, extractStyles, extractTypography, stripStyles };
