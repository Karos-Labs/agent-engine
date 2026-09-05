import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentToolRegistry } from "@agent-engine/core";
import { createCampaignWorkflow } from "../src/workflow/create-campaign-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodCampaignPlan,
  makeCampaignPromptStore,
  makeChannelPromptStores,
  makeChannelRouters,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" as const };
const runId = (seed: string) => `${seed}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const expectedChannelTurns: Record<"x" | "linkedin" | "reddit" | "blog" | "newsletter", number> = {
  x: 2,
  linkedin: 2,
  reddit: 1,
  blog: 1,
  newsletter: 1,
};

/** Wraps every tool's `execute` in a spy so we can prove a resumed run never re-invokes an already-checkpointed step, across the entire nested 5-channel tree. */
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

describe("checkpoint resume idempotency across the campaign gate (RFC-01 §8.1, §8.3)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment("acme");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("resuming past an approved gate re-executes nothing — not one tool call across all 5 channels, not one model turn", async () => {
    const params = { ...baseParams, runId: runId("campaign_run_gate") };
    const { spied, callCounts } = spyOnAllTools(env.tools);
    const campaignRouter = fakeRouterSequence([finalTurn(goodCampaignPlan())]);
    const channelRouters = makeChannelRouters();

    const workflowFn = createCampaignWorkflow({
      tools: spied,
      promptStore: makeCampaignPromptStore(),
      router: campaignRouter,
      channelPromptStores: makeChannelPromptStores(),
      channelRouters,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");

    const countsAtGate = callCounts();
    expect(Object.values(countsAtGate).some((n) => n > 0)).toBe(true);
    expect(campaignRouter.complete).toHaveBeenCalledTimes(1);

    await engine.resolveGate(params.runId, "13-campaign-review", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");

    // Steps 00-12 (including all 5 channels' own nested work) already completed
    // before the gate, so their tool calls stay at their pre-gate counts exactly —
    // only steps 14/15 (downstream of the gate) run for the first time on resume,
    // each calling these three tools once more, for the bundle itself.
    const expectedCountsAfterResume = {
      ...countsAtGate,
      "ledger.writeDeliverable": countsAtGate["ledger.writeDeliverable"]! + 1,
      "memory.appendDecision": countsAtGate["memory.appendDecision"]! + 1,
      "topics.commit": countsAtGate["topics.commit"]! + 1,
    };
    expect(callCounts()).toEqual(expectedCountsAfterResume);
    expect(campaignRouter.complete).toHaveBeenCalledTimes(1);
    for (const channel of ["x", "linkedin", "reddit", "blog", "newsletter"] as const) {
      expect(vi.mocked(channelRouters[channel].complete).mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(vi.mocked(channelRouters[channel].complete).mock.calls.length).toBeLessThanOrEqual(expectedChannelTurns[channel]);
    }

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
  });

  it("resumes correctly after a mid-run crash following gate approval: the bundle persists, nothing re-runs, the run still reaches completed", async () => {
    const params = { ...baseParams, runId: runId("campaign_run_gate_crash") };
    const { spied, callCounts } = spyOnAllTools(env.tools);
    const campaignRouter = fakeRouterSequence([finalTurn(goodCampaignPlan())]);
    const channelRouters = makeChannelRouters();

    // A wrapper that throws once memory.appendDecision is reached, simulating a
    // crash right after the bundle was persisted but before the run fully commits.
    let bundlePersisted = false;
    const crashOnceTools: AgentToolRegistry = {
      ...spied,
      "ledger.writeDeliverable": {
        ...spied["ledger.writeDeliverable"]!,
        execute: vi.fn(async (input: unknown, opts: unknown) => {
          const result = await spied["ledger.writeDeliverable"]!.execute(input as never, opts as never);
          const deliverable = (input as { kind?: string }).kind;
          if (deliverable === "campaign-bundle") bundlePersisted = true;
          return result;
        }),
      },
      "memory.appendDecision": {
        ...spied["memory.appendDecision"]!,
        execute: vi.fn(async (input: unknown, opts: unknown) => {
          if (bundlePersisted) {
            bundlePersisted = false; // only crash the first time we get here
            throw new Error("simulated crash right after persisting the campaign bundle");
          }
          return spied["memory.appendDecision"]!.execute(input as never, opts as never);
        }),
      },
    };

    const workflowFn = createCampaignWorkflow({
      tools: crashOnceTools,
      promptStore: makeCampaignPromptStore(),
      router: campaignRouter,
      channelPromptStores: makeChannelPromptStores(),
      channelRouters,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runIdValue = params.runId;
    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");

    await engine.resolveGate(runIdValue, "13-campaign-review", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("degraded");

    const stepsAfterCrash = await durableStore.listSteps(runIdValue);
    const persistStep = stepsAfterCrash.find((s) => s.stepId === "14-persist-campaign-bundle");
    const commitStep = stepsAfterCrash.find((s) => s.stepId === "15-commit-and-record");
    expect(persistStep?.status).toBe("completed");
    expect(commitStep?.status).toBe("failed");

    const countsAfterCrash = callCounts();
    expect(campaignRouter.complete).toHaveBeenCalledTimes(1);

    const third = await engine.run(workflowFn, params);
    expect(third.status).toBe("completed");

    // Nothing before the crash point re-ran on the second resume either.
    expect(campaignRouter.complete).toHaveBeenCalledTimes(1);
    expect(callCounts()["ledger.writeDeliverable"]).toBe(countsAfterCrash["ledger.writeDeliverable"]);

    const finalSteps = await durableStore.listSteps(runIdValue);
    // Named, not a boolean: a failure here has to say WHICH step ended in what
    // state, or the next reader is left with "expected false to be true".
    expect(finalSteps.filter((s) => s.status !== "completed").map((s) => `${s.stepId}: ${s.status}${s.error ? ` (${s.error})` : ""}`)).toEqual([]);
  });
});
