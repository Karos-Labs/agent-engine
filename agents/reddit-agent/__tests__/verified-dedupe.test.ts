import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { DEDUPE_SIMILARITY_THRESHOLD, similarity, type AgentContext } from "@agent-engine/core";
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
 * AU20 (SCRUM-304): the acceptance criterion — a planted NEAR-duplicate is
 * caught before the reply can pass review.
 *
 * "Near", not byte-identical, on purpose: this agent's only anti-repetition
 * mechanism for reply TEXT was the `recentPosts` directive in the drafting
 * prompt, which is advisory. Step 09's already-answered-thread check is a
 * different question entirely — it asks whether we have replied in THIS
 * thread, so a recycled comment dropped into a fresh thread passes it. The
 * planted reply below scores well over `evaluateDedupe`'s calibrated threshold
 * while sharing no whole paragraph verbatim with the reply it recycles.
 */

const params = { runId: "reddit_dedupe_1", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

/** Already shipped for this client, sitting in `ledger.recordOutputExcerpt`'s window. */
const PUBLISHED =
  "We run a small B2B SaaS shop and moved most of engineering to a four day week last quarter as a trial.\n\n" +
  "Sick days dropped noticeably across the team and shipped feature count stayed roughly flat.\n\n" +
  "Has anyone else run a trial like this? Curious what broke for you that did not show up in the first month.";

/** This run's first draft: the same reply, paragraphs reordered and lightly reworded. */
const NEAR_DUPLICATE =
  "Has anyone else run a trial like this one? Curious what broke for you that did not show up in the first month.\n\n" +
  "Sick days dropped noticeably across our team and shipped feature count stayed roughly flat.\n\n" +
  "We run a small B2B SaaS shop and moved most of engineering to a four day week last quarter as a trial.";

/** The redraft: a genuinely different contribution to the thread. */
const FRESH =
  "Different angle on this thread: we never changed the number of days, we changed who is allowed to book a meeting.\n\n" +
  "Two people can put something in the calendar without asking. Everyone else writes it up first and waits a day.\n\n" +
  "Turns out about half the meetings we thought we needed were someone thinking out loud. Anyone tried the same thing?";

function draft(text: string) {
  return finalTurn({
    targetThreadUrl: DEFAULT_TARGET_THREAD_URL,
    targetThreadTitle: DEFAULT_TARGET_THREAD_TITLE,
    replyBody: text,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
    text,
  });
}

describe("reddit-agent verified de-duplication (AU20)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("catches a planted near-duplicate before review, redrafts, and ships the fresh reply", async () => {
    // The plant really is a near-duplicate and really is not a copy: an
    // exact-match or substring check would not fire on it.
    expect(NEAR_DUPLICATE).not.toBe(PUBLISHED);
    expect(similarity(NEAR_DUPLICATE, PUBLISHED)).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);
    expect(similarity(FRESH, PUBLISHED)).toBeLessThan(DEDUPE_SIMILARITY_THRESHOLD);

    const seedCtx: AgentContext = { runId: "prior-run", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring", metadata: {} };
    await env.tools["ledger.recordOutputExcerpt"]!.execute({ agentId: "reddit-agent", runId: "prior-run", excerpt: PUBLISHED }, { ctx: seedCtx });

    const router = fakeRouterSequence([draft(NEAR_DUPLICATE), draft(FRESH)]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // The headline claim, asserted first so a regression here reads as what it
    // is: without the verified check the near-duplicate is what ships.
    expect(result.output.preview).toBe(FRESH);

    // The advisory half was present and was not enough: the do-not-repeat
    // directive reached the first drafting prompt, and the model returned the
    // near-duplicate anyway. Only the verified check stopped it.
    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(calls[0]![0])).toContain("RECENTLY PUBLISHED");

    const flagged = await durableStore.getStep(params.runId, "12a-verify-not-duplicate");
    expect(flagged?.status).toBe("completed");
    const verdict = flagged?.output as { status: string; maxSimilarity: number; comparedCount: number; mostSimilarRunId?: string };
    expect(verdict.status).toBe("similar");
    expect(verdict.mostSimilarRunId).toBe("prior-run");
    expect(verdict.comparedCount).toBe(1);
    expect(verdict.maxSimilarity).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);

    // The hit COST the draft: a second drafting pass ran, steered by the
    // offending reply, and cleared the same check.
    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(ids).toContain("12-draft-reply-attempt-2");
    const cleared = await durableStore.getStep(params.runId, "12a-verify-not-duplicate-attempt-2");
    expect((cleared?.output as { status: string }).status).toBe("ok");

    // The near-duplicate never reached the reviewer, and never shipped.
    const history = await env.store.readJson<Array<{ runId: string; excerpt: string }>>("acme", ["ledger", "output-history", "reddit-agent"]);
    expect(history?.map((e) => e.excerpt)).toContain(FRESH);
    expect(history?.map((e) => e.excerpt)).not.toContain(NEAR_DUPLICATE);
  }, 60000);
});
