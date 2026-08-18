import { inputKeyFor, type InputMeasurement, type InputMeasurementData, type ScoringBucketConfig } from "@agent-engine/tool-karos-seo-geo";

/** A schema-valid placeholder `InputMeasurementData`, matched to the input's own normalization kind. Never read: `evaluateScoreFamily` only calls `evaluateNorm` when `coverage === "measured"` (see `karos-seo-geo/src/evaluate-scores.ts`), and every measurement this function produces is `coverage: "unavailable"`. */
function placeholderDataFor(normalization: string): InputMeasurementData {
  switch (normalization) {
    case "boolean":
      return { kind: "boolean", measured: false };
    case "count_with_target":
      return { kind: "count", actual: 0 };
    case "ratio_clamp":
      return { kind: "ratio", value: 0 };
    case "percentage":
      return { kind: "percentage", valuePct: 0 };
    case "lower_is_better_stepped":
      return { kind: "stepped", value: 0 };
    case "multi_bool":
      return { kind: "multiBool", subBools: [] };
    case "combine":
      return { kind: "combine", fields: {} };
    default:
      return { kind: "boolean", measured: false };
  }
}

/**
 * Phase 2 (RFC-04 §2): there is no real crawler wired up yet in this repo —
 * `research.pull`'s own "Phase 1 stand-in" comment
 * (`packages/tools/karos-research/src/pull.ts`) applies transitively here,
 * since the crawl snapshot it returns is just `{note, query}`, nothing a
 * measurement can honestly be derived from. Every SEO / GEO-Readiness input
 * this bucket set declares is therefore reported as `coverage: "unavailable"`
 * — never a fabricated boolean/count — so `grade_data_only_rule`
 * (`karos-seo-geo`'s own scoring config) correctly scores this run as 0
 * points for every one of these inputs, excludes them from
 * `dataCoveragePct`'s numerator, and flags the resulting score `partial`.
 * The day a real crawler adapter lands, this function is exactly the place
 * to start deriving genuine `measured` values from its output instead.
 */
export function buildUnavailableMeasurements(buckets: readonly ScoringBucketConfig[]): Record<string, InputMeasurement> {
  const measurements: Record<string, InputMeasurement> = {};
  for (const bucket of buckets) {
    bucket.inputs.forEach((input, index) => {
      const inputKey = inputKeyFor(bucket.name, index);
      measurements[inputKey] = { data: placeholderDataFor(input.params.normalization), coverage: "unavailable" };
    });
  }
  return measurements;
}
