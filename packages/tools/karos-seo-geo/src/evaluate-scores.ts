import { applyGate, evaluateNorm, gateStateFor } from "./normalize.js";
import { roundHalfUp } from "./round.js";
import type { ScoringBucketConfig } from "./scoring-config.js";
import type { BucketSubtotal, EvaluatedInput, InputMeasurement, ScoreBreakdown } from "./types.js";

/** Stable identity for one `inputs[]` entry — `rec_id` alone is not unique (e.g. BOTH-01 appears twice in the `eligibility` bucket with distinct measures). */
export function inputKeyFor(bucketName: string, indexInBucket: number): string {
  return `${bucketName}[${indexInBucket}]`;
}

/** Every `(bucket, index) -> inputKey` mapping for a bucket set, so callers know exactly which keys `measurements` must supply. */
export function listInputKeys(buckets: readonly ScoringBucketConfig[]): Array<{ inputKey: string; recId: string; bucket: string; measure: string; weight: number }> {
  return buckets.flatMap((bucket) =>
    bucket.inputs.map((input, index) => ({
      inputKey: inputKeyFor(bucket.name, index),
      recId: input.recId,
      bucket: bucket.name,
      measure: input.measure,
      weight: input.weight,
    })),
  );
}

/**
 * Evaluates one score family (SEO or GEO Readiness) against caller-supplied
 * measurements. `points_rule`: `input_points = norm * input_weight`;
 * `round_half_up` is applied exactly once, to the final total — never to a
 * bucket subtotal or an intermediate leg. Per bucket, each input's `weight`
 * already sums to the bucket's declared weight (e.g. `eligibility`'s five
 * inputs sum to 35), and every bucket's weight sums to 100 across the score
 * family — so the flat sum over every input IS the 0-100 score; buckets are
 * a reporting grouping, not a second multiplier.
 *
 * `grade_data_only_rule`: an `estimated`/`unavailable` measurement scores 0
 * points and its weight is excluded from `dataCoveragePct`'s numerator (but
 * still counted in the denominator) — the score is never silently rescaled
 * to "what was measured", it is conservatively under-counted and flagged
 * `partial` instead, so a partial run can never read as a passing one.
 */
export function evaluateScoreFamily(buckets: readonly ScoringBucketConfig[], measurements: Record<string, InputMeasurement>): ScoreBreakdown {
  const evaluatedInputs: EvaluatedInput[] = [];
  const bucketSubtotals: BucketSubtotal[] = [];
  let weightTotal = 0;
  let measuredWeight = 0;
  let totalPoints = 0;

  for (const bucket of buckets) {
    let bucketPoints = 0;
    let bucketWeight = 0;

    bucket.inputs.forEach((input, index) => {
      const inputKey = inputKeyFor(bucket.name, index);
      const measurement = measurements[inputKey];
      bucketWeight += input.weight;

      let norm = 0;
      let coverage: EvaluatedInput["coverage"] = "unavailable";
      let gated = false;
      let gateState: EvaluatedInput["gateState"] = "none";

      if (measurement) {
        coverage = measurement.coverage;
        if (measurement.coverage === "measured") {
          norm = evaluateNorm(input.params, measurement.data);
          if (input.gate) {
            gateState = gateStateFor(measurement.gatePass);
            // `gated` reports whether the gate withheld credit, NOT whether the number
            // happened to move: the old `gateResult !== norm` test could not fire when
            // the pre-gate norm already equalled `on_fail_norm` (the commonest case —
            // both are usually 0), so a failed gate went unreported in exactly the
            // situation an auditor most wants to see it.
            gated = gateState !== "pass";
            norm = applyGate(norm, measurement.gatePass, input.gate.onFailNorm);
          }
        }
      }

      const points = norm * input.weight;
      bucketPoints += points;
      if (coverage === "measured") measuredWeight += input.weight;

      evaluatedInputs.push({
        recId: input.recId,
        bucket: bucket.name,
        measure: input.measure,
        inputKey,
        weight: input.weight,
        norm,
        points,
        coverage,
        gated,
        gateState,
        normalization: input.params.normalization,
      });
    });

    bucketSubtotals.push({ bucket: bucket.name, weightTotal: bucketWeight, points: bucketPoints });
    weightTotal += bucketWeight;
    totalPoints += bucketPoints;
  }

  const dataCoveragePct = weightTotal > 0 ? (measuredWeight / weightTotal) * 100 : 0;

  return {
    score: roundHalfUp(totalPoints),
    weightTotal,
    dataCoveragePct,
    partial: dataCoveragePct < 100,
    bucketSubtotals,
    inputs: evaluatedInputs,
  };
}
