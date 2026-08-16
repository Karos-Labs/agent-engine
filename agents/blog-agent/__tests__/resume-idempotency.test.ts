import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentToolRegistry } from "@agent-engine/core";
import { createBlogAgentWorkflow } from "../src/workflow/create-blog-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "blog_run_resume", clientSlug: "acme", productId: "blog-agent", runKind: "recurring" as const };

/** Wraps every tool's `execute` in a spy so we can prove a resumed run never re-invokes an already-checkpointed step. */
function spyOnAllTools(tools: AgentToolRegistry): { spied: AgentToolRegistry; callCounts: () => Record<string, number> } {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  const spied: AgentToolRegistry = {};
  for (const [name, tool] of Object.entries(tools)) {
    const spy = vi.fn(tool.execute.bind(tool));
    spies[name] = spy;
    spied[name] = { ...tool, execute: spy } as AgentToolRegistry[string];
  }
  return {
    spied,
    callCounts: () => Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length])),
  };
}

function goodDraft() {
  const title = "How We Cut Onboarding Time in Half With a Structured 4-Day Rollout";
  const bodyMarkdown =
    "## The problem with our old onboarding\n\nNew engineers took nearly a month before they shipped anything meaningful.\n\n" +
    "## The results after one quarter\n\nMedian time to first merged pull request dropped 47% [1], from 19 days to about 10.";
  return {
    title,
    slug: "structured-four-day-onboarding-rollout",
    excerpt: "A breakdown of the onboarding changes that actually moved the needle.",
    bodyMarkdown,
    headersList: ["The problem with our old onboarding", "The results after one quarter"],
    metaDescription: "How a structured 4-day onboarding rollout cut new-hire ramp time in half.",
    estimatedReadMinutes: 3,
    text: `${title}\n\n${bodyMarkdown}`,
  };
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
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const { spied, callCounts } = spyOnAllTools(env.tools);
    const workflowFn = createBlogAgentWorkflow({ tools: spied, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("completed");
    const countsAfterFirst = callCounts();
    expect(router.complete).toHaveBeenCalledTimes(1);
    expect(Object.values(countsAfterFirst).some((n) => n > 0)).toBe(true);

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") throw new Error("unreachable");
    expect(second.output).toEqual(first.output);

    // Nothing ran again: the router turn, and every tool call, stayed at their first-run counts.
    expect(router.complete).toHaveBeenCalledTimes(1);
    expect(callCounts()).toEqual(countsAfterFirst);

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords).toHaveLength(16);
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
  });

  it("resumes correctly after a mid-run crash: earlier steps aren't redone, the run still reaches completed", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const { spied, callCounts } = spyOnAllTools(env.tools);

    // A wrapper that throws once persistence starts (after step 13), simulating a crash
    // partway through, then behaves normally afterwards.
    let deliverablePersisted = false;
    const crashOnceTools: AgentToolRegistry = {
      ...spied,
      "ledger.writeDeliverable": {
        ...spied["ledger.writeDeliverable"]!,
        execute: vi.fn(async (input: unknown, opts: unknown) => {
          const result = await spied["ledger.writeDeliverable"]!.execute(input as never, opts as never);
          deliverablePersisted = true;
          return result;
        }),
      },
      "ledger.dashboardSnapshot": {
        ...spied["ledger.dashboardSnapshot"]!,
        execute: vi.fn(async (input: unknown, opts: unknown) => {
          if (deliverablePersisted) {
            deliverablePersisted = false; // only crash the first time we get here
            throw new Error("simulated crash right after persisting the deliverable");
          }
          return spied["ledger.dashboardSnapshot"]!.execute(input as never, opts as never);
        }),
      },
    };
    const workflowFn = createBlogAgentWorkflow({ tools: crashOnceTools, promptStore, router });

    const runId = "blog_run_resume_crash";
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, { ...params, runId });
    expect(first.status).toBe("degraded");

    const stepsAfterCrash = await durableStore.listSteps(runId);
    const step13 = stepsAfterCrash.find((s) => s.stepId === "13-persist-deliverable");
    const step14 = stepsAfterCrash.find((s) => s.stepId === "14-persist-manifest");
    expect(step13?.status).toBe("completed");
    // step 14's own tool call threw, so its checkpoint is recorded but as "failed" — not
    // "completed" — which is exactly what makes step-code re-run it (not skip it) on resume.
    expect(step14?.status).toBe("failed");

    const draftCallCountAfterCrash = callCounts()["ledger.writeDeliverable"];
    expect(router.complete).toHaveBeenCalledTimes(1);

    const second = await engine.run(workflowFn, { ...params, runId });
    expect(second.status).toBe("completed");

    // The draft/persist step from before the crash was NOT redone; only the steps
    // after the crash point ran on resume.
    expect(router.complete).toHaveBeenCalledTimes(1);
    expect(callCounts()["ledger.writeDeliverable"]).toBe(draftCallCountAfterCrash);

    const finalSteps = await durableStore.listSteps(runId);
    expect(finalSteps).toHaveLength(16);
    expect(finalSteps.every((s) => s.status === "completed")).toBe(true);
  });
});
