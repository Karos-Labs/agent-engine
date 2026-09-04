import type { DurableStepStore, GateRecord, RunClaimResult, RunRecord, RunStatus, SlotRecord, StepRecord } from "../types.js";
import { isReclaimableRunning } from "../types.js";
import type { FirestoreCollectionRef, FirestoreDocumentRef, FirestoreLike } from "./firestore-types.js";
import type { ArchiveStoreLike } from "./archive-types.js";

/**
 * Margin under Firestore's real, hard 1 MiB (1,048,576 byte) per-document
 * limit (Task 2's dual-storage architecture) — deliberately conservative:
 * the size check below measures one step/slot's own JSON, not the whole
 * parent document Firestore actually enforces the limit against (which also
 * includes every sibling field on the same doc, index overhead, etc.), so
 * leaving headroom means this fires before the real API call would 400,
 * not after.
 */
const FIRESTORE_INLINE_VALUE_LIMIT_BYTES = 900_000;

/**
 * When a sanitized step/slot record's JSON exceeds
 * `FIRESTORE_INLINE_VALUE_LIMIT_BYTES`, uploads its full, unsanitized
 * `output` to `archiveStore` at `objectPath` and returns the record with
 * `output` replaced by a small placeholder carrying the GCS reference —
 * otherwise (record fits, or no `archiveStore` was configured) returns the
 * sanitized record unchanged.
 *
 * Trade-off worth knowing about: `output` for an archived `step.agent` call
 * is no longer a real `AgentExecutionResult`, so
 * `serializeToDynamicAgentRunReport`'s `isAgentExecutionResult` check will
 * miss it and the run report falls back to reporting that step with no
 * per-model usage/cost breakdown (the step's own top-level `costUsd` field
 * is unaffected — it's sibling data on `StepRecord`, not inside `output`).
 * Given how rarely a single step's output should cross ~900 KB, this keeps
 * the archival logic simple and Layer-1-only (no `AgentExecutionResult`
 * shape knowledge here) rather than trying to losslessly preserve a
 * Layer-2-specific summary shape at the persistence boundary.
 */
async function archiveIfOversized<T extends { output?: unknown }>(
  archiveStore: ArchiveStoreLike | undefined,
  objectPath: string,
  record: T,
): Promise<T> {
  const sanitized = sanitizeForFirestore(record);
  const sizeBytes = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
  if (sizeBytes <= FIRESTORE_INLINE_VALUE_LIMIT_BYTES || !archiveStore) {
    return sanitized;
  }
  const { gcsUri } = await archiveStore.upload(objectPath, Buffer.from(JSON.stringify(record.output ?? null), "utf8"));
  return { ...sanitized, output: { archived: true, gcsUri, sizeBytes } };
}

/**
 * Recursively replaces every literal `undefined` — nested inside an array or
 * object, not just at the top level — with `null`. Real Firestore's `set()`/
 * `update()` throws on ANY `undefined` anywhere in the document tree (RFC-01
 * §8.4a), not only in a field this codebase happens to know about: an AI
 * step's checkpointed turn output can carry one several levels down (e.g. a
 * recorded tool call's `args`/`result`, shaped by whatever schema that tool
 * declared, with an optional property the caller never set) — a case the
 * previous `output: step.output ?? null` top-level-only guard missed
 * entirely, reproduced by the queue -> workflow -> Firestore integration test
 * in `apps/agent-server/__tests__/queue-firestore-integration.test.ts`.
 * Applied at this persistence boundary, once, so no step primitive, tool, or
 * future record field can reintroduce the crash.
 */
function sanitizeForFirestore<T>(value: T): T {
  if (value === undefined) return null as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeForFirestore(item)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, sanitizeForFirestore(val)])) as T;
  }
  return value;
}

