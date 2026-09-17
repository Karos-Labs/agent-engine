import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createBlogAgentWorkflow } from "../src/workflow/create-blog-agent-workflow.js";
import { allProse, deliveredPost, fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

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


describe("content gate failures are REPAIRED, never held (RFC-02 §5 steps 09-14r)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced numeric claim is removed from the article, which still ships", async () => {
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
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_numbers" });

    // The old contract was `held`: the run ended and the client got an error
    // message instead of the article. The gate's authority over what may be
    // PUBLISHED is unchanged and asserted below; what it lost is the authority
    // to end the run.
    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "blog_run_gate_numbers");
    expect(allProse(post)).not.toContain("43%");
    // ...and the repair is on the record rather than silent.
    expect(post["contentRepairs"]).toBeDefined();

    // Every later check still ran, on the repaired article.
    const ids = (await durableStore.listSteps("blog_run_gate_numbers")).map((s) => s.stepId);
    expect(ids).toContain("10-verify-numbers-sourced");
    expect(ids).toContain("11-verify-brand-compliance");
    expect(ids).toContain("14r-repair-post");
    expect(ids).toContain("16-persist-deliverable");
  });

  it("a forbidden brand term is removed from the article, which still ships", async () => {
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
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_gate_brand" });

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "blog_run_gate_brand");
    expect(allProse(post)).not.toContain("guaranteed");

    const ids = (await durableStore.listSteps("blog_run_gate_brand")).map((s) => s.stepId);
    expect(ids).toContain("11-verify-brand-compliance");
    expect(ids).toContain("12-render-preview-check");
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

  it("a title over the 120-char limit is TRIMMED to fit rather than holding the run", async () => {
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

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "blog_run_gate_title_limit");
    expect((post["title"] as string).length).toBeLessThanOrEqual(120);
    expect(post["contentRepairs"]).toContainEqual(expect.objectContaining({ action: "trimmed" }));
  });

  it("a metaDescription over the 160-char limit is TRIMMED to fit rather than holding the run", async () => {
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

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "blog_run_gate_meta_limit");
    expect((post["metaDescription"] as string).length).toBeLessThanOrEqual(160);
  });

  it("an unresolved template placeholder is removed, and the leak check still runs after it", async () => {
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

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "blog_run_gate_placeholder");
    expect(allProse(post)).not.toContain("{{client_support_email}}");

    const ids = (await durableStore.listSteps("blog_run_gate_placeholder")).map((s) => s.stepId);
    expect(ids).toContain("13-verify-no-placeholder");
    expect(ids).toContain("14-verify-no-leak");
  });

  it("a leaked local file path is removed before the article reaches a human", async () => {
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

    expect(result.status).toBe("completed");

    // The credential-shaped string is gone from EVERY field, not just the one
    // the gate reads — this is the assertion that would catch a repair that
    // fixed `text` and shipped `bodyMarkdown` unredacted.
    const post = await deliveredPost(env, "blog_run_gate_leak");
    expect(allProse(post)).not.toContain("/Users/jane/Documents/internal-retro-notes.md");

    const ids = (await durableStore.listSteps("blog_run_gate_leak")).map((s) => s.stepId);
    expect(ids).toContain("14-verify-no-leak");
    expect(ids).toContain("15-batch-review-r0");
  });
});
