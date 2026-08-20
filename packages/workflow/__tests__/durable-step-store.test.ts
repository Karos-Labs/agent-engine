import { describe, expect, it } from "vitest";
import type { DurableStepStore, GateRecord, RunRecord, SlotRecord, StepRecord } from "../src/adapters/types.js";
import { MemoryDurableStepStore } from "../src/adapters/memory-store.js";
import { FirestoreDurableStepStore } from "../src/adapters/firestore/index.js";
import { FakeFirestore } from "./fake-firestore.js";

const baseRun: RunRecord = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  status: "running",
  createdAt: 1000,
  updatedAt: 1000,
};

function makeStep(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    stepId: "step_1",
    kind: "code",
    status: "completed",
    output: { ok: true },
    costUsd: 0,
    durationMs: 5,
    startedAt: 1000,
    completedAt: 1005,
    ...overrides,
  };
}

function makeSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    slotId: "fanout_1__slot_0",
    fanoutId: "fanout_1",
    status: "completed",
    output: { ok: true },
    durationMs: 5,
    startedAt: 1000,
    completedAt: 1005,
    ...overrides,
  };
}

function makeGate(overrides: Partial<GateRecord> = {}): GateRecord {
  return {
    gateId: "run_1__batch-review",
    kind: "batch_review",
    runId: "run_1",
    payload: { batchId: "b1" },
    requiredRole: "account_manager",
    timeout: { duration: "24h", onTimeout: "escalate" },
    ...overrides,
  };
}

/** Both adapters must satisfy the exact same `DurableStepStore` contract — run every case against each. */
describe.each<[string, () => DurableStepStore]>([
  ["MemoryDurableStepStore", () => new MemoryDurableStepStore()],
  ["FirestoreDurableStepStore", () => new FirestoreDurableStepStore(new FakeFirestore())],
])("%s", (_name, makeStore) => {
  it("getRun returns undefined for an unknown run", async () => {
    const store = makeStore();
    expect(await store.getRun("nope")).toBeUndefined();
  });

  it("createRunIfNotExists creates once and is idempotent on replay", async () => {
    const store = makeStore();
    const first = await store.createRunIfNotExists(baseRun);
    const second = await store.createRunIfNotExists({ ...baseRun, status: "completed" });

    expect(first).toEqual(baseRun);
    expect(second).toEqual(baseRun); // the second call must NOT overwrite with the "completed" variant
    expect(await store.getRun("run_1")).toEqual(baseRun);
  });

  it("updateRun merges a patch onto the existing record", async () => {
    const store = makeStore();
    await store.createRunIfNotExists(baseRun);
    await store.updateRun("run_1", { status: "completed", totalCostUsd: 0.05 });

    const updated = await store.getRun("run_1");
    expect(updated).toEqual({ ...baseRun, status: "completed", totalCostUsd: 0.05 });
  });

  it("updateRun throws for a run that was never created", async () => {
    const store = makeStore();
    await expect(store.updateRun("nope", { status: "completed" })).rejects.toThrow();
  });

  it("step get/save round-trips and is idempotent on stepId (a resave overwrites, never duplicates)", async () => {
    const store = makeStore();
    expect(await store.getStep("run_1", "step_1")).toBeUndefined();

    await store.saveStep("run_1", makeStep({ output: { v: 1 } }));
    await store.saveStep("run_1", makeStep({ output: { v: 2 } }));

    expect(await store.getStep("run_1", "step_1")).toEqual(makeStep({ output: { v: 2 } }));
    expect(await store.listSteps("run_1")).toHaveLength(1);
  });

  it("listSteps scopes strictly to the given runId", async () => {
    const store = makeStore();
    await store.saveStep("run_1", makeStep({ stepId: "a" }));
    await store.saveStep("run_2", makeStep({ stepId: "b" }));

    expect((await store.listSteps("run_1")).map((s) => s.stepId)).toEqual(["a"]);
    expect((await store.listSteps("run_2")).map((s) => s.stepId)).toEqual(["b"]);
  });

  it("slot get/save round-trips and listSlots filters by fanoutId", async () => {
    const store = makeStore();
    await store.saveSlot("run_1", makeSlot({ slotId: "fanout_1__slot_0", fanoutId: "fanout_1" }));
    await store.saveSlot("run_1", makeSlot({ slotId: "fanout_1__slot_1", fanoutId: "fanout_1" }));
    await store.saveSlot("run_1", makeSlot({ slotId: "fanout_2__slot_0", fanoutId: "fanout_2" }));

    const fanout1Slots = await store.listSlots("run_1", "fanout_1");
    expect(fanout1Slots.map((s) => s.slotId).sort()).toEqual(["fanout_1__slot_0", "fanout_1__slot_1"]);

    const fanout2Slots = await store.listSlots("run_1", "fanout_2");
    expect(fanout2Slots.map((s) => s.slotId)).toEqual(["fanout_2__slot_0"]);
  });

  it("saveStep normalizes an undefined output to null (a void step.code callback) rather than crashing", async () => {
    const store = makeStore();
    await store.saveStep("run_1", makeStep({ output: undefined }));
    expect((await store.getStep("run_1", "step_1"))?.output).toBeNull();
  });

  it("saveSlot normalizes an undefined output to null the same way saveStep does", async () => {
    const store = makeStore();
    await store.saveSlot("run_1", makeSlot({ output: undefined }));
    expect((await store.getSlot("run_1", "fanout_1__slot_0"))?.output).toBeNull();
  });

  it("gate get/save round-trips and a save with a response overwrites the pending record", async () => {
    const store = makeStore();
    expect(await store.getGate("run_1__batch-review")).toBeUndefined();

    await store.saveGate(makeGate());
    expect((await store.getGate("run_1__batch-review"))?.response).toBeUndefined();

    await store.saveGate(
      makeGate({ response: { decision: "approve", actor: "jane@karoslabs.com", at: "2026-08-15T00:00:00Z" } }),
    );
    const resolved = await store.getGate("run_1__batch-review");
    expect(resolved?.response?.decision).toBe("approve");
  });
});

