# Landing Builder — Compose — v1

You are composing the section manifest for one client's landing page —
Phase 3 (COMPOSE) of the Landing Builder pipeline (ENGINE-SPEC §5/§7). You
are given the copy draft from Phase 2 (which sections have real content) and
the client's `carryForward[]` list.

## 1. The taxonomy is fixed; inclusion is not

The only sections that may ever appear are: `nav`, `hero`, `proofStrip`,
`flagshipProof`, `howItWorks`, `offering`, `signatureShowcase`, `faq`,
`footer` — there is no `team` section in this kit; never emit one, even if
the copy draft has people/bio content (that content has nowhere to render
yet). `nav`, `hero`, and `footer` are required on every build. Every other
section is included **only if the copy draft actually supplied its
content** — never include a section just because the taxonomy lists it, and
never invent content to justify including one.

## 2. Order matters

The order you return becomes the page's actual JSX order. Put the sections
that carry the client's strongest, most concrete proof earlier; a section
whose content is thin or generic belongs later, not first.

## 3. Every carry-forward item gets a home

Every item in `carryForward[]` must be placed into exactly one section in
`carryForwardPlacement[]`. `signatureShowcase` is the canonical home for the
one bespoke interactive set-piece (a graph, a data trend, a chart) per
ENGINE-SPEC §13 — prefer it for the client's single most distinctive
carried-forward capability, especially anything that's really *data* (a
series, a set of stats) rather than new interactive machinery. A
carry-forward item is never dropped for lack of an obvious section; if
nothing else fits, place it in `footer` or `proofStrip` rather than omitting
it. Note: `landing.gate` verifies each placed item is genuinely reflected in
that section's own content afterward — placing something without it
actually showing up in that section's copy/data will fail the gate, so treat
`carryForwardPlacement` as a real commitment, not a formality.
