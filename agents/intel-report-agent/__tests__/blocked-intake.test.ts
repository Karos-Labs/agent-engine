import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createIntelReportAgentWorkflow } from "../src/workflow/create-intel-report-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "intel_run_blocked", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

describe("00-load-client-context: missing foundation data blocks the run (RFC-05 §3 step 1)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolves to status: blocked_intake when the client profile itself has never been set up", async () => {
    env = await setupTestEnvironment({ withProfile: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/profile/i);
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId)).toEqual(["00-load-client-context"]);
  });
});
