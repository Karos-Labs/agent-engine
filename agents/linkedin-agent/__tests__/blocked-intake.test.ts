import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "linkedin_run_blocked", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

describe("00-intake-check: missing foundation data blocks the run (RFC-02 §5)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolves to status: blocked_intake when the client has no voice rules configured", async () => {
    env = await setupTestEnvironment({ withVoiceRules: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId);
    // The pre-flight runs first and is not a gate: it records that this
    // client has no charter, then intake blocks on the missing foundation
    // data it was always going to block on.
    expect(executedIds).toEqual(["00-channel-setup", "00-intake-check"]);
  });

  it("resolves to status: blocked_intake when the client profile itself has never been set up", async () => {
    env = await setupTestEnvironment({ withProfile: false, withVoiceRules: true });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "linkedin_run_blocked_2" });

    expect(result.status).toBe("blocked_intake");
  });
});
