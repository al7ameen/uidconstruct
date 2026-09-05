// lib/gen-specs.js — build-time generator for the static /specs/* library.
//
// WHY THIS EXISTS AND WHY IT COSTS NOTHING
// Every page here is produced by buildAnalysisPrompt(), which is pure cheerio +
// regex over the target's own stylesheets. There is NO AI CALL IN THIS PATH.
// That is the whole point: 25 pages cost zero tokens, cannot 429, are
// deterministic, and regenerate in seconds. The AI-generated prose spec stays
// behind the live tool; what we publish is the extracted token table, which is
// honest about what it is and is exactly what people search for.
//
// Output goes to specs/ at the repo root. NOT dist/ or build/ -- .gitignore
// lists both, so files there would be committed nowhere and simply never
// deploy, which is a silent failure we cannot afford to rediscover.
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { buildAnalysisPrompt } = require('./pipeline.js');
const { BROWSER_UA, safeFetch } = require('./net.js');
const SITES = require('./spec-sites.js');

const ROOT = path.resolve(__dirname, '..');
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://uidconstruct.vercel.app';
const OUT_DIR = path.join(ROOT, 'specs');

// Anything below this many real values is not worth publishing: a page that
// lists three colours makes the product look broken rather than capable.
// linear.app is the known case -- emotion-hashed inline CSS, no stylesheet link.
const MIN_VALUES = 6;

// Delete a spec page that a later run refused to publish. Idempotent: the common
// case is simply that there is nothing to delete.
function removePage(slug) {
    const f = path.join(OUT_DIR, `${slug}.html`);
    if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        console.log(`  RM    ${slug.padEnd(14)} (rejected this run)`);
    }
}


const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ---------------------------------------------------------------- token parsing
// mineDesignTokens() returns pre-formatted lines like
//   "  --color-sky-400: #00bcfe [dark-only]"
// with "[color]" / "[type]" / "[geometry]" section headers and a leading
// "[theme]" advisory sentence. We parse that back into structure for the visual
// tables, but ALWAYS render the original lines verbatim inside the copyable
// prompt -- re-serialising would risk drifting from what the live tool emits.
function parseTokenLines(lines) {
    const out = { color: [], type: [], geometry: [], themeNote: '', raw: lines || [] };
    let bucket = null;
    for (const line of lines || []) {
        const h = /^\[(color|type|geometry)\]$/.exec(line);
        if (h) { bucket = h[1]; continue; }
        if (/^\[theme\]/.test(line)) { out.themeNote = line.replace(/^\[theme\]\s*/, ''); continue; }
        if (!bucket) continue;
        const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*(\[.*\])?\s*$/.exec(line);
        if (!m) continue;
        out[bucket].push({ name: m[1], value: m[2], note: m[3] ? m[3].slice(1, -1) : '' });
    }
    return out;
}

const isHex = (v) => /^#[0-9a-f]{3,8}$/i.test(String(v).trim());

// A colour name that says "background"/"bg" is a surface, not an accent. Used
// only to pick the page's own preview swatch ordering -- never to claim a
// semantic role we did not verify.
function splitColors(colors) {
    const hexes = colors.filter((c) => isHex(c.value));
    const surfaces = hexes.filter((c) => /(bg|background|surface|canvas)/i.test(c.name));
    const accents = hexes.filter((c) => /(accent|primary|brand|link|success|warning|danger|error)/i.test(c.name));
    const rest = hexes.filter((c) => !surfaces.includes(c) && !accents.includes(c));
    return { surfaces: surfaces.slice(0, 8), accents: accents.slice(0, 8), rest: rest.slice(0, 24), all: hexes };
}

