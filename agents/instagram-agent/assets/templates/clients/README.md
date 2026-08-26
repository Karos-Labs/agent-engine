# Per-client curated template sets

One directory per client, named by the client's `agentsRepoSlug` (the same
slug every workspace path uses):

```
clients/
  geektime/
    meta.json
    stat_callout.html
    quote_card.html
  pitchbydeel/
    meta.json
    headline_focus.html
```

`scripts/seed-client-templates.ts` (repo root) publishes each directory into
the Firestore template registry as `source: "curated"` rows scoped to that
client via `clientSlug`. Dry-run by default; `--apply` writes.

## The template files

Each `<archetypeId>.html` is a FULL self-contained document in the exact
contract the bundled archetypes under `../default/` use — study those before
authoring:

- `{{field}}` placeholders for escaped text slots, `{{image:field}}` for the
  bounds-checked hero image path, `{{html:field}}` only for renderer-owned
  fragments. `supportedFields` is derived from the file, never declared.
- Brand-kit compatible: the head/body fragments (`--brand-*` variables, badge
  markup, logo slot, `body.ts-s/ts-l`/`ta-*` typography classes) are injected
  at materialization, so use the same token names the default set uses and
  every client's Brand Kit styles the file automatically.
- RTL-safe: inherit `dir` the way the default set does; never hardcode
  left/right paddings where a logical property exists.

The archetypeId (the filename stem) can be one of the calling agent's known
archetypes — then this file REPLACES the bundled implementation for this
client — or a new id, which the agent's template-resolution step exposes as an
extra layout.

## meta.json

```json
{
  "qualityScore": 75,
  "templates": {
    "stat_callout": { "name": "Geektime stat card", "layoutType": "typographic" },
    "quote_card":   { "name": "Geektime quote",     "layoutType": "photo", "qualityScore": 80 }
  }
}
```

- Every `.html` file in the directory MUST have an entry under `templates`
  (the seeder refuses otherwise — `layoutType` is load-bearing: it decides
  whether image sourcing runs for a slide, and guessing it costs a billed
  search or an empty hero).
- `qualityScore` (top-level default 75, per-file override) is EXPLICIT and
  defaults ABOVE the legacy floor (70) on purpose: `resolveBest` compares
  score first and uses client scope only as a tie-break, so a curated set
  seeded at the `curated` source default (60) would silently never win. 75
  says "this client's own reviewed design beats the generic one"; the
  promotion path's below-the-floor opening score is a guard for UNPROVEN AI
  generations, which is why the seeder writes rows directly instead of going
  through `promoteTemplate`.

Porting the legacy karos-agents client sets (xodigital, sitti, karoslabs)
into this contract is content work that happens per client, not code.
