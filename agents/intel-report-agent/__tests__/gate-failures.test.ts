import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createIntelReportAgentWorkflow } from "../src/workflow/create-intel-report-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

describe("03-verify-numbers-sourced: a fabricated numeric claim is removed from the report, and never reaches the client (RFC-05 §5)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced percentage is REPAIRED, not held: the client still gets a report and the figure is gone", async () => {
    const promptStore = makePromptStore();
    // research.pull's Phase-1 stand-in result only ever contains the query text and a
    // fixed "note" string (see packages/tools/karos-research/src/pull.ts) — it can never
    // contain a specific figure like "43%", so any numeric claim in the report's analysis
    // prose is, by construction, unsourced in this test environment.
    const fabricatedReport = goodIntelReport({
      conversionAnalysis: "Acme's conversion rate improved 43% after the last redesign, based on internal figures.",
    });
    const router = fakeRouterSequence([finalTurn(fabricatedReport)]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "intel_run_gate_numbers" });

    // The old contract was `held`: the gate threw, the run ended, and the
    // client got an error message instead of six sound sections. The gate's
    // authority over what may be PUBLISHED is unchanged and asserted below —
    // what it lost is the authority to end the run.
    expect(result.status).toBe("completed");

    const stepRecords = await durableStore.listSteps("intel_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("02-generate-report");
    expect(ids).toContain("03-verify-numbers-sourced");
    expect(ids).toContain("04-batch-review-r0");

    // The report really landed, and the invented figure really did not.
    const readReport = await env.tools["intel.getReport"]!.execute(
      {},
      { ctx: { ...baseParams, runId: "verify", metadata: {} } },
    );
    expect(readReport.status).toBe("success");
    const { report } = (readReport as { result: { report: Record<string, string> } }).result;
    expect(report["conversionAnalysis"]).not.toMatch(/43%/);
    // The other six sections are untouched — one bad sentence costs one
    // sentence, not the report.
    expect(report["seoAnalysis"]).toBe(fabricatedReport.seoAnalysis);

    // And the repair is on the record rather than silent.
    expect(result.status === "completed" && (result.output as { numericGrounding?: { redactedFigures: string[] } }).numericGrounding)
      .toMatchObject({ redactedFigures: ["43%"] });
  });

  it("never ends at held, however many figures the gate rejects", async () => {
    // The guarantee the owner asked for, stated directly: an internal quality
    // check failing is not a reason to bill the client a failed deliverable.
    const promptStore = makePromptStore();
    const fabricated = goodIntelReport({
      contentAnalysis: "Traffic grew 12% last quarter.",
      conversionAnalysis: "Conversion improved 43% after the redesign.",
      seoAnalysis: "Rankings moved 88% of tracked terms into the top three.",
      growthAnalysis: "Pipeline is up $4.2 million year over year.",
    });
    const router = fakeRouterSequence([finalTurn(fabricated)]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "intel_run_gate_numbers_many" });

    expect(result.status).toBe("completed");
    const stored = await env.tools["intel.getReport"]!.execute({}, { ctx: { ...baseParams, runId: "verify", metadata: {} } });
    const { report } = (stored as { result: { report: Record<string, string> } }).result;
    // The seven analysis fields only — `dimensionScores` carries a literal
    // `"weight": 12`, and this gate has never been about the scores.
    const prose = ["contentAnalysis", "conversionAnalysis", "seoAnalysis", "geoAnalysis", "positioningAnalysis", "brandAnalysis", "growthAnalysis"]
      .map((field) => report[field])
      .join(" ");
    for (const figure of ["12%", "43%", "88%", "$4.2 million"]) {
      expect(prose).not.toContain(figure);
    }
    // A section whose every sentence rested on an unsourced figure says so
    // rather than coming back empty.
    expect(report["contentAnalysis"]).toMatch(/not reported/i);
  });

  it("a numeric claim that genuinely appears in the research pull's own content clears the gate", async () => {
    const promptStore = makePromptStore();
    // The research query itself is deterministic (derived from the seeded client's
    // industry + competitor name) and becomes part of `sources` — so a "claim" that is
    // really just a substring of the query/result JSON blob passes. This isn't a
    // meaningful business number, just proof the gate's pass path is reachable at all
    // without a genuinely fabricated figure blocking every run.
    const cleanReport = goodIntelReport();
    const router = fakeRouterSequence([finalTurn(cleanReport)]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "intel_run_gate_numbers_clean" });

    expect(result.status).toBe("completed");
  });
});

describe("04-batch-review: the human gate genuinely blocks without options.autoApprove (RFC-01 §8.3)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("stops at awaiting_gate with no autoApprove, and the model is never called a second time on replay", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, { ...baseParams, runId: "intel_run_gate_review_block" });
    expect(first.status).toBe("awaiting_gate");

    // Replaying without resolving the gate must not re-invoke the model — the
    // 02-generate-report step is checkpointed, and the gate keeps throwing until resolved.
    const second = await engine.run(workflowFn, { ...baseParams, runId: "intel_run_gate_review_block" });
    expect(second.status).toBe("awaiting_gate");
    expect(router.complete).toHaveBeenCalledTimes(1);
  });
});