// ------------------------------------------------------------------ the prompt
// The copyable artifact. Deliberately plain text: it is what a user pastes into
// v0 / Cursor / Bolt / Lovable, so markdown decoration would just be noise the
// model has to skip over.
function buildSpecText(site, tokens, breakpoints, outline) {
    const L = [];
    L.push(`Design spec — ${site.name}`);
    L.push(`Source: ${site.url}`);
    L.push(`Extracted: ${new Date().toISOString().slice(0, 10)}`);
    L.push('');
    L.push('Build a page in this visual language. Use the exact tokens below.');
    L.push('These values were read from the live site\'s own stylesheets, not guessed.');
    L.push('');
    if (tokens.color.length) {
        L.push('COLOR TOKENS');
        for (const c of tokens.color) L.push(`  ${c.name}: ${c.value}${c.note ? '  /* ' + c.note + ' */' : ''}`);
        L.push('');
    }
    if (tokens.type.length) {
        L.push('TYPE TOKENS');
        for (const t of tokens.type) L.push(`  ${t.name}: ${t.value}`);
        L.push('');
    }
    if (tokens.geometry.length) {
        L.push('GEOMETRY (radius / spacing / size)');
        for (const g of tokens.geometry) L.push(`  ${g.name}: ${g.value}`);
        L.push('');
    }
    if (tokens.themeNote) {
        L.push('THEME CAVEAT');
        L.push('  ' + tokens.themeNote);
        L.push('');
    }
    if (breakpoints.length) {
        L.push('BREAKPOINTS SEEN IN CSS');
        L.push('  ' + breakpoints.join(', '));
        L.push('');
    }
    if (outline) {
        L.push('PAGE STRUCTURE (headings in DOM order)');
        for (const line of String(outline).split('\n').slice(0, 14)) L.push('  ' + line);
        L.push('');
    }
    L.push('Do not copy the site\'s logo, artwork, photography or brand name.');
    L.push('Reproduce the visual language -- palette, type scale, spacing rhythm, radius.');
    return L.join('\n');
}

// ------------------------------------------------------------------- html shell
// Theme resolves in an inline script BEFORE the stylesheet loads, so a
// dark-mode visitor never sees a light flash. app.js is deliberately NOT loaded
// here: it is one big IIFE that queries elements unique to the landing page and
// would throw long before reaching its theme code.
//
// Markup mirrors index.html exactly (.navbar > .container > .logo / .nav-links,
// .footer > .container > .footer-top + .footer-bottom). Inventing class names
// here is how you get a "styled" page that renders as raw text.
function shell(opts) {
    const { title, desc, canonical, body, jsonld, noindex } = opts;
    return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<script>(function(){try{var s=null;try{s=localStorage.getItem('uid-theme')}catch(e){}var d=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;if((s||d)==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}})();</script>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(canonical)}" />
${noindex ? '<meta name="robots" content="noindex" />' : ''}
<meta property="og:type" content="article" />
<meta property="og:site_name" content="uidconstruct" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${SITE_ORIGIN}/og.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="author" content="al7ameen" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23e63b2e'/%3E%3Ctext x='16' y='22' font-family='Georgia,serif' font-size='17' fill='white' text-anchor='middle'%3Eu%3C/text%3E%3C/svg%3E" />
<link rel="stylesheet" href="/style.css" />
<link rel="stylesheet" href="/specs/specs.css" />
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<a href="#main" class="skip-link">Skip to content</a>
<header class="navbar" role="banner">
  <div class="container">
    <a href="/" class="logo" aria-label="uidconstruct home">uid<span>construct</span></a>
    <nav class="nav-links" role="navigation" aria-label="Main navigation">
      <a href="/specs/">Spec library</a>
      <a href="/#pricing">Pricing</a>
      <a href="https://github.com/al7ameen/uidconstruct" target="_blank" rel="noopener noreferrer">GitHub</a>
      <button class="theme-toggle-btn" data-theme-toggle aria-label="Toggle theme">
        <span data-theme-icon aria-hidden="true"></span> <span data-theme-label>Dark</span>
      </button>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="footer" role="contentinfo">
  <div class="container">
    <div class="footer-top">
      <span class="logo">uid<span>construct</span></span>
      <div class="links">
        <a href="/specs/">Specs</a>
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
      </div>
    </div>
    <div class="footer-bottom">
      <span class="tagline">Values read from each site's own public stylesheets. No tracking pixels. No cookies. Not affiliated with or endorsed by the sites analysed; all trademarks belong to their owners.</span>
    <span class="made-with">Built by <a href="https://github.com/al7ameen" target="_blank" rel="noopener noreferrer">al7ameen</a> <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> &middot; <a href="https://www.instagram.com/al7ameen" target="_blank" rel="noopener noreferrer">Instagram</a></span>
    </div>
  </div>
</footer>
<script>
(function(){
  var h=document.documentElement;
  function paint(){var d=h.getAttribute('data-theme')==='dark';
    var i=document.querySelector('[data-theme-icon]'),l=document.querySelector('[data-theme-label]');
    if(i)i.textContent=d?'☀️':'🌙'; if(l)l.textContent=d?'Light':'Dark';}
  paint();
  Array.prototype.forEach.call(document.querySelectorAll('[data-theme-toggle]'),function(b){
    b.addEventListener('click',function(){var d=h.getAttribute('data-theme')==='dark';
      h.setAttribute('data-theme',d?'light':'dark');
      try{localStorage.setItem('uid-theme',d?'light':'dark')}catch(e){} paint();});});
  function flash(b,msg){var o=b.getAttribute('data-label')||b.textContent;b.setAttribute('data-label',o);
    b.textContent=msg;setTimeout(function(){b.textContent=o},1800);}
  function legacy(txt,b){var ta=document.createElement('textarea');ta.value=txt;
    ta.style.position='fixed';ta.style.top='-1000px';document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');flash(b,'Copied')}catch(e){flash(b,'Select + copy')}
    document.body.removeChild(ta);}
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'),function(b){
    b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy'));
      if(!t)return; var txt=t.textContent;
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(txt).then(function(){flash(b,'Copied ✓')},function(){legacy(txt,b)});
      } else legacy(txt,b);});});
})();
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------ components
function swatchGrid(colors, kind) {
    if (!colors.length) return '';
    const items = colors.map((c) => {
        const v = c.value.trim();
        const note = c.note ? `<span class="spec-chip">${esc(c.note)}</span>` : '';
        return `<li class="spec-swatch">
  <span class="spec-swatch-block" style="background:${esc(v)}"></span>
  <code class="spec-swatch-name">${esc(c.name)}</code>
  <code class="spec-swatch-val">${esc(v)}</code>${note}
</li>`;
    }).join('\n');
    return `<ul class="spec-swatches spec-swatches--${kind}">${items}</ul>`;
}

