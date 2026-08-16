import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "x_run_blocked", clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

describe("00-intake-check: missing xHandle blocks the run (RFC-02 §3)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolves to status: blocked_intake when client.config has no xHandle", async () => {
    env = await setupTestEnvironment({ withXHandle: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId);
    expect(executedIds).toEqual(["00-intake-check"]);
  });

  it("resolves to status: blocked_intake when client.config is entirely missing", async () => {
    env = await setupTestEnvironment({ withXHandle: true });
    // Overwrite the seeded config so it's gone entirely, simulating an unonboarded client.
    await env.store.writeJson("acme", ["client", "config"], null);

    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "x_run_blocked_2" });

    expect(result.status).toBe("blocked_intake");
  });
});
