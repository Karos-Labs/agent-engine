import { defineTool, success } from "@agent-engine/tool-common";
import { GEO_READINESS_BUCKETS, REPRODUCIBILITY, SEO_BUCKETS } from "./scoring-config.js";
import { evaluateScoreFamily } from "./evaluate-scores.js";
import { computeVisibilityMetrics } from "./visibility-metrics.js";
import { computeVisibilityIndex } from "./visibility-index.js";
import { computeInputsDigest, type HashInputs } from "./hash.js";
import { ScoreInputSchema, type ScoreInput } from "./schemas.js";
import type { ScoreBreakdown, VisibilityIndexResult } from "./types.js";

const TOOL_VERSION = "1.0.0";

export interface SeoGeoScoreResult {
  seoScore: ScoreBreakdown;
  geoReadiness: ScoreBreakdown;
  visibility: VisibilityIndexResult | null;
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
    version: TOOL_VERSION,
    inputSchema: ScoreInputSchema,
    async execute({ seoMeasurements, geoReadinessMeasurements, visibility, hashInputs }) {
      const seoScore = evaluateScoreFamily(SEO_BUCKETS, seoMeasurements);
      const geoReadiness = evaluateScoreFamily(GEO_READINESS_BUCKETS, geoReadinessMeasurements);

      let visibilityIndex: VisibilityIndexResult | null = null;
      if (visibility) {
        const metrics = computeVisibilityMetrics({
          cells: visibility.cells,
          promptCount: visibility.promptCount,
          clientDomains: visibility.clientDomains,
          competitorRoster: visibility.competitorRoster,
          competitorDomains: visibility.competitorDomains,
          denominator: visibility.denominator,
        });
        visibilityIndex = computeVisibilityIndex(metrics);
      }

      const hashInputsIncomplete = REPRODUCIBILITY.hash_inputs.some((field) => !hashInputs[field]);
      const inputsDigest = computeInputsDigest(hashInputs as HashInputs);

      return success<SeoGeoScoreResult>({
        seoScore,
        geoReadiness,
        visibility: visibilityIndex,
        inputsDigest,
        hashInputsIncomplete,
      });
    },
  });
}
