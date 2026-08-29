import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { GetReportResult } from "@agent-engine/tool-karos-intel";
import { createIntelReportAgentWorkflow } from "../src/workflow/create-intel-report-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * SCRUM-303 / AU19: intel-report-agent adopts the shared `runReviewCycle`
 * primitive (`@agent-engine/workflow`), the same pattern every other
 * migrated channel agent (x, linkedin, reddit, blog, newsletter, instagram)
 * already uses for its own human-review gate. Before this, step 04 was a
 * single-shot approve/reject gate with no `revise` path at all.
 *
 * This agent deliberately does NOT adopt `runTopicGuardrail`, unlike the
 * other two agents in this ticket: `apps/agent-server/__tests__/guardrail-coverage.test.ts`
 * documents, as an enforced repo-wide invariant, that intel-report-agent's
 * deliverable is internal (read by the client's own team, never published)
 * and must never run the terminal topic guardrail — that check asks "does
 * this text engage a subject the client's PUBLIC voice avoids", which does
 * not apply to an internal competitive-intelligence briefing. Adding the
 * call here would fail that coverage test outright.
 */

const params = { runId: "intel_rev", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

describe("intel-report-agent review cycle (runReviewCycle)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("re-generates the report with the reviewer's feedback, then delivers on approval", async () => {
    const firstDraft = goodIntelReport();
    const revisedDraft = goodIntelReport({
      contentAnalysis: "Revised per reviewer note: leads with the practitioner-content gap first, not the announcement-post pattern.",
    });
    const router = fakeRouterSequence([finalTurn(firstDraft), finalTurn(revisedDraft)]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const r0 = await engine.run(workflowFn, params);
    expect(r0.status).toBe("awaiting_gate");
    if (r0.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r0.pendingGateId).toContain("04-batch-review-r0");

    await engine.resolveGate(params.runId, "04-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Lead with the practitioner-content gap, not the announcement pattern.",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflowFn, params);
    expect(r1.status).toBe("awaiting_gate");
    if (r1.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r1.pendingGateId).toContain("04-batch-review-r1");

    await engine.resolveGate(params.runId, "04-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, params);
    expect(final.status).toBe("completed");

    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // Round 1's drafting steps are revision-scoped, so they genuinely re-ran.
    expect(ids).toContain("02-generate-report");
    expect(ids).toContain("02-generate-report-r1");
    expect(ids).toContain("03-verify-numbers-sourced-r1");
    // Everything upstream of the draft loop kept its id and ran exactly once —
    // the reason the revision is in-run rather than a fresh run.
    expect(ids.filter((i) => i === "00-load-client-context")).toHaveLength(1);
    expect(ids.filter((i) => i === "01-research-pull")).toHaveLength(1);
    expect(ids).not.toContain("01-research-pull-r1");

    // The persisted report is the REVISED draft, not the first one.
    const readReport = await env.tools["intel.getReport"]!.execute({}, { ctx: { ...params, runId: "verify", metadata: {} } });
    expect(readReport.status).toBe("success");
    if (readReport.status !== "success") throw new Error("unreachable");
    const readResult = readReport.result as GetReportResult;
    expect(readResult.report.contentAnalysis).toContain("Revised per reviewer note");
  }, 30000);

  it("saves the reviewer's words to client memory, on a revision and on an approval alike", async () => {
    const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "intel_rev_memory";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "04-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      feedback: "The conservative dimension scoring is landing well with this client, keep it up.",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...params, runId });
    expect(final.status).toBe("completed");

    const remembered = await env.store.listJson<{ note: string; decision: string; productId: string }>("acme", ["memory", "feedback"]);
    expect(remembered.map((r) => r.data.note)).toContain("The conservative dimension scoring is landing well with this client, keep it up.");
    expect(remembered.map((r) => r.data.decision)).toContain("approve");
    expect(remembered.map((r) => r.data.productId)).toContain("intel-report-agent");
  }, 30000);

  it("still holds on an outright rejection, with the reviewer's own reason in the hold", async () => {
    const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "intel_rev_reject";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "04-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "dimension scores look inflated this run",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...params, runId });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/review rejected/i);
    expect(result.reason).toMatch(/dimension scores look inflated this run/);
  }, 30000);

  it("holds after the reviewer's feedback keeps coming past the revision ceiling, rather than re-drafting forever", async () => {
    const router = fakeRouterSequence([
      finalTurn(goodIntelReport()),
      finalTurn(goodIntelReport({ contentAnalysis: "First revision attempt." })),
      finalTurn(goodIntelReport({ contentAnalysis: "Second revision attempt." })),
    ]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "intel_rev_ceiling";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "04-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "round 1 feedback",
      at: new Date().toISOString(),
    });
    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "04-batch-review-r1", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "round 2 feedback",
      at: new Date().toISOString(),
    });
    await engine.run(workflowFn, { ...params, runId });
    // maxRevisions is MAX_REVISION_ROUNDS (2): draft (r0) + 2 revisions
    // (r1, r2) is the ceiling, so a THIRD revise request holds rather than
    // drafting a fourth time.
    const result = await engine.run(workflowFn, { ...params, runId });
    expect(result.status).toBe("awaiting_gate");
    if (result.status !== "awaiting_gate") throw new Error("unreachable");
    await engine.resolveGate(runId, "04-batch-review-r2", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "round 3 feedback — should not get a 4th draft",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...params, runId });
    expect(final.status).toBe("held");
    if (final.status !== "held") throw new Error("unreachable");
    expect(final.reason).toMatch(/ceiling/i);
  }, 30000);
});

describe("intel-report-agent deliberately has no terminal topic guardrail", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("never runs the guardrail even when the client has forbidden topics configured", async () => {
    // Internal deliverable, never published — see this file's own header
    // comment and `guardrail-coverage.test.ts`. A report discussing a topic
    // this client will not POST about is exactly the honest briefing this
    // product exists to produce, and must not be blocked by a check meant
    // for public-facing copy.
    await env.store.writeJson("acme", ["client", "config"], { forbiddenTopics: ["cryptocurrency"] });

    const report = goodIntelReport({
      growthAnalysis: "Acme's growth motion increasingly depends on accepting digital assets on a distributed ledger for enterprise invoicing.",
    });
    const router = fakeRouterSequence([finalTurn(report)]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId: "intel_run_no_guardrail" });

    expect(result.status).toBe("completed");
    const stepIds = (await durableStore.listSteps("intel_run_no_guardrail")).map((s) => s.stepId);
    expect(stepIds).not.toContain("guardrail-verify");
    expect(stepIds).not.toContain("guardrail-verify-load-topics");
  });
});