export interface FirestoreDurableStepStoreOptions {
  /**
   * The named Firestore database this store talks to (RFC-01 §16.6) — e.g.
   * `"prep"` vs Firestore's own default, spelled `"(default)"`. `karosCMO`
   * already runs both databases in one GCP project; this adopts the same
   * split rather than inventing a different environment-separation
   * convention.
   *
   * This is metadata only: the injected `db` is already bound to the right
   * physical database by whoever constructed it (typically
   * `getFirestore(app, databaseId)` from `firebase-admin`) — named databases
   * are genuinely separate databases, not a collection-path prefix within
   * one database, so this class never folds `databaseId` into a path. It
   * exists here purely so error messages and logs can say which database a
   * given run/step/gate lookup was actually against.
   */
  databaseId?: string;
  /**
   * Enables Task 2's Firestore + GCS dual-storage archive: a step/slot
   * output whose sanitized JSON exceeds `FIRESTORE_INLINE_VALUE_LIMIT_BYTES`
   * uploads its full raw payload here instead of writing it inline, leaving
   * a `{archived:true, gcsUri, sizeBytes}` placeholder in Firestore. Omitted
   * (the default), an oversized write goes to Firestore exactly as before —
   * which still throws there past the real 1 MiB limit, unchanged from
   * pre-Task-2 behavior. Gates are never archived (`saveGate` doesn't call
   * this) — RFC-01's "gates... stay in Firestore" (Task 2's own framing) is
   * unconditional, not size-gated.
   */
  archiveStore?: ArchiveStoreLike;
}

/**
 * The Firestore-backed `DurableStepStore` (RFC-01 §8.4a): `agentEngineRuns/
 * {runId}`, `agentEngineRuns/{runId}/steps/{stepId}`, `agentEngineRuns/
 * {runId}/slots/{slotId}`, and the top-level `agentEngineGates/{gateId}`.
 * Every write is `set(data, {merge:true})` — the document id *is* the
 * idempotency key, so a retried write is just the same merge again, no
 * separate compare-and-set layer needed (RFC-01 §8.4a).
 *
 * `listSlots` filters by `fanoutId` client-side after listing the run's
 * whole `slots` subcollection — deliberately, to avoid needing a composite
 * index for a Phase 1 fan-out size (tens of slots, not thousands, per §8.4).
 */
export class FirestoreDurableStepStore implements DurableStepStore {
  /** `"(default)"` when no named database was supplied — Firestore's own name for its default database (RFC-01 §16.6). */
  readonly databaseId: string;
  private readonly archiveStore: ArchiveStoreLike | undefined;

  constructor(
    private readonly db: FirestoreLike,
    options: FirestoreDurableStepStoreOptions = {},
  ) {
    this.databaseId = options.databaseId ?? "(default)";
    this.archiveStore = options.archiveStore;
  }

  private runDoc(runId: string): FirestoreDocumentRef {
    return this.db.collection("agentEngineRuns").doc(runId);
  }

  private stepsCollection(runId: string): FirestoreCollectionRef {
    return this.runDoc(runId).collection("steps");
  }

  private slotsCollection(runId: string): FirestoreCollectionRef {
    return this.runDoc(runId).collection("slots");
  }

  private gateDoc(gateId: string): FirestoreDocumentRef {
    return this.db.collection("agentEngineGates").doc(gateId);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const snap = await this.runDoc(runId).get();
    return snap.exists ? (snap.data() as RunRecord) : undefined;
  }

  async createRunIfNotExists(run: RunRecord): Promise<RunRecord> {
    const existing = await this.getRun(run.runId);
    if (existing) {
      return existing;
    }
    await this.runDoc(run.runId).set(sanitizeForFirestore(run), { merge: true });
    return run;
  }

  async updateRun(runId: string, patch: Partial<Omit<RunRecord, "runId">>): Promise<void> {
    // Firestore's set(...,{merge:true}) would otherwise silently create a partial
    // doc for a run that was never started — check first so both adapters agree
    // on this being a caller bug, not a valid state.
    const existing = await this.getRun(runId);
    if (!existing) {
      throw new Error(`FirestoreDurableStepStore [database="${this.databaseId}"]: no run found for "${runId}"`);
    }
    await this.runDoc(runId).set(sanitizeForFirestore(patch), { merge: true });
  }

