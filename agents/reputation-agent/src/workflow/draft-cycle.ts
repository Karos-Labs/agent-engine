import type { SlotOutcome } from "@agent-engine/workflow";
import type { TriageResultRow } from "@agent-engine/tool-karos-reputation";
import { checkClientLock, type ClientLocks } from "./client-lock.js";
import type { ReputationCompletionManifestRow } from "./types.js";

/**
 * Pure, side-effect-free bookkeeping for the steps 06->09 draft/gate loop
 * (run-protocol.md §4's "two is the cap" doctrine-retry budget). Kept out of
 * the workflow file itself so the retry math can be reasoned about (and
 * tested) without a `WorkflowEngine` in the loop — every function here only
 * ever reads its arguments and returns a new value, never reaches into a
 * durable store or calls a tool. All of its inputs are themselves already
 * checkpointed (`wf.fanout`/`wf.step.code` results), so recomputing this
 * logic on a resumed run is always safe and cheap.
 */

/**
 * run-protocol.md §4: "A crash never writes a `RETURN` file, so **a crash
 * cannot consume a gate attempt**." Two budgets, because there are two
 * genuinely different kinds of failure and the source text only ever meant
 * the first to be capped at two:
 *
 * - `"content"` — a DEFINITIVE, OBSERVED business-logic verdict about the
 *   draft itself: a doctrine `fail`, a voice-batch `fail`, a mechanical
 *   anti-slop `content_fail`, an agent whose own status is `content_fail`.
 *   The model got its turn and the answer was no. Consumes `attempts`.
 * - `"tooling"` — the run's infrastructure broke on this item: a transient
 *   model/router failure (`tooling_error`/`budget_exceeded`), a thrown slot,
 *   a tool call that could not complete. Nothing was learned about the draft.
 *   Consumes `toolingRetries` and never `attempts`.
 */
export type DraftFailureKind = "content" | "tooling";

export interface DraftCycleItem {
  row: TriageResultRow;
  /** Observed CONTENT failures already made *before* this cycle — 0 on the very first cycle. Bounded by `MAX_DRAFT_GATE_RETRIES`. */
  attempts: number;
  /** Tooling/execution failures already suffered *before* this cycle. Bounded separately; never counts against `attempts`. */
  toolingRetries: number;
  lastFailureReason?: string;
}

export interface DraftAttemptOutcome {
  reviewId: string;
  ok: boolean;
  draftText?: string;
  reason?: string;
  /** Present only when `ok` is false. */
  failureKind?: DraftFailureKind;
}

export interface DraftStageFailure {
  reviewId: string;
  reason: string;
  kind: DraftFailureKind;
}

export interface ClientLockStageResult {
  survivors: Array<{ reviewId: string; draftText: string }>;
  /** Step 07 hard stops — never retried (run-protocol.md/RFC-08 task spec: "HARD STOPS a violating draft... does not loop back to step 06"). */
  droppedHard: ReputationCompletionManifestRow[];
  /** Items whose draft attempt itself failed, each tagged with which budget the failure spends. */
  retryQueue: DraftCycleItem[];
}

/** Applies one failure to an item, spending the budget its `kind` actually names. */
function chargeFailure(item: DraftCycleItem, failure: { reason: string; kind: DraftFailureKind }): DraftCycleItem {
  return {
    row: item.row,
    attempts: item.attempts + (failure.kind === "content" ? 1 : 0),
    toolingRetries: item.toolingRetries + (failure.kind === "tooling" ? 1 : 0),
    lastFailureReason: failure.reason,
  };
}

