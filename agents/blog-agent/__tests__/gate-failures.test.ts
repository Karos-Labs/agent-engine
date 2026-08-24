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

/**
 * A revised (post-self-critique) body that is genuinely under the 20,000-char
 * ceiling but still clears the 600-word floor with real, on-topic paragraphs
 * rather than a single filler sentence.
 */
const shorterRevisionBody =
  "## A header\n\n" +
  "Trying a shorter version this time, we went back through the original draft and cut every section that repeated itself rather " +
  "than adding new ground. The core idea survived the edit intact: a team that treats its first working week as a designed " +
  "experience, not an afterthought bolted onto a job offer, gets meaningfully better outcomes from new hires without spending more " +
  "money on the process. That claim held up across every team we talked to who had tried some version of a structured start, even " +
  "when the specifics of their schedule looked nothing like ours.\n\n" +
  "## Why the shorter version still works\n\n" +
  "The instinct when a draft runs long is to trim sentences from every paragraph evenly, but that usually leaves a piece that says " +
  "less about everything instead of saying enough about the parts that matter. We took a different approach here: entire sections " +
  "that restated the same point in different words got removed outright, while the sections that carried a genuinely new idea were " +
  "left alone or even given a bit more room to breathe. A reader scanning the shorter piece should still walk away with the same " +
  "practical takeaway as someone who read the long version, just without wading through paragraphs that only existed to pad the " +
  "word count.\n\n" +
  "## What a new hire actually needs in week one\n\n" +
  "Most of what slows a new engineer down in their first days is not a lack of technical skill. It is not knowing who owns a " +
  "particular piece of the system, not knowing which documentation is current and which was abandoned two reorganizations ago, and " +
  "not having a small enough task to build confidence before tackling something bigger. None of that requires exotic tooling or a " +
  "big budget to fix. It requires someone on the team to have already thought through the sequence a new person should follow, " +
  "written it down somewhere durable, and assigned an actual person to walk through it rather than leaving it to whoever happens to " +
  "answer first in a group chat.\n\n" +
  "## Keeping the structure honest over time\n\n" +
  "The failure mode we watched for most closely after rolling this out was quiet drift: a process that looks structured on paper " +
  "but slowly turns back into whatever the busiest week allows. The fix we settled on was simple and unglamorous. Someone reviews " +
  "the plan for the upcoming new hire a few days before they start, confirms the paired engineer and the scoped ticket are both " +
  "actually ready, and flags it immediately if either one is missing. That single check, repeated every time, kept the whole thing " +
  "from sliding back into the improvised version we started with.\n\n" +
  "## Closing thought\n\n" +
  "None of this is about optimizing for speed for its own sake. A new hire who ramps faster and still feels supported ends up more " +
  "confident earlier, asks better questions sooner, and contributes to team decisions well before they otherwise would have. That " +
  "is the actual goal. The faster onboarding number is just the easiest part of it to measure and put in a retrospective slide.\n\n" +
  "## One more thing worth naming\n\n" +
  "It is tempting to treat a rollout like this as finished once the first cohort clears it successfully, but the real test comes " +
  "with the second and third cohorts, run by people who were not in the room when the plan was designed. Write the reasoning down " +
  "alongside the schedule itself, not just the steps: explain why day one is environment setup and not a lecture on architecture, " +
  "why the ticket on day three has to be scoped small enough to finish in a single day, and why the whole plan tops out at four " +
  "days instead of stretching to a full two weeks. A team that only inherits the checklist tends to drift from it the first time a " +
  "deadline gets tight, while a team that inherits the reasoning behind the checklist is far more likely to adapt it sensibly " +
  "instead of quietly abandoning it.";

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
        bodyMarkdown: shorterRevisionBody,
        metaDescription: "A meta description.",
        text: `${title}\n\n${shorterRevisionBody}`,
      }),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_revision" });

    expect(router.complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();

    const stepRecords = await durableStore.listSteps("blog_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("18-commit-and-record");
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
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
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
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_meta_limit" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/metaDescription exceeds the 160-character SEO limit/i);
  });

  it("an unresolved template placeholder fails gate.noPlaceholder at step 13 -> held, before step 14 ever runs", async () => {
    const promptStore = makePromptStore();
    const title = "A reasonable title";
    // shorterRevisionBody already clears steps 09-12 (lintPost self-critique, numbers,
    // brand compliance, render.preview) on its own — this plants an unresolved
    // template marker on top of it, the thing only gate.noPlaceholder actually checks.
    const bodyMarkdown = `${shorterRevisionBody}\n\nReach the team directly at {{client_support_email}} with any follow-up questions.`;
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), title, bodyMarkdown, metaDescription: "A meta description.", text: `${title}\n\n${bodyMarkdown}` }),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_placeholder" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/unresolved placeholder found/i);

    const stepRecords = await durableStore.listSteps("blog_run_gate_placeholder");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("13-verify-no-placeholder");
    expect(ids).not.toContain("14-verify-no-leak");
  });

  it("a leaked local file path fails gate.leakCheck at step 14 -> held, before the human review gate ever runs", async () => {
    const promptStore = makePromptStore();
    const title = "A reasonable title";
    const bodyMarkdown = `${shorterRevisionBody}\n\nThe original retrospective notes live at /Users/jane/Documents/internal-retro-notes.md for anyone who wants the raw detail.`;
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), title, bodyMarkdown, metaDescription: "A meta description.", text: `${title}\n\n${bodyMarkdown}` }),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_leak" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/leak check failed/i);

    const stepRecords = await durableStore.listSteps("blog_run_gate_leak");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("13-verify-no-placeholder");
    expect(ids).toContain("14-verify-no-leak");
    expect(ids).not.toContain("15-batch-review-r0");
  });
});
