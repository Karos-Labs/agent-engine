import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import {
  createIntelReportAgentWorkflow,
  redactUnsourcedClaims,
} from "../src/workflow/create-intel-report-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

/**
 * The owner's rule, taken literally: this agent does not hand a client an
 * error in place of a report because something inside the agent went wrong.
 *
 * The run that settled it is prep job BplmW1WBhLTRaNZvtAGw / engine run
 * pubsub-21854296073980161 (karoslabs, 2026-09-17). The research pull carried
 * "non-technical mid-market B2B teams ($5M-$30M ARR)"; the draft quoted that
 * range back with an en dash; `gate.numbersSourced` could not read a
 * magnitude-suffixed range and reported "$30M" as unsourced; step 03 threw
 * `WorkflowHeld`; the client got a held job and $0.46 of research and drafting
 * was discarded. Two independent faults, and this file pins the fix to both:
 *
 *   - the gate now reads that range (`numbers-sourced.ts` 1.6.0, tested in
 *     `packages/tools/karos-gates`), so the honest draft simply passes; and
 *   - step 03 no longer has the power to end the run at all, so the NEXT
 *     misread — or the next genuinely invented figure — costs a sentence
 *     instead of a deliverable.
 */
describe("the intel report agent never ends a run at held", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("delivers the report the prep run was denied, with the disputed figure removed", async () => {
    // The prep failure, at the workflow level. In this environment
    // `research.pull` runs offline and its result carries only the query and a
    // fixed note, so the range is unsourced HERE by construction — whether the
    // gate can read "$5M-$30M" against a source that states it is pinned where
    // that belongs, in `packages/tools/karos-gates`.
    //
    // What this asserts is the part that failed on 2026-09-17 whichever side
    // was right: whatever the gate concludes, the client gets the report.
    const quoted = goodIntelReport({
      positioningAnalysis:
        "Okara targets non-technical mid-market B2B teams at $5M–$30M ARR. That is adjacent to but not the same as this client's lane.",
    });
    const router = fakeRouterSequence([finalTurn(quoted)]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "intel_never_holds_range" });

    expect(result.status).toBe("completed");

    const stored = await env.tools["intel.getReport"]!.execute({}, { ctx: { ...baseParams, runId: "verify", metadata: {} } });
    const { report } = (stored as { result: { report: Record<string, string> } }).result;
    // The unsourceable sentence is gone; the rest of the section survives it.
    expect(report["positioningAnalysis"]).not.toMatch(/\$30M/);
    expect(report["positioningAnalysis"]).toMatch(/adjacent to but not the same/);
    // And the repair is declared rather than silent.
    expect((result.status === "completed" ? result.output : null) as { numericGrounding?: { redactedFigures: string[] } })
      .toMatchObject({ numericGrounding: { redactedFigures: ["$5M", "$30M"], unsourcedFigures: [] } });

    const ids = (await durableStore.listSteps("intel_never_holds_range")).map((s) => s.stepId);
    expect(ids).toContain("02b-ground-numeric-claims");
    expect(ids).toContain("03-verify-numbers-sourced");
    expect(ids).toContain("06-persist-deliverable");
  });

  it("re-drafts rather than holding when the first draft comes back unparseable", async () => {
    // The other `WorkflowHeld` this workflow used to carry. A turn that comes
    // back without a usable structured output is a coin flip, not a verdict on
    // the report, so it gets re-flipped once under its own step id.
    const router = fakeRouterSequence([
      () => ({
        output: { type: "final", output: { nonsense: true } },
        modelUsed: "claude-sonnet-4-6",
        inputTokens: { cached: 0, uncached: 100 },
        outputTokens: 30,
      }),
      finalTurn(goodIntelReport()),
    ]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "intel_never_holds_redraft" });

    expect(result.status).toBe("completed");
    const ids = (await durableStore.listSteps("intel_never_holds_redraft")).map((s) => s.stepId);
    expect(ids).toContain("02a-regenerate-report");
  });

  it("does not spend a re-draft turn on a draft that parsed", async () => {
    // `02a` must stay off the happy path: one turn only, so a second request
    // would exhaust the queue and fail this test.
    const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "intel_never_holds_no_redraft" });

    expect(result.status).toBe("completed");
    const ids = (await durableStore.listSteps("intel_never_holds_no_redraft")).map((s) => s.stepId);
    expect(ids).not.toContain("02a-regenerate-report");
  });
});

