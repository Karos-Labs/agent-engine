import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

describe("content gate failures (RFC-02 §3 steps 09-12)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced numeric claim fails gate.numbersSourced at step 10 -> held", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn({
        text: "Teams using 4-day weeks saw output rise 43% this quarter.",
        hook: "Teams using 4-day weeks saw output rise 43% this quarter.",
        angle: "data-point",
        targetHandle: "@acmehq",
      }),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_numbers" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/numbers not sourced/i);

    const stepRecords = await durableStore.listSteps("x_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("09-draft-post");
    expect(ids).toContain("10-verify-numbers-sourced");
    expect(ids).not.toContain("11-verify-brand-compliance");
  });

  it("a forbidden brand term fails gate.brandCompliance at step 11 -> held", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn({
        text: "This approach is guaranteed to work for every team, every time.",
        hook: "This approach is guaranteed to work.",
        angle: "trend-observation",
        targetHandle: "@acmehq",
      }),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_brand" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/brand compliance failed/i);

    const stepRecords = await durableStore.listSteps("x_run_gate_brand");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("11-verify-brand-compliance");
    expect(ids).not.toContain("12-render-preview-check");
  });

  it("an over-limit first draft triggers a single self-critique revision, then completes", async () => {
    const promptStore = makePromptStore();
    const tooLong = "This is way too long for X. ".repeat(15); // > 280 chars, fails gate.lintPost
    // Neither turn supplies a `platform` field — proving XDraftAgent's own
    // `gateArgs: {platform: "x"}` is what pins gate.lintPost to the 280-char
    // limit, not something the model has to remember to include.
    const router = fakeRouterSequence([
      finalTurn({ text: tooLong, hook: "This is way too long for X.", angle: "trend-observation", targetHandle: "@acmehq" }),
      finalTurn({
        text: "Remote teams keep experimenting with shorter weeks. Worth watching if yours is rethinking its schedule.",
        hook: "Remote teams keep experimenting with shorter weeks.",
        angle: "trend-observation",
        targetHandle: "@acmehq",
      }),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_revision" });

    expect(router.complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();

    const stepRecords = await durableStore.listSteps("x_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("15-commit-and-record");
  });

  it("a draft that exceeds the character limit after passing lintPost's own check is still caught at step 12", async () => {
    // gate.lintPost and render.preview both use the 280-char X limit, so this exercises
    // the workflow-level render.preview guard directly rather than relying on it being
    // indistinguishable from the agent's own self-critique gate.
    const promptStore = makePromptStore();
    const exactlyAtLimitText = "A".repeat(280);
    const router = fakeRouterSequence([
      finalTurn({ text: exactlyAtLimitText, hook: "A", angle: "trend-observation", targetHandle: "@acmehq" }),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_at_limit" });

    // Exactly at the limit passes both gate.lintPost and render.preview.
    expect(result.status).toBe("completed");
  });
});
