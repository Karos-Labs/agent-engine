import { recCatalogData } from "./config/rec-catalog.data.js";
import { routingFor } from "./config/rec-routing-map.js";
import { roundHalfUp } from "./round.js";
import type { ActionKind, FixAction, RecOwner } from "./routable-recommendation-contract.js";

/** Failing these hard-gates the queue jumps the normal priority ordering (`routing-config.json` `trigger.priority_formula`). */
const CRITICAL_ELIGIBILITY_RECS = new Set(["BOTH-01", "BOTH-02", "GEO-01", "GEO-08", "GEO-10"]);

const IMPACT_W: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const EFFORT_W: Record<string, number> = { quick: 3, medium: 2, heavy: 1 };
const DELIVERABILITY_BONUS: Record<string, number> = { "agent-direct": 2, "existing-product": 1, "new-product": 0 };
const HARD_OVERRIDE_BONUS = 100_000;

export type FireState = "pass" | "approaching" | "fail";

export type InstanceNormalization =
  | "boolean"
  | "count_with_target"
  | "ratio_clamp"
  | "percentage"
  | "lower_is_better_stepped"
  | "multi_bool"
  | "combine";

/** Normalization primitives `trigger.fires_when` gives NO "approaching" tier to — anything short of norm==1 is a hard fail, never partial credit. */
const BINARY_ONLY_NORMALIZATIONS = new Set<InstanceNormalization>(["boolean", "multi_bool"]);

export interface RecInputInstance {
  norm: number;
  weight: number;
  /** Which primitive computed this instance's norm — required to apply `trigger.fires_when`'s boolean/multi_bool override correctly. */
  normalization: InstanceNormalization;
}

export interface FiredRecommendation {
  recId: string;
  recommendation: string;
  fireState: FireState;
  worstNorm: number;
  scoreLift: number;
  impact: string;
  effort: string;
  delivery: string;
  priorityScore: number;
  hardOverride: boolean;
}

/** The catalog's `lever` field. `"BOTH"` is the contract's default for an absent or unrecognized value. */
export type RecLever = "SEO" | "GEO" | "BOTH";
const KNOWN_LEVERS = new Set<string>(["SEO", "GEO", "BOTH"]);

/** The catalog's `product_ref` — a **lab** product/folder reference, never an engine `productId` (contract Rule 1). */
export interface CatalogProductRef {
  id: string;
  folder: string;
  status: string;
}

/**
 * The wire shape of a fired recommendation (SCRUM-257 / T-A4), per
 * `docs/routable-recommendation-contract.md` §"The canonical shape".
 *
 * It **extends** `FiredRecommendation` rather than replacing it: all ten
 * scoring fields are untouched, and every existing consumer that reads a
 * `FiredRecommendation[]` keeps working unchanged. What is added is the two
 * halves the old wire shape threw away:
 *
 *  - `check`/`lever`/`productRef` were sitting on each `rec-catalog.data.ts`
 *    row all along and were simply never read — `recommend.ts` only ever
 *    touched `recommendation`/`impact`/`effort`/`delivery`/`source`;
 *  - `fixAction`/`actionKind`/`owner`/`engineProductId` come from
 *    `config/rec-routing-map.ts`, this ticket's 75-row table.
 *
 * `engineProductId` is present only when `owner === "karos_agent"`, which the
 * routing table enforces in its own type (contract Rule 3).
 */
export interface RoutableRecommendation extends FiredRecommendation {
  /** The failing check — the evidence behind the recommendation (catalog `check`). */
  check: string;
  lever: RecLever;
  /** Catalog `product_ref`. `folder` is a lab folder name, never an engine `productId` (Rule 1). */
  productRef: CatalogProductRef | null;
  fixAction: FixAction;
  actionKind: ActionKind;
  owner: RecOwner;
  /**
   * Part of the contract's shape table, kept here so this side emits the same
   * field set karos-portal's parser reads. No `rec-catalog.data.ts` record
   * carries a target platform today, so nothing populates it — it is left
   * absent rather than filled with a guess.
   */
  targetPlatform?: string;
  /** Only present when `owner === "karos_agent"`; a `KNOWN_PRODUCT_IDS` member, pinned by test. */
  engineProductId?: string;
}

