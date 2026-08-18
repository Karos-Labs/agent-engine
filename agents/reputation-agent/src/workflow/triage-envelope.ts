import type { Review, TriagePayload } from "@agent-engine/tool-karos-reputation";

/**
 * Step 04's envelope assembly (RFC-08 §5 step 04: "assemble the
 * `TriagePayload` envelope"), pulled out as its own pure function so it can
 * be exercised directly against `karos-reputation`'s own golden fixtures
 * without a `WorkflowEngine` in the loop (see
 * `__tests__/triage-fixture-integration.test.ts`) — the same envelope shape
 * `create-reputation-pulse-workflow.ts`'s step 04d builds inline from the
 * frozen inputs, the merged/annotated review list, and the three live
 * ledger reads.
 */
export function buildTriagePayload(params: {
  now: string;
  reviews: Review[];
  alreadyRespondedIds: string[];
  seenReviewIds: string[];
  alertedCrisisSignatures: string[];
  baselineRatingAvg: Record<string, number>;
}): TriagePayload {
  return {
    now: params.now,
    reviews: params.reviews,
    already_responded_ids: params.alreadyRespondedIds,
    seen_review_ids: params.seenReviewIds,
    alerted_crisis_signatures: params.alertedCrisisSignatures,
    baseline_rating_avg: params.baselineRatingAvg,
  };
}
