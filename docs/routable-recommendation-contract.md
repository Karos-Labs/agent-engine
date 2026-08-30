# Routable recommendation — cross-repo contract (SCRUM-210 / C2)

**The full `rec_id -> {fixAction, actionKind, owner, engineProductId?}` mapping
table for `rec-catalog.data.ts`'s 75 records is NOT in this document, and is
not built by it.** That table, and the `recommend.ts`/`FiredRecommendation`
enrichment that would carry it over the wire, are **T-A4/SCRUM-257's own
deliverable** — a separate, much bigger ticket. This document, and the
`packages/tools/karos-seo-geo/src/routable-recommendation-contract.ts` types
it describes, exist only to give T-A4 (SCRUM-257) and T-A17 (SCRUM-261) — both
`Repo: agent-engine` per Jira — a real, in-repo spec to build against, mirroring
the equivalent doc already committed on the karos-portal side.

Status: **types + spec only, on this side.** The vocabulary
(`FixAction`/`ActionKind`/`RecOwner`), the shape
(`RoutableRecommendation extends FiredRecommendation`), and the three
invariant rules below are exactly what karos-portal's own
`docs/routable-recommendation-contract.md` and
`src/lib/agent-engine/routable-recommendation.ts` already describe — this
document ports that spec into agent-engine, it does not change it.

## Why this exists

`seo-geo-agent`'s catalog (`packages/tools/karos-seo-geo/src/config/rec-catalog.data.ts`
— 75 records) carries, per record: `check` (the failing check, i.e. the
evidence), `lever` (SEO/GEO/BOTH), `product_ref` (`{id, folder, status}`) —
and, once T-A4 ships, which of three categories owns the fix and which engine
product runs it when we own it.

Today's wire shape (`packages/tools/karos-seo-geo/src/recommend.ts`'s
`FiredRecommendation`) is exactly ten fields of scoring output:

```
recId, recommendation, fireState, worstNorm, scoreLift,
impact, effort, delivery, priorityScore, hardOverride
```

`recommend.ts`'s own internal catalog-row reader only ever touches
`recommendation`/`impact`/`effort`/`delivery`/`source` off each catalog row —
none of the catalog's `check`/`lever`/`product_ref` routable hints leave the
catalog today. karos-portal's `materializeSeoGeoReport` reads exactly this
ten-field shape and turns it into a recId plus a prose bullet; there is
nothing else in the payload to keep, on either side, until T-A4 ships.

## Vocabulary — canonical, not invented here

`FixAction` and `ActionKind` are **karos-portal's own unions**
(`src/lib/seo-geo.ts`), used today by the client-facing SaaS action plan.
This contract declares them canonical for both repos — agent-engine does not
get its own, differently-spelled versions of either. They are ported
verbatim into this repo as real, importable types in
`packages/tools/karos-seo-geo/src/routable-recommendation-contract.ts`:

```ts
// src/lib/seo-geo.ts (karos-portal) — canonical, do not fork.
// Mirrored verbatim as FixAction / ActionKind in this repo's
// packages/tools/karos-seo-geo/src/routable-recommendation-contract.ts.
export type FixAction =
  | "meta_title"
  | "meta_description"
  | "schema"
  | "og_image"
  | "canonical"
  | "image_alt"
  | "sitemap"
  | "indexing"
  | "manual";

export type ActionKind = "one_click" | "review_approve" | "connect" | "guided_manual";
```

`RecOwner` is **new** — the three-way split the original requirement asked
for, defined identically on both sides
(karos-portal's `src/lib/agent-engine/routable-recommendation.ts`; this
repo's `packages/tools/karos-seo-geo/src/routable-recommendation-contract.ts`):

```ts
export type RecOwner =
  | "karos_agent"   // our agent runs the fix automatically
  | "karos_tool"    // a tool or connector does it, not a full agent
  | "client_manual"; // we recommend the client do it themselves
```

**`client_manual` is the fail-safe default.** An unmapped, malformed, or
not-yet-classified record is `client_manual` — never silently promoted to
something the platform runs on its own.

## The canonical shape

`RoutableRecommendation` **extends** `FiredRecommendation` — it does not
replace it. Every existing scoring field stays exactly as-is; what's added is
what the catalog already holds and the old wire shape discarded, plus the new
routing:

| Field | Type | Notes |
|---|---|---|
| `recId` … `hardOverride` | *(ten `FiredRecommendation` fields, unchanged)* | |
| `check` | `string` | The failing check / the evidence (catalog `check`). Empty string if absent on the wire. |
| `lever` | `"SEO" \| "GEO" \| "BOTH"` | Defaults to `"BOTH"` if absent/unrecognized. |
| `productRef` | `{id, folder, status} \| null` | `folder` is a **lab folder name**, never an engine `productId` — see Rule 1. |
| `fixAction` | `FixAction` | Defaults to `"manual"` if absent/unrecognized. |
| `actionKind` | `ActionKind` | Defaults to `"guided_manual"` if absent/unrecognized. |
| `owner` | `RecOwner` | Defaults to `"client_manual"` if absent/unrecognized. |
| `targetPlatform?` | `string` | Optional, no default. |
| `engineProductId?` | `string` | **Only present, and only trusted, when `owner === "karos_agent"`.** See Rule 3. |

This repo does not yet define `RoutableRecommendation` itself — that
interface, and the code that populates it from the catalog + scoring output,
is part of T-A4's build (it is the enrichment step for `recommend.ts`
mentioned above). What this repo defines today is the three unions
(`FixAction`/`ActionKind`/`RecOwner`) T-A4 builds that enrichment against, so
the shape lands typed correctly from the start rather than inventing a
fourth spelling of any of them.

