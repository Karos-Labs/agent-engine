import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

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
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router });
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
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router, autoApprove: true });
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
    const workflow1 = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router: router1, autoApprove: true });
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
    const workflow2 = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router: router2, autoApprove: true });
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

  // SCRUM-320 (AU29) regression: step 04's `memory.updateBeliefs` call used to
  // omit `language` from the persisted `seoGeoFrozenPromptSet` belief record.
  // A recurring run for a non-English client then correctly REUSED the frozen
  // Spanish prompt text (hash-stable) but reported `promptSet.language` as
  // "en" from the very first recurring run onward — silently contradicting
  // AU29's own "20-35 prompts in the client's language" contract line for
  // every subsequent run's report/gate metadata. This test fails on the old
  // code (which never persisted `language` at all) and passes once step 04's
  // belief diff carries it through.
  it("a recurring run for a non-English client reports the client's actual language, not a silent fallback to 'en'", async () => {
    const spanishEnv = await setupTestEnvironment({ language: "es" });
    try {
      const promptStore = makePromptStore();

      // Baseline (setup) run — drafts fresh in Spanish.
      const router1 = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
      const workflow1 = createSeoGeoAgentWorkflow({ tools: spanishEnv.tools, promptStore, router: router1, autoApprove: true });
      const durableStore1 = new MemoryDurableStepStore();
      const engine1 = new WorkflowEngine(durableStore1);
      const firstRunId = "seo_geo_run_es_baseline";
      const first = await engine1.run(workflow1, { ...baseParams, runId: firstRunId, runKind: "setup" });
      expect(first.status).toBe("completed");

      const firstDeliverable = await spanishEnv.store.readJson<{
        deliverable: { promptSet: { language: string; languageFallbackApplied: boolean; prompts: Array<{ promptText: string }> } };
      }>("acme", ["ledger", "deliverables", firstRunId, "_", "seo-geo-report"]);
      expect(firstDeliverable?.deliverable.promptSet.language).toBe("es");
      expect(firstDeliverable?.deliverable.promptSet.languageFallbackApplied).toBe(false);
      // Sanity: the frozen prompts are genuinely Spanish text, not just a label.
      expect(firstDeliverable?.deliverable.promptSet.prompts[0]?.promptText).toMatch(/[¿¡]/);

      // Recurring run — a fresh MemoryDurableStepStore (a different run), same
      // WorkspaceStore/tools, so `memory.read`'s beliefs carry the frozen set
      // (language included) forward, exactly like the "reuses the prior run's
      // frozen prompt set" test above.
      const router2 = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
      const workflow2 = createSeoGeoAgentWorkflow({ tools: spanishEnv.tools, promptStore, router: router2, autoApprove: true });
      const durableStore2 = new MemoryDurableStepStore();
      const engine2 = new WorkflowEngine(durableStore2);
      const secondRunId = "seo_geo_run_es_recurring";
      const second = await engine2.run(workflow2, { ...baseParams, runId: secondRunId, runKind: "recurring" });
      expect(second.status).toBe("completed");

      const secondDeliverable = await spanishEnv.store.readJson<{
        deliverable: { promptSet: { language: string; source: string; prompts: Array<{ promptText: string }> } };
      }>("acme", ["ledger", "deliverables", secondRunId, "_", "seo-geo-report"]);
      expect(secondDeliverable?.deliverable.promptSet.source).toBe("reused");
      // The regression: this used to come back "en" on every recurring run,
      // whatever the client's real language, because step 04 never persisted it.
      expect(secondDeliverable?.deliverable.promptSet.language).toBe("es");
      expect(secondDeliverable?.deliverable.promptSet.prompts).toEqual(firstDeliverable?.deliverable.promptSet.prompts);

      // The belief record itself carries `language` — not just something step
      // 02 happens to infer correctly some other way.
      const beliefsOutcome = await spanishEnv.tools["memory.read"]!.execute(
        { scope: "beliefs" },
        { ctx: { runId: secondRunId, clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring", metadata: {} } },
      );
      expect(beliefsOutcome.status).toBe("success");
      const frozenBelief = (beliefsOutcome as { result: { beliefs: Record<string, unknown> } }).result.beliefs["seoGeoFrozenPromptSet"] as {
        language?: string;
      };
      expect(frozenBelief.language).toBe("es");
    } finally {
      await spanishEnv.cleanup();
    }
  });
});