function tokenTable(tokens, label) {
    if (!tokens.length) return '';
    const rows = tokens.map((t) =>
        `<tr><td><code>${esc(t.name)}</code></td><td><code>${esc(t.value)}</code></td>${t.note ? `<td><span class="spec-chip">${esc(t.note)}</span></td>` : '<td></td>'}</tr>`
    ).join('\n');
    return `<div class="spec-table-wrap"><table class="spec-table"><caption class="sr-only">${esc(label)}</caption>
<thead><tr><th scope="col">Token</th><th scope="col">Value</th><th scope="col">Note</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

// ------------------------------------------------------------------- spec page
function renderSpec(site, analysis, generatedAt, published) {
    const e = analysis.extracted;
    const tokens = parseTokenLines(e.designTokens);
    const counts = splitColors(tokens.color);
    const breakpoints = (e.cssBreakpoints || []).slice(0, 12);
    const specText = buildSpecText(site, tokens, breakpoints, e.pageOutline);
    const id = 'spec-prompt';

    const hero = `<section class="spec-hero container">
  <p class="spec-eyebrow"><a href="/specs/">Spec library</a> <span aria-hidden="true">/</span> ${esc(site.name)}</p>
  <h1>${esc(site.name)} design tokens</h1>
  <p class="spec-lede">Every value below was read from ${esc(site.url)}'s own public stylesheets — not eyeballed, not guessed. Copy the prompt straight into v0, Cursor, Bolt or Lovable.</p>
  <p class="spec-meta"><span>${tokens.color.length} colours</span> · <span>${tokens.type.length} type</span> · <span>${tokens.geometry.length} geometry</span> · <span>extracted ${esc(generatedAt)}</span></p>
  <p class="spec-cta-row"><a class="btn-primary" href="/?url=${encodeURIComponent(site.url)}">Analyse a different site</a></p>
</section>`;

    const sections = [];
    if (counts.all.length) {
        sections.push(`<section class="spec-section container">
  <h2>Colours</h2>
  <p class="spec-note">Grouped by the token's own name, which is the site author's claim about intent — not a guarantee. Values marked <em>dark-only</em> appear only under a theme variant.</p>
  ${counts.accents.length ? `<h3>Accents &amp; semantic</h3>${swatchGrid(counts.accents, 'accent')}` : ''}
  ${counts.surfaces.length ? `<h3>Surfaces</h3>${swatchGrid(counts.surfaces, 'surface')}` : ''}
  ${counts.rest.length ? `<h3>Full ramp</h3>${swatchGrid(counts.rest, 'ramp')}` : ''}
</section>`);
    }
    // The section was gated on type TOKENS (custom properties) while the font
    // data comes from cssFonts (plain declarations) — two independent sources.
    // Result: apple/notion/planetscale/spotify each had 6-10 mined fonts thrown
    // away because none of those sites expose type as a custom property.
    if (tokens.type.length || (e.cssFonts && e.cssFonts.length)) {
        sections.push(`<section class="spec-section container">
  <h2>Typography</h2>
  <p class="spec-note">Typefaces named in its own stylesheets${e.cssFonts && e.cssFonts.length ? ', the fonts it ships itself first' : ''}: ${e.cssFonts && e.cssFonts.length ? esc(e.cssFonts.slice(0, 8).join(', ')) : 'none found in the CSS it links'}.</p>
  ${tokens.type.length ? tokenTable(tokens.type, 'Typography tokens') : ''}
</section>`);
    }
    if (tokens.geometry.length) {
        sections.push(`<section class="spec-section container">
  <h2>Radius, spacing &amp; size</h2>
  ${tokenTable(tokens.geometry, 'Geometry tokens')}
</section>`);
    }
    if (breakpoints.length) {
        sections.push(`<section class="spec-section container">
  <h2>Breakpoints</h2>
  <ul class="spec-inline-list">${breakpoints.map((b) => `<li><code>${esc(b)}</code></li>`).join('')}</ul>
</section>`);
    }
    if (e.pageOutline) {
        sections.push(`<section class="spec-section container">
  <h2>Page structure</h2>
  <pre class="spec-outline">${esc(e.pageOutline)}</pre>
</section>`);
    }

    sections.push(`<section class="spec-section container">
  <div class="build-prompt-card">
    <div class="build-prompt-head">
      <span class="build-prompt-label">Build prompt</span>
      <button class="copy-prompt-btn" data-copy="${id}">Copy prompt</button>
    </div>
    <pre id="${id}" class="spec-prompt-text">${esc(specText)}</pre>
  </div>
</section>`);

    sections.push(`<section class="spec-section container spec-more">
  <h2>Get a spec for any site</h2>
  <p>Paste a URL and uidconstruct reads its live stylesheets the same way it read these, then writes a build-ready spec for your AI editor.</p>
  <p><a class="btn-primary" href="/">Try uidconstruct</a></p>
</section>`);

    const body = `<div class="spec-page">${hero}${sections.join('\n')}${otherSitesBlock(site, published)}</div>`;

    const jsonld = {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: `${site.name} design tokens`,
        description: `${site.name} colour, type and spacing tokens extracted from its public stylesheets.`,
        url: `${SITE_ORIGIN}/specs/${site.slug}`,
        datePublished: generatedAt,
        dateModified: generatedAt,
        isBasedOn: site.url,
        publisher: { '@type': 'Organization', name: 'uidconstruct', url: SITE_ORIGIN }
    };

    return {
        html: shell({
            title: `${site.name} design tokens — colours, fonts, spacing | uidconstruct`,
            desc: `Every ${site.name} colour, font-size and spacing value extracted from its live stylesheets, as a copy-paste build prompt for v0, Cursor, Bolt and Lovable.`,
            canonical: `${SITE_ORIGIN}/specs/${site.slug}`,
            body, jsonld
        }),
        stats: { colors: counts.all.length, type: tokens.type.length, geometry: tokens.geometry.length, total: tokens.color.length + tokens.type.length + tokens.geometry.length }
    };
}

function otherSitesBlock(current, published) {
    // The chip row is a promise that a page exists. It used to be built from the
    // curated SITES list alone, so every page linked to gated and never-built
    // slugs: 4 dead chips x 16 pages = 64 404s on production. Curated order is
    // still the ranking, but a slug may only appear if it is in `published`.
    const rows = Array.isArray(published) && published.length ? published : SITES;
    const names = new Map(rows.map((r) => [r.slug, r.name]));
    const others = SITES
        .filter((s) => s.slug !== current.slug && names.has(s.slug))
        .slice(0, 12);
    if (!others.length) return "";
    return `<section class="spec-section container"><h2>Other specs</h2><ul class="spec-inline-list">${others.map((s) => `<li><a href="/specs/${s.slug}">${esc(s.name)}</a></li>`).join("")}</ul></section>`;
}

// ------------------------------------------------------------------ index page
function renderIndex(rows, generatedAt) {
    const cards = rows.map((r) => `<li class="spec-card">
  <a href="/specs/${r.slug}">
    <span class="spec-card-name">${esc(r.name)}</span>
    <span class="spec-card-stat">${r.stats.colors} colours · ${r.stats.type} type · ${r.stats.geometry} geometry</span>
    <span class="spec-card-blurb">${esc(r.blurb)}</span>
  </a>
</li>`).join('\n');
    const body = `<section class="spec-hero container">
  <h1>Design token library</h1>
  <p class="spec-lede">Real colour, type and spacing values from ${rows.length} well-known sites, pulled straight out of their public stylesheets. Each page ends in a prompt you can paste into v0, Cursor, Bolt or Lovable.</p>
  <p class="spec-meta"><span>Extracted ${esc(generatedAt)}</span> · <a href="/?url=https://example.com">analyse any URL instead</a></p>
</section>
<section class="spec-section container">
  <ul class="spec-grid">${cards}</ul>
</section>
<section class="spec-section container spec-more">
  <h2>Site not here?</h2>
  <p>Paste any URL and uidconstruct reads its live stylesheets the same way it read these.</p>
  <p><a class="btn-primary" href="/">Analyse a site now</a></p>
</section>`;
    return shell({
        title: 'Design token library — colours, fonts & spacing from real sites | uidconstruct',
        desc: `Extracted design tokens from ${rows.length} well-known websites: hex colours, type scales, radii and spacing, each as a copy-paste build prompt.`,
        canonical: `${SITE_ORIGIN}/specs/`,
        body,
        jsonld: {
            '@context': 'https://schema.org', '@type': 'CollectionPage',
            name: 'Design token library', url: `${SITE_ORIGIN}/specs/`,
            description: 'Design tokens extracted from public stylesheets.',
            hasPart: rows.map((r) => ({ '@type': 'TechArticle', name: `${r.name} design tokens`, url: `${SITE_ORIGIN}/specs/${r.slug}` }))
        }
    });
}

// --------------------------------------------------------------------- css file
const SPECS_CSS = `/* specs/specs.css — generated alongside the pages by lib/gen-specs.js.
   Everything here is built from the landing page's own custom properties, so a
   token change in style.css flows through without touching this file. */
.spec-page { padding-top: var(--space-10); }
.spec-hero { padding-bottom: var(--space-8); border-bottom: 1px solid var(--border); }
.spec-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: .04em; color: var(--text-muted); margin: 0 0 var(--space-4); }
.spec-eyebrow a { color: var(--link-text); text-decoration: none; }
.spec-eyebrow a:hover { text-decoration: underline; }
.spec-hero h1 { font-family: var(--font-serif); font-weight: 400; font-size: clamp(34px, 6vw, 56px); line-height: 1.1; margin: 0 0 var(--space-5); }
.spec-lede { max-width: 62ch; font-size: clamp(16px, 1.6vw, 18px); color: var(--text-secondary); margin: 0 0 var(--space-5); }
.spec-meta { font-family: var(--font-mono); font-size: 12.5px; color: var(--text-muted); margin: 0; }
.spec-meta span { white-space: nowrap; }
.spec-cta-row { margin-top: var(--space-6); }
.spec-section { padding-top: var(--space-9); }
.spec-section h2 { font-family: var(--font-serif); font-weight: 400; font-size: clamp(26px, 4vw, 34px); margin: 0 0 var(--space-4); }
.spec-section h3 { font-size: 13px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); font-weight: 600; margin: var(--space-7) 0 var(--space-4); }
.spec-note { color: var(--text-secondary); font-size: 15px; max-width: 70ch; margin: 0 0 var(--space-5); }
.spec-swatches { list-style: none; padding: 0; margin: 0 0 var(--space-5); display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); }
.spec-swatch { border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--surface); }
.spec-swatch-block { display: block; height: 56px; border-bottom: 1px solid var(--border); }
.spec-swatch-name, .spec-swatch-val { display: block; padding: 0 var(--space-3); font-family: var(--font-mono); font-size: 11.5px; }
.spec-swatch-name { margin-top: 8px; color: var(--text); word-break: break-all; }
.spec-swatch-val { color: var(--text-muted); margin-bottom: 8px; }
.spec-chip { display: inline-block; margin: 0 var(--space-3) 8px; padding: 1px 6px; font-family: var(--font-mono); font-size: 10.5px; border-radius: 999px; background: var(--bg-alt); color: var(--text-secondary); border: 1px solid var(--border); }
.spec-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
.spec-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.spec-table th { text-align: left; font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); font-weight: 600; padding: 10px var(--space-3); background: var(--bg-alt); border-bottom: 1px solid var(--border); }
.spec-table td { padding: 9px var(--space-3); border-bottom: 1px solid var(--border); vertical-align: top; }
.spec-table tr:last-child td { border-bottom: 0; }
.spec-table code { font-family: var(--font-mono); font-size: 12.5px; color: var(--code-text); word-break: break-all; }
.spec-inline-list { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-2); }
.spec-inline-list li { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 10px; background: var(--surface); }
.spec-inline-list code { font-family: var(--font-mono); font-size: 12.5px; color: var(--text-secondary); }
.spec-outline { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-4) var(--space-5); max-height: 420px; overflow: auto; margin: 0; }
.spec-prompt-text { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; margin: 0; max-height: 460px; overflow: auto; background: var(--surface); border-radius: var(--radius-sm); padding: var(--space-4); border: 1px solid var(--border); }
.spec-more { padding-top: var(--space-10); padding-bottom: var(--space-10); margin-top: var(--space-9); border-top: 1px solid var(--border); }
.spec-grid { list-style: none; padding: 0; margin: 0; display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fill, minmax(258px, 1fr)); }
.spec-card a { display: flex; flex-direction: column; gap: 6px; height: 100%; padding: var(--space-5); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); text-decoration: none; color: inherit; transition: border-color var(--duration-fast) var(--ease), transform var(--duration-fast) var(--ease); }
.spec-card a:hover { border-color: var(--border-strong); transform: translateY(-2px); }
.spec-card-name { font-size: 17px; font-weight: 600; color: var(--text); }
.spec-card-stat { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted); }
.spec-card-blurb { font-size: 14px; color: var(--text-secondary); line-height: 1.5; }
`;


// ------------------------------------------------------------------- sitemap
// Generated, never hand-maintained: a sitemap that drifts from the pages on
// disk is worse than none, because it teaches crawlers that our signals lie.
// Reads the merged slug list so it always matches what the hub links.
function writeSitemap(entries, generatedAt) {
    const urls = [
        { loc: `${SITE_ORIGIN}/`, lastmod: generatedAt, priority: '1.0' },
        { loc: `${SITE_ORIGIN}/specs/`, lastmod: generatedAt, priority: '0.9' },
        ...entries.map((e) => ({
            loc: `${SITE_ORIGIN}/specs/${e.slug}`,
            lastmod: generatedAt,
            priority: '0.8'
        }))
    ];
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority}</priority></url>`).join('\n')
        + '\n</urlset>\n';
    fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml);
    return urls.length;
}

