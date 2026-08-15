import type { DurableStepStore, GateRecord, RunRecord, SlotRecord, StepRecord } from "../types.js";
import type { FirestoreCollectionRef, FirestoreDocumentRef, FirestoreLike } from "./firestore-types.js";

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

  constructor(
    private readonly db: FirestoreLike,
    options: FirestoreDurableStepStoreOptions = {},
  ) {
    this.databaseId = options.databaseId ?? "(default)";
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
    await this.runDoc(run.runId).set(run, { merge: true });
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
    await this.runDoc(runId).set(patch, { merge: true });
  }

  async getStep(runId: string, stepId: string): Promise<StepRecord | undefined> {
    const snap = await this.stepsCollection(runId).doc(stepId).get();
    return snap.exists ? (snap.data() as StepRecord) : undefined;
  }

  async saveStep(runId: string, step: StepRecord): Promise<void> {
    await this.stepsCollection(runId).doc(step.stepId).set(step, { merge: true });
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
    await this.slotsCollection(runId).doc(slot.slotId).set(slot, { merge: true });
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
    await this.gateDoc(gate.gateId).set(gate, { merge: true });
  }
}

/** Convenience factory, matching the `createXStore`/`createWorkspaceStore` convention used elsewhere in this codebase. */
export function createFirestoreDurableStepStore(db: FirestoreLike, options?: FirestoreDurableStepStoreOptions): FirestoreDurableStepStore {
  return new FirestoreDurableStepStore(db, options);
}
