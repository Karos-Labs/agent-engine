import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createNewsletterAgentWorkflow } from "../src/workflow/create-newsletter-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "newsletter_run_blocked", clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring" as const };

describe("00-intake-check: missing target audience, frequency, or brand guidelines blocks the run (RFC-02 §5)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolves to status: blocked_intake when the client has no target audience configured", async () => {
    env = await setupTestEnvironment({ withTargetAudience: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId);
    expect(executedIds).toEqual(["00-intake-check"]);
  });

  it("resolves to status: blocked_intake when the client has no newsletter frequency configured", async () => {
    env = await setupTestEnvironment({ withFrequency: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "newsletter_run_blocked_2" });

    expect(result.status).toBe("blocked_intake");
  });

  it("resolves to status: blocked_intake when the client has no brand guidelines set up", async () => {
    env = await setupTestEnvironment({ withBrand: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "newsletter_run_blocked_3" });

    expect(result.status).toBe("blocked_intake");
  });
});