// ------------------------------------------------------------------------- main
const CSS_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A degraded stylesheet fetch is transient by nature — CDN throttling and cold
// edges clear on their own. Retrying costs nothing (no AI call, no rate limit)
// and converts a skipped page into a published one, so it is worth more than any
// cleverness in the gate. Backoff because we are usually being throttled, and
// throttling gets worse when you hammer.
async function fetchAnalysis(site) {
    let lastErr;
    for (let attempt = 1; attempt <= CSS_ATTEMPTS; attempt++) {
        try {
            const res = await safeFetch(site.url, { headers: { 'User-Agent': BROWSER_UA } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const html = await res.text();
            const $ = cheerio.load(html);
            return await buildAnalysisPrompt(html, $, site.url, site.slug);
        } catch (err) {
            lastErr = err;
            // Only the transient class is worth retrying; a 404 or an SSRF block
            // will fail identically 30s from now.
            const transient = err.name === 'CssUnavailableError'
                || err.name === 'TimeoutError'
                || /timeout|timed out|abort|fetch failed|ECONN|socket/i.test(String(err.message));
            if (!transient || attempt === CSS_ATTEMPTS) break;
            console.log(`  ...   ${site.slug.padEnd(14)} attempt ${attempt} failed (${err.name}), retrying`);
            await sleep(1500 * attempt);
        }
    }
    throw lastErr;
}

// Matches the whole "Other specs" section. Non-greedy is safe: the block holds
// a <ul> of anchors and no nested <section>.
const OTHER_SPECS_RE = /<section class="spec-section container"><h2>Other specs<\/h2>.*?<\/section>/s;

// renderSpec runs per-site inside the loop, before the merged published set is
// known -- so its chip block is provisional. This is the authoritative pass:
// after the merge, rewrite the section in every surviving page from the final
// row list. Deterministic, no network, and it is also the repair path for pages
// already on disk (call it with slugs.json and it fixes them in place).
function syncOtherSites(rows) {
    const touched = [];
    const skipped = [];
    for (const row of rows) {
        const file = path.join(OUT_DIR, `${row.slug}.html`);
        if (!fs.existsSync(file)) { skipped.push(row.slug); continue; }
        const html = fs.readFileSync(file, "utf8");
        if (!OTHER_SPECS_RE.test(html)) { skipped.push(row.slug); continue; }
        const next = html.replace(OTHER_SPECS_RE, () => otherSitesBlock(row, rows));
        if (next !== html) fs.writeFileSync(file, next);
        touched.push(row.slug);
    }
    return { touched: touched.length, skipped };
}

async function main() {
    const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const list = only.length ? SITES.filter((s) => only.includes(s.slug)) : SITES;
    const generatedAt = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'specs.css'), SPECS_CSS);

    const done = [];
    const failed = [];
    for (const site of list) {
        try {
            const a = await fetchAnalysis(site);
            const r = renderSpec(site, a, generatedAt);
            // The gate. A page that found three values is worse than no page: it
            // tells a searcher this tool is weak. Skip loudly rather than ship thin.
            if (r.stats.total < MIN_VALUES) {
                failed.push({ slug: site.slug, reason: `only ${r.stats.total} tokens (< ${MIN_VALUES})` });
                console.log(`  SKIP  ${site.slug.padEnd(14)} ${r.stats.total} tokens`);
                // The gate must own the filesystem. Without this, a page written
                // by an earlier run survives every later rejection: the hub stops
                // linking it, but the URL still resolves and search engines keep
                // the old copy. Skipped has to mean absent.
                removePage(site.slug);
                continue;
            }
            fs.writeFileSync(path.join(OUT_DIR, `${site.slug}.html`), r.html);
            done.push({ slug: site.slug, name: site.name, blurb: site.blurb, stats: r.stats });
            console.log(`  OK    ${site.slug.padEnd(14)} ${r.stats.colors}c ${r.stats.type}t ${r.stats.geometry}g`);
        } catch (err) {
            failed.push({ slug: site.slug, reason: `${err.name}: ${err.message}` });
            console.log(`  FAIL  ${site.slug.padEnd(14)} ${err.name}: ${err.message}`);
            removePage(site.slug);
        }
    }

    // Merge with what is already published, don't replace it. `done` only holds
    // sites from THIS run, so a single-slug refresh used to rewrite the hub down
    // to one card and shrink slugs.json to one entry -- measured: 16 -> 1. The
    // whole point of per-slug args is to refresh one site without touching the
    // others, so the index has to be the union of this run and prior survivors.
    const slugsPath = path.join(OUT_DIR, 'slugs.json');
    let prior = [];
    try { prior = JSON.parse(fs.readFileSync(slugsPath, 'utf8')); } catch { prior = []; }
    const thisRun = new Set(done.map((d) => d.slug));
    const merged = [
        ...done,
        // A prior page survives only if its file is still on disk -- removePage()
        // deletes rejected ones, so a missing file means it was dropped this run.
        ...prior.filter((p) => !thisRun.has(p.slug)
            && fs.existsSync(path.join(OUT_DIR, `${p.slug}.html`)))
    ].sort((a, b) => a.slug.localeCompare(b.slug));

    if (merged.length) {
        fs.writeFileSync(path.join(OUT_DIR, 'index.html'), renderIndex(merged, generatedAt));
        // sitemap fragment for the main sitemap.xml, if we ever add one
        fs.writeFileSync(path.join(OUT_DIR, 'slugs.json'), JSON.stringify(merged, null, 2));
    }
    const chipSync = syncOtherSites(merged);
    if (chipSync.skipped.length) console.log(`  chips NOT synced (no page/block): ${chipSync.skipped.join(", ")}`);
    const n = writeSitemap(merged, generatedAt);
    console.log(`\n${done.length} published this run, ${merged.length} total in hub, ${n} sitemap URLs, ${failed.length} skipped/failed.`);
    if (failed.length) console.log('FAILED: ' + failed.map((f) => `${f.slug} (${f.reason})`).join('; '));
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });
module.exports = { buildSpecText, parseTokenLines, renderIndex, renderSpec, splitColors, syncOtherSites, otherSitesBlock, writeSitemap };
