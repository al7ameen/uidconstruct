# uidconstruct

**Paste any website URL. Get the design spec behind it, as a prompt you can hand to v0, Cursor, Bolt or Lovable.**

Live: https://uidconstruct.vercel.app — no account, no cookies, no tracking pixels.

Built by [al7ameen](https://github.com/al7ameen).

---

## Why this exists

Every "extract a site's design" tool either screenshots the page or runs a headless browser.
Neither tells you what to *build with*.

uidconstruct reads a site's own public stylesheets and returns the actual values it uses —
colour palette, type scale, spacing rhythm, radii, breakpoints — formatted as a single
copy-pasteable prompt for an AI code editor.

Try it on a site you know. Then paste the result into v0 and see how close the rebuild gets.

## The interesting constraint: no browser

There is **no headless browser here**. One runtime dependency, [`cheerio`](https://github.com/cheeriojs/cheerio),
which is an HTML *parser*, not a rendering engine. It has no cascade and no computed-style
engine, so `$(el).css('color')` only ever returns an inline `style=""` attribute — and modern
sites don't use those.

So the values have to come from somewhere else: the stylesheets the page links.

```
fetch page  ->  sanitize  ->  pull every linked stylesheet  ->  mine CSS custom properties
     ->  rank them against the class names actually present in the HTML  ->  emit a spec
```

The step that makes it usable is the ranking. A Tailwind site ships a ~690 KB palette; dumping
it would be noise. Intersecting the tokens with the classes the page really renders collapses
that to the ~40 values a visitor actually sees.

Matching is non-obvious: `--color-gray-950` is consumed by the class `bg-gray-950`, so the
utility prefix has to be stripped and variants (`dark:hover:bg-`) handled. Framework-internal
plumbing (`--tw-*`, `--el-*`, `--radix-*`, `--sh-*`) is excluded — it isn't a design value and
it alphabetically crowds out the ones that are.

**Result:** tailwindcss.com went from zero hex values to a full 36-colour palette, type scale
and breakpoint set in about 24 seconds. No browser, no GPU, no 300 MB of Chromium.

## What it extracts

| | |
|---|---|
| **Colour** | Palette, with the token name it ships under |
| **Type** | Font families, size scale, weights |
| **Geometry** | Radii, spacing rhythm, shadows |
| **Layout** | Breakpoints, section structure, DOM heading order |
| **Content** | Nav labels, CTAs, form fields — the scaffolding an editor needs |

Token budget is allocated **per category**, not globally. A single global sort let Tailwind's
colour tokens eat the entire allowance and return zero radii; now colours, type and geometry
each get a guaranteed floor before the remainder is shared.

## It tells you when it knows nothing

This is the part I care most about.

- Font names arrive **decoded**. CSS escapes (`\30d2\30e9\30ae\30ce`) become ヒラギノ角ゴ Pro W3.
- **Generic fallbacks are filtered.** `Apple Color Emoji`, `SFMono-Regular`, `Consolas` and
  `Georgia` appear in nearly every stack on the web. Listing them as "Vercel's fonts" is a lie.
  Vercel's page now says *"none found in the CSS it links"* — which is true, and more useful.
- Subsets collapse. `CircularSp-Deva` and `CircularSp` are one typeface.
- Failures are loud. If the stylesheets can't be read, the request says so instead of returning
  a confident-looking empty spec.

A spec with plausible-looking junk in it is worse than a spec that admits it found nothing,
because you can't tell the difference downstream.

## Honest limitations

Both remaining ceilings need a real rendering engine, not more regex:

1. **Utility classes with no custom property** can't be resolved to a value.
2. **Sites that inline or hash their styles** expose nothing to mine. linear.app serves about
   7 KB of CSS total, so token mining structurally cannot help there.

So: it works well on sites that ship `link[rel=stylesheet]`, and poorly on ones that don't.
I'd rather say that than promise "any website".

## Engineering notes

- **SSRF-guarded.** Every outbound URL is sanitised, and because `fetch` follows redirects by
  default, redirects are re-validated **per hop** — otherwise a public URL can 302 to
  `169.254.169.254` and reach cloud metadata.
- **BYOK.** Paste your own OpenAI or Anthropic key. Endpoints come from a hardcoded allowlist,
  never from user input, so this is not an open proxy. Keys are never logged.
- **Honest backpressure.** A concurrency gate returns a real `429` with `Retry-After` rather
  than letting requests pile up into `500`s. A truthful failure reads as a working system;
  a `500` reads as an outage.
- **201 tests, 0 failures** — 105 unit · 42 integration · 40 frontend · 14 gate.

The frontend suite parses the **real** tokens out of `style.css` and computes WCAG contrast
ratios in both themes, and asserts that every white-alpha declaration has a dark-mode override.
That caught two user-visible bugs that were invisible in the stylesheet, because the CSS was
perfectly legal — the theme was just inverted underneath it.

## Run it

```bash
npm install
cp .env.example .env   # add your own key, or leave it out for the free tier
npx vercel dev
```

Deploys to Vercel as-is: static frontend plus one serverless function in `api/`.

## Credits

Design tokens are facts about how a site is built, not creative expression — extracting them is
normal practice. uidconstruct positions itself as a **spec and inspiration tool**, not a clone
button. Not affiliated with or endorsed by any site analysed; all trademarks belong to their owners.

