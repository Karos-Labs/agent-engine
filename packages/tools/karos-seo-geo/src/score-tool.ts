import { defineTool, success } from "@agent-engine/tool-common";
import { GEO_READINESS_BUCKETS, REPRODUCIBILITY, SEO_BUCKETS } from "./scoring-config.js";
import { evaluateScoreFamily } from "./evaluate-scores.js";
import { computeVisibilityMetrics } from "./visibility-metrics.js";
import { computeVisibilityIndex } from "./visibility-index.js";
import { computeInputsDigest, type HashInputs } from "./hash.js";
import { ScoreInputSchema, type ScoreInput } from "./schemas.js";
import type { ScoreBreakdown, VisibilityIndexResult, VisibilityMetricsResult } from "./types.js";

const TOOL_VERSION = "1.0.0";

export interface SeoGeoScoreResult {
  seoScore: ScoreBreakdown;
  geoReadiness: ScoreBreakdown;
  visibility: VisibilityIndexResult | null;
  /**
   * The metrics the Index was computed from — carries the KNOWN/FOUND report
   * (`knownVsFound`, with its `neverBlend` marker) and the resolved
   * `denominatorDecision`. `null` whenever no capture data was supplied. This
   * is what a report should publish; `visibility.index` is the blended Index,
   * which pools cohorts by construction.
   */
  visibilityMetrics: VisibilityMetricsResult | null;
  inputsDigest: string;
  /** True whenever any hash_inputs field was omitted — the digest is well-formed but not yet a complete reproducibility snapshot. */
  hashInputsIncomplete: boolean;
}

/**
 * `seoGeo.score` (RFC-04 Phase 4): pure, deterministic — zero LLM judgment
 * calls. Wraps `evaluateScoreFamily` (SEO + GEO Readiness) and, when capture
 * data is supplied, the Visibility Index. Identical inputs (and an
 * identical `inputsDigest`) always produce identical integer scores per
 * `seo-geo-scoring-config.json`'s reproducibility rule.
 */
export function createSeoGeoScore() {
  return defineTool<ScoreInput, SeoGeoScoreResult>({
    name: "seoGeo.score",
    description:
      "Pure, deterministic SEO/GEO scoring — zero LLM judgment calls. Wraps evaluateScoreFamily for SEO + GEO Readiness and, when capture data is supplied, the Visibility Index. Identical inputs (and an identical inputsDigest) always produce identical integer scores.",
    version: TOOL_VERSION,
    inputSchema: ScoreInputSchema,
    async execute({ seoMeasurements, geoReadinessMeasurements, visibility, hashInputs }) {
      const seoScore = evaluateScoreFamily(SEO_BUCKETS, seoMeasurements);
      const geoReadiness = evaluateScoreFamily(GEO_READINESS_BUCKETS, geoReadinessMeasurements);

      let visibilityIndex: VisibilityIndexResult | null = null;
      let visibilityMetrics: VisibilityMetricsResult | null = null;
      if (visibility) {
        visibilityMetrics = computeVisibilityMetrics({
          cells: visibility.cells,
          promptCount: visibility.promptCount,
          clientDomains: visibility.clientDomains,
          competitorRoster: visibility.competitorRoster,
          competitorDomains: visibility.competitorDomains,
          promptCohorts: visibility.promptCohorts,
          denominator: visibility.denominator,
        });
        visibilityIndex = computeVisibilityIndex(visibilityMetrics);
      }

      const hashInputsIncomplete = REPRODUCIBILITY.hash_inputs.some((field) => !hashInputs[field]);
      const inputsDigest = computeInputsDigest(hashInputs as HashInputs);

      return success<SeoGeoScoreResult>({
        seoScore,
        geoReadiness,
        visibility: visibilityIndex,
        visibilityMetrics,
        inputsDigest,
        hashInputsIncomplete,
      });
    },
  });
}
