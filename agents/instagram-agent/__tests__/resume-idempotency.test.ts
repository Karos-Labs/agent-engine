import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import pathMod from "node:path";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentToolRegistry } from "@agent-engine/core";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "instagram_run_resume", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** Wraps every tool's `execute` in a spy so we can prove a resumed run never re-invokes an already-checkpointed step (mirrors `linkedin-agent`'s own resume test helper). */
function spyOnAllTools(tools: AgentToolRegistry): { spied: AgentToolRegistry; callCounts: () => Record<string, number> } {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  const spied: AgentToolRegistry = {};
  for (const [name, tool] of Object.entries(tools)) {
    const spy = vi.fn(tool.execute.bind(tool));
    spies[name] = spy;
    spied[name] = { ...tool, execute: spy } as AgentToolRegistry[string];
  }
  return { spied, callCounts: () => Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length])) };
}

describe("checkpoint resume idempotency (RFC-01 §8.1)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("re-running engine.run() with the same runId does not re-execute any already-completed step", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);
    // Chromium-free, same rationale as `workflow-e2e.test.ts` (see
    // `fakeRenderCarousel`'s own doc comment) -- swapped in BEFORE spying so
    // the spy still faithfully counts calls to whatever `execute` actually runs.
    const tools: AgentToolRegistry = { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
    const { spied, callCounts } = spyOnAllTools(tools);
    const workflowFn = createInstagramAgentWorkflow({
      tools: spied,
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("completed");
    const countsAfterFirst = callCounts();
    expect(router.complete).toHaveBeenCalledTimes(4);
    expect(Object.values(countsAfterFirst).some((n) => n > 0)).toBe(true);

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") throw new Error("unreachable");
    expect(second.output).toEqual(first.output);

    // Nothing ran again: the router turns, and every tool call, stayed at their first-run counts.
    expect(router.complete).toHaveBeenCalledTimes(4);
    expect(callCounts()).toEqual(countsAfterFirst);

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
  }, 60000);

  /**
   * IGSTYLE-3, §2.3's own acceptance line: "Resume determinism — extend
   * resume-idempotency.test.ts". A revision round's `04g-style-directive`
   * step must behave exactly like every other checkpointed step above — a
   * resume that replays the workflow function from the top must not
   * re-invoke a single tool or model call for a round that already reached
   * its gate, and the round's materialized template must stay byte-identical.
   *
   * The one deliberate exception, called out by `ensureTemplatesOnDisk`'s own
   * doc comment (this file's step above it): that function is NOT itself
   * checkpointed — it re-verifies the template file is actually on THIS
   * instance's disk on every attempt, on purpose, so a resume that lands on
   * a different Cloud Run instance (whose disk never saw round 1's file at
   * all) still gets it written. So this test does not assert "no filesystem
   * write happened" — it asserts the two things IGSTYLE-3 actually promises:
   * no tool/model call re-fires, and the file's CONTENT does not drift.
   */
  it("a resumed run past a style-directive revision does not re-invoke any tool/model call, and the materialized template stays byte-identical (IGSTYLE-3 resume determinism)", async () => {
    const PLAIN_BRAND = {
      name: "Plain Co",
      colors: { neutralDark: "#17181C", neutralLight: "#F2F2F2" },
      visualStyle: "Dark Mode",
    };
    await env.store.writeJson("acme", ["client", "brand"], PLAIN_BRAND);

    const copy = goodCopyOutput();
    const draftTurns = () => [finalTurn(copy), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(), ...draftTurns()]);

    const tools: AgentToolRegistry = { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
    const { spied, callCounts } = spyOnAllTools(tools);
    const workflowFn = createInstagramAgentWorkflow({
      tools: spied,
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const runId = "instagram_run_resume_style_directive";
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const r0 = await engine.run(workflowFn, { ...params, runId });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "make the background darker and the text orange",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflowFn, { ...params, runId });
    expect(r1.status).toBe("awaiting_gate");
    const countsAfterR1 = callCounts();
    const completeCallsAfterR1 = (router.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    const round1Html = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, "slide.html"), "utf8");
    expect(round1Html).toContain("--fg: #FFA500;");

    const stepsAfterR1 = await durableStore.listSteps(runId);
    const directiveStepsAfterR1 = stepsAfterR1.filter((s) => s.stepId === "04g-style-directive-r1");
    expect(directiveStepsAfterR1).toHaveLength(1);
    expect(directiveStepsAfterR1[0]!.status).toBe("completed");

    // Resume with NO new gate resolution — same unresolved gate, replayed
    // from the top. Every checkpointed step up to and including
    // `04g-style-directive-r1` must short-circuit: zero new tool calls, zero
    // new model calls, and the SAME single completed step record (never a
    // second row for the same id).
    const r1Again = await engine.run(workflowFn, { ...params, runId });
    expect(r1Again.status).toBe("awaiting_gate");

    expect(callCounts()).toEqual(countsAfterR1);
    expect((router.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(completeCallsAfterR1);

    const stepsAfterResume = await durableStore.listSteps(runId);
    const directiveStepsAfterResume = stepsAfterResume.filter((s) => s.stepId === "04g-style-directive-r1");
    expect(directiveStepsAfterResume).toHaveLength(1);
    expect(directiveStepsAfterResume[0]!.output).toEqual(directiveStepsAfterR1[0]!.output);

    // `ensureTemplatesOnDisk` is deliberately NOT checkpointed (re-verified
    // every attempt for cross-instance resume safety) — it may re-run, but
    // must reproduce the exact same bytes, never drift on a mere resume.
    const round1HtmlAfterResume = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, "slide.html"), "utf8");
    expect(round1HtmlAfterResume).toBe(round1Html);
  }, 60000);
});