describe("the gate's sources are the same evidence the drafting prompt reads", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  /** The prose the draft writes when it quotes the market-strategy document. */
  const QUOTING_THE_CONTEXT_DOC =
    "The band this client sells into is $5M-$30M ARR, which is where the category's most visible entrant also concentrates.";

  it("counts a figure stated in a projected context document as sourced", async () => {
    // The drafting prompt is handed `targetAudience` and `marketStrategy` as
    // fact, so a figure the draft takes from one of them is quoted, not
    // invented — but the gate was only ever shown the web research, so it
    // reported such a figure as unsourced and the step above it held the run.
    await env.store.writeJson("acme", ["context", "market-strategy"], {
      markdown: "We sell into mid-market B2B teams at $5M-$30M ARR with 1-3 non-technical marketers.",
    });

    const router = fakeRouterSequence([finalTurn(goodIntelReport({ positioningAnalysis: QUOTING_THE_CONTEXT_DOC }))]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...baseParams, runId: "intel_sources_context_doc" });

    expect(result.status).toBe("completed");
    const stored = await env.tools["intel.getReport"]!.execute({}, { ctx: { ...baseParams, runId: "verify", metadata: {} } });
    const { report } = (stored as { result: { report: Record<string, string> } }).result;
    // Intact, i.e. NOT redacted: the context document counted as a source.
    expect(report["positioningAnalysis"]).toBe(QUOTING_THE_CONTEXT_DOC);
    expect((result.status === "completed" ? result.output : null) as Record<string, unknown>).not.toHaveProperty("numericGrounding");
  });

  it("still redacts the same figure when no document states it", async () => {
    // The control that makes the test above mean something: with the default
    // fixture's figure-free context documents, the identical sentence is
    // unsourced and loses its sentence.
    const router = fakeRouterSequence([finalTurn(goodIntelReport({ positioningAnalysis: QUOTING_THE_CONTEXT_DOC }))]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...baseParams, runId: "intel_sources_context_doc_control" });

    expect(result.status).toBe("completed");
    const stored = await env.tools["intel.getReport"]!.execute({}, { ctx: { ...baseParams, runId: "verify", metadata: {} } });
    const { report } = (stored as { result: { report: Record<string, string> } }).result;
    expect(report["positioningAnalysis"]).not.toBe(QUOTING_THE_CONTEXT_DOC);
  });
});

describe("redactUnsourcedClaims: the deterministic floor under step 03", () => {
  const base = goodIntelReport();

  it("drops the sentence carrying the figure and keeps the rest of the section", () => {
    const report = goodIntelReport({
      conversionAnalysis: "The signup flow is three steps long. Conversion improved 43% after the redesign. Pricing is visible without a sales call.",
    });

    const out = redactUnsourcedClaims(report, ["43%"]);

    expect(out.report.conversionAnalysis).toBe("The signup flow is three steps long. Pricing is visible without a sales call.");
    expect(out.redactedFigures).toEqual(["43%"]);
    expect(out.droppedSentences).toBe(1);
  });

  it("leaves a section that lost nothing byte-identical", () => {
    // Rebuilding every section would flatten paragraph breaks into single
    // spaces for no reason, silently rewriting prose nobody asked it to touch.
    const report = goodIntelReport({
      contentAnalysis: "First paragraph.\n\nSecond paragraph.",
      conversionAnalysis: "Conversion improved 43% after the redesign.",
    });

    const out = redactUnsourcedClaims(report, ["43%"]);

    expect(out.report.contentAnalysis).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("states the gap rather than emptying a section whose every sentence carried a figure", () => {
    const report = goodIntelReport({ growthAnalysis: "Pipeline is up 40%." });

    const out = redactUnsourcedClaims(report, ["40%"]);

    expect(out.report.growthAnalysis).toMatch(/not reported/i);
    expect(out.report.growthAnalysis.length).toBeGreaterThan(0);
  });

  it("is a no-op when there is nothing to redact", () => {
    const out = redactUnsourcedClaims(base, []);

    expect(out.report).toBe(base);
    expect(out.droppedSentences).toBe(0);
  });

  it("reports that it located nothing, so step 03's loop can stop instead of spinning", () => {
    // The termination property. If the gate ever names a figure that is not
    // findable in the prose as written, redaction must say so rather than
    // return an unchanged report the caller would hand straight back to it.
    const out = redactUnsourcedClaims(base, ["£999 trillion"]);

    expect(out.droppedSentences).toBe(0);
    expect(out.redactedFigures).toEqual([]);
  });
});
