/**
 * `points_rule` (seo-geo-scoring-config.json `normalization_fns`): round_half_up
 * applied ONCE to a final 0-100 total, never to intermediate sums. Half-up
 * (not banker's rounding) on non-negative scores: `floor(x + 0.5)`.
 */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
