import { scoringConfigData } from "./config/scoring-config.data.js";
import type { CombineLeg, NormalizationParams, SteppedBand } from "./normalize.js";

export interface ScoringInputConfig {
  recId: string;
  measure: string;
  weight: number;
  params: NormalizationParams;
  gate?: { field: string; onFailNorm: number };
}

export interface ScoringBucketConfig {
  name: string;
  weight: number;
  inputs: ScoringInputConfig[];
}

/**
 * The raw config asset is a trusted, verbatim, statically-embedded literal
 * (`config/scoring-config.data.ts` — see that file's header), so this
 * adapter reads its loosely-typed shape by field presence rather than
 * fighting TypeScript's inferred union of every bucket's distinct input
 * shape; the output (`ScoringInputConfig`) is what the rest of this package
 * actually type-checks against.
 */
function toParams(raw: Record<string, unknown>): NormalizationParams {
  return {
    normalization: raw.normalization as NormalizationParams["normalization"],
    target: typeof raw.target === "number" ? raw.target : undefined,
    bands: Array.isArray(raw.bands) ? (raw.bands as unknown as SteppedBand[]) : undefined,
    combine: raw.combine as "mean" | "product" | undefined,
    legs: Array.isArray(raw.legs) ? (raw.legs as unknown as CombineLeg[]) : undefined,
  };
}

function toInput(raw: Record<string, unknown>): ScoringInputConfig {
  const gateRaw = raw.gate as { field: string; on_fail_norm: number } | undefined;
  const input: ScoringInputConfig = {
    recId: raw.rec_id as string,
    measure: raw.measure as string,
    weight: raw.weight as number,
    params: toParams(raw),
  };
  if (gateRaw) {
    input.gate = { field: gateRaw.field, onFailNorm: gateRaw.on_fail_norm };
  }
  return input;
}

function toBucket(raw: Record<string, unknown>): ScoringBucketConfig {
  return {
    name: raw.name as string,
    weight: raw.weight as number,
    inputs: (raw.inputs as Record<string, unknown>[]).map(toInput),
  };
}

export const SEO_BUCKETS: ScoringBucketConfig[] = (
  scoringConfigData.scores.seo.buckets as unknown as Record<string, unknown>[]
).map(toBucket);

export const GEO_READINESS_BUCKETS: ScoringBucketConfig[] = (
  scoringConfigData.scores.geo_readiness.buckets as unknown as Record<string, unknown>[]
).map(toBucket);

export const VISIBILITY_INDEX_COMPONENTS = scoringConfigData.visibility.index.components;
export const VISIBILITY_ENGINES_CONFIG = scoringConfigData.visibility.engines;
export const CONSTANTS = scoringConfigData.constants;
export const REPRODUCIBILITY = scoringConfigData.reproducibility;
export const GEO_SCORE_MODEL = scoringConfigData.geo_score_model;
export const GRADE_DATA_ONLY_RULE = scoringConfigData.grade_data_only_rule;
