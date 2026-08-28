import { defineTool, success } from "@agent-engine/tool-common";
import { evaluateRecommendations, groupInputsByRecId, type FiredRecommendation } from "./recommend.js";
import { RecommendInputSchema, type RecommendInput } from "./schemas.js";

const TOOL_VERSION = "1.0.0";

export interface SeoGeoRecommendResult {
  fired: FiredRecommendation[];
}

/**
 * `seoGeo.recommend` (RFC-04 Phase 6): deterministic rec-firing off
 * already-computed norms — reads `seoGeo.score`'s per-input breakdown, never
 * re-measures anything. Consumes the flat `EvaluatedInput[]` from
 * `evaluateScoreFamily`'s SEO/GEO Readiness runs (pass their `.inputs`
 * arrays here as `seoInputs`/`geoReadinessInputs`).
 */
export function createSeoGeoRecommend() {
  return defineTool<RecommendInput, SeoGeoRecommendResult>({
    name: "seoGeo.recommend",
    description:
      "Deterministic rec-firing off already-computed norms — reads seoGeo.score's per-input breakdown, never re-measures anything. Pass evaluateScoreFamily's SEO/GEO Readiness .inputs arrays as seoInputs/geoReadinessInputs.",
    version: TOOL_VERSION,
    inputSchema: RecommendInputSchema,
    async execute({ seoInputs, geoReadinessInputs }) {
      const grouped = groupInputsByRecId([...seoInputs, ...geoReadinessInputs]);
      const fired = evaluateRecommendations(grouped);
      return success<SeoGeoRecommendResult>({ fired });
    },
  });
}
