import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

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
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router });
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
    // The fixes and narrative are now drafted, so the run pauses again at the
    // new final review gate rather than completing straight through.
    expect(third.status).toBe("awaiting_gate");
    if (third.status !== "awaiting_gate") throw new Error("unreachable");
    expect(third.pendingGateId).toContain("16-batch-review-r0");

    const stepsAfterFixApproval = await durableStore.listSteps(runId);
    expect(stepsAfterFixApproval.map((s) => s.stepId)).toContain("13-draft-fixes");

    await engine.resolveGate(runId, "16-batch-review-r0", { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });
    const fourth = await engine.run(workflowFn, { ...baseParams, runId });
    expect(fourth.status).toBe("completed");

    const finalSteps = await durableStore.listSteps(runId);
    expect(finalSteps.map((s) => s.stepId)).toContain("13-draft-fixes");
  });

  /**
   * A REJECTION REFUSES THE FIXES, NOT THE REPORT.
   *
   * This reverses the earlier behaviour deliberately. By the time this gate
   * opens the run has paid for a full technical crawl, an AI-visibility
   * capture, a scoring pass and the recommendation firing — every number the
   * client-visible report is made of. Holding here threw all of it away to
   * refuse the one thing the gate is about: drafting fixes.
   *
   * The gate keeps that authority — no fix is drafted — and the report ships
   * with the reviewer's own words attached where nobody can miss them.
   */
  it("rejecting the gate drafts no fix, and still delivers the report that was already measured", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router });
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
    const third = await engine.run(workflowFn, { ...baseParams, runId });
    // The narrative is still written, so the run stops at the final review
    // gate exactly as an approved one does.
    expect(third.status).toBe("awaiting_gate");
    if (third.status !== "awaiting_gate") throw new Error("unreachable");
    expect(third.pendingGateId).toContain("16-batch-review-r0");

    // The refused half, and the ONLY refused half.
    expect((await durableStore.listSteps(runId)).map((s) => s.stepId)).not.toContain("13-draft-fixes");

    await engine.resolveGate(runId, "16-batch-review-r0", { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });
    const result = await engine.run(workflowFn, { ...baseParams, runId });
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect(deliverables).toHaveLength(1);
    const report = (deliverables[0] as { data: { deliverable: Record<string, unknown> } }).data.deliverable;
    // Measured output survives: the recommendations are findings, not drafted
    // text, and refusing to draft fixes is not a claim that they are wrong.
    expect((report["firedRecommendations"] as unknown[]).length).toBeGreaterThan(0);
    expect(report["fixDrafts"]).toEqual([]);
    expect(report["narrative"]).toBeTruthy();
    expect(report["contentRepairs"]).toContainEqual(
      expect.objectContaining({
        check: "fix-generation-review",
        action: "unresolved",
        detail: expect.stringContaining("want a second look at priorities before drafting fixes"),
      }),
    );
  }, 30000);
});
