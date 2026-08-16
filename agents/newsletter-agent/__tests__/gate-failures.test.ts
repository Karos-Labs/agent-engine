import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createNewsletterAgentWorkflow } from "../src/workflow/create-newsletter-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring" as const };

function baseFields() {
  return {
    sections: [{ heading: "A heading", body: "A body." }],
    callToAction: { text: "Do something", url: "https://example.com" },
    signoff: "— The Team",
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
    const intro = "Teams using anchor days saw scheduling conflicts fall 43% this quarter.";
    const router = fakeRouterSequence([
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: "A reasonable preview text.",
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\n— The Team`,
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_numbers" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/numbers not sourced/i);

    const stepRecords = await durableStore.listSteps("newsletter_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("09-draft-post");
    expect(ids).toContain("10-verify-numbers-sourced");
    expect(ids).not.toContain("11-verify-brand-compliance");
  });

  it("a forbidden brand term fails gate.brandCompliance at step 11 -> held", async () => {
    const promptStore = makePromptStore();
    const intro = "This approach is guaranteed to work for every team, every time.";
    const router = fakeRouterSequence([
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: "A reasonable preview text.",
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\n— The Team`,
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_brand" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/brand compliance failed/i);

    const stepRecords = await durableStore.listSteps("newsletter_run_gate_brand");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("11-verify-brand-compliance");
    expect(ids).not.toContain("12-render-preview-check");
  });

  it("an over-limit first draft triggers a single self-critique revision, then completes", async () => {
    const promptStore = makePromptStore();
    const intro = "This edition body is far too long for a single newsletter. ".repeat(180); // > 10000 chars, fails gate.lintPost
    // No `platform` field on either turn's output — NewsletterDraftAgent's own
    // `gateArgs: {platform: "newsletter"}` is what pins gate.lintPost to the
    // 10000-char limit here, not something the model has to remember to include.
    const router = fakeRouterSequence([
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: "A reasonable preview text.",
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\n— The Team`,
      }),
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: "A reasonable preview text.",
        intro: "A shorter intro this time.",
        text: "A shorter intro this time.\n\n## A heading\n\nA body.\n\nDo something\n\n— The Team",
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_revision" });

    expect(router.complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.mainStory).toBeTruthy();

    const stepRecords = await durableStore.listSteps("newsletter_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("15-commit-and-record");
  });

  it("a subject line over the 70-char limit is caught at step 12, distinct from preview/body limits", async () => {
    const promptStore = makePromptStore();
    const tooLongSubject = "This subject line is way too long for an inbox. ".repeat(3); // > 70 chars
    const intro = "A short, reasonable intro.";
    const router = fakeRouterSequence([
      finalTurn({
        ...baseFields(),
        subjectLine: tooLongSubject,
        previewText: "A reasonable preview text.",
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\n— The Team`,
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_subject_limit" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/subject line exceeds the 70-character limit/i);
  });

  it("a preview text over the 140-char limit is caught at step 12, distinct from subject/body limits", async () => {
    const promptStore = makePromptStore();
    const tooLongPreview = "This preview text is going to run on for quite a while, well past what any inbox client would actually render for a subscriber. ".repeat(2);
    const intro = "A short, reasonable intro.";
    const router = fakeRouterSequence([
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: tooLongPreview,
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\n— The Team`,
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_preview_limit" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/preview text exceeds the 140-character limit/i);
  });
});
