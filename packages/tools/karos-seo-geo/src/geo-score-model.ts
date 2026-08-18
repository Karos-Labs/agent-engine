import { GEO_SCORE_MODEL } from "./scoring-config.js";
import { roundHalfUp, clamp } from "./round.js";
import type { GeoScoreModelResult, SeoGeoVisibilityEngine } from "./types.js";

/**
 * The alternate `geo_score_model` ("geo-score-v3", `seo-geo-scoring-config.json`
 * `geo_score_model`) — 10 fixed prompts per engine, `engine_score =
 * 0.40*appearance + 0.20*citation + 0.15*position + 0.15*share_of_voice +
 * 0.10*sentiment`, overall = unweighted mean of the 5 engine scores.
 *
 * `weights_status` is explicitly "PROPOSED starting weights — Ines to
 * confirm/tune" — this is a DIAGNOSTIC surfaced alongside the canonical
 * Visibility Index (`visibility-index.ts`), never a silent replacement for
 * it, per RFC-04 §4's instruction to preserve gated decisions visibly.
 */
export interface EnginePromptAppearance {
  engine: SeoGeoVisibilityEngine;
  /** Out of the model's fixed 10 prompts. */
  appearanceCount: number;
  /** 0-1 normalized components, each already computed by the caller from the same 10-prompt capture set. */
  citation: number;
  position: number;
  shareOfVoice: number;
  sentiment: number;
}

export function computeGeoScoreModel(perEngine: readonly EnginePromptAppearance[]): GeoScoreModelResult {
  const weights = GEO_SCORE_MODEL.weights;
  const w = (metric: string): number => (weights.find((entry) => entry.metric === metric)?.weight ?? 0) / 100;

  const scores = perEngine.map((e) => {
    const appearance = clamp(e.appearanceCount / 10, 0, 1);
    const score =
      100 *
      (w("appearance") * appearance +
        w("citation") * clamp(e.citation, 0, 1) +
        w("position") * clamp(e.position, 0, 1) +
        w("share_of_voice") * clamp(e.shareOfVoice, 0, 1) +
        w("sentiment") * clamp(e.sentiment, 0, 1));
    return { engine: e.engine, score: roundHalfUp(score) };
  });

  const overall = scores.length > 0 ? roundHalfUp(scores.reduce((sum, s) => sum + s.score, 0) / scores.length) : 0;

  return { overall, perEngine: scores, weightsStatus: GEO_SCORE_MODEL.weights_status };
}
