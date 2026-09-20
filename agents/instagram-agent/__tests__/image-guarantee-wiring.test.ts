import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { GENERATED_IMAGES_PER_RUN_CAP, MIN_GENERATED_IMAGES_PER_RUN, RUN_BUDGET_BELIEF_KEY } from "../src/workflow/run-budget.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,

  goodCopyOutput,
  goodImageCandidatePool,
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
 * ── THE COUNTER THE WORKFLOW ACTUALLY PASSES. ──
 *
 * `image-floor-never-cut.test.ts` covers `partitionGaps` and
 * `guaranteedGapCount` thoroughly, and every one of its cases hands the pure
 * function a number directly. **The defect that shipped was not in the pure
 * function.** It was the call site: the workflow passed `generatedSoFar`, its
 * GROSS counter, incremented from `tierPool.length` the moment `image.generate`
 * returns and before any vet has seen a frame.
 *
 * So on 2026-09-20 two prep carousels (`pubsub-21902648165262839`,
 * `pubsub-21903994794164204`) bought three frames, had all three refused by the
 * vet, and the floor read its guarantee as fully discharged:
 *
 *     {"action":"unfilled","pictureSlides":0,"generated":3,
 *      "reason":"this run already generated 3 image(s) — its whole guarantee of
 *      3 — and none of them survived vetting, so there is no generation left to
 *      buy and 0 slide(s) carry a picture against a floor of 3"}
 *
 * A unit test over the pure function cannot see that, because the pure function
 * was always right. This file asserts the WIRING, and it is the test that goes
 * red if anyone re-points the call site at the gross counter — which is exactly
 * the edit that caused the incident.
 */

const params = {
  runId: "instagram_run_guarantee_wiring",
  clientSlug: "acme",
  productId: "instagram-agent",
  runKind: "recurring" as const,
};

function testTools(tools: AgentToolRegistry): AgentToolRegistry {
  return { ...tools, "publish.renderCarousel": fakeRenderCarousel(tools["publish.renderCarousel"]!) };
}

async function allowGeneratedImages(env: TestEnvironment, runId: string): Promise<void> {
  await env.tools["memory.updateBeliefs"]!.execute(
    { diff: { [RUN_BUDGET_BELIEF_KEY]: { version: 1, ewmaRatio: 0.5, overrunStreak: 0, underTargetStreak: 0, runs: [] } } },
    { ctx: { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } },
  );
}

describe("the picture guarantee is wired to frames HELD, not frames bought", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment({ scraper: createOfflineScraper() });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("keeps buying frames while the vet refuses them, instead of reading its guarantee as spent", async () => {
    await allowGeneratedImages(env, params.runId);
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();

    let framesBought = 0;
    const tools = testTools({
      ...env.tools,
      // Retrieval finds nothing, so every picture slide is a gap the generate
      // tier owns — the shape both shipped runs were in.
      "media.findImages": {
        name: "media.findImages",
        version: "1.0.0",
        async execute() {
          return { status: "success", result: { provider: "none", providersUsed: [], candidates: [], unmet: [] } };
        },
        inputSchema: { parse: (v: unknown) => v } as never,
      } as unknown as AgentTool,
      "image.generate": {
        name: "image.generate",
        version: "1.0.0",
        async execute(args: unknown) {
          const needs = (args as { needs?: unknown[] }).needs ?? [];
          framesBought += needs.length;
          return {
            status: "success",
            result: {
              model: "imagen-4.0-generate-001",
              unmet: [],
              candidates: needs.map((_n, i) => ({
                path: pool[i % pool.length]!.path,
                description: "a generated frame the vet will refuse",
                provider: "imagen",
                licenseConfidence: "generated",
              })),
            },
          };
        },
        inputSchema: { parse: (v: unknown) => v } as never,
      } as unknown as AgentTool,
    });

    // EVERY vetting turn refuses everything, exactly as the shipped runs did.
    // `fakeRouterSequence` is positional, so this supplies far more vet turns
    // than the run can consume rather than guessing the count.
    const refuseAll = finalTurn({
      selections: copy.slides.map((s) => ({
        n: s.n,
        imagePath: null,
        reason: "the frame was drawn to a claim this slide no longer makes",
        license: "n/a",
        rightsUsable: false,
        watermarkFree: false,
        claimMatch: 1,
        subjectMatch: 1,
        claimMatchReason: "lacks the required conversation interface and the 'sponsored' label",
        subjectMatchReason: "not the briefed subject",
      })),
    });
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()),
      finalTurn(goodResearchOutput()),
      finalTurn(goodAngleProposal()),
      finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(copy),
      ...Array.from({ length: 24 }, () => refuseAll),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(goodVisualQaOutput()),
      finalTurn(DEFAULT_PACKAGE_TURN),
    ]);

    const durableStore = new MemoryDurableStepStore();
    await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      params,
    );

    // ── THE ASSERTION, AND THE TWO NUMBERS IT WAS CALIBRATED ON ──
    //
    // Both measured on this fixture, by reverting the call site to the gross
    // counter and running it again:
    //
    //   guarantee counted in frames BOUGHT (the shipped bug):  4 frames
    //   guarantee counted in frames HELD   (this branch):      7 frames
    //
    // So "more than the floor" is NOT the discriminator — the buggy run passes
    // that, because the generate tier is entered once per attempt and buys a
    // little regardless. The discriminator is whether the run spends toward
    // the CEILING: with the guarantee re-arming as frames die it keeps buying
    // while any allowance is left, and with the guarantee read as discharged
    // it stops near the floor.
    //
    // Tied to `GENERATED_IMAGES_PER_RUN_CAP` rather than to the literal 7, so
    // this survives a change to the cap; `- 1` because the last frame is only
    // bought when a gap happens to remain on the final pass.
    expect(
      framesBought,
      `the run bought ${framesBought} frame(s) against a ceiling of ${GENERATED_IMAGES_PER_RUN_CAP}. Stopping near the floor of ` +
        `${MIN_GENERATED_IMAGES_PER_RUN} means the guarantee is being read as discharged by frames that never survived vetting — ` +
        `the 2026-09-20 defect, back at the call site.`,
    ).toBeGreaterThanOrEqual(GENERATED_IMAGES_PER_RUN_CAP - 1);

    // And the other side of it: re-arming must not become unbounded. The
    // ceiling is the thing that makes "keep buying" safe to say.
    expect(framesBought, "the re-armed guarantee ran past the per-run ceiling").toBeLessThanOrEqual(GENERATED_IMAGES_PER_RUN_CAP);
  }, 120_000);
});
