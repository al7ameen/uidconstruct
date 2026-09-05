// lib/spec-sites.js — the curated list of sites we pre-analyse into static
// SEO pages. Lives in lib/ deliberately: vercel.json redirects /lib/* to a 404,
// so a build-time tool here cannot be fetched by the public. Putting it in a
// new top-level scripts/ directory WOULD be fetchable -- that is exactly how
// /lib/*.js leaked before commit 1c79fbb.
//
// Selection rule: sites whose design system people actually search for, and
// which are extractable by our regex miner (i.e. they ship a real
// link[rel=stylesheet] with custom properties). linear.app is NOT on this list
// on purpose: it inlines emotion-hashed CSS, so it yields ~3 tokens and would
// publish a near-empty page that makes the product look broken.
module.exports = [
    { slug: 'tailwindcss', url: 'https://tailwindcss.com', name: 'Tailwind CSS', blurb: 'The utility-first framework, so its token names are the ones every AI coding tool already understands.' },
    { slug: 'vercel', url: 'https://vercel.com', name: 'Vercel', blurb: 'Geist: near-black canvas, tight greyscale ramp, restrained accent usage.' },
    { slug: 'stripe', url: 'https://stripe.com', name: 'Stripe', blurb: 'The reference point for gradient-forward fintech marketing pages.' },
    { slug: 'linear', url: 'https://linear.app', name: 'Linear', blurb: 'Dense product UI, dark-first, famously imitated.' },
    { slug: 'notion', url: 'https://www.notion.com', name: 'Notion', blurb: 'Warm neutrals and a serif-leaning display voice.' },
    { slug: 'figma', url: 'https://www.figma.com', name: 'Figma', blurb: 'Playful accent palette over a disciplined greyscale.' },
    { slug: 'framer', url: 'https://www.framer.com', name: 'Framer', blurb: 'High-contrast dark marketing with generous type scale.' },
    { slug: 'raycast', url: 'https://www.raycast.com', name: 'Raycast', blurb: 'Developer-tool dark UI with a red accent.' },
    { slug: 'supabase', url: 'https://supabase.com', name: 'Supabase', blurb: 'Open-source dark green identity, dense documentation UI.' },
    { slug: 'resend', url: 'https://resend.com', name: 'Resend', blurb: 'Minimal monochrome email-infrastructure branding.' },
    { slug: 'clerk', url: 'https://clerk.com', name: 'Clerk', blurb: 'Purple-accented auth SaaS, heavy on card layouts.' },
    { slug: 'airbnb', url: 'https://www.airbnb.com', name: 'Airbnb', blurb: 'One of the most-copied consumer palettes on the web.' },
    { slug: 'spotify', url: 'https://www.spotify.com', name: 'Spotify', blurb: 'Iconic green-on-black consumer dark theme.' },
    { slug: 'apple', url: 'https://www.apple.com', name: 'Apple', blurb: 'Neutral greyscale with product photography carrying the colour.' },
    { slug: 'github', url: 'https://github.com', name: 'GitHub', blurb: 'Primer design system, the most familiar dark UI in developer land.' },
    { slug: 'gitlab', url: 'https://about.gitlab.com', name: 'GitLab', blurb: 'Orange-accented DevOps brand.' },
    { slug: 'cloudflare', url: 'https://www.cloudflare.com', name: 'Cloudflare', blurb: 'Orange on dark, infrastructure marketing.' },
    { slug: 'hashicorp', url: 'https://www.hashicorp.com', name: 'HashiCorp', blurb: 'Multi-product infrastructure brand system.' },
    { slug: 'mongodb', url: 'https://www.mongodb.com', name: 'MongoDB', blurb: 'Green leaf brand over a developer docs surface.' },
    { slug: 'sanity', url: 'https://www.sanity.io', name: 'Sanity', blurb: 'Bold red accent, strong typographic hierarchy.' },
    { slug: 'planetscale', url: 'https://planetscale.com', name: 'PlanetScale', blurb: 'Dark database marketing with vivid accents.' },
    { slug: 'neon', url: 'https://neon.tech', name: 'Neon', blurb: 'Purple serverless Postgres identity.' },
    { slug: 'prime', url: 'https://www.react-pdf-kit.dev', name: 'react-pdf-kit', blurb: 'Small open-source library — a realistic non-brand example.' },
    { slug: 'shadcn', url: 'https://ui.shadcn.com', name: 'shadcn/ui', blurb: 'The component library whose CSS variables most AI tools already emit.' },
    { slug: 'vite', url: 'https://vitejs.dev', name: 'Vite', blurb: 'Purple-gradient dev tooling brand.' }
];
