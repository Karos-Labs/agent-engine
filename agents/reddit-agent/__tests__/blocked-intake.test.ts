import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import {
  DEFAULT_TARGET_THREAD_TITLE,
  DEFAULT_TARGET_THREAD_URL,
  fakeRouterSequence,
  finalTurn,
  guardrailTurn,
  makePromptStore,
  plannerTurn,
  scoutTurn,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "reddit_run_blocked", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

function goodDraft() {
  const replyBody =
    "We ran the same trial at a 12-person shop. Output held, but Friday response times were the thing that slipped, so we moved one person to a Friday rota.";
  return {
    targetThreadUrl: DEFAULT_TARGET_THREAD_URL,
    targetThreadTitle: DEFAULT_TARGET_THREAD_TITLE,
    replyBody,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
    text: replyBody,
  };
}

/**
 * Setup is a step, not a precondition.
 *
 * prep job 5A6bc8VUgRKcCg0Vh7xz (Karos Labs, 2026-09-05) was `blocked_intake`
 * with "client has not configured any target subreddits yet, and no Reddit
 * charter is on file" — for a client with a profile, a brand kit and six
 * knowledge documents. Nothing looked at any of them before giving up. Now a
 * client with nothing on file gets a charter derived from what it is, recorded
 * as auto-derived so a real form replaces it later, and the run continues.
 */
describe("auto-setup: a client with no Reddit configuration is set up on the way past, not blocked", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("derives a charter, records it as auto-derived, discovers a thread and delivers", async () => {
    env = await setupTestEnvironment({ withTargetSubreddits: false });
    const promptStore = makePromptStore();
    // The auto-derived charter carries off-limits topics, so the topic
    // guardrail runs as a fourth model call after the draft.
    const router = fakeRouterSequence([plannerTurn(), scoutTurn(), finalTurn(goodDraft()), guardrailTurn()]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // A scanned candidate carries the canonical thread URL, not the slugged one.
    expect(result.output.targetThreadUrl).toBe("https://www.reddit.com/r/smallbusiness/comments/abc123/");
    // Planner, scout, draft, guardrail: four model calls, in that order.
    expect(router.complete).toHaveBeenCalledTimes(4);

    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(ids).toContain("04a-plan-channel");
    expect(ids).toContain("04b-record-auto-charter");
    expect(ids).toContain("05-discover-threads");
    expect(ids).toContain("06-scout-thread");

    // The charter landed where `client.getStrategy` reads it, and says what it is.
    const charter = await env.store.readJson<{ markdown: string; data: Record<string, unknown>; source: Record<string, unknown> }>("acme", [
      "strategy",
      "reddit-agent",
      "config",
    ]);
    expect(charter?.data["autoDerived"]).toBe(true);
    expect(charter?.data["targetSubreddits"]).toEqual(["r/smallbusiness", "r/startups", "r/marketing"]);
    expect(charter?.data["searchKeywords"]).toContain("4-day week");
    expect(charter?.markdown).toContain("AUTO-DERIVED");
    expect(charter?.source["form"]).toBe("reddit-auto-setup");

    // The deliverable records that the engine chose the communities.
    const deliverables = await env.store.listJson<{ deliverable: { charterSource: string; whyThisThread: string } }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables[0]?.data.deliverable.charterSource).toBe("auto-derived");
    expect(deliverables[0]?.data.deliverable.whyThisThread).toBeTruthy();
  }, 60_000);

  it("a second run for the same client reuses the auto-derived charter without planning again", async () => {
    env = await setupTestEnvironment({ withTargetSubreddits: false });
    const promptStore = makePromptStore();
    const first = fakeRouterSequence([plannerTurn(), scoutTurn(), finalTurn(goodDraft()), guardrailTurn()]);
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const r1 = await engine.run(createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router: first, autoApprove: true }), params);
    expect(r1.status).toBe("completed");

    // Second run: no planner turn is configured, so a planner call would throw.
    // A different thread and a different reply: the first run's reply is now in
    // the output-history window, and a repeat would be caught by 12a.
    const secondUrl = "https://www.reddit.com/r/smallbusiness/comments/def456/late_paying_clients/";
    const secondReply = "Deposits before work starts fixed this for us. After the first late invoice we moved every client to half up front and nobody left over it.";
    const second = fakeRouterSequence([
      scoutTurn({ url: secondUrl, angle: "thorough-value" }),
      finalTurn({ ...goodDraft(), targetThreadUrl: secondUrl, targetThreadTitle: "How do you handle late-paying clients without souring the relationship?", replyBody: secondReply, text: secondReply }),
      guardrailTurn(),
    ]);
    const store2 = new MemoryDurableStepStore();
    const r2 = await new WorkflowEngine(store2).run(
      createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router: second, autoApprove: true }),
      { ...params, runId: "reddit_run_blocked_second" },
    );
    expect(r2.status).toBe("completed");
    expect(second.complete).toHaveBeenCalledTimes(3);
    const ids = (await store2.listSteps("reddit_run_blocked_second")).map((s) => s.stepId);
    expect(ids).not.toContain("04a-plan-channel");
  }, 60_000);

  it("prunes a community the planner guessed wrong once Reddit says it does not exist", async () => {
    env = await setupTestEnvironment({ withTargetSubreddits: false, reddit: { missingSubreddits: ["marketing"] } });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([plannerTurn(), scoutTurn(), finalTurn(goodDraft()), guardrailTurn()]);
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const result = await engine.run(createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true }), params);
    expect(result.status).toBe("completed");

    const charter = await env.store.readJson<{ data: Record<string, unknown> }>("acme", ["strategy", "reddit-agent", "config"]);
    expect(charter?.data["targetSubreddits"]).toEqual(["r/smallbusiness", "r/startups"]);
  }, 60_000);

  it("resolves to blocked_intake, naming the setup form, only when the planner itself cannot produce a charter", async () => {
    env = await setupTestEnvironment({ withTargetSubreddits: false });
    const promptStore = makePromptStore();
    // Every turn is schema-invalid for the planner, so the step cannot complete.
    const junk = () => finalTurn({ nonsense: true });
    const router = fakeRouterSequence([junk(), junk(), junk(), junk()]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "reddit_run_blocked_planner" });

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/auto-setup could not derive one/i);
    expect(result.reason).toMatch(/Reddit setup form/i);
    // Nothing was written: a failed plan must not leave a half-charter behind.
    expect(await env.store.readJson("acme", ["strategy", "reddit-agent", "config"])).toBeUndefined();
  }, 60_000);

  it("resolves to blocked_intake when the client has no brand guidelines set up", async () => {
    env = await setupTestEnvironment({ withTargetSubreddits: true, withBrand: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "reddit_run_blocked_2" });

    expect(result.status).toBe("blocked_intake");
    expect(router.complete).not.toHaveBeenCalled();
  });
});
