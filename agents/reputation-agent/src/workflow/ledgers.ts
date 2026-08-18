import { createHash } from "node:crypto";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import type { Annotations } from "@agent-engine/tool-karos-reputation";
import { sanitizeReputationKey } from "./claims.js";

/**
 * The three "live, read at step 02 and re-read on resume" ledgers
 * (run-protocol.md §6): the response ledger (`already_responded_ids`), the
 * seen-review ledger (`seen_review_ids` — every review any prior pulse for
 * this client has ever ingested, regardless of lane), and the crisis ledger
 * (`alerted_crisis_signatures`). All three are re-read live on every call
 * (never frozen alongside step 02's client-facts/config freeze), matching
 * run-protocol.md §6's exact "frozen vs live" split.
 *
 * Each entry is written keyed by the thing it is actually about (the review
 * id, or the crisis signature), with the run-protocol.md §12 idempotency key
 * (`<run-id>:<step>:<review_id>`) carried *inside* the record for audit
 * rather than used as the storage path — the ledger's whole purpose is
 * answering "has this review/signature ever been recorded", which needs a
 * lookup keyed by the review/signature itself, not by which run recorded it
 * first. `appendIfAbsent` below is what actually implements run-protocol.md
 * §12's "skipped if that key is already present": the first writer for a
 * given review/signature owns the record, and every later append (whether a
 * resume of the same run or a different run) is a genuine no-op, never an
 * overwrite.
 */

interface LedgerEntry {
  appendKey: string;
  recordedAt: string;
  [key: string]: unknown;
}

async function appendIfAbsent(store: WorkspaceStoreLike, clientSlug: string, segments: readonly string[], entry: LedgerEntry): Promise<boolean> {
  const existing = await store.readJson<LedgerEntry>(clientSlug, segments);
  if (existing) {
    return false;
  }
  await store.writeJson(clientSlug, segments, entry);
  return true;
}

function ledgerAppendKey(runId: string, step: string, reviewId: string): string {
  return `${runId}:${step}:${reviewId}`;
}

// ── response ledger ──────────────────────────────────────────────────────

export async function readResponseLedger(store: WorkspaceStoreLike, clientSlug: string): Promise<string[]> {
  // `e.id` is the sanitized filename (colons replaced), never the real
  // review id — the original is preserved inside the record itself.
  const entries = await store.listJson<LedgerEntry & { reviewId: string }>(clientSlug, ["reputation", "ledger", "responded"]);
  return entries.map((e) => e.data.reviewId);
}

/** Recorded once a drafted reply for `reviewId` has cleared every gate through the mandatory human approve-all gate (step 11) — the honest proxy this system has for "answered," since `reputation.publish` is permanently locked and this workflow can never itself confirm a human actually sent it (RFC-08 §9). This is what stops a later pulse from drafting a second reply to the same review. */
export async function recordResponded(store: WorkspaceStoreLike, clientSlug: string, runId: string, step: string, reviewId: string): Promise<boolean> {
  const key = sanitizeReputationKey(reviewId);
  return appendIfAbsent(store, clientSlug, ["reputation", "ledger", "responded", key], {
    appendKey: ledgerAppendKey(runId, step, reviewId),
    recordedAt: new Date().toISOString(),
    reviewId,
  });
}

// ── seen-review ledger ───────────────────────────────────────────────────

export async function readSeenReviewLedger(store: WorkspaceStoreLike, clientSlug: string): Promise<string[]> {
  const entries = await store.listJson<LedgerEntry & { reviewId: string }>(clientSlug, ["reputation", "ledger", "seen"]);
  return entries.map((e) => e.data.reviewId);
}

/** Recorded for every review this pulse's envelope contained (any lane), once triage has run — this is what lets `reputation.triage`'s crisis-trigger suppression tell "a burst/keyword hit this pulse discovered for the first time" apart from "a review a prior pulse already alerted on." */
export async function recordSeen(store: WorkspaceStoreLike, clientSlug: string, runId: string, step: string, reviewId: string): Promise<boolean> {
  const key = sanitizeReputationKey(reviewId);
  return appendIfAbsent(store, clientSlug, ["reputation", "ledger", "seen", key], {
    appendKey: ledgerAppendKey(runId, step, reviewId),
    recordedAt: new Date().toISOString(),
    reviewId,
  });
}

// ── crisis ledger ────────────────────────────────────────────────────────

/** Crisis trigger signatures (`rating_dip|...`, `negative_burst|...`) contain `|`, `,`, and `:` — none of them safe path characters — so the storage key is a stable hash of the signature, with the raw signature kept in the record for the actual comparison callers need. */
function crisisSignatureKey(signature: string): string {
  return createHash("sha256").update(signature).digest("hex").slice(0, 32);
}

export async function readCrisisLedger(store: WorkspaceStoreLike, clientSlug: string): Promise<string[]> {
  const entries = await store.listJson<LedgerEntry & { signature: string }>(clientSlug, ["reputation", "ledger", "crisis-signatures"]);
  return entries.map((e) => e.data.signature);
}

