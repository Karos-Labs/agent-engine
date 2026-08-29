import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createIntelReportAgentWorkflow } from "../src/workflow/create-intel-report-agent-workflow.js";
import type { GetReportResult } from "@agent-engine/tool-karos-intel";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "intel_run_1", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

const ALL_STEP_IDS = [
  "00-load-client-context",
  "01-research-pull",
  "01b-read-past-feedback",
  "02-generate-report",
  "03-verify-numbers-sourced",
  // Revision-scoped: `-r0` is the first review round. A `revise` decision
  // registers `-r1` after re-generating.
  "04-batch-review-r0",
  "05-persist-report",
  "06-persist-deliverable",
  "07-persist-manifest",
  "08-record-feedback",
];

function goodReportRouter() {
  return fakeRouterSequence([finalTurn(goodIntelReport())]);
}

describe("end-to-end: the Intel Report agent workflow (RFC-05 §3)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes every step and resolves to completed with a deterministic score/grade (auto-approved gate)", async () => {
    const promptStore = makePromptStore();
    const router = goodReportRouter();
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // Hand-computed from goodIntelReport()'s 8 dimension scores and DIMENSION_WEIGHTS
    // (contentMessaging 15, conversion 15, seo 12, geo 8, positioning 15, brand 10,
    // growth 10, social 15): (78*15+70*15+60*12+50*8+85*15+80*10+65*10+88*15)/100
    // = (1170+1050+720+400+1275+800+650+1320)/100 = 7385/100 = 73.85 -> rounds to 74.
    const expectedOverallScore = Math.round((78 * 15 + 70 * 15 + 60 * 12 + 50 * 8 + 85 * 15 + 80 * 10 + 65 * 10 + 88 * 15) / 100);
    expect(expectedOverallScore).toBe(74);
    expect(result.output.overallScore).toBe(expectedOverallScore);
    expect(result.output.overallGrade).toBe("B"); // 70 <= 74 < 85
    expect(result.output.competitorCount).toBe(1);
    expect(result.output.deliverableId).toBeTruthy();
    expect(result.totalCostUsd).toBeGreaterThan(0);

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId).sort();
    expect(executedIds).toEqual([...ALL_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
    // NO `kind: "gate"` step on this path, and that is correct rather than a
    // gap: `autoApprove` makes the review a `wf.step.code` that synthesizes a
    // system approval (see each workflow's own `options.autoApprove` branch), so
    // there is no real gate to checkpoint. The gate-pause-and-resume test below
    // is where a genuine `"gate"` record is asserted.
    expect(stepRecords.some((s) => s.kind === "gate")).toBe(false);

    // The deliverable and the intel report both really landed on the file-backed WorkspaceStore.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["intel-report"]);

    const readReport = await env.tools["intel.getReport"]!.execute({}, { ctx: { ...params, runId: "verify", metadata: {} } });
    expect(readReport.status).toBe("success");
    if (readReport.status !== "success") throw new Error("unreachable");
    const readResult = readReport.result as GetReportResult;
    expect(readResult.report.overallScore).toBe(expectedOverallScore);
    expect(readResult.competitors[0]!.source).toBe("report");
  });

  it("pauses at the human batch-review gate by default, then resumes to completed on approval (RFC-01 §8.3)", async () => {
    const promptStore = makePromptStore();
    const router = goodReportRouter();
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("04-batch-review-r0");

    const beforeApproval = await env.tools["intel.getReport"]!.execute({}, { ctx: { ...params, runId: "verify", metadata: {} } });
    expect(beforeApproval.status).toBe("not_available");

    await engine.resolveGate(params.runId, "04-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date(2026, 7, 17).toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(1);

    // THE GATE IS A STEP RECORD TOO, now that `wf.step.gate` checkpoints
    // itself (`kind: "gate"`) — so the full id list appears here, gate
    // included, and this suite's own "N-step workflow" name is finally
    // literally true. This assertion used to filter "04-batch-review" OUT,
    // under a comment explaining that a gate never reaches `listSteps()`;
    // that absence is exactly what made a real run's step sequence read
    // straight past its human review step in the portal.
    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual([...ALL_STEP_IDS].sort());
    // And the checkpoint carries the DECISION, which is the only place the
    // run records that a human approved this and who they were.
    const gateStep = stepRecords.find((s) => s.kind === "gate");
    expect(gateStep?.stepId).toBe("04-batch-review-r0");
    expect(gateStep?.output).toMatchObject({ decision: "approve", actor: "jane@karoslabs.com" });
  });

  it("rejects the batch review with a reason -> held, and nothing is persisted", async () => {
    const promptStore = makePromptStore();
    const router = goodReportRouter();
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    await engine.run(workflowFn, params);
    await engine.resolveGate(params.runId, "04-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "dimension scores look inflated this run",
      at: new Date(2026, 7, 17).toISOString(),
    });

    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/review rejected/i);
    expect(result.reason).toMatch(/dimension scores look inflated this run/);

    const readReport = await env.tools["intel.getReport"]!.execute({}, { ctx: { ...params, runId: "verify", metadata: {} } });
    expect(readReport.status).toBe("not_available");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  });
});
