import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine, CLEAN_GATE_TIMEOUT, FLAGGED_GATE_TIMEOUT } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import {
  goodFixDrafts,
  goodNarrative,
  makePromptStore,
  setupTestEnvironment,
  smartFakeRouter,
  withMeasuredCapture,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * A GATE THAT APPROVES ON TIMEOUT IS A DELAY, NOT A GATE.
 *
 * `16-batch-review` is the gate holding the client-visible seo-geo report, and
 * it carried a flat `1h / auto_approve`. A report whose AI visibility was never
 * MEASURED — the capture layer down, the index nulled, half the product
 * missing — shipped on the same hour as a complete one. The platform's
 * three-tier policy (`packages/workflow/src/primitives/gate-timeout.ts`) gives
 * it six hours and then still ships it: the flag buys a reviewer TIME, not a
 * veto, because a report nobody came back to is a report thrown away.
 */

const baseParams = { clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

async function pauseAtBatchReview(env: TestEnvironment, measured: boolean, runId: string) {
  const workflowFn = createSeoGeoAgentWorkflow({
    tools: measured ? withMeasuredCapture(env.tools) : env.tools,
    promptStore: makePromptStore(),
    router: smartFakeRouter([goodFixDrafts(), goodNarrative()]),
  });
  const durableStore = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(durableStore);
  // Three human gates upstream of the one under test; approve each in turn.
  for (const gateId of ["03-prompt-set-review", "12-fix-generation-review"]) {
    await engine.run(workflowFn, { ...baseParams, runId });
    await engine.resolveGate(runId, gateId, { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });
  }
  const paused = await engine.run(workflowFn, { ...baseParams, runId });
  if (paused.status !== "awaiting_gate") throw new Error(`expected the batch-review gate, got ${paused.status}`);
  const gate = await durableStore.getGate(paused.pendingGateId);
  return { gate, payload: (gate?.payload ?? {}) as Record<string, unknown> };
}

describe("what the clock on the seo-geo batch-review gate is worth", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a fully measured report keeps the hour it always had", async () => {
    const { gate, payload } = await pauseAtBatchReview(env, true, "seo_geo_clock_clean");
    expect(gate?.timeout?.duration).toBe(CLEAN_GATE_TIMEOUT);
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["gateFlags"]).toBeUndefined();
  }, 60_000);

  it("a report whose AI visibility was never measured waits six hours, and says so", async () => {
    const { gate, payload } = await pauseAtBatchReview(env, false, "seo_geo_clock_flagged");
    expect(gate?.timeout?.duration).toBe(FLAGGED_GATE_TIMEOUT);
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["gateFlags"]).toEqual([expect.stringMatching(/visibility was not measured/i)]);
  }, 60_000);
});
