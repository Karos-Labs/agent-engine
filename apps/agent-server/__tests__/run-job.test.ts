import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { ModelRouter } from "@agent-engine/core";
import { startRunJob } from "../src/run-job.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * Wraps a real `ModelRouter` with a call counter on `complete`, preserving
 * `complete`'s own generic signature (a `vi.fn()` wrapper loses it, since
 * vitest's mock type can't express a generic method) — exactly what's needed
 * to prove a redelivered message never re-invokes the model.
 */
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

describe("startRunJob", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("starts a fresh run for a valid request", async () => {
    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" },
      "job-run-1",
      { durableStore: env.durableStore, runtimeDeps: env.runtimeDeps },
    );

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("expected started");
    expect(outcome.runId).toBe("job-run-1");
    expect(outcome.status).toBe("awaiting_gate");
    expect(outcome.pendingGateId).toBeDefined();
    expect(outcome.report).toBeDefined();
  });

  it("calling startRunJob twice with the same runId (simulating a Pub/Sub redelivery) does not invoke the model router a second time", async () => {
    const { router: countingRouter, callCount } = withCallCounter(env.runtimeDeps.router);
    const instrumentedRuntimeDeps = { ...env.runtimeDeps, router: countingRouter };
    const request = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" } as const;
    const runId = "pubsub-redelivery-test";

    const first = await startRunJob(request, runId, { durableStore: env.durableStore, runtimeDeps: instrumentedRuntimeDeps });
    expect(first.outcome).toBe("started");
    const callCountAfterFirst = callCount();
    expect(callCountAfterFirst).toBeGreaterThan(0);

    const second = await startRunJob(request, runId, { durableStore: env.durableStore, runtimeDeps: instrumentedRuntimeDeps });

    expect(callCount()).toBe(callCountAfterFirst);
    expect(second.outcome).toBe("started");
    if (second.outcome !== "started" || first.outcome !== "started") throw new Error("expected started");
    expect(second.runId).toBe(first.runId);
    expect(second.status).toBe(first.status);
  });

  /**
   * A CONTINUATION message (`RunJobRequestSchema.runId`, 2026-09-22): `/resume`
   * records the decision and hands the rest of the run to the worker through
   * the same topic every start uses. It must re-enter the named run — and it
   * must never mint a run under a caller-chosen id that does not exist.
   */
  it("continues an existing run named by the payload's runId, replaying from its checkpoints and applying the gate decision", async () => {
    const request = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" } as const;
    const first = await startRunJob(request, "cont-run-1", { durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
    if (first.outcome !== "started") throw new Error("expected started");
    expect(first.status).toBe("awaiting_gate");
    const gate = await env.durableStore.getGate(first.pendingGateId!);
    await env.durableStore.saveGate({ ...gate!, response: { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() } });

    const cont = await startRunJob({ ...request, runId: "cont-run-1" }, "pubsub-some-other-message-id", { durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
    expect(cont.outcome).toBe("started");
    if (cont.outcome !== "started") throw new Error("expected started");
    expect(cont.status).toBe("completed");
    expect((await env.durableStore.getRun("cont-run-1"))?.status).toBe("completed");
    // Nothing was created under the message-derived id.
    expect(await env.durableStore.getRun("pubsub-some-other-message-id")).toBeUndefined();
  });

  it("refuses a continuation naming a run that does not exist, permanently (not_found), rather than starting one", async () => {
    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring", runId: "never-existed" },
      "never-existed",
      { durableStore: env.durableStore, runtimeDeps: env.runtimeDeps },
    );
    expect(outcome.outcome).toBe("not_found");
    expect(await env.durableStore.getRun("never-existed")).toBeUndefined();
  });
});
