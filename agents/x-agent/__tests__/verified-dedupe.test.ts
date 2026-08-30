import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { DEDUPE_SIMILARITY_THRESHOLD, similarity, type AgentContext } from "@agent-engine/core";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * AU20 (SCRUM-304): the acceptance criterion — a planted NEAR-duplicate is
 * caught before the draft can pass review.
 *
 * "Near", not byte-identical, on purpose: the point of the ticket is that this
 * agent's only anti-repetition mechanism was the `recentPosts` directive in
 * the drafting prompt, which is advisory. A model that reorders its own
 * sentences and swaps a few words is still repeating itself, and nothing
 * downstream ever measured whether it had. The planted draft below scores
 * comfortably over `evaluateDedupe`'s calibrated threshold while sharing no
 * whole line verbatim with the published post it recycles — exactly the case a
 * prompt-only check sails past.
 */

const params = { runId: "x_dedupe_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

/** Already shipped for this client, sitting in `ledger.recordOutputExcerpt`'s window. */
const PUBLISHED =
  "Four day week trials keep spreading across mid sized teams. Internal data shows output held steady while sick days fell. The real trade off is scheduling, not productivity.";

/** This run's first draft: the same post, sentences reordered and lightly reworded. */
const NEAR_DUPLICATE =
  "The real trade off here is scheduling, not productivity. Fresh internal data shows output held steady while sick days fell. Four day week trials keep spreading among mid sized teams.";

/** The redraft: genuinely different hook, structure and subject matter. */
const FRESH =
  "Hiring managers keep asking us how to interview for judgement rather than trivia. Our answer is boring: give the candidate a real ticket from last week and talk about what they would cut.";

function draft(text: string) {
  return finalTurn({
    text,
    mainPostText: text,
    hook: text.slice(0, 40),
    angle: "data-point",
    lane: "knowledge",
    targetHandle: "@acmehq",
  });
}

describe("x-agent verified de-duplication (AU20)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("catches a planted near-duplicate before review, redrafts, and ships the fresh draft", async () => {
    // The plant really is a near-duplicate and really is not a copy: an
    // exact-match or substring check would not fire on it.
    expect(NEAR_DUPLICATE).not.toBe(PUBLISHED);
    expect(similarity(NEAR_DUPLICATE, PUBLISHED)).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);
    expect(similarity(FRESH, PUBLISHED)).toBeLessThan(DEDUPE_SIMILARITY_THRESHOLD);

    const seedCtx: AgentContext = { runId: "prior-run", clientSlug: "acme", productId: "x-agent", runKind: "recurring", metadata: {} };
    await env.tools["ledger.recordOutputExcerpt"]!.execute({ agentId: "x-agent", runId: "prior-run", excerpt: PUBLISHED }, { ctx: seedCtx });

    const router = fakeRouterSequence([draft(NEAR_DUPLICATE), draft(FRESH)]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
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

    const flagged = await durableStore.getStep(params.runId, "10a-verify-not-duplicate");
    expect(flagged?.status).toBe("completed");
    const verdict = flagged?.output as { status: string; maxSimilarity: number; comparedCount: number; mostSimilarRunId?: string };
    expect(verdict.status).toBe("similar");
    expect(verdict.mostSimilarRunId).toBe("prior-run");
    expect(verdict.comparedCount).toBe(1);
    expect(verdict.maxSimilarity).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);

    // The hit COST the draft: a second drafting pass ran, steered by the
    // offending post, and cleared the same check.
    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(ids).toContain("10-draft-post-attempt-2");
    const cleared = await durableStore.getStep(params.runId, "10a-verify-not-duplicate-attempt-2");
    expect((cleared?.output as { status: string }).status).toBe("ok");

    // The near-duplicate never reached the reviewer, and never shipped.
    const history = await env.store.readJson<Array<{ runId: string; excerpt: string }>>("acme", ["ledger", "output-history", "x-agent"]);
    expect(history?.map((e) => e.excerpt)).toContain(FRESH);
    expect(history?.map((e) => e.excerpt)).not.toContain(NEAR_DUPLICATE);
  }, 60000);
});
