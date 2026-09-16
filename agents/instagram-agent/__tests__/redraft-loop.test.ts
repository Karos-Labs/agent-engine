import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { OutputLimitExceededError } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { COPY_MAX_TOKENS } from "../src/agent/instagram-copy-agent.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodRelevanceVerdict,
  goodResearchOutput,
  goodTrendScoutOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { DEFAULT_ENTITIES_TURN, DEFAULT_PACKAGE_TURN, VALUE_TURN_NO_FINDINGS } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";

/**
 * ══ THE REDRAFT LOOP, WITH A TRUNCATED ATTEMPT IN THE MIDDLE OF IT ══
 *
 * ## The production failure this reproduces
 *
 * On 2026-09-16, across three prep runs, **five of six redraft attempts died
 * with `anthropic: model "claude-sonnet-4-6" hit the 16384-token output limit
 * before completing its structured output`**, each booked at $0.000000 with
 * zero tokens. The run then re-judged the FIRST draft, failed the same gates
 * with the same words (`thepitchbydeel` returned the identical "no tension"
 * reason on attempt 1 and attempt 3), and shipped it marked `degraded`.
 *
 * Two things were broken at once and each hid the other:
 *
 *   1. **The ceiling.** Nobody set one, so the step inherited
 *      `DEFAULT_MAX_TOKENS = 16384` and the writer's plan plus its draft went
 *      past it. `COPY_MAX_TOKENS` is the fix.
 *   2. **The meter.** `messages-api-adapter.ts` threw a bare `Error` BEFORE
 *      resolving the response's usage, so the one failure mode guaranteed to
 *      have spent its whole output ceiling was the one that reported spending
 *      nothing. The budget ladder was cutting generated images out of posts to
 *      stay under a target it could not see. `OutputLimitExceededError`, which
 *      carries the provider's own usage, is the fix.
 *
 * CI saw neither, because every workflow fixture in this package returns a
 * short fake output through a fake router and no fixture had ever made a model
 * call fail the way a real one does.
 *
 * ## What this queues
 *
 * `[long-valid-draft, truncation-error, long-valid-draft]`, exactly as the
 * spec's B4 asks. Attempt 1 carries a banned word so the self-check returns it
 * (the same lever `self-check-retry.test.ts` uses), attempt 2 is the
 * truncation, attempt 3 is clean. The assertions are the three failures above,
 * stated as outcomes rather than as mechanism.
 */

const params = { runId: "instagram_run_redraft", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** The claim attempt 3 puts on slide 1, and nothing else in the fixture set says. Finding it in the shipped post is how "which draft shipped" is answered. */
const ATTEMPT_3_MARKER = "Third draft headline that only attempt three wrote";

/** `goodCopyOutput()` with a banned word ("guaranteed", banned by `goodStyleConfig()`) in one body: fails step 07's self-check for exactly one reason. */
function draftWithBannedWord(): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return { ...copy, slides: copy.slides.map((s, i) => (i === 0 ? { ...s, body: `${s.body} This is guaranteed to help.` } : s)) };
}

/** A clean draft carrying `ATTEMPT_3_MARKER` where the assembled slides will show it. */
function draftFromAttemptThree(): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return { ...copy, slides: copy.slides.map((s, i) => (i === 0 ? { ...s, headline: ATTEMPT_3_MARKER } : s)) };
}

/**
 * The usage a real truncated Sonnet turn reports, taken from the 2026-09-16
 * runs rather than invented: a cold `05` attempt sent ~47,000 uncached input
 * tokens with ~23,000 of them written to cache, and a truncated turn burns the
 * whole output ceiling by definition. `computeStepCostUsd` prices this at about
 * $0.33, which is what those five attempts really cost and reported as $0.
 */
function truncatedCopyTurn(): () => never {
  return () => {
    throw new OutputLimitExceededError(
      `anthropic: model "claude-sonnet-4-6" hit the ${COPY_MAX_TOKENS}-token output limit before completing its structured output`,
      {
        usage: { modelUsed: "claude-sonnet-4-6", inputTokens: { cached: 23_167, uncached: 23_778 }, outputTokens: COPY_MAX_TOKENS },
        attemptedMaxTokens: COPY_MAX_TOKENS,
      },
    );
  };
}

