import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool, AgentToolRegistry, ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
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

/**
 * # A GENERATED FRAME BELONGS TO THE RUN, NOT TO THE ATTEMPT THAT BOUGHT IT
 *
 * prep `pubsub-21909275109642063` (thepitchbydeel, 2026-09-20) generated eight
 * images — its entire per-run ceiling — and shipped two pictures:
 *
 *     attempt 1: generated 2, pictureSlides 2
 *     attempt 2: generated 5, pictureSlides 2
 *     attempt 3: generated 8, pictureSlides 2
 *
 * Not the vet refusing them. At attempt 2 the floor vet ACCEPTED slide 2's
 * generated frame — `claimMatch 4`, rights and watermark clear, *"Candidate
 * was generated specifically to fulfill this slide's brief"* — and slide 2
 * shipped without a picture, with no downgrade step recording it.
 *
 * `attemptPool` and `selections` are both declared INSIDE the attempt loop,
 * and the pool is rebuilt each attempt from the client's uploads, the library
 * and a fresh harvest. A frame generated on attempt 1 appears in none of
 * those, so attempt 2 could not re-select it however good it was — while
 * `generatedSoFar` kept counting it against the ceiling.
 *
 * This test is that mechanism, and it asserts the cheapest provable fact: the
 * frame attempt 1 paid for is IN the pool attempt 2 vets. Whether it then wins
 * its slide is the vet's judgment against a redrafted post, which is exactly
 * as it should be — what the run must not do is throw the frame away and buy
 * another.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** Every `input` object the router was handed, in order. */
function turnInputs(router: ModelRouter): Array<Record<string, unknown>> {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  const inputs: Array<Record<string, unknown>> = [];
  for (const call of complete.mock.calls) {
    const promptArg = call[0];
    if (typeof promptArg !== "string") continue;
    try {
      const parsed = JSON.parse(promptArg) as { input?: Record<string, unknown> };
      if (parsed.input !== undefined && parsed.input !== null && typeof parsed.input === "object") inputs.push(parsed.input);
    } catch {
      /* BaseAgent always sends JSON; unreachable in practice */
    }
  }
  return inputs;
}

/**
 * The FIRST candidate pool each attempt vets, in attempt order.
 *
 * Attempt-scoped on purpose, and this is the whole difficulty of the test. An
 * attempt makes several vetting calls — the first pass over the retrieval
 * pool, then a re-vet per rescue tier — and the generate tier's own re-vet
 * sees the frames it just generated WITHIN that attempt. A test that simply
 * looked at "some later pool" therefore passed with the fix reverted, because
 * it was reading attempt 1's generate re-vet and calling it attempt 2.
 *
 * A copy turn is what starts an attempt (`05-write-copy-attempt-N`), so the
 * boundaries are the copy turns and what matters is the first vetting pool
 * AFTER each one. That pool is built from `attemptPool` at its freshest, which
 * is exactly the thing this fix changes.
 */
function firstPoolPerAttempt(router: ModelRouter): string[][] {
  const perAttempt: string[][] = [];
  let seenCopyTurn = false;
  let takenThisAttempt = true;
  for (const input of turnInputs(router)) {
    const isCopyTurn = "facts" in input && "styleConfig" in input;
    if (isCopyTurn) {
      seenCopyTurn = true;
      takenThisAttempt = false;
      continue;
    }
    const isVettingTurn = "candidatePool" in input && "slides" in input;
    if (!isVettingTurn || !seenCopyTurn || takenThisAttempt) continue;
    perAttempt.push(((input["candidatePool"] as Array<{ path: string }>) ?? []).map((c) => c.path));
    takenThisAttempt = true;
  }
  return perAttempt;
}

describe("generated frames survive a redraft", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("puts the frame attempt 1 generated into the pool attempt 2 vets, instead of buying another", async () => {
    // A DISTINCT path per call, which is what makes the test decisive.
    //
    // With one fixed path the frame appears in every pool — including attempt
    // 1's, because generation runs before the first vetting turn — and the
    // assertion cannot tell "attempt 2 kept attempt 1's frame" from "attempt 2
    // generated its own again". That version passed with the fix reverted.
    const generatedPaths: string[] = [];
    let generateCalls = 0;
    const generate: AgentTool = {
      name: "image.generate",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute() {
        const path = `.media-cache/carry/n2-gen${generateCalls}.png`;
        generateCalls += 1;
        generatedPaths.push(path);
        return {
          status: "success",
          result: {
            model: "gemini-2.5-flash-image",
            unmet: [],
            candidates: [
              {
                path,
                description: "slide 2 candidate — AI-generated illustration created specifically for this slide",
                provider: "gemini-image",
                licenseConfidence: "generated",
              },
            ],
          },
        };
      },
    } as unknown as AgentTool;

    const copy = goodCopyOutput();
    // Attempt 1's QA fails, which is what forces the redraft this test is about.
    const failingQa = { pass: false, findings: [{ ruleId: "font-hierarchy", slide: 6, passed: false, note: "the closer's headline and body are the same size" }] };
    const vetNothing = { selections: copy.slides.map((s) => ({ n: s.n, imagePath: null, reason: "no candidate matched", license: "n/a", rightsUsable: false, watermarkFree: false, claimMatch: 1, claimMatchReason: "nothing shows the claim" })) };

    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()),
      // attempt 1
      finalTurn(goodAngleProposal()),
      finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(copy),
      finalTurn(vetNothing),
      finalTurn(vetNothing),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(failingQa),
      // attempt 2
      finalTurn(copy),
      finalTurn(vetNothing),
      finalTurn(vetNothing),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(goodVisualQaOutput()),
      finalTurn(DEFAULT_PACKAGE_TURN),
    ]);

    const tools = {
      ...env.tools,
      "image.generate": generate,
      "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
    } as AgentToolRegistry;

    await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...base, runId: "carry" },
    );

    const pools = firstPoolPerAttempt(router);
    expect(generateCalls, "generation never ran, so there is no carried frame to assert about").toBeGreaterThan(0);
    expect(pools.length, "only one attempt vetted, so the redraft this test is about never happened").toBeGreaterThan(1);

    // The frame attempt 1 paid for: the first one generation ever produced.
    const firstFrame = generatedPaths[0]!;
    // The premise, so a pass cannot come from the fixture rather than the
    // code: attempt 2 really did generate something of its own, so its pool
    // holding `firstFrame` is a carry and not merely "the newest frame".
    expect(generatedPaths.length, "generation ran only once, so nothing distinguishes a carried frame from a fresh one").toBeGreaterThan(1);

    // THE ASSERTION: attempt 2 opens holding the frame attempt 1 bought.
    expect(
      pools[1],
      `attempt 2 started without the frame attempt 1 generated (${firstFrame}) — it was bought and thrown away. ` +
        `Opening pools per attempt: ${JSON.stringify(pools)}; frames generated: ${JSON.stringify(generatedPaths)}`,
    ).toContain(firstFrame);
  }, 120_000);
});
