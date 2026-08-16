import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createBlogAgentWorkflow } from "../src/workflow/create-blog-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "blog-agent", runKind: "recurring" as const };

function baseFields() {
  return {
    slug: "a-post",
    excerpt: "An excerpt.",
    headersList: ["A header"],
    estimatedReadMinutes: 2,
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
    const title = "What happened after we restructured onboarding";
    const bodyMarkdown = "## A header\n\nTeams using structured onboarding saw ramp time fall 43% this quarter.";
    const router = fakeRouterSequence([
      finalTurn({
        ...baseFields(),
        title,
        bodyMarkdown,
        metaDescription: "A meta description.",
        text: `${title}\n\n${bodyMarkdown}`,
      }),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_numbers" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/numbers not sourced/i);

    const stepRecords = await durableStore.listSteps("blog_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("09-draft-post");
    expect(ids).toContain("10-verify-numbers-sourced");
    expect(ids).not.toContain("11-verify-brand-compliance");
  });

  it("a forbidden brand term fails gate.brandCompliance at step 11 -> held", async () => {
    const promptStore = makePromptStore();
    const title = "Our results after switching schedules";
    const bodyMarkdown = "## A header\n\nThis approach is guaranteed to work for every team, every time.";
    const router = fakeRouterSequence([
      finalTurn({
        ...baseFields(),
        title,
        bodyMarkdown,
        metaDescription: "A meta description.",
        text: `${title}\n\n${bodyMarkdown}`,
      }),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_brand" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/brand compliance failed/i);

    const stepRecords = await durableStore.listSteps("blog_run_gate_brand");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("11-verify-brand-compliance");
    expect(ids).not.toContain("12-render-preview-check");
  });

  it("an over-limit first draft triggers a single self-critique revision, then completes", async () => {
    const promptStore = makePromptStore();
    const title = "A reasonable title";
    const tooLongBody = "This paragraph is far too long for a single blog post body. ".repeat(350); // > 20000 chars, fails gate.lintPost
    // No `platform` field on either turn's output — BlogDraftAgent's own
    // `gateArgs: {platform: "blog"}` is what pins gate.lintPost to the
    // 20000-char limit here, not something the model has to remember to include.
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), title, bodyMarkdown: tooLongBody, metaDescription: "A meta description.", text: `${title}\n\n${tooLongBody}` }),
      finalTurn({
        ...baseFields(),
        title,
        bodyMarkdown: "## A header\n\nTrying a shorter version this time.",
        metaDescription: "A meta description.",
        text: `${title}\n\n## A header\n\nTrying a shorter version this time.`,
      }),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_revision" });

    expect(router.complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();

    const stepRecords = await durableStore.listSteps("blog_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("15-commit-and-record");
  });

  it("a title over the 120-char limit is caught at step 12, distinct from meta/body limits", async () => {
    const promptStore = makePromptStore();
    const tooLongTitle = "This is a title. ".repeat(10); // > 120 chars
    const bodyMarkdown = "## A header\n\nA short, reasonable body.";
    const router = fakeRouterSequence([
      finalTurn({
        ...baseFields(),
        title: tooLongTitle,
        bodyMarkdown,
        metaDescription: "A meta description.",
        text: `${tooLongTitle}\n\n${bodyMarkdown}`,
      }),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_title_limit" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/title exceeds the 120-character limit/i);
  });

  it("a metaDescription over the 160-char limit is caught at step 12, distinct from title/body limits", async () => {
    const promptStore = makePromptStore();
    const title = "A reasonable title";
    const bodyMarkdown = "## A header\n\nA short, reasonable body.";
    const tooLongMeta = "This meta description is going to run on for quite a while, well past what any search engine would actually render for a user. ".repeat(2);
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), title, bodyMarkdown, metaDescription: tooLongMeta, text: `${title}\n\n${bodyMarkdown}` }),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_meta_limit" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/metaDescription exceeds the 160-character SEO limit/i);
  });
});
