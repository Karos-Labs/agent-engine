import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { ModelRouter } from "@agent-engine/core";
import type { QueueAdapter, QueueMessage, QueueMessageHandler, QueueSubscription } from "@agent-engine/queue";
import {
  FirestoreDurableStepStore,
  type FirestoreCollectionRef,
  type FirestoreDocumentRef,
  type FirestoreDocumentSnapshot,
  type FirestoreLike,
  type FirestoreQuerySnapshot,
  type FirestoreTransaction,
} from "@agent-engine/workflow";
import { RunJobRequestSchema, startRunJob } from "../src/run-job.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * A minimal `FirestoreLike` double, exercised through the exact same
 * interface `FirestoreDurableStepStore` uses in production (a real
 * `firebase-admin` `Firestore` satisfies it structurally — see
 * firestore-types.ts). Mirrors real Firestore's strict rejection of a
 * literal `undefined` anywhere in a written document tree, so this test
 * would fail the same way production did before `saveStep`/`saveSlot`
 * normalized `output` to `null` (see firestore-store.ts's own comment).
 */
function assertNoUndefinedValues(value: unknown, fieldPath = ""): void {
  if (value === undefined) {
    throw new Error(`FakeFirestore: Cannot use "undefined" as a Firestore value${fieldPath ? ` (found in field "${fieldPath}")` : ""}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoUndefinedValues(item, fieldPath ? `${fieldPath}.${i}` : String(i)));
    return;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, val] of Object.entries(value)) {
      assertNoUndefinedValues(val, fieldPath ? `${fieldPath}.${key}` : key);
    }
  }
}

class FakeDoc implements FirestoreDocumentRef {
  private data: Record<string, unknown> | undefined;
  private readonly subcollections = new Map<string, FakeCollection>();

  async get(): Promise<FirestoreDocumentSnapshot> {
    const data = this.data;
    return { exists: data !== undefined, data: () => data };
  }

  async set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown> {
    assertNoUndefinedValues(data);
    this.data = options?.merge && this.data ? { ...this.data, ...data } : { ...data };
    return undefined;
  }

  collection(name: string): FirestoreCollectionRef {
    let col = this.subcollections.get(name);
    if (!col) {
      col = new FakeCollection();
      this.subcollections.set(name, col);
    }
    return col;
  }
}

class FakeCollection implements FirestoreCollectionRef {
  private readonly docs = new Map<string, FakeDoc>();

  doc(id: string): FirestoreDocumentRef {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new FakeDoc();
      this.docs.set(id, doc);
    }
    return doc;
  }

  async get(): Promise<FirestoreQuerySnapshot> {
    const entries = [...this.docs.entries()];
    const snaps = await Promise.all(entries.map(async ([id, doc]) => ({ id, snap: await doc.get() })));
    const docs = snaps.filter(({ snap }) => snap.exists).map(({ id, snap }) => ({ id, data: () => snap.data() ?? {} }));
    return { docs };
  }
}

class FakeFirestore implements FirestoreLike {
  private readonly collections = new Map<string, FakeCollection>();

  collection(path: string): FirestoreCollectionRef {
    let col = this.collections.get(path);
    if (!col) {
      col = new FakeCollection();
      this.collections.set(path, col);
    }
    return col;
  }

  async runTransaction<T>(updateFunction: (tx: FirestoreTransaction) => Promise<T>): Promise<T> {
    const pendingWrites: Promise<unknown>[] = [];
    const tx: FirestoreTransaction = {
      get: (ref) => ref.get(),
      set: (ref, data, options) => {
        const written = ref.set(data, options);
        pendingWrites.push(written);
        return written;
      },
    };
    const result = await updateFunction(tx);
    await Promise.all(pendingWrites);
    return result;
  }
}

/**
 * A single-topic, single-subscription `QueueAdapter` double that behaves like
 * `GooglePubSubQueueAdapter` closely enough to exercise the real consumption
 * contract end to end: `publish` assigns an incrementing message id (reused
 * verbatim on a repeated call with the same `dedupeKey`, standing in for
 * Pub/Sub's own "redelivery reuses message id" behavior — see
 * `QueueMessage.id`'s doc comment), and delivery to the subscribed handler
 * NACKs (logs, does not rethrow) on a handler throw exactly like the real
 * adapter's own `subscribe` does, instead of crashing the publisher.
 */
class InMemoryQueueAdapter implements QueueAdapter {
  readonly providerId = "in-memory-fake";
  private handler: QueueMessageHandler | undefined;
  private seq = 0;
  private readonly messageIdsByDedupeKey = new Map<string, string>();

  subscribe<TPayload = unknown>(_subscription: string, handler: QueueMessageHandler<TPayload>): QueueSubscription {
    this.handler = handler as QueueMessageHandler;
    return { stop: async () => {} };
  }

  /** `dedupeKey`, if passed, simulates an at-least-once redelivery of the same Pub/Sub message. */
  async publish(_topic: string, payload: unknown, attributes: Record<string, string> = {}, dedupeKey?: string): Promise<{ messageId: string }> {
    let messageId = dedupeKey ? this.messageIdsByDedupeKey.get(dedupeKey) : undefined;
    if (!messageId) {
      messageId = `fake-msg-${++this.seq}`;
      if (dedupeKey) this.messageIdsByDedupeKey.set(dedupeKey, messageId);
    }

    const message: QueueMessage = { id: messageId, payload, attributes };
    if (!this.handler) throw new Error("InMemoryQueueAdapter: publish() called before subscribe()");
    try {
      await this.handler(message);
    } catch (err) {
      // ACK/NACK semantics per QueueMessageHandler's contract: a thrown handler
      // error NACKs the message (logged here) rather than propagating to the publisher.
      console.error(`InMemoryQueueAdapter: handler threw for message ${messageId} (NACK)`, err);
    }
    return { messageId };
  }
}

/**
 * The exact per-message dispatch logic `apps/agent-server/src/queue-consumer.ts`
 * runs in its real pull loop, reproduced here against the fake adapter so this
 * test exercises the real consumption contract (parse -> deterministic runId
 * -> `startRunJob` -> ack/nack) rather than a shortcut around it.
 */
function wireConsumer(queue: QueueAdapter, subscriptionName: string, deps: Parameters<typeof startRunJob>[2]): void {
  queue.subscribe(subscriptionName, async (message) => {
    const parsed = RunJobRequestSchema.safeParse(message.payload);
    if (!parsed.success) {
      throw new Error("invalid run-job payload");
    }
    const runId = `pubsub-${message.id}`;
    const outcome = await startRunJob(parsed.data, runId, deps);
    if (outcome.outcome === "error") {
      throw new Error(outcome.message);
    }
  });
}

function withCallCounter(router: ModelRouter): { router: ModelRouter; callCount: () => number } {
  let count = 0;
  const wrapped: ModelRouter = {
    ...router,
    async complete(prompt, schema, policy, opts) {
      count += 1;
      return router.complete(prompt, schema, policy, opts);
    },
  };
  return { router: wrapped, callCount: () => count };
}

describe("Pub/Sub message consumption -> workflow dispatch -> Firestore write cycle", () => {
  let env: TestEnvironment;
  let firestore: FakeFirestore;
  let durableStore: FirestoreDurableStepStore;
  let queue: InMemoryQueueAdapter;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    firestore = new FakeFirestore();
    durableStore = new FirestoreDurableStepStore(firestore);
    queue = new InMemoryQueueAdapter();
    wireConsumer(queue, "agent-engine-run-jobs-pull", { durableStore, runtimeDeps: env.runtimeDeps });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("delivering one queue message runs the workflow and lands a run doc + step docs + gate doc in Firestore", async () => {
    const { messageId } = await queue.publish("agent-engine-run-jobs", {
      clientSlug: "acme",
      productId: "linkedin-agent",
      runKind: "recurring",
    });

    const runId = `pubsub-${messageId}`;

    const runSnap = await firestore.collection("agentEngineRuns").doc(runId).get();
    expect(runSnap.exists).toBe(true);
    const runData = runSnap.data();
    expect(runData?.clientSlug).toBe("acme");
    expect(runData?.productId).toBe("linkedin-agent");
    expect(runData?.status).toBe("awaiting_gate");

    const steps = await durableStore.listSteps(runId);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(typeof step.stepId).toBe("string");
      expect(step.status).toBeDefined();
      // The invariant this actually guards is `sanitizeUndefined`: real
      // Firestore's `set()` throws on a literal `undefined` ANYWHERE in the
      // document, so a void step callback's `output: undefined` must be
      // normalized to null before the write.
      //
      // ASKED PER STATUS, because "absent" and "undefined-valued" are two
      // different things and only one of them is the hazard. This used to read
      // `expect(step.output).not.toBeUndefined()` over every step, which
      // conflated them — fine while every step doc at rest had had a terminal
      // write, and wrong the moment a step could legitimately still be
      // "running" when the run reaches a resting state. `step.gate` is exactly
      // that step: it checkpoints as `kind: "gate", status: "running"` and stays
      // there for as long as the human takes, and `StepRecordSchema` says in as
      // many words that such a record "genuinely doesn't have them yet".
      if (step.status === "running") {
        expect("output" in step, `${step.stepId}: a running checkpoint must omit output, not carry an undefined one`).toBe(false);
      } else {
        expect(step.output, `${step.stepId}: a terminal checkpoint's output must be normalized, never undefined`).not.toBeUndefined();
      }
    }

    // The gate is a step now, not a hole in the sequence. Before it checkpointed
    // itself, the `steps` subcollection had no row for the one step a human
    // participates in — an x-agent run's sequence read 14 -> 16.
    const gateSteps = steps.filter((s) => s.kind === "gate");
    expect(gateSteps).toHaveLength(1);
    expect(gateSteps[0]!.status).toBe("running");
    expect(runData?.currentStepId).toBe(gateSteps[0]!.stepId);

    // The run stopped at a real gate -- confirm it actually landed in agentEngineGates,
    // not just as an in-memory field on the run record.
    const run = await durableStore.getRun(runId);
    expect(run?.pendingGateId).toBeDefined();
    const gate = await durableStore.getGate(run!.pendingGateId!);
    expect(gate).toBeDefined();
    expect(gate?.runId).toBe(runId);
  });

  it("a redelivered message (same Pub/Sub message id) does not re-run the model or double-write steps", async () => {
    const { router: countingRouter, callCount } = withCallCounter(env.runtimeDeps.router);
    const instrumentedQueue = new InMemoryQueueAdapter();
    wireConsumer(instrumentedQueue, "agent-engine-run-jobs-pull", {
      durableStore,
      runtimeDeps: { ...env.runtimeDeps, router: countingRouter },
    });

    const payload = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" } as const;
    const first = await instrumentedQueue.publish("agent-engine-run-jobs", payload, {}, "redelivery-dedupe-key");
    const callsAfterFirst = callCount();
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await instrumentedQueue.publish("agent-engine-run-jobs", payload, {}, "redelivery-dedupe-key");

    expect(second.messageId).toBe(first.messageId);
    expect(callCount()).toBe(callsAfterFirst);

    const steps = await durableStore.listSteps(`pubsub-${first.messageId}`);
    const stepIds = steps.map((s) => s.stepId);
    expect(new Set(stepIds).size).toBe(stepIds.length); // no duplicate step docs from the redelivery
  });
});
