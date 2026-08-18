import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
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
});
