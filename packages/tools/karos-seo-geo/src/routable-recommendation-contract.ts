/**
 * Cross-repo contract types (SCRUM-210 / C2) — the vocabulary side of the
 * "routable recommendation" contract shared with karos-portal.
 *
 * WHY THIS FILE EXISTS. T-A4 (SCRUM-257) and T-A17 (SCRUM-261) — both
 * `Repo: agent-engine` tickets — need a real in-repo pointer to this
 * contract to build against. Before this file, the contract (its doc and
 * its types) existed only in karos-portal
 * (`docs/routable-recommendation-contract.md`,
 * `src/lib/agent-engine/routable-recommendation.ts`), so an agent-engine
 * engineer picking up T-A4 had zero in-repo reference. See
 * `../../../docs/routable-recommendation-contract.md` (this repo) for the
 * full spec — shape, invariants, and the fail-safe rules. This file is the
 * types-only half of that port.
 *
 * `FixAction` and `ActionKind` here are copied VERBATIM from karos-portal's
 * `src/lib/seo-geo.ts` — that file is the canonical source for both unions,
 * across both repos. Do not add, remove, or rename a member here without
 * first changing it there; `__tests__/routable-recommendation-contract.test.ts`
 * pins these three unions against the exact literal set this ticket
 * documents so an accidental drift fails a test, on this side, even though
 * there is no live agent-engine source of truth for these three unions to
 * parse (seo-geo.ts lives in the other repo).
 *
 * `RecOwner` is the three-way split the original SCRUM-210 requirement asked
 * for. `client_manual` is the fail-safe default everywhere this contract is
 * consumed: an unmapped, malformed, or not-yet-classified record is
 * `client_manual`, never silently promoted to something the platform runs
 * on its own.
 *
 * OUT OF SCOPE HERE, ON PURPOSE: the actual `rec_id ->
 * {fixAction, actionKind, owner, engineProductId?}` mapping table for the
 * 75 `rec-catalog.data.ts` records, and the `recommend.ts`/
 * `FiredRecommendation` enrichment that would carry these fields over the
 * wire. Both are T-A4/SCRUM-257's own deliverable — this file adds the
 * shared vocabulary T-A4 builds against, nothing more.
 */

/**
 * The eight machine-appliable fix types plus the advisory fallback.
 * Canonical source: karos-portal's `src/lib/seo-geo.ts` `FixAction` union.
 */
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

/** The literal `FixAction` members, for a runtime pin against the type above. */
export const KNOWN_FIX_ACTIONS = [
  "meta_title",
  "meta_description",
  "schema",
  "og_image",
  "canonical",
  "image_alt",
  "sitemap",
  "indexing",
  "manual",
] as const satisfies readonly FixAction[];

/**
 * How a fix ships, once its `FixAction` is known. Canonical source:
 * karos-portal's `src/lib/seo-geo.ts` `ActionKind` union.
 */
export type ActionKind = "one_click" | "review_approve" | "connect" | "guided_manual";

/** The literal `ActionKind` members, for a runtime pin against the type above. */
export const KNOWN_ACTION_KINDS = [
  "one_click",
  "review_approve",
  "connect",
  "guided_manual",
] as const satisfies readonly ActionKind[];

/**
 * The three categories a routable recommendation's fix can land in. New to
 * this contract (not sourced from `seo-geo.ts`) — the three-way split the
 * original SCRUM-210 requirement asked for.
 */
export type RecOwner = "karos_agent" | "karos_tool" | "client_manual";

/** The literal `RecOwner` members, for a runtime pin against the type above. */
export const KNOWN_REC_OWNERS = ["karos_agent", "karos_tool", "client_manual"] as const satisfies readonly RecOwner[];

/** Fail-safe default per the contract: an unmapped/unrecognized record never runs anything automatically. */
export const DEFAULT_REC_OWNER: RecOwner = "client_manual";