/**
 * `trigger.fires_when`: "per distinct rec_id, FIRE if min(norm across
 * weighted input_weight>0 instances) < 1.0. Bands: norm>=1.0 pass (no
 * action); 0.75<=norm<1.0 under_threshold/approaching (fires); norm<0.75
 * fail (fires). **boolean/multi_bool: norm==1 pass else fail.**" The last
 * sentence is a distinct override, not a restatement of the generic bands —
 * a boolean/multi_bool-typed instance has no "approaching" tier at all;
 * anything short of a clean pass is a hard fail, classified on the WORST
 * instance's own normalization type.
 */
function classifyFireState(norm: number, normalization: InstanceNormalization): FireState {
  if (BINARY_ONLY_NORMALIZATIONS.has(normalization)) {
    return norm === 1 ? "pass" : "fail";
  }
  if (norm >= 1.0) return "pass";
  if (norm >= 0.75) return "approaching";
  return "fail";
}

/** `evidence_penalty`: source strings tagged `[VENDOR-correlational]` get penalized; every other provenance is 0. */
function evidencePenaltyFor(source: string): number {
  return source.includes("VENDOR-correlational") ? 1 : 0;
}

type RecCatalogEntry = {
  recommendation: string;
  impact: string;
  effort: string;
  delivery: string;
  source: string;
  /** Read since SCRUM-257 — the evidence half of the routable contract, previously discarded. */
  check?: string;
  lever?: string;
  product_ref?: { id: string; folder: string; status: string } | null;
};
const RAW_CATALOG = recCatalogData as unknown as Record<string, RecCatalogEntry>;

/** Contract default: an absent or unrecognized `lever` is `"BOTH"`, never dropped and never guessed at. */
function leverOf(catalogEntry: RecCatalogEntry): RecLever {
  const raw = catalogEntry.lever;
  return raw !== undefined && KNOWN_LEVERS.has(raw) ? (raw as RecLever) : "BOTH";
}

/** Contract default: `check` is a string on the wire, empty when the catalog row has none. */
function checkOf(catalogEntry: RecCatalogEntry): string {
  return catalogEntry.check ?? "";
}

/** Normalizes the catalog's `product_ref` to `{id, folder, status} | null` — `folder` stays a lab folder name (Rule 1). */
function productRefOf(catalogEntry: RecCatalogEntry): CatalogProductRef | null {
  const ref = catalogEntry.product_ref;
  if (!ref) return null;
  return { id: ref.id, folder: ref.folder, status: ref.status };
}

/**
 * Rec-firing + priority engine, ported verbatim from `seo-geo-routing-config.json`
 * `trigger.fires_when` / `trigger.priority_formula`. `inputValuesByRecId` is
 * the roll-up of `evaluateScoreFamily`'s `EvaluatedInput[]` grouped by
 * `recId` — this function never re-measures anything, it only interprets
 * already-computed norms (RFC-04 Phase 6 is a deterministic rule, not a new
 * scoring pass).
 *
 * `priority_score = 100*IMPACT_W*EFFORT_W + 20*(1-worst_norm) +
 * 10*(fire_state=='fail') + 5*deliverability_bonus - 3*evidence_penalty`.
 * Failing a critical-eligibility rec (BOTH-01, BOTH-02, GEO-01, GEO-08,
 * GEO-10) jumps the queue via a large additive override, never a silent
 * reprioritization of the base formula.
 *
 * Since SCRUM-257 every fired row is a `RoutableRecommendation`: the ten
 * scoring fields, unchanged, plus the catalog's own `check`/`lever`/
 * `product_ref` and this repo's `config/rec-routing-map.ts` routing. None of
 * the scoring arithmetic reads any of those — enrichment is attachment, not
 * input, so the priority queue is bit-identical to before.
 */
