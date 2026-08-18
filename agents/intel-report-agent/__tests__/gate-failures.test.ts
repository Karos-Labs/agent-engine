import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createIntelReportAgentWorkflow } from "../src/workflow/create-intel-report-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

describe("03-verify-numbers-sourced: a fabricated numeric claim holds the run before it ever reaches a human (RFC-05 §5)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced percentage in the analysis prose fails gate.numbersSourced -> held, never reaching batch-review", async () => {
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

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/numbers not sourced/i);
    expect(result.reason).toMatch(/43%/);

    const stepRecords = await durableStore.listSteps("intel_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("02-generate-report");
    expect(ids).toContain("03-verify-numbers-sourced");
    expect(ids).not.toContain("04-batch-review");

    const readReport = await env.tools["intel.getReport"]!.execute(
      {},
      { ctx: { ...baseParams, runId: "verify", metadata: {} } },
    );
    expect(readReport.status).toBe("not_available");
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
