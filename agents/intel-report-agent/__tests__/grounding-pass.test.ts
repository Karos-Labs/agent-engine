import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createIntelReportAgentWorkflow } from "../src/workflow/create-intel-report-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

/**
 * `02b-ground-numeric-claims` — the pre-gate self-correction pass.
 *
 * `gate.numbersSourced` holding the run is correct and is not being softened.
 * But a held run is a report nobody gets, and the usual cause is one sentence
 * out of seven sections: on 2026-09-04 a Karos Labs report was held over seven
 * figures, six of which were faithful quotations of sourced ranges the gate
 * mis-read (fixed separately in `numbers-sourced.ts`) and one of which was a
 * genuine over-assertion — the draft turned a source's `$500-$2,000/month`
 * into "engagements at $2,000+/month".
 *
 * The property that matters most here is the LAST test in this file: this step
 * can improve a report's chances and must never be able to wave one through.
 *
 * In this environment `research.pull` runs on the offline scraper, whose result
 * carries only the query and a fixed note — so any figure in the analysis prose
 * is unsourced by construction, which is exactly what these tests need.
 */
describe("02b-ground-numeric-claims", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  /** The seven corrected sections plus the audit trail, as the grounding agent returns them. */
  function groundingOutput(overrides: Record<string, unknown> = {}) {
    return {
      contentAnalysis: "Messaging is specific and consistent across the site.",
      conversionAnalysis: "Pricing sits well above the category's entry tier, though the exact figure is not confirmed in the research.",
      seoAnalysis: "Coverage of buying-intent terms is thin relative to the category.",
      geoAnalysis: "The site offers few citable, answer-shaped pages.",
      positioningAnalysis: "Positioned as the developer-first option.",
      brandAnalysis: "Voice is consistent between docs and marketing.",
      growthAnalysis: "Growth is inbound-led with no outbound assist.",
      corrections: [{ claim: "43%", action: "replaced_with_qualitative", note: "No source states this figure; rewritten without a number." }],
      ...overrides,
    };
  }

  it("repairs an unsourced figure and lets the run through the gate", async () => {
    const fabricated = goodIntelReport({
      conversionAnalysis: "Acme's conversion rate improved 43% after the last redesign.",
    });
    // Turn 1: the draft. Turn 2: the correction pass.
    const router = fakeRouterSequence([finalTurn(fabricated), finalTurn(groundingOutput())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "intel_grounding_repairs" });

    expect(result.status).toBe("completed");
    const ids = (await durableStore.listSteps("intel_grounding_repairs")).map((s) => s.stepId);
    expect(ids).toContain("02b-ground-numeric-claims");
    expect(ids).toContain("03-verify-numbers-sourced");
  });

  it("keeps the corrected prose, not the draft's, in the persisted report", async () => {
    // A correction that runs but is discarded would pass the gate and still
    // ship the sentence with the invented figure in it.
    const fabricated = goodIntelReport({
      conversionAnalysis: "Acme's conversion rate improved 43% after the last redesign.",
    });
    const router = fakeRouterSequence([finalTurn(fabricated), finalTurn(groundingOutput())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });

    await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...baseParams, runId: "intel_grounding_persists" });

    const stored = await env.tools["intel.getReport"]!.execute({}, { ctx: { ...baseParams, runId: "verify", metadata: {} } });
    expect(stored.status).toBe("success");
    const { report } = (stored as { result: { report: { conversionAnalysis: string } } }).result;
    expect(report.conversionAnalysis).not.toMatch(/43%/);
    expect(report.conversionAnalysis).toMatch(/not confirmed/i);
  });

  it("does not spend a turn on a report that already passes", async () => {
    // `goodIntelReport` carries no numeric claims at all, so the gate's dry run
    // returns "pass" and the correction pass must return the draft untouched
    // without calling the model. Only ONE turn is configured: a second request
    // would exhaust the queue and throw.
    const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...baseParams, runId: "intel_grounding_noop" });

    expect(result.status).toBe("completed");
  });

  it("keeps the original draft when the correction pass itself fails", async () => {
    // Losing a drafted report because a repair attempt errored would be
    // strictly worse than not attempting one. The run is still held by the
    // gate, with the message it would have had anyway.
    const fabricated = goodIntelReport({
      conversionAnalysis: "Acme's conversion rate improved 43% after the last redesign.",
    });
    // One turn only: the grounding agent's request exhausts the queue.
    const router = fakeRouterSequence([finalTurn(fabricated)]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...baseParams, runId: "intel_grounding_failed" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/numbers not sourced/i);
    expect(result.reason).toMatch(/43%/);
  });

  it("CANNOT wave a report through — a correction that invents a new figure is still held", async () => {
    // The load-bearing property. This step runs BEFORE the gate, never instead
    // of it, so its output faces exactly the same check the draft did. A
    // correction pass that could bypass the gate would be a hole straight
    // through the anti-fabrication guarantee.
    const fabricated = goodIntelReport({
      conversionAnalysis: "Acme's conversion rate improved 43% after the last redesign.",
    });
    const stillUnsourced = groundingOutput({
      conversionAnalysis: "Acme's conversion rate improved 61% after the last redesign.",
    });
    const router = fakeRouterSequence([finalTurn(fabricated), finalTurn(stillUnsourced)]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...baseParams, runId: "intel_grounding_cannot_bypass" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    // The gate reports the NEW invented figure, proving it checked the
    // corrected text rather than the draft.
    expect(result.reason).toMatch(/61%/);
  });
});
