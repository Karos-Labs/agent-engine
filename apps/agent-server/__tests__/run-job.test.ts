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
});
