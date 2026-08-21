# Landing Engine — Canonical Template

The single, flexible kit every client landing is generated from. A **composable
floor + design system**, not a fixed page. The kit guarantees craft and
consistency; the agent guarantees per-client uniqueness by composing, omitting,
reordering, and ADDING bespoke pieces on top.

Stack: Next.js 16.2.9 · React 19 · Tailwind v4 (`@theme inline` CSS vars) ·
Framer Motion (`motion` v12) · `next/font/google`.

## Skin levers (the only things you change to reskin)

1. **Tokens** — `src/app/globals.css` `:root` values (8 semantic role colors +
   `--accent-rgb` / `--fg-rgb` triplets + `--ease`). Components only ever use
   role utilities (`bg-ground`, `text-fg`, `text-accent`, `border-edge`, …),
   never a brand color directly.
2. **Fonts** — `src/app/layout.tsx` swaps three `next/font/google` families.
   The CSS variable role names stay constant.
3. **Content** — write `src/content/<client>.ts` as a `LandingContent` object
   and point `src/app/page.tsx` at it. See `src/content/example.ts`.

## Content-driven behavior (no per-brand `if` logic anywhere)

- `nav.wordmark` / `footer.wordmark` — brand name in header, footer, and the
  oversized footer watermark (uppercased).
- `hero.image` present => grid layout; absent => single-column text hero.
- `hero.backdrop` — `"sweep"` (rotating conic spotlight, default), `"mesh"`
  (two drifting blobs), or `"custom"` (agent swaps in a bespoke backdrop).
- `offering.billingToggle` — `true` renders a monthly/annual toggle + price
  math; falsy renders price/cadence verbatim (works for prize amounts).
- Optional `id` on each section drives nav anchors (`offering.id`, etc.).
- `partners` / `partnersLabel` — the rotating marquee. Omit => no strip.
- `carryForward[]` — `chatbot` => floating widget; `graph` => signature
  showcase. Reskinned to the new tokens.
- `signatureShowcase.unit` / `.deltaLabel` — the figure unit and delta pill text.

## Components (the kit)

`site-nav` · `site-footer` (required) · `hero` (required) · `partner-marquee` ·
`proof-strip` · `flagship-proof` · `how-it-works` · `offering` ·
`signature-showcase` · `faq` · `coach-chatbot` (optional). Support:
`primitives` (Reveal/RevealGroup/RevealItem) · `interactions`
(GlowButton/TiltCard/EASE). Contract: `src/lib/content-schema.ts`.

## Extending per client (bespoke pieces)

- **New section** (calculator, testimonials, live widget): create
  `src/components/<name>.tsx`, type its data under a new optional field in
  `content-schema.ts`, add a guarded render line to `page.tsx`. Consume
  `content.media[]` / `content.customSections[]` as needed.
- **Custom hero backdrop**: set `hero.backdrop: "custom"`, add a
  `<CustomHeroBackdrop />` that reads tokens and respects `useReducedMotion()`,
  swap it into `hero.tsx`.
- **Rules for all new pieces**: use role tokens (no hardcoded colors), read
  `useReducedMotion()` in every motion component, mobile-first responsive.

## Build + gate

```bash
npm install
npm run build
node ../gate.mjs --brand ./brand.json --site .
```

`brand.json` is the neutral example contract matching the default skin, so the
template self-verifies out of the box. Replace it per client.
