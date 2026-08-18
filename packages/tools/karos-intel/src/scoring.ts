import { DIMENSION_WEIGHTS, type DimensionScore } from "./types.js";

/** A(85+) / B(70-84) / C(55-69) / D(40-54) / F(0-39) — `DEFAULT_INTEL_PROMPT`'s grade bands, ported verbatim. */
export function gradeFor(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

/**
 * `Overall Score = Σ(dimension.score * dimension.weight) / 100`, computed
 * deterministically in code from the model's per-dimension judgments
 * (RFC-05 §4 / RFC-01's mechanical-tier philosophy) — legacy has the model
 * compute this arithmetic itself inside one giant prompt; moving the
 * weighted sum into code eliminates the "the model miscalculated its own
 * rubric" class of bug while leaving every actual judgment call (each
 * dimension's 0-100 score) with the model, exactly as legacy intended.
 */
export function computeOverallScore(dimensionScores: readonly DimensionScore[]): { overallScore: number; overallGrade: string } {
  const seen = new Set(dimensionScores.map((d) => d.dimension));
  const missing = Object.keys(DIMENSION_WEIGHTS).filter((key) => !seen.has(key as DimensionScore["dimension"]));
  if (missing.length > 0) {
    throw new Error(`computeOverallScore: missing dimension score(s): ${missing.join(", ")}`);
  }

  const weightedSum = dimensionScores.reduce((sum, d) => sum + d.score * DIMENSION_WEIGHTS[d.dimension], 0);
  const overallScore = Math.round(weightedSum / 100);
  return { overallScore, overallGrade: gradeFor(overallScore) };
}