/** Chromium-free `publish.renderCarousel` stand-in — same rationale as `workflow-e2e.test.ts`. */
function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

interface AgentStepRecord {
  status: string;
  costUsd?: number;
  output?: { status?: string; steps?: ReadonlyArray<{ status?: string; outputTokens?: number; costUsd?: number }> };
}

describe("05-write-copy: a truncated attempt in the middle of the redraft loop", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("ships attempt 3's draft, not attempt 1's, and books what the truncated attempt burned", async () => {
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()),
      finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      // Attempt 1: valid, refused by the self-check.
      finalTurn(draftWithBannedWord()),
      finalTurn(goodImageVettingOutput()),
      // Attempt 2: the failure five of six real redrafts hit. No vetting turn
      // follows it, because the draft never existed.
      truncatedCopyTurn(),
      // Attempt 3: the draft that should ship.
      finalTurn(draftFromAttemptThree()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(goodVisualQaOutput()),
      finalTurn(DEFAULT_PACKAGE_TURN),
    ]);

    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);

    // ── THE PREMISE, asserted before anything is concluded from it ──────────
    // A test that "passes" because the truncation never happened would be the
    // guard-that-cannot-fail this repo keeps catching, so the failure is read
    // back off its own checkpoint first.
    const attempt2 = (await durableStore.getStep(params.runId, "05-write-copy-attempt-2")) as AgentStepRecord | undefined;
    expect(attempt2, "attempt 2 never ran, so this test proves nothing").toBeDefined();
    expect(attempt2!.output?.status).toBe("tooling_error");

    expect(result.status).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("05-write-copy-attempt-3");
    // (a) The run reached a third attempt and SHIPPED it. Before the ceiling
    //     was raised, attempts 2 and 3 both truncated and attempt 1's draft was
    //     salvaged and delivered `degraded`.
    expect(stepIds).toContain("07c-emit-slides-data-attempt-3");
    expect(stepIds).not.toContain("07c-emit-slides-data-attempt-1");

    const slidesData = (await durableStore.getStep(params.runId, "07c-emit-slides-data-attempt-3")) as
      | { output?: { slides?: ReadonlyArray<{ fields?: Record<string, string> }> } }
      | undefined;
    const shipped = JSON.stringify(slidesData?.output?.slides ?? []);
    expect(shipped, "the shipped slides do not carry attempt 3's copy").toContain(ATTEMPT_3_MARKER);
    expect(shipped, "the shipped slides still carry attempt 1's banned word").not.toContain("guaranteed");

    // (b) The failed attempt is on the record as a failed attempt, with its own
    //     step id, so a reviewer can count the drafts a run really bought.
    //     `draftProvenance` (spec §3 B5) puts this on the GATE PAYLOAD and is
    //     W2-D's; this is the checkpoint it will be built from, and it is
    //     asserted here so the underlying fact cannot regress before then.
    const copySteps = stepIds.filter((id) => id.startsWith("05-write-copy-attempt-"));
    expect(copySteps).toHaveLength(3);
    expect(attempt2!.status).not.toBe("completed");

    // (c) THE CROSS-CHECK ON THE COST FIX. A truncated turn burned its whole
    //     output ceiling; before `OutputLimitExceededError` carried the usage, this
    //     step booked $0.000000 with zero tokens, and the budget ladder read
    //     that zero and cut the post's generated images to stay under a target
    //     it was already over. Reverting the adapter change fails this line.
    expect(attempt2!.costUsd, "a truncated attempt booked nothing").toBeGreaterThan(0);
    expect(attempt2!.output?.steps?.[0]?.outputTokens).toBe(COPY_MAX_TOKENS);
    // ~$0.33 at sonnet-4-6's $3/$15 per 1M with the cache-write premium. Held
    // as a floor rather than an exact figure: the assertion is that the run
    // sees a real number, not that pricing never moves.
    expect(attempt2!.costUsd).toBeGreaterThan(0.2);

    // Twelve calls, ENUMERATED rather than observed: 3 pre-loop (scout,
    // research, angle) + attempt 1 (copy, vetting) + attempt 2's single
    // truncated copy call + attempt 3's five (copy, vetting, relevance, value,
    // QA) + 1 packager.
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(13);
  }, 120000);
});
