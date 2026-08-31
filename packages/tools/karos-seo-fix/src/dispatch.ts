import { KNOWN_FIX_ACTIONS } from "@agent-engine/tool-karos-seo-geo";
import { PROPOSAL_BUILDERS } from "./artifact-proposals.js";
import type { SeoFixArtifact, SeoFixDispatchOutcome, SeoFixInput, SeoFixProposal } from "./types.js";

const KNOWN_FIX_ACTION_SET = new Set<string>(KNOWN_FIX_ACTIONS);

export interface DispatchSeoFixOptions {
  /** Injectable clock, for deterministic tests. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

/**
 * The SEO/GEO fix actuator's one dispatch entry point (SCRUM-261 / T-A17).
 *
 * Takes one routed, fired recommendation (T-A4/SCRUM-257's enrichment —
 * `SeoFixInput`, i.e. `@agent-engine/tool-karos-seo-geo`'s
 * `RoutableRecommendation`) and returns either a populated `artifactRef`
 * (`SeoFixDispatchSuccess`) or a typed refusal (`SeoFixRefusal`) — never
 * `null`, never a thrown exception for an expected-shape input.
 *
 * ## Generic on `fixAction`/`owner`, by construction
 *
 * The two decisions this function makes are both table lookups, never a
 * conditional keyed on `recId`:
 *
 *   1. `rec.actionKind === "connect"` → refuse (`requires_external_connection`),
 *      whatever the `fixAction`/`owner`/`recId` is. This is the SCRUM-261
 *      scope guard applied mechanically: `connect` means an external account
 *      or credential this actuator does not hold is required first (RFC-09
 *      §4 path B), so there is nothing safe to draft yet.
 *   2. Otherwise, `PROPOSAL_BUILDERS[rec.fixAction]` (`artifact-proposals.ts`)
 *      — one generator per `FixAction`, keyed on the union itself. Adding a
 *      tenth `FixAction` member is a `tsc` error in that file's `Record`
 *      literal, not a silently-missed `case`; there is no `recId` anywhere in
 *      this function's control flow.
 *
 * `owner` is read for the artifact's own record (so a caller can see who
 * would perform the fix) but never branches dispatch — every non-`connect`
 * `owner` (`karos_agent`, `karos_tool`, `client_manual`) gets the same
 * artifact-shaped-by-`fixAction` treatment. This mirrors RFC-09 §3's own
 * rule that a previewable artifact is produced before ANY write, for
 * `one_click` and `review_approve` alike — the artifact step doesn't change
 * shape by who eventually applies it; only what happens *after* dispatch
 * (never built here) depends on that.
 *
 * ## Why this refuses rather than returning `null`
 *
 * An unmapped/malformed `fixAction` arriving over a wire boundary (this
 * function's own parameter type cannot stop that — see `types.ts`'s
 * `unknown_fix_action` doc) must not silently become "no artifact, no
 * error" — that is indistinguishable from "nothing was wrong to fix,"
 * which is a false negative a downstream approval queue could act on. The
 * acceptance criteria's negative test pins this: refusing beats guessing,
 * and refusing beats vanishing.
 */
export function dispatchSeoFix(rec: SeoFixInput, options: DispatchSeoFixOptions = {}): SeoFixDispatchOutcome {
  if (!KNOWN_FIX_ACTION_SET.has(rec.fixAction)) {
    return {
      ok: false,
      recId: rec.recId,
      reason: "unknown_fix_action",
      detail: `${rec.recId}: "${rec.fixAction}" is not a known FixAction — refusing rather than guessing an artifact.`,
    };
  }

  if (rec.actionKind === "connect") {
    return {
      ok: false,
      recId: rec.recId,
      reason: "requires_external_connection",
      detail: `${rec.recId}: routed "connect" — an external account/credential is required before any artifact can be drafted, and this actuator holds none (SCRUM-261 scope guard).`,
    };
  }

  const buildProposal = PROPOSAL_BUILDERS[rec.fixAction] as (input: SeoFixInput) => SeoFixProposal;
  const proposal = buildProposal(rec);
  const now = options.now ?? (() => new Date().toISOString());

  const artifact: SeoFixArtifact = {
    recId: rec.recId,
    fixAction: rec.fixAction,
    actionKind: rec.actionKind,
    owner: rec.owner,
    summary: `Drafted a ${rec.fixAction} fix for ${rec.recId}: ${rec.recommendation}`,
    proposal,
    generatedAt: now(),
  };

  return {
    ok: true,
    // Logical, deterministic reference — see `SeoFixDispatchSuccess.artifactRef`'s doc for why this
    // is not yet a real persisted path, and the SCRUM-261 report for the integration that would make it one.
    artifactRef: `seo-fix/${rec.recId}/${rec.fixAction}`,
    actionKind: rec.actionKind,
    artifact,
  };
}
