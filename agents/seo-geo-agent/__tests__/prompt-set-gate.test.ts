import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

describe("03-prompt-set-review gate (RFC-04 §2 Phase 1)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("pauses at the human gate by default, before any AI-visibility capture spend", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "seo_geo_run_promptgate" });

    expect(result.status).toBe("awaiting_gate");
    if (result.status !== "awaiting_gate") throw new Error("unreachable");
    expect(result.pendingGateId).toContain("03-prompt-set-review");

    // No AI-visibility capture slots ran yet — the gate genuinely blocks spend.
    const slots = await durableStore.listSlots("seo_geo_run_promptgate", "07-capture-ai-visibility");
    expect(slots).toHaveLength(0);
  });

  it("rejecting the prompt set holds the run with a reason, and never reaches capture", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "seo_geo_run_promptgate_reject";

    await engine.run(workflowFn, { ...baseParams, runId });
    await engine.resolveGate(runId, "03-prompt-set-review", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "roster needs one more competitor before we spend capture budget",
      at: new Date().toISOString(),
    });

    const result = await engine.run(workflowFn, { ...baseParams, runId });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/prompt set rejected/i);

    const slots = await durableStore.listSlots(runId, "07-capture-ai-visibility");
    expect(slots).toHaveLength(0);
  });

  it("approving the gate resumes the run through capture and scoring", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "seo_geo_run_promptgate_approve";

    await engine.run(workflowFn, { ...baseParams, runId });
    await engine.resolveGate(runId, "03-prompt-set-review", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });

    // Resolves to the next gate (12-fix-generation-review) since autoApprove is off.
    const result = await engine.run(workflowFn, { ...baseParams, runId });
    expect(result.status).toBe("awaiting_gate");
    if (result.status !== "awaiting_gate") throw new Error("unreachable");
    expect(result.pendingGateId).toContain("12-fix-generation-review");

    const slots = await durableStore.listSlots(runId, "07-capture-ai-visibility");
    expect(slots.length).toBeGreaterThan(0);
  });

  it("options.autoApprove skips the gate entirely and records a synthetic system approval", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "seo_geo_run_promptgate_auto" });

    expect(result.status).toBe("completed");
    const stepRecords = await durableStore.listSteps("seo_geo_run_promptgate_auto");
    const step03 = stepRecords.find((s) => s.stepId === "03-prompt-set-review");
    expect(step03?.status).toBe("completed");
    expect((step03?.output as { actor?: string } | null)?.actor).toBe("system");
  });

  it("a recurring run reuses the prior run's frozen prompt set, never drafting a fresh one", async () => {
    const promptStore = makePromptStore();

    // Baseline run.
    const router1 = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflow1 = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router: router1, autoApprove: true });
    const durableStore1 = new MemoryDurableStepStore();
    const engine1 = new WorkflowEngine(durableStore1);
    const firstRunId = "seo_geo_run_reuse_baseline";
    const first = await engine1.run(workflow1, { ...baseParams, runId: firstRunId, runKind: "setup" });
    expect(first.status).toBe("completed");

    const firstDeliverable = await env.store.readJson<{ deliverable: { promptSet: { source: string; prompts: unknown[] } } }>("acme", [
      "ledger",
      "deliverables",
      firstRunId,
      "_",
      "seo-geo-report",
    ]);
    expect(firstDeliverable?.deliverable.promptSet.source).toBe("drafted");

    // Recurring run — a fresh MemoryDurableStepStore (a different run), same
    // WorkspaceStore/tools, so `memory.read`'s beliefs carry the frozen set forward.
    const router2 = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflow2 = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router: router2, autoApprove: true });
    const durableStore2 = new MemoryDurableStepStore();
    const engine2 = new WorkflowEngine(durableStore2);
    const secondRunId = "seo_geo_run_reuse_recurring";
    const second = await engine2.run(workflow2, { ...baseParams, runId: secondRunId, runKind: "recurring" });
    expect(second.status).toBe("completed");

    const secondDeliverable = await env.store.readJson<{ deliverable: { promptSet: { source: string; prompts: unknown[] } } }>("acme", [
      "ledger",
      "deliverables",
      secondRunId,
      "_",
      "seo-geo-report",
    ]);
    expect(secondDeliverable?.deliverable.promptSet.source).toBe("reused");
    expect(secondDeliverable?.deliverable.promptSet.prompts).toEqual(firstDeliverable?.deliverable.promptSet.prompts);
  });
});
