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

/**
 * The universal approve / revise / reject cycle, as reddit-agent uses it.
 *
 * Draft-only stays draft-only here: `revise` re-drafts the reply text for a
 * human to post from their own account, exactly like `approve` does — neither
 * decision grants or needs a posting capability.
 */

const params = { runId: "reddit_rev", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

function draft(replyBody: string) {
  return finalTurn({
    targetThreadUrl: DEFAULT_TARGET_THREAD_URL,
    targetThreadTitle: DEFAULT_TARGET_THREAD_TITLE,
    replyBody,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
    text: replyBody,
  });
}

const FIRST =
  "We run a small B2B SaaS shop and moved most of engineering to a 4-day week last quarter as a trial.\n\n" +
  "Sick days dropped noticeably across the team, and shipped feature count stayed roughly flat.";
const REVISED =
  "Curious if anyone else has tried this: we moved engineering to a 4-day week last quarter.\n\n" +
  "Sick days dropped noticeably across the team, and shipped feature count stayed roughly flat.";

describe("reddit-agent revision loop", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("re-drafts with the reviewer's feedback, then delivers on approval", async () => {
    const router = fakeRouterSequence([draft(FIRST), draft(REVISED)]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const r0 = await engine.run(workflowFn, params);
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(params.runId, "18-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Open with a question, this subreddit responds better to that.",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflowFn, params);
    expect(r1.status).toBe("awaiting_gate");
    if (r1.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r1.pendingGateId).toContain("18-batch-review-r1");

    await engine.resolveGate(params.runId, "18-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, params);
    expect(final.status).toBe("completed");

    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // Round 1's drafting steps are revision-scoped, so they genuinely re-ran.
    expect(ids).toContain("12-draft-reply");
    expect(ids).toContain("12-draft-reply-r1");
    expect(ids).toContain("13-verify-numbers-sourced-r1");
    // Everything upstream — including thread selection, the thread read, research and the merged
    // channel-setup pre-flight — kept its id and was reused, which is why the
    // revision is in-run rather than a fresh run against a different thread.
    expect(ids.filter((i) => i === "00-channel-setup")).toHaveLength(1);
    expect(ids.filter((i) => i === "07-select-target-thread")).toHaveLength(1);
    expect(ids).not.toContain("07-select-target-thread-r1");
    expect(ids).not.toContain("08-fetch-thread-r1");
    expect(ids).not.toContain("11-research-pull-r1");
  }, 60000);

  it("saves the reviewer's words to client memory, on a revision and on an approval alike", async () => {
    const router = fakeRouterSequence([draft(FIRST)]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "reddit_rev_memory";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "18-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      feedback: "The specific-numbers framing is working, keep doing that.",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...params, runId });
    expect(final.status).toBe("completed");

    const remembered = await env.store.listJson<{ note: string; decision: string; productId: string }>("acme", [
      "memory",
      "feedback",
    ]);
    expect(remembered.map((r) => r.data.note)).toContain("The specific-numbers framing is working, keep doing that.");
    expect(remembered.map((r) => r.data.decision)).toContain("approve");
    // Scoped to the product, so a later reddit-agent run reads its own history first.
    expect(remembered.map((r) => r.data.productId)).toContain("reddit-agent");
  }, 60000);

  it("still holds on an outright rejection, because the gate exists to be able to say no", async () => {
    const router = fakeRouterSequence([draft(FIRST)]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "reddit_rev_reject";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "18-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "too promotional for this subreddit",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...params, runId });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/review rejected/i);
  }, 60000);
});
