import type { WorkspaceStoreLike } from "@agent-engine/tool-common";

/**
 * The idempotent-claim primitive behind run-protocol.md §5's "two claims"
 * (the pulse number, and each `review_id`), ported onto this repo's
 * `WorkspaceStoreLike` abstraction per RFC-08 §1/§9's instruction: "a
 * Firestore transaction on the claim document removes the race entirely
 * rather than detecting it after the fact, and should replace the
 * read-after-write pattern in the port, not just copy it."
 *
 * This repo has no raw Firestore transaction available at the tool layer —
 * `WorkspaceStoreLike` is the actual storage substrate every `karos-*` tool
 * is built on (`packages/tools/karos-topics/src/reserve.ts`,
 * `packages/tools/karos-ledger/src/write-deliverable.ts`) — so this follows
 * the SAME read-then-write-if-absent convention those tools use (see
 * `ledgers.ts`'s own `appendIfAbsent`).
 *
 * The read HAS to come first, and this is worth being explicit about because
 * an earlier version of this file got it wrong: `WorkspaceStore.writeJson`
 * always overwrites, and reports `created` only as an after-the-fact
 * observation of whether the path existed BEFORE the write. Writing first and
 * then reading back therefore reads back one's OWN record every time — which
 * silently made every claim a win and the whole claim mechanism a no-op.
 *
 * Caveat, stated plainly rather than glossed over: this leaves a real (if
 * narrow) TOCTOU window between the read and the write — closing it fully
 * needs either a real Firestore `runTransaction` adapter or a filesystem
 * lock, neither of which exists in this repo's `WorkspaceStoreLike` contract
 * today. Every other idempotent-write helper in this codebase
 * (`topics.reserve`, `ledger.writeDeliverable`, `memory.appendDecision`,
 * `appendIfAbsent`) accepts the same limitation as "the Firestore idiom,
 * reproduced here without Firestore" — this claim helper is held to the same
 * bar, not a stricter one invented just for this migration.
 */
export interface ReputationClaimRecord {
  runId: string;
  claimedAt: string;
  /**
   * Set when the holding run closed without persisting a reply for this
   * review (run-protocol.md §9: "closing... releases every claim"). A
   * released record is a tombstone, not a live claim: the next pulse may take
   * the key. It is kept rather than deleted both because
   * `WorkspaceStoreLike` has no `delete` in its contract and because "this
   * claim was taken, then given back, by run X at time T" is exactly the kind
   * of fact run-protocol.md wants recorded rather than erased.
   */
  releasedAt?: string;
}

export interface ReputationClaimOutcome {
  /** True when this run holds the claim (either it won the write, or a prior write by this same run already holds it). */
  won: boolean;
  claimedBy: string;
}

async function claimKey(
  store: WorkspaceStoreLike,
  clientSlug: string,
  segments: readonly string[],
  runId: string,
): Promise<ReputationClaimOutcome> {
  const existing = await store.readJson<ReputationClaimRecord>(clientSlug, segments);
  if (existing !== undefined && existing.releasedAt === undefined && existing.runId !== runId) {
    // A different, still-open run holds this key (run-protocol.md §5: "a lost
    // race costs one review deferred to the next pulse, never a double reply").
    return { won: false, claimedBy: existing.runId };
  }
  const record: ReputationClaimRecord = { runId, claimedAt: new Date().toISOString() };
  await store.writeJson(clientSlug, segments, record);
  return { won: true, claimedBy: runId };
}

/**
 * `:` is a reserved Windows path character outside a drive letter (bit the
 * seo-geo-agent workflow's `research.pull` job-id the same way — see that
 * file's own comment) and review ids are literally `<platform>:<listing_id>:
 * <platform_review_id>` (run-protocol.md §5), so every claim/ledger key built
 * from a review id must be sanitized before it ever reaches `WorkspaceStore`.
 */
export function sanitizeReputationKey(rawKey: string): string {
  return rawKey.replace(/[:/\\]/g, "__");
}

/** run-protocol.md §5 claim #1: the pulse number, keyed by the number itself, stopping "two runs sharing an identity, and a re-used number landing on a closed run's folder." */
export function claimPulseNumber(
  store: WorkspaceStoreLike,
  clientSlug: string,
  runId: string,
  pulseNumber: number,
): Promise<ReputationClaimOutcome> {
  return claimKey(store, clientSlug, ["reputation", "claims", "pulse-numbers", String(pulseNumber)], runId);
}

function reviewClaimSegments(reviewId: string): string[] {
  return ["reputation", "claims", "reviews", sanitizeReputationKey(reviewId)];
}

/** run-protocol.md §5 claim #2: the review, keyed by `review_id`, stopping "two pulses answering the same review." */
export function claimReview(store: WorkspaceStoreLike, clientSlug: string, runId: string, reviewId: string): Promise<ReputationClaimOutcome> {
  return claimKey(store, clientSlug, reviewClaimSegments(reviewId), runId);
}

/**
 * run-protocol.md §9: "close the run... **That releases every claim**...
 * Closing is always available." A claim exists only to stop two pulses
 * drafting the same review AT THE SAME TIME; it is not a record that the
 * review was answered (that is the response ledger's job, §6). So every claim
 * this run took for a review it did NOT successfully persist has to come back
 * at the run's closing point — otherwise a review whose draft was rejected at
 * the human gate, dropped by the client lock, or dropped after the retry cap
 * is claimed FOREVER: every future pulse loses the claim race to a run that is
 * long closed and silently defers it, with no path back to ever drafting a
 * reply.
 *
 * Deliberately guarded by run id (`§11`: a re-run "reuses the same pulse
 * folder... and keeps its claims" — releasing a claim another live run holds
 * would hand it two owners), and idempotent: releasing an already-released
 * claim is a no-op, so a resumed closing step is safe to replay.
 *
 * Returns true when this call actually released a claim held by `runId`.
 */
export async function releaseReviewClaim(store: WorkspaceStoreLike, clientSlug: string, runId: string, reviewId: string): Promise<boolean> {
  const segments = reviewClaimSegments(reviewId);
  const existing = await store.readJson<ReputationClaimRecord>(clientSlug, segments);
  if (existing === undefined || existing.runId !== runId || existing.releasedAt !== undefined) {
    return false;
  }
  await store.writeJson(clientSlug, segments, { ...existing, releasedAt: new Date().toISOString() } satisfies ReputationClaimRecord);
  return true;
}
