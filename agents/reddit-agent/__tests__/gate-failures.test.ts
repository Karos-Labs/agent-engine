import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import {
  DEFAULT_TARGET_THREAD_TITLE,
  DEFAULT_TARGET_THREAD_URL,
  fakeRouterSequence,
  finalTurn,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

function baseFields() {
  return {
    targetThreadUrl: DEFAULT_TARGET_THREAD_URL,
    targetThreadTitle: DEFAULT_TARGET_THREAD_TITLE,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
  };
}

describe("content gate failures (RFC-02 §5 steps 13-17)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced numeric claim fails gate.numbersSourced at step 13 -> held", async () => {
    const promptStore = makePromptStore();
    const replyBody = "Teams using anchor days saw scheduling conflicts fall 43% this quarter.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), replyBody, text: replyBody })]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_numbers" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/numbers not sourced/i);

    const stepRecords = await durableStore.listSteps("reddit_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("12-draft-reply");
    expect(ids).toContain("13-verify-numbers-sourced");
    expect(ids).not.toContain("14-verify-brand-compliance");
  });

  it("a forbidden brand term fails gate.brandCompliance at step 14 -> held", async () => {
    const promptStore = makePromptStore();
    const replyBody = "This approach is guaranteed to work for every team, every time.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), replyBody, text: replyBody })]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_brand" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/brand compliance failed/i);

    const stepRecords = await durableStore.listSteps("reddit_run_gate_brand");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("14-verify-brand-compliance");
    expect(ids).not.toContain("15-verify-no-placeholder");
  });

  it("a placeholder marker left in the draft fails gate.noPlaceholder at step 15 -> held", async () => {
    const promptStore = makePromptStore();
    const replyBody = "Here's what worked for us: {{insert real number here}} once we tried it.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), replyBody, text: replyBody })]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_placeholder" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/placeholder/i);

    const stepRecords = await durableStore.listSteps("reddit_run_gate_placeholder");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("15-verify-no-placeholder");
    expect(ids).not.toContain("16-verify-leak-check");
  });

  it("a leaked local file path in the draft fails gate.leakCheck at step 16 -> held", async () => {
    const promptStore = makePromptStore();
    const replyBody = "Here's the config file we used: C:\\Users\\jane\\acme\\internal-config.json, worked great.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), replyBody, text: replyBody })]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_leak" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/leak/i);

    const stepRecords = await durableStore.listSteps("reddit_run_gate_leak");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("16-verify-leak-check");
    expect(ids).not.toContain("17-render-preview-check");
  });

  it("an over-limit first draft triggers a single self-critique revision, then completes", async () => {
    const promptStore = makePromptStore();
    const tooLongBody = "This paragraph is way too long for a single Reddit reply body. ".repeat(700); // > 40000 chars, fails gate.lintPost
    // No `platform` field on either turn's output — RedditDraftAgent's own
    // `gateArgs: {platform: "reddit"}` is what pins gate.lintPost's self-critique
    // check here, not something the model has to remember to include.
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), replyBody: tooLongBody, text: tooLongBody }),
      finalTurn({
        ...baseFields(),
        replyBody: "Trying a shorter version this time: has anyone else tried a similar schedule change?",
        text: "Trying a shorter version this time: has anyone else tried a similar schedule change?",
      }),
    ]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_revision" });

    expect(router.complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();

    const stepRecords = await durableStore.listSteps("reddit_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("21-commit-and-record");
  });

  it("a reply over Reddit's 10000-character comment limit is caught at step 17, distinct from gate.lintPost's own 40000-char submission-era ceiling", async () => {
    const promptStore = makePromptStore();
    // Long enough to clear render.preview's real 10,000-char comment limit but
    // still comfortably under gate.lintPost's 40,000-char "reddit" platform
    // ceiling — so this trips ONLY the workflow-level render check, proving the
    // two limits are genuinely distinct rather than the same number twice.
    const overCommentLimitBody = "A genuinely long real reply with real specifics, repeated many times over. ".repeat(150); // ~11400 chars
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), replyBody: overCommentLimitBody, text: overCommentLimitBody }),
    ]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_comment_limit" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/exceeds Reddit's 10000-character comment limit/i);
    // Only one model call: gate.lintPost's self-critique never objected to this length.
    expect(router.complete).toHaveBeenCalledTimes(1);
  });
});
