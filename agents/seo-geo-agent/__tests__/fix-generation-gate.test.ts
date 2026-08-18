import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/** Resolves the (always-first) `03-prompt-set-review` gate so tests can focus on the second gate. */
async function approvePromptSetGate(engine: WorkflowEngine, runId: string): Promise<void> {
  await engine.resolveGate(runId, "03-prompt-set-review", { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });
}

describe("12-fix-generation-review gate (RFC-04 §2 Phase 7 — \"nothing ships without sign-off\")", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("pauses before any fix drafts are generated, then resumes to completed on approval", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "seo_geo_run_fixgate_approve";

    await engine.run(workflowFn, { ...baseParams, runId });
    await approvePromptSetGate(engine, runId);

    const second = await engine.run(workflowFn, { ...baseParams, runId });
    expect(second.status).toBe("awaiting_gate");
    if (second.status !== "awaiting_gate") throw new Error("unreachable");
    expect(second.pendingGateId).toContain("12-fix-generation-review");

    // No fix-draft step has run yet.
    const stepsBeforeApproval = await durableStore.listSteps(runId);
    expect(stepsBeforeApproval.map((s) => s.stepId)).not.toContain("13-draft-fixes");

    await engine.resolveGate(runId, "12-fix-generation-review", { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });
    const third = await engine.run(workflowFn, { ...baseParams, runId });
    expect(third.status).toBe("completed");

    const finalSteps = await durableStore.listSteps(runId);
    expect(finalSteps.map((s) => s.stepId)).toContain("13-draft-fixes");
  });

  it("rejecting the gate holds the run before any fix is drafted, and the deliverable never ships", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "seo_geo_run_fixgate_reject";

    await engine.run(workflowFn, { ...baseParams, runId });
    await approvePromptSetGate(engine, runId);
    await engine.run(workflowFn, { ...baseParams, runId });

    await engine.resolveGate(runId, "12-fix-generation-review", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "want a second look at priorities before drafting fixes",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...baseParams, runId });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/fix generation rejected/i);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect(deliverables).toHaveLength(0);
  });
});
