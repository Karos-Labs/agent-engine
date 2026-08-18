import { describe, expect, it } from "vitest";
import { SEO_BUCKETS, GEO_READINESS_BUCKETS, type ScoringBucketConfig, type ScoringInputConfig } from "../src/scoring-config.js";
import { evaluateScoreFamily, inputKeyFor, listInputKeys } from "../src/evaluate-scores.js";
import type { InputMeasurement, InputMeasurementData } from "../src/types.js";
import type { CombineLeg } from "../src/normalize.js";

/** Synthesizes a measurement that scores norm==1 for any config input, regardless of its normalization primitive — used to prove "everything passing" produces exactly 100. */
function perfectData(params: ScoringInputConfig["params"]): InputMeasurementData {
  switch (params.normalization) {
    case "boolean":
      return { kind: "boolean", measured: true };
    case "count_with_target":
      return { kind: "count", actual: params.target ?? 1 };
    case "ratio_clamp":
      return { kind: "ratio", value: params.target ?? 1 };
    case "percentage":
      return { kind: "percentage", valuePct: params.target ?? 100 };
    case "lower_is_better_stepped": {
      const firstBand = (params.bands ?? [])[0];
      return { kind: "stepped", value: firstBand?.[0] ?? 0 };
    }
    case "multi_bool":
      return { kind: "multiBool", subBools: [true, true, true] };
    case "combine": {
      const fields: Record<string, number | boolean> = {};
      for (const leg of params.legs ?? []) {
        fields[leg.field] = perfectLegValue(leg);
      }
      return { kind: "combine", fields };
    }
  }
}

function perfectLegValue(leg: CombineLeg): number | boolean {
  switch (leg.fn) {
    case "boolean":
      return true;
    case "count_with_target":
      return leg.target;
    case "ratio_clamp":
    case "percentage":
      return leg.target;
    case "lower_is_better_stepped":
      return leg.bands[0]?.[0] ?? 0;
  }
}

function perfectMeasurements(buckets: readonly ScoringBucketConfig[]): Record<string, InputMeasurement> {
  const measurements: Record<string, InputMeasurement> = {};
  buckets.forEach((bucket) => {
    bucket.inputs.forEach((input, index) => {
      const key = inputKeyFor(bucket.name, index);
      const measurement: InputMeasurement = { data: perfectData(input.params), coverage: "measured" };
      if (input.gate) measurement.gatePass = true;
      measurements[key] = measurement;
    });
  });
  return measurements;
}

describe("evaluateScoreFamily against the real seo-geo-scoring-config.json bucket data", () => {
  it("SEO: every input measured and passing scores exactly 100, full coverage, not partial", () => {
    const result = evaluateScoreFamily(SEO_BUCKETS, perfectMeasurements(SEO_BUCKETS));
    expect(result.score).toBe(100);
    expect(result.dataCoveragePct).toBe(100);
    expect(result.partial).toBe(false);
  });

  it("GEO Readiness: every input measured and passing scores exactly 100", () => {
    const result = evaluateScoreFamily(GEO_READINESS_BUCKETS, perfectMeasurements(GEO_READINESS_BUCKETS));
    expect(result.score).toBe(100);
    expect(result.dataCoveragePct).toBe(100);
  });

  it("no measurements supplied at all scores 0 and is fully partial (grade_data_only_rule: never fabricate a number)", () => {
    const result = evaluateScoreFamily(SEO_BUCKETS, {});
    expect(result.score).toBe(0);
    expect(result.dataCoveragePct).toBe(0);
    expect(result.partial).toBe(true);
  });

  it("an estimated/unavailable measurement scores 0 for that input and is excluded from the coverage numerator, but the input's weight still counts in the denominator", () => {
    const measurements = perfectMeasurements(SEO_BUCKETS);
    const keys = listInputKeys(SEO_BUCKETS);
    const firstKey = keys[0]!;
    measurements[firstKey.inputKey] = { data: { kind: "boolean", measured: true }, coverage: "estimated" };

    const result = evaluateScoreFamily(SEO_BUCKETS, measurements);
    expect(result.score).toBe(100 - firstKey.weight);
    expect(result.dataCoveragePct).toBeCloseTo(((result.weightTotal - firstKey.weight) / result.weightTotal) * 100);
    expect(result.partial).toBe(true);
  });

  it("GEO-18's anti-stuffing gate forces norm to 0 even when the raw count would otherwise pass", () => {
    const geo18Key = listInputKeys(GEO_READINESS_BUCKETS).find((k) => k.recId === "GEO-18")!;
    const measurements = perfectMeasurements(GEO_READINESS_BUCKETS);
    measurements[geo18Key.inputKey] = { data: { kind: "count", actual: 20 }, coverage: "measured", gatePass: false };

    const result = evaluateScoreFamily(GEO_READINESS_BUCKETS, measurements);
    const geo18Result = result.inputs.find((i) => i.inputKey === geo18Key.inputKey)!;
    expect(geo18Result.norm).toBe(0);
    expect(geo18Result.gated).toBe(true);
    expect(result.score).toBe(100 - geo18Key.weight);
  });

  it("a rec_id repeated across distinct instances (BOTH-01 appears twice in the eligibility bucket) is tracked as two independent inputs, not collapsed", () => {
    const both01Keys = listInputKeys(SEO_BUCKETS).filter((k) => k.recId === "BOTH-01");
    expect(both01Keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(both01Keys.map((k) => k.inputKey)).size).toBe(both01Keys.length);
  });

  it("bucket subtotals sum to the same total as the flat score", () => {
    const result = evaluateScoreFamily(SEO_BUCKETS, perfectMeasurements(SEO_BUCKETS));
    const bucketSum = result.bucketSubtotals.reduce((sum, b) => sum + b.points, 0);
    expect(Math.round(bucketSum)).toBe(result.score);
  });
});
