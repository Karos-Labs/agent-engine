import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "reddit_run_blocked", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

describe("00-intake-check: missing target subreddits or brand guidelines blocks the run (RFC-02 §5)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolves to status: blocked_intake when the client has no target subreddits configured", async () => {
    env = await setupTestEnvironment({ withTargetSubreddits: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId);
    expect(executedIds).toEqual(["00-channel-setup", "00-intake-check"]);
  });

  it("resolves to status: blocked_intake when the client has no brand guidelines set up", async () => {
    env = await setupTestEnvironment({ withTargetSubreddits: true, withBrand: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "reddit_run_blocked_2" });

    expect(result.status).toBe("blocked_intake");
  });
});
