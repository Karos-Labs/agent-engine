import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine, CLEAN_GATE_TIMEOUT, FLAGGED_GATE_TIMEOUT } from "@agent-engine/workflow";
import { createIntelReportAgentWorkflow } from "../src/workflow/create-intel-report-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * A GATE THAT APPROVES ON TIMEOUT IS A DELAY, NOT A GATE.
 *
 * `04-batch-review` carried a flat `1h / auto_approve`. A report that had a
 * sentence REDACTED on the way here — an unsourced figure the numbers gate
 * refused — is not what the writer wrote, and it got the same hour a clean
 * report got. The platform's three-tier policy
 * (`packages/workflow/src/primitives/gate-timeout.ts`) gives it six hours and
 * then still ships it: the flag buys a reviewer TIME, not a veto.
 */

const baseParams = { clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

async function pauseAtGate(env: TestEnvironment, report: ReturnType<typeof goodIntelReport>, runId: string) {
  const workflowFn = createIntelReportAgentWorkflow({
    tools: env.tools,
    promptStore: makePromptStore(),
    router: fakeRouterSequence([finalTurn(report)]),
  });
  const durableStore = new MemoryDurableStepStore();
  const paused = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId });
  if (paused.status !== "awaiting_gate") throw new Error(`expected the batch-review gate, got ${paused.status}`);
  const gate = await durableStore.getGate(paused.pendingGateId);
  return { gate, payload: (gate?.payload ?? {}) as Record<string, unknown> };
}

describe("what the clock on the intel batch-review gate is worth", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a report with nothing repaired keeps the hour it always had", async () => {
    const { gate, payload } = await pauseAtGate(env, goodIntelReport(), "intel_clock_clean");
    expect(gate?.timeout?.duration).toBe(CLEAN_GATE_TIMEOUT);
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["gateFlags"]).toBeUndefined();
  });

  it("a report with a redacted figure waits six hours, and says which", async () => {
    // `research.pull`'s stand-in result can never contain a specific figure, so
    // any number in the analysis prose is unsourced by construction here.
    const fabricated = goodIntelReport({
      conversionAnalysis: "Acme's conversion rate improved 43% after the last redesign, based on internal figures.",
    });
    const { gate, payload } = await pauseAtGate(env, fabricated, "intel_clock_flagged");
    expect(gate?.timeout?.duration).toBe(FLAGGED_GATE_TIMEOUT);
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["gateFlags"]).toEqual([expect.stringMatching(/unsourced figure\(s\) were redacted/)]);
    expect(payload["gateWaitReason"]).toMatch(/waits for a person/i);
  });
});
