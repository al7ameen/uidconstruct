// lib/prompts.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.


const SYSTEM_PROMPT = `You are a senior UI/UX engineer and design system expert. Given raw HTML, CSS, and extracted design data from a website, produce a dense, pixel-accurate UI specification that any AI coding assistant (Cursor, v0, Bolt, Claude Code) can use to rebuild the UI 1:1.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

BUILD PROMPT
<one imperative instruction, under 40 words, that the user pastes into v0 / Cursor / Bolt / Lovable to start the build>

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

HARD LIMIT: 500 words total, including the BUILD PROMPT line.

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

    return `Analyze this website and produce a detailed UI specification.

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

The Design Tokens are given to you as data. Reproduce that table ONCE,
verbatim, as section 1 — an AI editor needs the literal hex values, especially
on sites whose token names are meaningless (--a1, --x-23). But never repeat a
hex value in prose afterwards: refer to tokens by name ("primary action uses
sky-400"). Spend the rest of the word budget on layout, structure and
components, which is the part only you can derive from the outline.
Produce the specification now. Hard cap: 500 words, maximally dense, tables
over prose, state each value once.`;
};

// ============================================================
// MAIN HANDLER
// ============================================================

module.exports = { SYSTEM_PROMPT, USER_PROMPT, mergeBreakpoints };
