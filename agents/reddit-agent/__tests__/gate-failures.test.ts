import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

function baseFields() {
  return {
    targetSubreddit: "smallbusiness",
    flair: "",
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
    const title = "What happened after we tried a 4-day week";
    const body = "Teams using anchor days saw scheduling conflicts fall 43% this quarter.";
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), title, body, hook: body, text: `${title}\n\n${body}` }),
    ]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_numbers" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/numbers not sourced/i);

    const stepRecords = await durableStore.listSteps("reddit_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("09-draft-post");
    expect(ids).toContain("10-verify-numbers-sourced");
    expect(ids).not.toContain("11-verify-brand-compliance");
  });

  it("a forbidden brand term fails gate.brandCompliance at step 11 -> held", async () => {
    const promptStore = makePromptStore();
    const title = "Our results after switching schedules";
    const body = "This approach is guaranteed to work for every team, every time.";
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), title, body, hook: body, text: `${title}\n\n${body}` }),
    ]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_brand" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/brand compliance failed/i);

    const stepRecords = await durableStore.listSteps("reddit_run_gate_brand");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("11-verify-brand-compliance");
    expect(ids).not.toContain("12-render-preview-check");
  });

  it("an over-limit first draft triggers a single self-critique revision, then completes", async () => {
    const promptStore = makePromptStore();
    const title = "A reasonable title";
    const tooLongBody = "This paragraph is way too long for a single Reddit post body. ".repeat(700); // > 40000 chars, fails gate.lintPost
    // No `platform` field on either turn's output — RedditDraftAgent's own
    // `gateArgs: {platform: "reddit"}` is what pins gate.lintPost to the
    // 40000-char limit here, not something the model has to remember to include.
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), title, body: tooLongBody, hook: "This paragraph is way too long.", text: `${title}\n\n${tooLongBody}` }),
      finalTurn({
        ...baseFields(),
        title,
        body: "Trying a shorter version this time — has anyone else tried a similar schedule change?",
        hook: "Trying a shorter version this time.",
        text: `${title}\n\nTrying a shorter version this time — has anyone else tried a similar schedule change?`,
      }),
    ]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_revision" });

    expect(router.complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();

    const stepRecords = await durableStore.listSteps("reddit_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("15-commit-and-record");
  });

  it("a title over Reddit's 300-char limit is caught at step 12, distinct from the body limit", async () => {
    const promptStore = makePromptStore();
    const tooLongTitle = "This is a title. ".repeat(20); // > 300 chars
    const body = "A short, reasonable body with a real question at the end. Anyone else tried this?";
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), title: tooLongTitle, body, hook: body, text: `${tooLongTitle}\n\n${body}` }),
    ]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_title_limit" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/title exceeds Reddit's 300-character limit/i);
  });
});
