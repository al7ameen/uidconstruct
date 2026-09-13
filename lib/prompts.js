// lib/prompts.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.


const SYSTEM_PROMPT = `You are a senior UI/UX engineer and design system expert. Given raw HTML, CSS, and extracted design data from a website, produce the NARRATIVE half of a build specification that any AI coding
assistant (Cursor, v0, Bolt, Claude Code) can use to rebuild the UI 1:1. The
narrative is paired with VERBATIM DATA BLOCKS that the extraction server
attaches to your answer mechanically: design tokens, exact colour rules,
fonts, breakpoints and the site's real text are NOT yours to restate — your
job is everything data cannot express: structure, components, motion intent,
accessibility and a build checklist.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

BUILD PROMPT
<one imperative instruction, under 40 words, that the user pastes into v0 / Cursor / Bolt / Lovable to start the build>

# UI Specification: [domain]

## 1. Design Tokens

### Color Palette
The exact palette is appended verbatim as data block 10 — do NOT restate it
and do NOT emit any hex/rgb value that is not in the provided data. Where
values are genuinely absent, write the role as a CSS custom property name
(e.g. --color-text-secondary), never an invented number.

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
The site’s literal keyframes, transition rules and media-query ranges are
appended as data block 15 — do NOT restate them. Your job is the part CSS
cannot express: what MOVES. One line each, mapped to a section from the page
outline:
- [element/section]: what enters/moves, direction, approx pace (slow/snappy),
  trigger (load / scroll / hover)
- JS-driven motion not visible in CSS — state the technique and what the
collected evidence shows
- Loading/skeleton behaviour, page transitions, reduced-motion treatment

## 6. Accessibility Notes
- Focus ring styling
- Color contrast concerns
- Keyboard navigation patterns
- ARIA patterns used

## 7. Assets & Dark Mode
- Icons: style (outline/filled), size, library if identifiable
- Images: roles and placement (hero, card, avatar, logo) — the URLs and
  alts arrive verbatim in data block 14; never copy them into your answer
- Dark mode: one short paragraph on what differs

## 8. Build Instructions for AI Editor
Numbered, actionable checklist (6-10 lines). Data blocks 10-15 are appended
after your answer, so say "use the attached palette / copy / asset list
verbatim" rather than repeating their contents.

TARGET: 450-600 words total, including the BUILD PROMPT line. Every token
table, colour rule, font declaration, media query, asset URL and text string
lives in the data blocks, so this budget is for narrative only.

The BUILD PROMPT is the product. A user copies it into an AI editor and gets a
rebuild; the spec underneath is the evidence it works from. Write it as a single
imperative instruction naming the domain, what the site IS, and the signals that
define it (dark/light, the primary colours, the typeface, the layout pattern).
Never write "Build a site like X" with no specifics — that is what the user
already knows.

Be maximally dense — compact lines, tables over prose, no filler. Include every distinct hex code, px value and font size found, but state each once. Tokens are authoritative for VALUES (colours, sizes, radii); the Page outline is
authoritative for IDENTITY (what the site is and which sections it has). These are
different jobs, not a ranking: never guess the site's genre or sections from its
colour tokens alone, and never invent a value that a token already supplies.
The data blocks carry the facts; your narrative must add what facts cannot say.
Where a component genuinely needs a conventional value the data does not list
(sidebar width, input height), state it once, plainly flagged as convention.
DO NOT write "not detectable", "not found", "unknown", or any other placeholder for data that is missing. If a section has no data, either omit it or fill it with what the evidence DOES support — a reader copying this into Cursor gets nothing from a placeholder, and a page full of them makes a readable site look unreadable. Never invent values. A developer copying this into Cursor or v0 must be able to rebuild the UI accurately.`;
// Two independent sources for the same fact: compiled stylesheets give us
// min/max-width values, inline <style> blocks give us raw @media text. Pull
// the numbers out of both and de-duplicate.

// Two independent sources for the same fact: compiled stylesheets give us
// min/max-width values, inline <style> blocks give us raw @media text. Pull
// the numbers out of both and de-duplicate.
function mergeBreakpoints(fromCss, fromInline) {
    const out = new Set();
    (fromCss || []).forEach(b => out.add(String(b)));
    (fromInline || []).forEach(line => {
        const re = /(\d+(?:\.\d+)?)(px|rem)/g;
        let m;
        while ((m = re.exec(String(line)))) out.add(m[1] + m[2]);
    });
    return Array.from(out).slice(0, 14).join(', ');
}


