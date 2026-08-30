import type { AgentToolRegistry } from "@agent-engine/core";
import { createSeoGeoScore } from "./score-tool.js";
import { createSeoGeoRecommend } from "./recommend-tool.js";

export * from "./types.js";
export * from "./round.js";
export * from "./normalize.js";
export * from "./scoring-config.js";
export * from "./evaluate-scores.js";
export * from "./visibility-metrics.js";
export * from "./visibility-index.js";
export * from "./geo-score-model.js";
export * from "./hash.js";
export * from "./recommend.js";
export * from "./schemas.js";
export * from "./score-tool.js";
export * from "./recommend-tool.js";
export * from "./routable-recommendation-contract.js";
// SCRUM-257: the 75-row rec_id -> routing table `recommend.ts` enriches against.
export * from "./config/rec-routing-map.js";
export { GRADE_DATA_ONLY_RULE } from "./scoring-config.js";

/** The `karos-seo-geo` tool registry (RFC-04 Phase 4/6) — deterministic scoring and rec-firing, zero LLM judgment calls. */
export function createKarosSeoGeoTools(): AgentToolRegistry {
  return {
    "seoGeo.score": createSeoGeoScore(),
    "seoGeo.recommend": createSeoGeoRecommend(),
  };
}
