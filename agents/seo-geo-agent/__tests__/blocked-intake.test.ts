import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_run_blocked", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

describe("00-intake-check: missing foundation data blocks the run (RFC-04 §2 Phase 0)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolves to status: blocked_intake when the client profile has never been set up", async () => {
    env = await setupTestEnvironment({ withProfile: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId)).toEqual(["00-intake-check"]);
  });

  it("resolves to status: blocked_intake when the client has no brand kit configured", async () => {
    env = await setupTestEnvironment({ withBrand: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "seo_geo_run_blocked_2" });

    expect(result.status).toBe("blocked_intake");
  });

  it("does not block on a missing competitor list — that's optional intake, not foundation data", async () => {
    env = await setupTestEnvironment({ withCompetitors: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "seo_geo_run_no_competitors" });

    // Progresses well past intake (proves competitors are optional) even though
    // this particular router has nothing queued for the bounded agent steps.
    expect(result.status).not.toBe("blocked_intake");
    const stepRecords = await durableStore.listSteps("seo_geo_run_no_competitors");
    expect(stepRecords.map((s) => s.stepId)).toContain("01-load-client-context");
  });
});
