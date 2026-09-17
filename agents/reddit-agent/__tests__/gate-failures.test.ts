import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import {
  deliveredProse,
  deliveredReply,
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

describe("content gate failures are REPAIRED, never held (RFC-02 §5 steps 13-17r)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced numeric claim is removed from the reply, which still ships", async () => {
    const promptStore = makePromptStore();
    const replyBody = "Teams using anchor days saw scheduling conflicts fall 43% this quarter.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), replyBody, text: replyBody })]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_numbers" });

    // The old contract was `held`. The gate keeps its authority over what
    // may be PUBLISHED, asserted below; it lost the authority to end the run.
    expect(result.status).toBe("completed");

    const reply = await deliveredReply(env, "reddit_run_gate_numbers");
    expect(deliveredProse(reply)).not.toContain('43%');

    // Every later check still runs, on the repaired reply.
    const ids = (await durableStore.listSteps("reddit_run_gate_numbers")).map((st) => st.stepId);
    expect(ids).toContain("13-verify-numbers-sourced");
    expect(ids).toContain("14-verify-brand-compliance");
    expect(ids).toContain("17r-repair-reply");
  });

  it("a forbidden brand term is removed from the reply, which still ships", async () => {
    const promptStore = makePromptStore();
    const replyBody = "This approach is guaranteed to work for every team, every time.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), replyBody, text: replyBody })]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_brand" });

    // The old contract was `held`. The gate keeps its authority over what
    // may be PUBLISHED, asserted below; it lost the authority to end the run.
    expect(result.status).toBe("completed");

    const reply = await deliveredReply(env, "reddit_run_gate_brand");
    expect(deliveredProse(reply)).not.toContain('guaranteed');

    // Every later check still runs, on the repaired reply.
    const ids = (await durableStore.listSteps("reddit_run_gate_brand")).map((st) => st.stepId);
    expect(ids).toContain("14-verify-brand-compliance");
    expect(ids).toContain("15-verify-no-placeholder");
    expect(ids).toContain("17r-repair-reply");
  });

  it("a placeholder marker is removed from the reply, which still ships", async () => {
    const promptStore = makePromptStore();
    const replyBody = "Here's what worked for us: {{insert real number here}} once we tried it.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), replyBody, text: replyBody })]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_placeholder" });

    // The old contract was `held`. The gate keeps its authority over what
    // may be PUBLISHED, asserted below; it lost the authority to end the run.
    expect(result.status).toBe("completed");

    const reply = await deliveredReply(env, "reddit_run_gate_placeholder");
    expect(deliveredProse(reply)).not.toContain('{{insert real number here}}');

    // Every later check still runs, on the repaired reply.
    const ids = (await durableStore.listSteps("reddit_run_gate_placeholder")).map((st) => st.stepId);
    expect(ids).toContain("15-verify-no-placeholder");
    expect(ids).toContain("16-verify-leak-check");
    expect(ids).toContain("17r-repair-reply");
  });

  it("a leaked local file path is removed from the reply, which still ships", async () => {
    const promptStore = makePromptStore();
    const replyBody = "Here's the config file we used: C:\\Users\\jane\\acme\\internal-config.json, worked great.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), replyBody, text: replyBody })]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_leak" });

    // The old contract was `held`. The gate keeps its authority over what
    // may be PUBLISHED, asserted below; it lost the authority to end the run.
    expect(result.status).toBe("completed");

    const reply = await deliveredReply(env, "reddit_run_gate_leak");
    expect(deliveredProse(reply)).not.toContain('internal-config.json');

    // Every later check still runs, on the repaired reply.
    const ids = (await durableStore.listSteps("reddit_run_gate_leak")).map((st) => st.stepId);
    expect(ids).toContain("16-verify-leak-check");
    expect(ids).toContain("17-render-preview-check");
    expect(ids).toContain("17r-repair-reply");
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
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
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

  it("a reply over Reddit's 10000-character comment limit is TRIMMED to fit, distinct from gate.lintPost's own 40000-char ceiling", async () => {
    const promptStore = makePromptStore();
    // Long enough to clear render.preview's real 10,000-char comment limit but
    // still comfortably under gate.lintPost's 40,000-char "reddit" platform
    // ceiling — so this trips ONLY the workflow-level render check, proving the
    // two limits are genuinely distinct rather than the same number twice.
    const overCommentLimitBody = "A genuinely long real reply with real specifics, repeated many times over. ".repeat(150); // ~11400 chars
    // Three identical over-limit drafts: the draft loop steers ONE redraft with
    // the exact overrun (`lengthDirective`), 17r then spends its own repair
    // redraft, and a model that ignores all of it is what reaches the
    // deterministic floor.
    const overLimit = finalTurn({ ...baseFields(), replyBody: overCommentLimitBody, text: overCommentLimitBody });
    const router = fakeRouterSequence([overLimit, overLimit, overLimit]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_gate_comment_limit" });

    // A reply, unlike a long-form article, IS safely truncatable at a sentence
    // boundary: the trailing sentence is the one that overflows, and losing it
    // beats losing the reply.
    expect(result.status).toBe("completed");

    const reply = await deliveredReply(env, "reddit_run_gate_comment_limit");
    expect((reply["text"] as string).length).toBeLessThanOrEqual(10_000);
    // `replyBody` is the copy a human pastes into Reddit, so it is trimmed too
    // — a short `text` beside a full-length `replyBody` would defeat the limit.
    expect((reply["replyBody"] as string).length).toBeLessThanOrEqual(10_000);
    expect(reply["contentRepairs"]).toContainEqual(expect.objectContaining({ check: "reddit-length", action: "trimmed" }));

    // The draft loop's own length steer still fires first, before 17r spends
    // anything: that ordering is what keeps the cheap fix ahead of the costly one.
    const lengthSteered = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]![0] as string;
    expect(lengthSteered).toContain("lengthDirective");
  });
});
