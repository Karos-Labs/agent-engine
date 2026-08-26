import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
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

const params = { runId: "seo_geo_zero_cell", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/**
 * AU26 (SCRUM-292): a run whose AI-visibility capture measured nothing must
 * end `held` and must never persist a client-facing report.
 *
 * The distinction under test is `measuredCount` vs `capturedCount`. Every
 * capture slot COMPLETES today — `research.captureVisibility` has no capture
 * adapter and returns a successful, schema-valid `UNAVAILABLE` cell for every
 * input — so `capturedCount` is the full prompt×engine matrix on a run that
 * measured precisely nothing. A `capturedCount === 0` guard would never fire.
 */
describe("AU26: zero measured capture cells holds the run", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("holds when every captured cell is UNAVAILABLE, and persists no deliverable", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    // env.tools is the REAL registry — the stub capture tool, unmodified.
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/measured nothing/i);
    expect(result.reason).toMatch(/UNAVAILABLE/);

    // The capture itself worked — this is a data-availability hold, not a
    // tooling failure, and the message says so with real counts.
    const assembled = await durableStore.getStep(params.runId, "08-assemble-visibility-cells");
    expect(assembled?.status).toBe("completed");
    const capture = assembled?.output as { capturedCount: number; measuredCount: number; attemptedCount: number };
    expect(capture.measuredCount).toBe(0);
    expect(capture.capturedCount).toBeGreaterThan(0);
    expect(capture.capturedCount).toBe(capture.attemptedCount);

    // Nothing past the hold ran: no scoring, no narrative, no persistence.
    for (const stepId of ["09-compute-scores", "13-draft-fixes", "14-draft-narrative", "17-persist-deliverable"]) {
      expect(await durableStore.getStep(params.runId, stepId), `${stepId} must not have run`).toBeUndefined();
    }

    // The deliverable ledger must be empty — the whole point of the guard.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]).catch(() => []);
    expect(deliverables).toHaveLength(0);
  });

  it("proceeds normally when at least one cell is genuinely MEASURED", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    const assembled = await durableStore.getStep(params.runId, "08-assemble-visibility-cells");
    const capture = assembled?.output as { capturedCount: number; measuredCount: number };
    expect(capture.measuredCount).toBeGreaterThan(0);
    expect(capture.measuredCount).toBe(capture.capturedCount);

    // The phases the hold would have skipped all ran, and a report exists.
    expect(await durableStore.getStep(params.runId, "09-compute-scores")).toBeDefined();
    expect(result.output.deliverableId).toBeTruthy();
  });
});
