import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import {
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

function goodDraft() {
  const replyBody = "Here's what actually happened after the change, no strings attached.";
  return {
    targetThreadUrl: DEFAULT_TARGET_THREAD_URL,
    targetThreadTitle: DEFAULT_TARGET_THREAD_TITLE,
    replyBody,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
    text: replyBody,
  };
}

function disclosedDraft() {
  const replyBody = "Full disclosure: I work for Acme. Here's what actually happened after the change.";
  return {
    targetThreadUrl: DEFAULT_TARGET_THREAD_URL,
    targetThreadTitle: DEFAULT_TARGET_THREAD_TITLE,
    replyBody,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: true,
    text: replyBody,
  };
}

describe("Reddit subreddit-rules gate (RFC-02 §5 migration audit, Reddit P0)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("blocks before drafting when the target subreddit is off-limits for this client", async () => {
    await env.store.writeJson("acme", ["client", "subreddit-rules"], { smallbusiness: { offLimits: true } });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_off_limits" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/off-limits/i);
    // The draft never ran — this is a pre-draft eligibility check, not a wasted draft.
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps("reddit_run_off_limits");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("10-verify-subreddit-eligibility");
    expect(ids).not.toContain("12-draft-reply");
  });

  it("blocks before drafting when the target subreddit bans AI-assisted content", async () => {
    await env.store.writeJson("acme", ["client", "subreddit-rules"], { smallbusiness: { aiContentBanned: true } });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_ai_banned" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/ai-assisted/i);
    expect(router.complete).not.toHaveBeenCalled();
  });

  it("APPENDS the required disclosure when the draft omits it, rather than blocking", async () => {
    await env.store.writeJson("acme", ["client", "subreddit-rules"], {
      smallbusiness: { disclosureRequired: true, requiredDisclosure: "I work for Acme" },
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_no_disclosure" });

    // The subreddit names the disclosure sentence verbatim, so appending it is
    // an EXACT fix — no legal copy is invented on the client's behalf — and the
    // reply ships disclosed instead of not shipping at all.
    expect(result.status).toBe("completed");

    const reply = await deliveredReply(env, "reddit_run_no_disclosure");
    expect(reply["text"]).toContain("I work for Acme");
    expect(reply["replyBody"]).toContain("I work for Acme");
    expect(reply["disclosureIncluded"]).toBe(true);
    // Drafting DID happen — disclosure can only be checked once real text exists.
    expect(router.complete).toHaveBeenCalled();
  });

  it("completes normally when disclosure is required and the draft includes it", async () => {
    await env.store.writeJson("acme", ["client", "subreddit-rules"], {
      smallbusiness: { disclosureRequired: true, requiredDisclosure: "I work for Acme" },
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(disclosedDraft())]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_with_disclosure" });

    expect(result.status).toBe("completed");
  });

  it("passes the pre-draft eligibility check with no subreddit rules configured at all (unconfigured, not blocked)", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_unconfigured_rules" });

    expect(result.status).toBe("completed");
  });

  describe("account warming and mention-cooldown (Phase-1-stubbed data, real check logic)", () => {
    it("SHIPS the reply flagged when the account is still warming, rather than holding it", async () => {
      await env.store.writeJson("acme", ["client", "subreddit-rules"], {
        smallbusiness: {
          disclosureRequired: true,
          requiredDisclosure: "I work for Acme",
          accountWarmingUntil: "2099-01-01T00:00:00.000Z",
        },
      });
      const promptStore = makePromptStore();
      const router = fakeRouterSequence([finalTurn(disclosedDraft())]);
      const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);

      const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_warming" });

      // An account-POSTURE refusal is not about the words, so there is nothing
      // in the text to redact — and this fixture configures no product-mention
      // NAMES, so the workflow's "drop the mention instead" repair has nothing
      // to drop either. The reply therefore ships FLAGGED: a human reads the
      // warning and decides, which beats the run ending with nothing to read.
      expect(result.status).toBe("completed");

      const reply = await deliveredReply(env, "reddit_run_warming");
      expect(reply["contentRepairs"]).toContainEqual(
        expect.objectContaining({ action: "unresolved", detail: expect.stringMatching(/warming/i) }),
      );
    });

    it("does not hold a value-only reply (no mention) even while the account is warming", async () => {
      await env.store.writeJson("acme", ["client", "subreddit-rules"], {
        smallbusiness: { accountWarmingUntil: "2099-01-01T00:00:00.000Z" },
      });
      const promptStore = makePromptStore();
      const router = fakeRouterSequence([finalTurn(goodDraft())]); // disclosureIncluded: false — no mention attempted
      const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);

      const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_warming_value_only" });

      expect(result.status).toBe("completed");
    });

    it("SHIPS the reply flagged when the mention would land inside the cooldown, rather than holding it", async () => {
      const recentMention = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
      await env.store.writeJson("acme", ["client", "subreddit-rules"], {
        smallbusiness: {
          disclosureRequired: true,
          requiredDisclosure: "I work for Acme",
          mentionCooldownDays: 60,
          lastMentionAt: recentMention,
        },
      });
      const promptStore = makePromptStore();
      const router = fakeRouterSequence([finalTurn(disclosedDraft())]);
      const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);

      const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_cooldown" });

      // Same reasoning as the warming case, and the same outcome: nothing in
      // the text to redact and no configured mention name to drop, so the reply
      // ships carrying the cooldown warning for a human to act on.
      expect(result.status).toBe("completed");

      const reply = await deliveredReply(env, "reddit_run_cooldown");
      expect(reply["contentRepairs"]).toContainEqual(
        expect.objectContaining({ action: "unresolved", detail: expect.stringMatching(/cooldown/i) }),
      );
    });

    it("completes when a mention ships after the mention cooldown has elapsed", async () => {
      const oldMention = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(); // 120 days ago
      await env.store.writeJson("acme", ["client", "subreddit-rules"], {
        smallbusiness: {
          disclosureRequired: true,
          requiredDisclosure: "I work for Acme",
          mentionCooldownDays: 60,
          lastMentionAt: oldMention,
        },
      });
      const promptStore = makePromptStore();
      const router = fakeRouterSequence([finalTurn(disclosedDraft())]);
      const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);

      const result = await engine.run(workflowFn, { ...baseParams, runId: "reddit_run_cooldown_elapsed" });

      expect(result.status).toBe("completed");
    });
  });
});