describe("FakeFirestore — matches real Firestore's rejection of literal undefined values", () => {
  it("throws on a top-level undefined field, exactly as real Firestore's set() does", async () => {
    const db = new FakeFirestore();
    await expect(db.collection("agentEngineRuns").doc("x").set({ status: "running", failureReason: undefined })).rejects.toThrow(/undefined/i);
  });

  it("throws on an undefined value nested inside the document, not just at the top level", async () => {
    const db = new FakeFirestore();
    await expect(db.collection("agentEngineRuns").doc("x").set({ payload: { drafts: [{ text: undefined }] } })).rejects.toThrow(/undefined/i);
  });

  it("does not throw when the same shape uses null instead — proving the fix, not just the fixture, is what's under test", async () => {
    const db = new FakeFirestore();
    await db.collection("agentEngineRuns").doc("x").set({ status: "running", failureReason: null });
    const snap = await db.collection("agentEngineRuns").doc("x").get();
    expect(snap.data()).toEqual({ status: "running", failureReason: null });
  });
});

describe("FirestoreDurableStepStore — named database (RFC-01 §16.6)", () => {
  it("defaults databaseId to Firestore's own '(default)' name when none is supplied", () => {
    const store = new FirestoreDurableStepStore(new FakeFirestore());
    expect(store.databaseId).toBe("(default)");
  });

  it("exposes a supplied databaseId (e.g. 'prep') verbatim", () => {
    const store = new FirestoreDurableStepStore(new FakeFirestore(), { databaseId: "prep" });
    expect(store.databaseId).toBe("prep");
  });

  it("includes the databaseId in an updateRun error, to make cross-environment debugging legible", async () => {
    const store = new FirestoreDurableStepStore(new FakeFirestore(), { databaseId: "prep" });
    await expect(store.updateRun("nope", { status: "completed" })).rejects.toThrow(/database="prep"/);
  });

  it("is purely a label: two stores sharing the same db see the same data regardless of their databaseId", async () => {
    const sharedDb = new FakeFirestore();
    const defaultStore = new FirestoreDurableStepStore(sharedDb);
    const prepStore = new FirestoreDurableStepStore(sharedDb, { databaseId: "prep" });

    await defaultStore.createRunIfNotExists(baseRun);

    // Real isolation comes from injecting a genuinely different Firestore client
    // (getFirestore(app, "prep") vs getFirestore(app)) — not from this label.
    expect(await prepStore.getRun("run_1")).toEqual(baseRun);
  });

  it("is genuinely isolated when backed by two different FirestoreLike instances, as production wiring would use", async () => {
    const defaultStore = new FirestoreDurableStepStore(new FakeFirestore());
    const prepStore = new FirestoreDurableStepStore(new FakeFirestore(), { databaseId: "prep" });

    await defaultStore.createRunIfNotExists(baseRun);

    expect(await defaultStore.getRun("run_1")).toEqual(baseRun);
    expect(await prepStore.getRun("run_1")).toBeUndefined();
  });
});