export function evaluateRecommendations(inputValuesByRecId: Record<string, RecInputInstance[]>): RoutableRecommendation[] {
  const fired: RoutableRecommendation[] = [];

  for (const [recId, catalogEntry] of Object.entries(RAW_CATALOG)) {
    const instances = (inputValuesByRecId[recId] ?? []).filter((i) => i.weight > 0);
    if (instances.length === 0) continue; // no scored instance for this rec in this run — nothing to roll up.

    const worst = instances.reduce((min, i) => (i.norm < min.norm ? i : min));
    const fireState = classifyFireState(worst.norm, worst.normalization);
    if (fireState === "pass") continue; // norm>=1.0: no action.

    const scoreLift = (1 - worst.norm) * worst.weight;
    const impactW = IMPACT_W[catalogEntry.impact] ?? 1;
    const effortW = EFFORT_W[catalogEntry.effort] ?? 1;
    const deliverabilityBonus = DELIVERABILITY_BONUS[catalogEntry.delivery] ?? 0;
    const evidencePenalty = evidencePenaltyFor(catalogEntry.source);

    const basePriority =
      100 * impactW * effortW + 20 * (1 - worst.norm) + 10 * (fireState === "fail" ? 1 : 0) + 5 * deliverabilityBonus - 3 * evidencePenalty;

    const hardOverride = fireState === "fail" && CRITICAL_ELIGIBILITY_RECS.has(recId);
    const priorityScore = hardOverride ? basePriority + HARD_OVERRIDE_BONUS : basePriority;

    const routing = routingFor(recId);
    fired.push({
      recId,
      recommendation: catalogEntry.recommendation,
      fireState,
      worstNorm: worst.norm,
      scoreLift: roundHalfUp(scoreLift * 100) / 100,
      impact: catalogEntry.impact,
      effort: catalogEntry.effort,
      delivery: catalogEntry.delivery,
      priorityScore,
      hardOverride,
      check: checkOf(catalogEntry),
      lever: leverOf(catalogEntry),
      productRef: productRefOf(catalogEntry),
      fixAction: routing.fixAction,
      actionKind: routing.actionKind,
      owner: routing.owner,
      // Spread rather than `engineProductId: routing.engineProductId`, so a non-`karos_agent` row
      // emits no key at all instead of an explicit `undefined` on the wire.
      ...(routing.owner === "karos_agent" ? { engineProductId: routing.engineProductId } : {}),
    });
  }

  // Final tiebreak: priority desc, then impact rank, effort, rec_id ascending.
  return fired.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    const impactDiff = (IMPACT_W[b.impact] ?? 0) - (IMPACT_W[a.impact] ?? 0);
    if (impactDiff !== 0) return impactDiff;
    const effortDiff = (EFFORT_W[b.effort] ?? 0) - (EFFORT_W[a.effort] ?? 0);
    if (effortDiff !== 0) return effortDiff;
    return a.recId.localeCompare(b.recId);
  });
}

export interface CatalogCoverage {
  /** Every rec_id in `rec-catalog.data.ts`. */
  catalogRecIds: string[];
  /** rec_ids the scoring config actually produces a scored instance for — the only ones `evaluateRecommendations` can ever fire. */
  scoredRecIds: string[];
  /** In the catalog but never scored: these recommendations are structurally unfirable, no matter what a run measures. */
  unscoredCatalogRecIds: string[];
  /** Referenced by the scoring config but absent from the catalog: these would be scored and then silently dropped. */
  uncatalogedScoredRecIds: string[];
}

/**
 * Diffs the rec catalog against the rec_ids the scoring config actually
 * scores. `evaluateRecommendations` skips any rec with no scored instance,
 * so a catalog entry the scoring config never references can never fire —
 * it is a recommendation the engine is structurally incapable of making.
 *
 * SCRUM-318 (AU27) asks for the agent-engine catalog to be reconciled
 * against v2's, which is the authority on which of these gaps are v2
 * additions still to be wired up and which are dead entries to drop. That
 * comparison could not be made here (`karos-agents` is unreachable from
 * this environment), so this function exposes the measurement instead of
 * asserting a conclusion: the gap is now countable and testable, and
 * SCRUM-319/320 can reconcile against a real number rather than a guess.
 */
export function computeCatalogCoverage(scoredRecIds: Iterable<string>): CatalogCoverage {
  const catalog = new Set(Object.keys(RAW_CATALOG));
  const scored = new Set(scoredRecIds);
  return {
    catalogRecIds: [...catalog].sort(),
    scoredRecIds: [...scored].sort(),
    unscoredCatalogRecIds: [...catalog].filter((r) => !scored.has(r)).sort(),
    uncatalogedScoredRecIds: [...scored].filter((r) => !catalog.has(r)).sort(),
  };
}

/** Groups `evaluateScoreFamily`'s flat `EvaluatedInput[]` by `recId`, the shape `evaluateRecommendations` expects. */
export function groupInputsByRecId(
  inputs: readonly { recId: string; norm: number; weight: number; normalization: InstanceNormalization }[],
): Record<string, RecInputInstance[]> {
  const grouped: Record<string, RecInputInstance[]> = {};
  for (const input of inputs) {
    (grouped[input.recId] ??= []).push({ norm: input.norm, weight: input.weight, normalization: input.normalization });
  }
  return grouped;
}
