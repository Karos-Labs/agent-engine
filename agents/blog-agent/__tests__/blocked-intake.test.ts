import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createBlogAgentWorkflow } from "../src/workflow/create-blog-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "blog_run_blocked", clientSlug: "acme", productId: "blog-agent", runKind: "recurring" as const };

describe("00-intake-check: missing voice rules, target keywords, or content pillars blocks the run (RFC-02 §5)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolves to status: blocked_intake when the client has no voice rules configured", async () => {
    env = await setupTestEnvironment({ withVoiceRules: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId);
    expect(executedIds).toEqual(["00-intake-check"]);
  });

  it("resolves to status: blocked_intake when the client has no target keywords configured", async () => {
    env = await setupTestEnvironment({ withTargetKeywords: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "blog_run_blocked_2" });

    expect(result.status).toBe("blocked_intake");
  });

  it("resolves to status: blocked_intake when the client has no content pillars configured", async () => {
    env = await setupTestEnvironment({ withContentPillars: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "blog_run_blocked_3" });

    expect(result.status).toBe("blocked_intake");
  });
});
