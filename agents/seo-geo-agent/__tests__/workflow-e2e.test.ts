import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_run_e2e", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/** Every non-fan-out `wf.step.*` id the workflow records (05/07 are `wf.fanout`s, tracked as slots, not steps). */
const NON_FANOUT_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-draft-prompt-set",
  "03-prompt-set-review",
  "04-freeze-prompt-set",
  "06-derive-technical-measurements",
  "08-assemble-visibility-cells",
  "09-compute-scores",
  "10-connector-overlay",
  "11-fire-recommendations",
  "12-fix-generation-review",
  "13-draft-fixes",
  "14-draft-narrative",
  "15-verify-narrative-numbers",
  // Revision-scoped: `-r0` is the first review round. A `revise` decision
  // registers `-r1` after re-drafting the fixes/narrative.
  "16-batch-review-r0",
  "17-assemble-report",
  "18-persist-deliverable",
  "19-persist-manifest",
  "20-commit-and-record",
];

describe("end-to-end: the 9-phase SEO & GEO agent workflow (RFC-04)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes every phase and resolves to completed with both human gates auto-approved", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    // Measured capture is required to reach "every phase" at all: with the real
    // stub every cell is UNAVAILABLE and the run correctly holds at 08a (AU26).
    // The technical measurements are still all-unavailable, which is why the
    // SEO/GEO readiness scores below remain 0 — only visibility is measured here.
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    expect(result.output.seoScore).toBe(0); // every input is honestly "unavailable" — Phase 1 stand-in.
    expect(result.output.geoReadinessScore).toBe(0);
    expect(result.output.hashInputsIncomplete).toBe(true);
    expect(result.output.firedRecommendationCount).toBeGreaterThan(0);
    expect(result.output.fixDraftCount).toBeGreaterThan(0);
    expect(result.output.deliverableId).toBeTruthy();
    expect(result.output.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.totalCostUsd).toBeGreaterThan(0);

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId).sort();
    expect(executedIds).toEqual([...NON_FANOUT_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    const crawlSlots = await durableStore.listSlots(params.runId, "05-crawl-technical-seo");
    expect(crawlSlots).toHaveLength(4);
    const captureSlots = await durableStore.listSlots(params.runId, "07-capture-ai-visibility");
    expect(captureSlots.length).toBeGreaterThan(0);
    expect(captureSlots.every((s) => s.status === "completed")).toBe(true);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["seo-geo-report"]);

    const snapshot = await env.store.readJson("acme", ["ledger", "dashboard-snapshots", params.runId]);
    expect(snapshot).toBeTruthy();

    const decisions = await env.store.listJson("acme", ["memory", "products", params.productId, "decisions"]);
    expect(decisions.some((d) => (d.data as { decisionId: string }).decisionId === `${params.runId}__decision`)).toBe(true);
  });

  it("without autoApprove, pauses at the first gate rather than running through completion", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "seo_geo_run_e2e_no_auto" });

    expect(result.status).toBe("awaiting_gate");
  });
});