/** Recorded for every UNSUPPRESSED trigger `reputation.triage` fires this pulse — this is what stops the same crisis from re-alerting on the next pulse's re-ingest of the same trailing window. */
export async function recordCrisisSignature(
  store: WorkspaceStoreLike,
  clientSlug: string,
  runId: string,
  step: string,
  signature: string,
): Promise<boolean> {
  const key = crisisSignatureKey(signature);
  return appendIfAbsent(store, clientSlug, ["reputation", "ledger", "crisis-signatures", key], {
    appendKey: ledgerAppendKey(runId, step, signature),
    recordedAt: new Date().toISOString(),
    signature,
  });
}

// ── annotations cache ────────────────────────────────────────────────────

/**
 * `references/scoring.md` §2: "one pass per review, cached, never
 * re-classified." `reputation.capture`'s adapters never carry annotations
 * forward themselves (they re-fetch/re-read verbatim from the platform or
 * export every pulse) — this cache is what actually makes cross-*pulse*
 * caching real, on top of the natural within-*run* caching `wf.fanout`'s own
 * checkpointing already gives step 04a for free. Unlike the response/seen/
 * crisis ledgers, this cache is read ONCE per run (via `wf.step.code`, see
 * `create-reputation-pulse-workflow.ts`'s step 04a) rather than live on every
 * replay: the set of reviews needing extraction determines a `wf.fanout`'s
 * item list, and that list must stay stable across a resume (RFC-01 §5.5) —
 * re-reading it live could change which reviews need extraction mid-run and
 * desync the fanout's positional checkpoints.
 */
/**
 * `review-schema.md` (Annotations): the cache is "keyed `(review_id,
 * classifier_model_id)`" — a PAIR, not the review id alone. That is the whole
 * mechanism behind the schema's next sentence: "a recompute requires a new
 * `classifier_model_id` and is a logged config change." Keying on the review
 * id alone would serve a retired model's cached booleans forever, and swapping
 * the extraction model would silently change nothing.
 */
function annotationCacheKey(reviewId: string, classifierModelId: string): string {
  // Sanitized as ONE string: `::` is the logical pair separator, but `:` is a
  // reserved Windows path character (see `sanitizeReputationKey`), so it can
  // never survive verbatim in a storage key.
  return sanitizeReputationKey(`${reviewId}::${classifierModelId}`);
}

export async function readAnnotationsCache(
  store: WorkspaceStoreLike,
  clientSlug: string,
  reviewIds: readonly string[],
  classifierModelId: string,
): Promise<Map<string, Annotations>> {
  const result = new Map<string, Annotations>();
  for (const reviewId of reviewIds) {
    const entry = await store.readJson<{ reviewId: string; annotations: Annotations }>(clientSlug, [
      "reputation",
      "cache",
      "annotations",
      annotationCacheKey(reviewId, classifierModelId),
    ]);
    if (entry) {
      result.set(reviewId, entry.annotations);
    }
  }
  return result;
}

/**
 * Idempotent overwrite (not `appendIfAbsent`): re-caching the same review with
 * the same freshly-extracted annotations on a resume is harmless — there is no
 * ordering hazard here the way there is for the response/crisis ledgers.
 *
 * The write key's model half comes from `annotations.classifier_model_id` —
 * the model that ACTUALLY produced these booleans — so a run whose router
 * resolved a different model than the reader expects simply misses the cache
 * and re-classifies, which is the correct direction to fail.
 */
export async function writeAnnotationToCache(store: WorkspaceStoreLike, clientSlug: string, reviewId: string, annotations: Annotations): Promise<void> {
  await store.writeJson(clientSlug, ["reputation", "cache", "annotations", annotationCacheKey(reviewId, annotations.classifier_model_id)], {
    reviewId,
    classifierModelId: annotations.classifier_model_id,
    annotations,
    cachedAt: new Date().toISOString(),
  });
}

// ── learning log ─────────────────────────────────────────────────────────

/**
 * RFC-08 §8's manager stub: "the folder shape... is fixed, but the judgment
 * logic... is deliberately unwritten." This append is that fixed shape only
 * — one row per pulse recording what happened, with zero threshold-
 * recalibration or pattern-detection judgment layered on top. The manager
 * (a separate, still-unbuilt package) is the only thing meant to ever read
 * this and apply real judgment to it.
 */
export async function appendLearningLog(
  store: WorkspaceStoreLike,
  clientSlug: string,
  runId: string,
  entry: { pulseNumber: number; counts: Record<string, number>; crisisFired: boolean; droppedToFlagCount: number },
): Promise<boolean> {
  return appendIfAbsent(store, clientSlug, ["reputation", "learning-log", runId], {
    appendKey: `${runId}:11-learning-log`,
    recordedAt: new Date().toISOString(),
    ...entry,
  });
}