const USER_PROMPT = (data) => {
    // Build the data block from ONLY the sections that have content. Five
    // literal "Not detected" lines used to sit in front of the model like
    // evidence that the site was unreadable, and it dutifully wrote
    // "not detectable" into the spec. Absence of a section is neutral;
    // an explicit "Not detected" is a conclusion.
    const e = data.extracted;
    const sections = [];
    const add = (title, body, note) => {
        const text = typeof body === 'string' ? body.trim() : (body || []).join('\n').trim();
        if (!text) return;
        sections.push(`### ${title}${note ? ' — ' + note : ''}:\n${text}`);
    };

    add('Page outline — the actual visible content, in DOM order (AUTHORITATIVE for what this site IS)', e.pageOutline);
    add('Fonts (from stylesheets)', e.cssFonts.join(', '));
    add('Font sizes / weights / line-heights', e.fontSizes.slice(0, 12).join(', '));
    add('Colors (inline styles)', e.colors.join(', '));
    add('Layout patterns (inline styles)', e.layoutPatterns);
    add('Component styles (inline styles)', e.componentPatterns);
    // Inline <style> @media queries are a separate source: sites that ship no
    // external stylesheet still expose them, so merge rather than choose.
    add('Breakpoints', mergeBreakpoints(e.cssBreakpoints, e.responsiveBreakpoints));
    add('Design Tokens — parsed from the site\'s real stylesheets (AUTHORITATIVE, use these exact values)', e.designTokens);
    add('Component rules — resolved from the site\'s CSS with var()/calc() evaluated (AUTHORITATIVE, use these exact values)', e.componentRules);
    // The outline is the only input that says what the site IS. Without it the
    // model can describe the paint and not the page.
    add('CSS (inline <style>, excerpt)', data.cssStyles);
    add('Keyframes / transitions / media queries — literal CSS (AUTHORITATIVE)', e.motion);
    add('Assets — real image/icon URLs from the page', e.assets);

    return `Analyze this website and write the narrative spec (sections 1-8 of the required format). Data blocks are attached mechanically after your answer — never restate them.

Website URL: ${data.url}
Domain: ${data.domain}

## Extracted Design Data
${sections.join('\n\n')}

## Page HTML (body excerpt)
${data.rawHtml}

## How to read this data
Sections marked AUTHORITATIVE were parsed from the site's own compiled
stylesheets and are exact. Anything not listed was genuinely absent from the
page source — do NOT write "not detectable"; describe what IS present and
infer conventional values only where a component clearly needs one.

The Page outline is the visible content of the site: its headings, nav labels,
button text and copy. Use it to say what the site actually IS and to describe
its sections in order. A spec that could have been written from the colour
tokens alone has ignored it.

Everything under "Extracted Design Data" is delivered to the builder as a
verbatim data block appended after your answer. NEVER copy a data block into
your narrative — tables, hex lists, font stacks, keyframe bodies, media-query
ranges, asset URLs and text strings: the exact strings arrive mechanically,
repetition only wastes the word budget. Refer to values by token name
("primary action uses sky-400"), and spend the whole budget on what only you
can derive: layout, structure, components, motion intent, build checklist.
Produce the narrative now: 450-600 words, maximally dense, tables over prose,
state each value once.`;
};

// ============================================================
// MAIN HANDLER
// ============================================================

// ============================================================
// ASSEMBLY (Step 1 architecture): the model writes the narrative, the
// machine appends the facts. The measured failure this fixes: a model asked
// to retype data drops the copy FIRST and invents the colours the palette
// caps out of — a fresh framer.com run extracted 9,320 chars, returned 3,847,
// carried ZERO of the site's real text, and cited 49 hex codes of which only
// 23 existed. Data that passes through a word budget is data at risk; the
// blocks below bypass it entirely.
// ============================================================

function cleanBlock(x) {
    if (Array.isArray(x)) x = x.join('\n');
    return String(x == null ? '' : x).trim();
}

function assembleSpec(narrative, analysis) {
    const e = (analysis && analysis.extracted) || {};
    const out = [String(narrative || '').trim()];
    if (!out[0]) return '';
    const dom = (analysis && analysis.domain) || 'the analyzed site';
    const push = (n, title, body) => {
        const b = cleanBlock(body);
        if (b) out.push('## ' + n + '. ' + title + ' (extracted from ' + dom + ' \u2014 verbatim, use exact values)\n' + b);
    };
    push(10, 'Design Tokens', e.designTokens);
    push(11, 'Color & Component Rules', e.componentRules);
    push(12, 'Type, Spacing & Breakpoints', [e.cssFonts, e.fontSizes, e.cssBreakpoints].map(cleanBlock).filter(Boolean).join('\n'));
    push(13, 'Copy \u2014 the site\u2019s real text (use these exact strings; never lorem ipsum)', e.pageOutline);
    push(14, 'Assets', e.assets);
    push(15, 'Motion', e.motion);
    return out.join('\n\n') + '\n';
}

module.exports = { SYSTEM_PROMPT, USER_PROMPT, mergeBreakpoints, assembleSpec };
