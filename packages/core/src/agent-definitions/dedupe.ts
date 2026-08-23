import { DEDUPE_SIMILARITY_THRESHOLD, closestMatch } from "./similarity.js";

/** The step id the de-duplication verdict is recorded under, alongside the guardrail's. */
export const DEDUPE_STEP_ID = "output-dedupe";

/** One prior deliverable to compare against (`ledger.listOutputExcerpts`'s shape). */
export interface DedupeHistoryEntry {
  runId: string;
  excerpt: string;
}

/**
 * What a de-duplication check concluded.
 *
 * `no_history` is deliberately distinct from `ok`. "Compared against four past
 * runs and found nothing close" and "there was nothing to compare against" are
 * different facts, and collapsing them would let an agent's first run for a
 * client read as having passed a check it never ran.
 */
export interface DedupeVerdict {
  status: "ok" | "similar" | "no_history";
  /** How many excerpts were ACTUALLY compared — not how many were available. */
  comparedCount: number;
  maxSimilarity: number;
  threshold: number;
  /** Present only when `status` is `"similar"`. */
  mostSimilarRunId?: string;
}

/**
 * Scores a finished deliverable against this agent's recent output for the
 * same client.
 *
 * De-duplication only ever FLAGS. Unlike the topic guardrail — which fails the
 * run, because publishing a forbidden topic is a breach — a repeated theme is
 * a similarity signal for a human to weigh. Two posts a fortnight apart about
 * the same launch may be exactly right, and a measure with a fixed threshold
 * is not entitled to overrule that. The verdict rides along on the run's
 * output; nothing in this module throws.
 *
 * Pure: no I/O, no clock, no model call. The caller supplies the history, so
 * this function's behaviour is entirely pinned by unit tests.
 */
export function evaluateDedupe(deliverable: string, history: readonly DedupeHistoryEntry[]): DedupeVerdict {
  const hasText = deliverable.trim().length > 0;

  if (!hasText || history.length === 0) {
    return {
      status: "no_history",
      // Zero when the deliverable is empty even though history existed:
      // comparedCount reports what was compared, so it can never contradict
      // the status beside it.
      comparedCount: 0,
      maxSimilarity: 0,
      threshold: DEDUPE_SIMILARITY_THRESHOLD,
    };
  }

  const best = closestMatch(deliverable, [...history].map((h) => ({ jobId: h.runId, excerpt: h.excerpt })));
  const score = best?.score ?? 0;
  const similar = score >= DEDUPE_SIMILARITY_THRESHOLD;

  return {
    status: similar ? "similar" : "ok",
    comparedCount: history.length,
    maxSimilarity: score,
    threshold: DEDUPE_SIMILARITY_THRESHOLD,
    ...(similar && best ? { mostSimilarRunId: best.jobId } : {}),
  };
}
