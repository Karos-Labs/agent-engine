import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createNewsletterAgentWorkflow } from "../src/workflow/create-newsletter-agent-workflow.js";
import {
  deliveredEdition,
  editionProse, editionRouter, finalTurn, heldEditionRouter, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring" as const };

function baseFields() {
  return {
    sections: [{ heading: "A heading", body: "A body." }],
    callToAction: { text: "Do something", url: "https://example.com" },
    signoff: "The Team",
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

  it("an unsourced numeric claim fails gate.numbersSourced at step 11 -> redrafted with the reason, twice, then held", async () => {
    const promptStore = makePromptStore();
    const intro = "Teams using anchor days saw scheduling conflicts fall 43% this quarter.";
    const router = heldEditionRouter([
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: "A reasonable preview text.",
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\nThe Team`,
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_numbers" });

    // Three editorial rounds are the model's three attempts at this; what
    // used to follow them was a hold. Now the deterministic floor drops the
    // sentence carrying the unsourced figure and the edition ships.
    expect(result.status).toBe("completed");

    const edition = await deliveredEdition(env, "newsletter_run_gate_numbers");
    expect(editionProse(edition)).not.toContain("43%");
    expect(edition["contentRepairs"]).toBeDefined();

    // Plan + 3 drafts + the editor = 5 router turns. The redraft loop itself
    // is unchanged at three rounds; what changed is that the run now REACHES
    // the editor instead of ending at the third round's hold.
    expect(router.complete).toHaveBeenCalledTimes(5);
    const stepRecords = await durableStore.listSteps("newsletter_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("09-draft-post");
    expect(ids).toContain("10-verify-brand-compliance");
    expect(ids).toContain("11-verify-numbers-sourced");
    expect(ids).toContain("12-verify-compliance-footer");
    expect(ids).toContain("09-draft-post-round-2");
    expect(ids).toContain("11-verify-numbers-sourced-round-3");
    expect(ids).not.toContain("15c-editor-verdict");

    // The redraft was TOLD what was wrong: the second drafting prompt carries
    // the gate's own reason, naming the figure.
    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const secondDraftPrompt = String(calls[2]![0]);
    expect(secondDraftPrompt).toContain("editorialNotes");
    expect(secondDraftPrompt).toContain("numbers not sourced");
    expect(secondDraftPrompt).toContain("43%");
    // ...and the first one did not (nothing had failed yet).
    expect(String(calls[1]![0])).not.toContain("editorialNotes");
  });

  it("a forbidden brand term fails gate.brandCompliance at step 10 -> redrafted, then held", async () => {
    const promptStore = makePromptStore();
    const intro = "This approach is guaranteed to work for every team, every time.";
    const router = heldEditionRouter([
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: "A reasonable preview text.",
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\nThe Team`,
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_brand" });

    expect(result.status).toBe("completed");

    const edition = await deliveredEdition(env, "newsletter_run_gate_brand");
    expect(editionProse(edition)).not.toContain("guaranteed");

    const stepRecords = await durableStore.listSteps("newsletter_run_gate_brand");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("10-verify-brand-compliance");
    // Every gate still runs on a failing round, so one redraft fixes everything at once.
    expect(ids).toContain("11-verify-numbers-sourced");
    expect(ids).toContain("10-verify-brand-compliance-round-3");
  });

  it("an over-limit first draft triggers a single self-critique revision, then completes", async () => {
    const promptStore = makePromptStore();
    const intro = "This edition body is far too long for a single newsletter. ".repeat(180); // > 10000 chars, fails gate.lintPost
    // No `platform` field on either turn's output — NewsletterDraftAgent's own
    // `gateArgs: {platform: "newsletter"}` is what pins gate.lintPost to the
    // 10000-char limit here, not something the model has to remember to include.
    const router = editionRouter([
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: "A reasonable preview text.",
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\nThe Team`,
      }),
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: "A reasonable preview text.",
        intro: "A shorter intro this time.",
        text: "A shorter intro this time.\n\n## A heading\n\nA body.\n\nDo something\n\nThe Team",
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_revision" });

    // Plan, the over-limit draft, its self-critique redraft, the editor.
    expect(router.complete).toHaveBeenCalledTimes(4);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.mainStory).toBeTruthy();

    const stepRecords = await durableStore.listSteps("newsletter_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("19-commit-and-record");
  });

  it("a subject line over the 70-char limit is TRIMMED to fit, distinct from preview/body limits", async () => {
    const promptStore = makePromptStore();
    const tooLongSubject = "This subject line is way too long for an inbox. ".repeat(3); // > 70 chars
    const intro = "A short, reasonable intro.";
    const router = heldEditionRouter([
      finalTurn({
        ...baseFields(),
        subjectLine: tooLongSubject,
        previewText: "A reasonable preview text.",
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\nThe Team`,
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_subject_limit" });

    expect(result.status).toBe("completed");

    const edition = await deliveredEdition(env, "newsletter_run_gate_subject_limit");
    expect((edition["subjectLine"] as string).length).toBeLessThanOrEqual(70);
    expect(edition["contentRepairs"]).toContainEqual(expect.objectContaining({ check: "newsletter-length", action: "trimmed" }));
  });

  it("a preview text over the 140-char limit is TRIMMED to fit, distinct from subject/body limits", async () => {
    const promptStore = makePromptStore();
    const tooLongPreview = "This preview text is going to run on for quite a while, well past what any inbox client would actually render for a subscriber. ".repeat(2);
    const intro = "A short, reasonable intro.";
    const router = heldEditionRouter([
      finalTurn({
        ...baseFields(),
        subjectLine: "A reasonable subject line",
        previewText: tooLongPreview,
        intro,
        text: `${intro}\n\n## A heading\n\nA body.\n\nDo something\n\nThe Team`,
      }),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "newsletter_run_gate_preview_limit" });

    expect(result.status).toBe("completed");

    const edition = await deliveredEdition(env, "newsletter_run_gate_preview_limit");
    expect((edition["previewText"] as string).length).toBeLessThanOrEqual(140);
  });
});
