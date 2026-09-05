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

function goodDraft() {
  const replyBody = "Here's what actually worked for us when we tried this.";
  return {
    targetThreadUrl: DEFAULT_TARGET_THREAD_URL,
    targetThreadTitle: DEFAULT_TARGET_THREAD_TITLE,
    replyBody,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
    text: replyBody,
  };
}

describe("thread-level dedup (workflow step 09 — memory.read scope=\"decisions\")", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("holds a run whose target thread URL was already answered in a prior run for this client", async () => {
    const promptStore = makePromptStore();

    // A prior run already recorded a decision for this exact thread URL — this
    // is the real mechanism step 21 writes to and step 09 reads back from,
    // not a stub: legacy's `answered_thread_urls` (run-protocol.md §11),
    // simplified to memory.appendDecision/memory.read.
    await env.tools["memory.appendDecision"]!.execute(
      {
        decisionId: "prior_run__decision",
        summary: `Replied to thread ${DEFAULT_TARGET_THREAD_URL} in r/smallbusiness (topic: "four-day work weeks", angle: thorough-value)`,
      },
      { ctx: { runId: "prior_run", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring", metadata: {} } },
    );

    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_dedup_hold" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/already answered in a prior run/i);
    // The draft never ran — dedup is checked well before drafting.
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps("reddit_run_dedup_hold");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("09-check-thread-not-answered");
    expect(ids).not.toContain("10-verify-subreddit-eligibility");
  });

  it("a different thread URL from a prior run's decision does not collide", async () => {
    const promptStore = makePromptStore();
    await env.tools["memory.appendDecision"]!.execute(
      {
        decisionId: "prior_run_other__decision",
        summary: `Replied to thread https://www.reddit.com/r/startups/comments/zzz999/some_other_thread/ in r/startups (topic: "remote hiring", angle: personal-experience)`,
      },
      { ctx: { runId: "prior_run_other", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring", metadata: {} } },
    );

    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_dedup_no_collision" });

    expect(result.status).toBe("completed");
  });

  it("running the same run twice (resume) never double-holds on its own already-recorded decision", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_dedup_self" });
    expect(first.status).toBe("completed");

    const second = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_dedup_self" });
    expect(second.status).toBe("completed");
  });
});
