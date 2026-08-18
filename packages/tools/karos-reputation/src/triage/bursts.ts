import { parseTs } from "./timestamps.js";
import { pyRound } from "./round.js";
import { compareReviewIds } from "./sort.js";
import type { Review, TriageConfig } from "./types.js";

/** `trigger_signature` (triage.py): stable identity — type + sorted unique platforms + sorted member review_ids. Same evidence -> same signature, across pulses and re-runs. */
export function triggerSignature(ttype: string, platforms: readonly string[], reviewIds: readonly string[]): string {
  const uniquePlatforms = [...new Set(platforms)].sort();
  const sortedIds = [...reviewIds].sort();
  return [ttype, uniquePlatforms.join("+"), sortedIds.join(",")].join("|");
}

/** `crisis_cutoff` (triage.py): crisis triggers describe NOW — reviews older than `max_trigger_age_days` can inform the analysis brain and still FLAG for a human, but cannot fire a current-crisis alert. */
export function crisisCutoff(cfg: TriageConfig, now: Date): Date {
  return new Date(now.getTime() - cfg.crisis.max_trigger_age_days * 24 * 60 * 60 * 1000);
}

/**
 * `detect_bursts` (triage.py): the set of review_ids sitting inside any
 * negative-burst window (>= count reviews rated <= max_rating within
 * window_hours of each other, all newer than the crisis cutoff). Computed
 * over the WHOLE input, before scoring any individual review (RFC-08's
 * ordering rule) — a burst discovered halfway through a batch would score
 * its first members differently from its last.
 */
export function detectBursts(reviews: readonly Review[], cfg: TriageConfig, now: Date): Set<string> {
  const burstCfg = cfg.crisis.negative_burst;
  const cutoff = crisisCutoff(cfg, now);

  const negatives = reviews
    .filter(
      (r) =>
        r.rating !== null &&
        r.rating !== undefined &&
        r.rating <= burstCfg.max_rating &&
        r.capture_tier !== "UNAVAILABLE" &&
        parseTs(r.created_at) >= cutoff,
    )
    .map((r) => ({ review: r, createdAt: parseTs(r.created_at) }))
    .sort((a, b) => {
      const diff = a.createdAt.getTime() - b.createdAt.getTime();
      if (diff !== 0) return diff;
      // Code-point order, matching Python's `sorted(..., key=...)` tie-break —
      // burst MEMBERSHIP is invariant under permutation of equal-timestamp
      // entries, so this is not load-bearing today, but leaving one
      // `localeCompare` behind next to `sort.ts`'s rule is a latent trap.
      return compareReviewIds(a.review.review_id, b.review.review_id);
    });

  const windowMs = burstCfg.window_hours * 60 * 60 * 1000;
  const count = burstCfg.count;
  const members = new Set<string>();

  for (let i = 0; i <= negatives.length - count; i++) {
    const span = negatives[i + count - 1]!.createdAt.getTime() - negatives[i]!.createdAt.getTime();
    if (span <= windowMs) {
      for (let j = i; j < i + count; j++) {
        members.add(negatives[j]!.review.review_id);
      }
    }
  }
  return members;
}

export interface RatingDip {
  platform: string;
  baseline_rating_avg: number;
  window_rating_avg: number;
  window_review_count: number;
  review_ids: string[];
}

/**
 * `detect_rating_dip` (triage.py): per-platform trailing-window average vs
 * the supplied baseline. Platforms without a baseline are skipped — data
 * unavailable is not a zero.
 */
export function detectRatingDip(
  reviews: readonly Review[],
  baselines: Readonly<Record<string, number>>,
  cfg: TriageConfig,
  now: Date,
): RatingDip[] {
  const dipCfg = cfg.crisis.rating_dip;
  const windowStart = new Date(now.getTime() - dipCfg.window_days * 24 * 60 * 60 * 1000);
  const dips: RatingDip[] = [];

  for (const platform of Object.keys(baselines).sort()) {
    const windowReviews = reviews.filter(
      (r) =>
        r.platform === platform &&
        r.rating !== null &&
        r.rating !== undefined &&
        r.capture_tier !== "UNAVAILABLE" &&
        parseTs(r.created_at) >= windowStart,
    );
    if (windowReviews.length < dipCfg.min_reviews_in_window) continue;

    const sum = windowReviews.reduce((acc, r) => acc + (r.rating as number), 0);
    const windowAvg = pyRound(sum / windowReviews.length, 2);
    // Round the delta so an exact-boundary dip (e.g. 4.5 - 4.2 == 0.2999.. in
    // float) still fires at the configured threshold.
    if (pyRound(baselines[platform]! - windowAvg, 2) >= dipCfg.delta) {
      dips.push({
        platform,
        baseline_rating_avg: baselines[platform]!,
        window_rating_avg: windowAvg,
        window_review_count: windowReviews.length,
        review_ids: windowReviews.map((r) => r.review_id).sort(),
      });
    }
  }
  return dips;
}
