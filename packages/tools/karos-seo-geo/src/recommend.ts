import { recCatalogData } from "./config/rec-catalog.data.js";
import { roundHalfUp } from "./round.js";

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

type RecCatalogEntry = { recommendation: string; impact: string; effort: string; delivery: string; source: string };
const RAW_CATALOG = recCatalogData as unknown as Record<string, RecCatalogEntry>;

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
 */
export function evaluateRecommendations(inputValuesByRecId: Record<string, RecInputInstance[]>): FiredRecommendation[] {
  const fired: FiredRecommendation[] = [];

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
