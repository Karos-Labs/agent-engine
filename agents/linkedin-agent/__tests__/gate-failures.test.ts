import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

function baseFields() {
  return {
    headline: "A headline",
    hashtags: ["HybridWork"],
    callToAction: "Think about it.",
    targetAudience: "Operations leaders",
  };
}

describe("content gate failures (RFC-02 §5 steps 09-12)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced numeric claim fails gate.numbersSourced at step 10 -> held", async () => {
    const promptStore = makePromptStore();
    const text = "Teams using anchor days saw scheduling conflicts fall 43% this quarter.";
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: text, body: text, text }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_numbers" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/numbers not sourced/i);

    const stepRecords = await durableStore.listSteps("linkedin_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("09-draft-post");
    expect(ids).toContain("10-verify-numbers-sourced");
    expect(ids).not.toContain("11-verify-brand-compliance");
  });

  it("a forbidden brand term fails gate.brandCompliance at step 11 -> held", async () => {
    const promptStore = makePromptStore();
    const text = "This approach is guaranteed to work for every team, every time.";
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: text, body: text, text }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_brand" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/brand compliance failed/i);

    const stepRecords = await durableStore.listSteps("linkedin_run_gate_brand");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("11-verify-brand-compliance");
    expect(ids).not.toContain("12-render-preview-check");
  });

  it("an over-limit first draft triggers a single self-critique revision, then completes", async () => {
    const promptStore = makePromptStore();
    const tooLong = "This paragraph is way too long for LinkedIn. ".repeat(100); // > 3000 chars, fails gate.lintPost
    // No `platform` field on either turn's output — LinkedInDraftAgent's own
    // `gateArgs: {platform: "linkedin"}` is what pins gate.lintPost to the
    // 3000-char limit here, not something the model has to remember to include.
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: "This paragraph is way too long for LinkedIn.", body: tooLong, text: tooLong }),
      finalTurn({
        ...baseFields(),
        hook: "Remote teams keep experimenting with anchor days.",
        body: "Worth watching if yours is rethinking its hybrid schedule.",
        text: "Remote teams keep experimenting with anchor days.\n\nWorth watching if yours is rethinking its hybrid schedule.\n\n#HybridWork",
      }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_revision" });

    expect(router.complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();

    const stepRecords = await durableStore.listSteps("linkedin_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("15-commit-and-record");
  });

  it("a draft exactly at the character limit passes both gate.lintPost and render.preview at step 12", async () => {
    const promptStore = makePromptStore();
    const exactlyAtLimitText = "A".repeat(3000);
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: "A", body: exactlyAtLimitText, text: exactlyAtLimitText }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_at_limit" });

    expect(result.status).toBe("completed");
  });
});
