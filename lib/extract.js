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


module.exports = { collectUsedClasses, extractColors, extractComponents, extractInlineStyles, extractLayout, extractResponsive, extractStyles, extractTypography, stripStyles };
