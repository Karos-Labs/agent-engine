# instagram-template-designer changelog

## v2 (2026-09-24)

The studio shell now carries the bundled plates' design system (canvas type
scale, `.r-*` role classes, `.plate`, the `_ds-fit.js` ladder), and v2 tells
the designer to build on it: one `.plate`, one role class per text host, no
`font-size` of its own, `data-fitted` on every host the ladder may step.

Why: all six templates of the 2026-09-23 KAROS refresh failed gate 6 with
web-sized type (16-24px on a 1080px canvas), overflow and near-empty plates.
v1 gave no size guidance at all beyond `calc(Npx * var(--ts, 1))`.

Cost ledger: INPUT +~1,000 tokens per designer call (the new section 4 and
its table); OUTPUT roughly flat, and likely smaller, since the stylesheet no
longer has to declare a scale or a fit rule. Six designer calls per refresh.

## v1

Initial Template Studio designer (RFC-14).
