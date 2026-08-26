import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentToolRegistry } from "@agent-engine/core";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_run_resume", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/** Wraps every tool's `execute` in a spy so we can prove a resumed run never re-invokes an already-checkpointed step or fan-out slot. */
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

describe("checkpoint resume idempotency (RFC-01 §8.1) — steps and fan-out slots alike", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("re-running engine.run() with the same runId does not re-invoke any already-completed step or slot", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const { spied, callCounts } = spyOnAllTools(withMeasuredCapture(env.tools));
    const workflowFn = createSeoGeoAgentWorkflow({ tools: spied, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("completed");
    const countsAfterFirst = callCounts();
    expect(Object.values(countsAfterFirst).some((n) => n > 0)).toBe(true);
    const captureCallsAfterFirst = countsAfterFirst["research.captureVisibility"];
    expect(captureCallsAfterFirst).toBeGreaterThan(0);

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") throw new Error("unreachable");
    expect(second.output).toEqual(first.output);

    // Nothing ran again: every tool call count is identical to the first run's.
    expect(callCounts()).toEqual(countsAfterFirst);

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
  });

  it("resumes correctly after a mid-run crash: earlier steps aren't redone, the run still reaches completed", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const { spied, callCounts } = spyOnAllTools(withMeasuredCapture(env.tools));

    // A wrapper that throws once, right after the deliverable is persisted,
    // simulating a crash partway through Phase 8's final persistence steps.
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
    const workflowFn = createSeoGeoAgentWorkflow({ tools: crashOnceTools, promptStore, router, autoApprove: true });

    const runId = "seo_geo_run_resume_crash";
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, { ...params, runId });
    expect(first.status).toBe("degraded");

    const stepsAfterCrash = await durableStore.listSteps(runId);
    const persistDeliverableStep = stepsAfterCrash.find((s) => s.stepId === "17-persist-deliverable");
    const persistManifestStep = stepsAfterCrash.find((s) => s.stepId === "18-persist-manifest");
    expect(persistDeliverableStep?.status).toBe("completed");
    expect(persistManifestStep?.status).toBe("failed");

    const deliverableCallsAfterCrash = callCounts()["ledger.writeDeliverable"];
    const captureCallsAfterCrash = callCounts()["research.captureVisibility"];

    const second = await engine.run(workflowFn, { ...params, runId });
    expect(second.status).toBe("completed");

    // Everything before the crash point (including the entire AI-visibility
    // fan-out) was NOT redone; only the steps after the crash point ran on resume.
    expect(callCounts()["ledger.writeDeliverable"]).toBe(deliverableCallsAfterCrash);
    expect(callCounts()["research.captureVisibility"]).toBe(captureCallsAfterCrash);

    const finalSteps = await durableStore.listSteps(runId);
    expect(finalSteps.every((s) => s.status === "completed")).toBe(true);
  });
});