## The three rules (from the ticket, verbatim)

1. **`product_ref.folder` is a lab folder name, NOT an engine `productId`.**
   The mapping from a catalog record to an `engineProductId` is manual and
   reviewed — never derived automatically from a folder name string.
2. **`engineProductId` must come from `KNOWN_PRODUCT_IDS`**
   (`apps/agent-server/src/wiring/workflows.ts`, this repo; karos-portal's
   mirror is `KNOWN_ENGINE_PRODUCT_IDS` in
   `src/lib/agent-engine/product-mapping.ts`), enforced by a test on
   whichever side does the mapping.
3. **`owner === "karos_agent"` without a valid `engineProductId` is a build
   error** on the side that owns the 75-row mapping table — this repo, once
   T-A4 lands. karos-portal cannot enforce a build error against a value
   arriving over the wire at runtime, so its parser
   (`toRoutableRecommendation` in `routable-recommendation.ts`) fails safe
   instead: a `karos_agent` record whose `engineProductId` is missing or not a
   `KNOWN_ENGINE_PRODUCT_IDS` member is downgraded to `client_manual` and the
   invalid id is dropped, rather than ever being routed to a product nobody
   validated. On this side, T-A4 should make the equivalent case an actual
   build/test failure, not a runtime fallback — this repo owns the mapping
   table, so it can enforce the invariant at the source.

## Where the mapping table itself lives

**Not here, and not in this document.** The 75-row `rec_id ->
{fixAction, actionKind, owner, engineProductId?}` table is, per the ticket,
this repo's own artifact: *"The mapping lives in the engine beside the
catalog (the same commit updates both); the portal consumes it through the
output and keeps no copy."* This means, concretely, for T-A4:

- The table lands beside `rec-catalog.data.ts`
  (`packages/tools/karos-seo-geo/src/config/`), in whatever file T-A4 picks.
- `recommend.ts`'s `FiredRecommendation` gets enriched with `check`/`lever`/
  `productRef` (already sitting unused in the catalog rows) plus
  `fixAction`/`actionKind`/`owner`/`engineProductId?` from the new table.
- `engineProductId` values are validated against this repo's own
  `KNOWN_PRODUCT_IDS` (`apps/agent-server/src/wiring/workflows.ts`) — Rule 3's
  actual enforcement point lives here, not in karos-portal's runtime
  fail-safe.

karos-portal's `routable-recommendation.ts` only defines the **shape** and a
**fail-safe parser** for whatever this repo eventually sends — it holds no
per-recId mapping data and never will. This repo's
`routable-recommendation-contract.ts` (added by this ticket) holds only the
three shared unions today, for the same reason: the mapping table is T-A4's
job, not this document's.

## What this repo has today (this ticket's contribution)

- `packages/tools/karos-seo-geo/src/routable-recommendation-contract.ts` —
  `FixAction`, `ActionKind`, `RecOwner` (ported verbatim from karos-portal's
  `src/lib/seo-geo.ts` for the first two, newly defined identically on both
  sides for the third), plus a `KNOWN_FIX_ACTIONS`/`KNOWN_ACTION_KINDS`/
  `KNOWN_REC_OWNERS` literal array for each, and `DEFAULT_REC_OWNER`
  (`"client_manual"`).
- `packages/tools/karos-seo-geo/__tests__/routable-recommendation-contract.test.ts`
  pins all three unions against the exact literal set this ticket documents.
  Unlike karos-portal's own pin (which parses `seo-geo.ts`'s live AST, since
  that file is local to that repo), this test hard-codes the expected literal
  set independently in the test file itself — there is no live agent-engine
  source of truth for these three unions to parse, since `seo-geo.ts` lives
  in karos-portal, a different repo.
- This document.

Not built here, and out of scope for this ticket: the mapping table itself,
any change to `recommend.ts`'s enrichment, and any change to
`rec-catalog.data.ts`. All three are T-A4/SCRUM-257's job.
