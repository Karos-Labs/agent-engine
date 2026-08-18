import { CONSTANTS } from "./scoring-config.js";
import { roundHalfUp, clamp } from "./round.js";
import type { VisibilityIndexResult, VisibilityMetricsResult } from "./types.js";

/**
 * The 6-component Visibility Index (`seo-geo-scoring-config.json`
 * `visibility.index`), weights summing to 100. Each component's `norm` is
 * computed from its exact named `value` formula in the config, then
 * `ratio_clamp`'d against its target — ported as fixed formulas (not a
 * generic interpreter) because each one names a distinct derived quantity,
 * unlike the SEO/GEO Readiness buckets which are homogeneous input lists.
 *
 * `Visibility_Index = round_half_up(100 * sum_component(weight/100 * norm))`.
 */
export function computeVisibilityIndex(metrics: VisibilityMetricsResult): VisibilityIndexResult {
  const targetCite = CONSTANTS.TARGET_CITE;
  const targetMention = CONSTANTS.TARGET_MENTION;

  const meanFirstPositionRate = metrics.perEngine.reduce((sum, e) => sum + e.firstPositionRate, 0) / metrics.perEngine.length;
  const meanNetSentiment = metrics.perEngine.reduce((sum, e) => sum + e.netSentiment, 0) / metrics.perEngine.length;
  const meanGhostCitationRate = metrics.perEngine.reduce((sum, e) => sum + e.ghostCitationRate, 0) / metrics.perEngine.length;

  const components = [
    {
      recId: "GEO-11",
      name: "citation_share",
      weight: 35,
      norm: clamp(metrics.citationShareBlended / targetCite, 0, 1),
    },
    {
      recId: "BOTH-14",
      name: "who_ranks_first",
      weight: 20,
      norm: clamp(meanFirstPositionRate / 1.0, 0, 1),
    },
    {
      recId: "GEO-27",
      name: "share_of_voice",
      weight: 20,
      norm: clamp(metrics.shareOfVoiceClient / 100 / (1 / metrics.rosterSize), 0, 1),
    },
    {
      recId: "GEO-35",
      name: "named_mention_rate",
      weight: 15,
      norm: clamp(metrics.mentionRateBlended / targetMention, 0, 1),
    },
    {
      recId: "GEO-32",
      name: "sentiment",
      weight: 6,
      norm: clamp((meanNetSentiment + 1) / 2, 0, 1),
    },
    {
      recId: "GEO-26",
      name: "ghost_penalty",
      weight: 4,
      norm: clamp(1 - clamp(meanGhostCitationRate / 100, 0, 1), 0, 1),
    },
  ].map((c) => ({ ...c, points: (c.weight / 100) * c.norm * 100 }));

  const index = roundHalfUp(components.reduce((sum, c) => sum + c.points, 0));

  return { index, componentNorms: components };
}