  async claimRun(
    runId: string,
    allowedFromStatuses: readonly RunStatus[],
    patch: Partial<Omit<RunRecord, "runId">>,
    reclaimRunningBefore?: number,
  ): Promise<RunClaimResult> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.runDoc(runId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(`FirestoreDurableStepStore [database="${this.databaseId}"]: no run found for "${runId}"`);
      }
      const existing = snap.data() as RunRecord;
      if (!allowedFromStatuses.includes(existing.status) && !isReclaimableRunning(existing, reclaimRunningBefore)) {
        return { claimed: false, run: existing };
      }
      const updated = { ...existing, ...patch };
      // A transaction's set() is buffered until commit and replayed on conflict — a second,
      // concurrent transaction reading the same doc before this one commits sees the
      // pre-claim status and correctly loses the race, rather than both winning.
      tx.set(ref, sanitizeForFirestore(patch), { merge: true });
      return { claimed: true, run: updated };
    });
  }

  async getStep(runId: string, stepId: string): Promise<StepRecord | undefined> {
    const snap = await this.stepsCollection(runId).doc(stepId).get();
    return snap.exists ? (snap.data() as StepRecord) : undefined;
  }

  async saveStep(runId: string, step: StepRecord): Promise<void> {
    // A void `step.code`/`step.agent` callback checkpoints `output: undefined`, and an AI
    // step's turn output can carry one nested several levels down (e.g. a recorded tool
    // call's `args`) — real Firestore's `set()` throws on any literal `undefined` anywhere
    // in the document (a P1 audit finding: this crashed every run past such a step in
    // production while every test against the in-memory store passed). Normalized here, at
    // the persistence boundary, rather than at each call site, so no future step primitive
    // can reintroduce it. `archiveIfOversized` (Task 2) runs after sanitization for the same
    // reason: it measures the exact bytes this write would otherwise send.
    const data = await archiveIfOversized(this.archiveStore, `runs/${runId}/steps/${step.stepId}/output.json`, step);
    await this.stepsCollection(runId).doc(step.stepId).set(data, { merge: true });
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const snap = await this.stepsCollection(runId).get();
    return snap.docs.map((doc) => doc.data() as StepRecord);
  }

  async getSlot(runId: string, slotId: string): Promise<SlotRecord | undefined> {
    const snap = await this.slotsCollection(runId).doc(slotId).get();
    return snap.exists ? (snap.data() as SlotRecord) : undefined;
  }

  async saveSlot(runId: string, slot: SlotRecord): Promise<void> {
    // Same undefined-value hazard and oversized-output archiving as saveStep, for a fan-out slot's own checkpoint.
    const data = await archiveIfOversized(this.archiveStore, `runs/${runId}/slots/${slot.slotId}/output.json`, slot);
    await this.slotsCollection(runId).doc(slot.slotId).set(data, { merge: true });
  }

  async listSlots(runId: string, fanoutId: string): Promise<SlotRecord[]> {
    const snap = await this.slotsCollection(runId).get();
    return snap.docs.map((doc) => doc.data() as SlotRecord).filter((slot) => slot.fanoutId === fanoutId);
  }

  async getGate(gateId: string): Promise<GateRecord | undefined> {
    const snap = await this.gateDoc(gateId).get();
    return snap.exists ? (snap.data() as GateRecord) : undefined;
  }

  async saveGate(gate: GateRecord): Promise<void> {
    // gate.payload is arbitrary caller-shaped data (whatever the step that raised this gate
    // passed along) — same undefined-value hazard as saveStep/saveSlot's output.
    await this.gateDoc(gate.gateId).set(sanitizeForFirestore(gate), { merge: true });
  }
}

/** Convenience factory, matching the `createXStore`/`createWorkspaceStore` convention used elsewhere in this codebase. */
export function createFirestoreDurableStepStore(db: FirestoreLike, options?: FirestoreDurableStepStoreOptions): FirestoreDurableStepStore {
  return new FirestoreDurableStepStore(db, options);
}