/** Step 07: the deterministic client-lock hard stop, applied to every draft attempt this cycle produced. */
export function applyClientLock(
  pending: readonly DraftCycleItem[],
  draftSlots: ReadonlyArray<SlotOutcome<DraftAttemptOutcome>>,
  locks: ClientLocks,
): ClientLockStageResult {
  const survivors: Array<{ reviewId: string; draftText: string }> = [];
  const droppedHard: ReputationCompletionManifestRow[] = [];
  const retryQueue: DraftCycleItem[] = [];

  pending.forEach((item, i) => {
    const slot = draftSlots[i];
    if (!slot || slot.status === "failed") {
      // A slot that threw is an execution fault, never a verdict on the draft.
      retryQueue.push(
        chargeFailure(item, {
          kind: "tooling",
          reason: `draft attempt failed: ${slot?.status === "failed" ? slot.reason : "no slot result returned"}`,
        }),
      );
      return;
    }
    const out = slot.output;
    if (!out.ok || !out.draftText) {
      retryQueue.push(
        chargeFailure(item, { kind: out.failureKind ?? "tooling", reason: out.reason ?? "draft step produced no usable output" }),
      );
      return;
    }
    const lock = checkClientLock(out.draftText, locks);
    if (!lock.ok) {
      droppedHard.push({ reviewId: item.row.review_id, outcome: "dropped", reason: `client lock violation (step 07, no retry): ${lock.reason}` });
      return;
    }
    survivors.push({ reviewId: item.row.review_id, draftText: out.draftText });
  });

  return { survivors, droppedHard, retryQueue };
}

export interface CycleResolution {
  nextPending: DraftCycleItem[];
  approved: Array<{ reviewId: string; draftText: string }>;
  droppedThisCycle: ReputationCompletionManifestRow[];
  /**
   * Items whose TOOLING-failure budget is exhausted. Not a content verdict and
   * never degraded to FLAG: the caller raises a `WorkflowToolingFailure` so
   * the run halts `degraded` for a human to fix and resume — RFC-01 §6's
   * "never recorded as a content verdict."
   */
  toolingFailures: DraftStageFailure[];
}

/**
 * Merges the lock stage's survivors against whatever happened to them next
 * (a voice/mechanical-antislop failure, or a doctrine-gate failure) into the
 * final per-cycle outcome: approved, queued for another attempt (bounded by
 * `maxRetries` for content failures and `maxToolingRetries` for execution
 * faults), dropped to FLAG with a reason, or escalated as a tooling failure.
 */
export function resolveCycleOutcome(
  pending: readonly DraftCycleItem[],
  lockResult: ClientLockStageResult,
  laterFailures: ReadonlyMap<string, { reason: string; kind: DraftFailureKind }>,
  approvedReviewIds: ReadonlySet<string>,
  maxRetries: number,
  maxToolingRetries: number,
): CycleResolution {
  const originalByReviewId = new Map(pending.map((p) => [p.row.review_id, p]));
  const approved: Array<{ reviewId: string; draftText: string }> = [];
  const droppedThisCycle: ReputationCompletionManifestRow[] = [...lockResult.droppedHard];
  const toolingFailures: DraftStageFailure[] = [];
  let nextPending: DraftCycleItem[] = [...lockResult.retryQueue];

  for (const survivor of lockResult.survivors) {
    if (approvedReviewIds.has(survivor.reviewId)) {
      approved.push(survivor);
      continue;
    }
    const original = originalByReviewId.get(survivor.reviewId)!;
    const failure = laterFailures.get(survivor.reviewId) ?? {
      reason: "did not clear a later gate for an unspecified reason",
      kind: "content" as const,
    };
    nextPending.push(chargeFailure(original, failure));
  }

  nextPending = nextPending.filter((item) => {
    if (item.toolingRetries > maxToolingRetries) {
      toolingFailures.push({
        reviewId: item.row.review_id,
        kind: "tooling",
        reason: `steps 06-09 hit ${item.toolingRetries} execution/tooling failures for this item (budget ${maxToolingRetries}), last: ${item.lastFailureReason ?? "unspecified"}`,
      });
      return false;
    }
    // The content cap applies uniformly, whether the item came from the lock
    // stage's own retry queue (a draft that came back `content_fail`) or from
    // a later-stage content verdict.
    if (item.attempts > maxRetries) {
      droppedThisCycle.push({
        reviewId: item.row.review_id,
        outcome: "dropped",
        reason: `exceeded ${maxRetries} retries to steps 06-09: ${item.lastFailureReason ?? "unspecified"}`,
      });
      return false;
    }
    return true;
  });

  return { nextPending, approved, droppedThisCycle, toolingFailures };
}
