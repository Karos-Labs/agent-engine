import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  goodRelevanceVerdict,
  goodTrendScoutOutput,
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { DEFAULT_ENTITIES_TURN, DEFAULT_PACKAGE_TURN, VALUE_TURN_NO_FINDINGS } from "./turns.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import { goodAngleProposal } from "./angle-fixtures.js";

const params = { runId: "instagram_run_selfcheck", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** `goodCopyOutput()` with a banned word ("guaranteed" -- banned by `goodStyleConfig()`) injected into one slide's body -- everything else stays valid, so this fails step 07's self-check for exactly one reason. */
function copyOutputWithBannedWord(): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return {
    ...copy,
    slides: copy.slides.map((s, i) => (i === 0 ? { ...s, body: `${s.body} This is guaranteed to help your team.` } : s)),
  };
}

/** Chromium-free `publish.renderCarousel` stand-in -- same rationale as `workflow-e2e.test.ts` (see `fakeRenderCarousel`'s own doc comment). */
function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

describe("07-emit-slides-data: self-check retry, capped at two returns to step 05 (RFC-03 §3 step 07)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("fails the self-check on attempt 1 (a banned word), then succeeds on attempt 2 with a clean revision", async () => {
    const promptStore = makePromptStore();
    const badCopy = copyOutputWithBannedWord();
    const goodCopy = goodCopyOutput();
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(badCopy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    // scout + research + angle + (copy + vet) + (copy + vet + relevance + QA): a failed 07 self-check never reaches the relevance judge.
    expect(result.status).toBe("completed");
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(12);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("05-write-copy-attempt-1");
    expect(stepIds).toContain("06-vet-images-attempt-1");
    expect(stepIds).toContain("07-self-check-attempt-1");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("06-vet-images-attempt-2");
    expect(stepIds).toContain("07-self-check-attempt-2");
    expect(stepIds).not.toContain("05-write-copy-attempt-3");
    expect(stepIds).toContain("07b-craft-hygiene-attempt-2");
    expect(stepIds).toContain("07c-emit-slides-data-attempt-2");
    expect(stepIds).toContain("08b-visual-qa-attempt-2");

    const selfCheck1 = (await durableStore.getStep(params.runId, "07-self-check-attempt-1")) as { output: { ok: boolean } };
    expect(selfCheck1.output.ok).toBe(false);
    const selfCheck2 = (await durableStore.getStep(params.runId, "07-self-check-attempt-2")) as { output: { ok: boolean } };
    expect(selfCheck2.output.ok).toBe(true);
  }, 60000);

  /**
   * ── RFC-19 §8.6: THIS CASE USED TO END `held`, AND THAT WAS THE DEFECT ──
   *
   * It asserted `result.status === "held"`, `/self-check never passed after 3 attempt/`, and that ZERO
   * deliverables existed. Read plainly: three drafts were paid for, all three were refused over one banned
   * word, and the client received nothing at all. That is precisely what the owner ruled out — *"if the score
   * is not good then it should repeat steps or do something else, but THE CLIENT CANNOT RECEIVE A FAILED RUN
   * unless it is a real fault"* — and a banned word is not a real fault, it is a quality event.
   *
   * **The gate is NOT weakened.** `07-self-check-attempt-3` still refuses this draft, and the premise
   * assertion below reads its checkpoint back and proves it did. What changed is only what happens after the
   * refusal: the attempt walks on, the post ships `completed`, and the marker carries the gate's own sentence.
   *
   * **The turn count is what bites, and it is ENUMERATED rather than observed** (RFC-19 §8.2 assertion 9):
   * delivering pulls the relevance, value, visual-QA and packager turns this fixture never queued when it
   * held. 3 pre-loop (scout, research, angle) + 2 refused attempts × (copy, vetting) + the delivering
   * attempt's 5 (copy, vetting, relevance, value, QA) + 1 packager = 13.
   *
   * `testTools(env)` rather than the bare registry, for the reason the first case uses it: this run now
   * REACHES the render, and launching Chromium is not what this test is about.
   */
  it("delivers the post after all 3 attempts refused the same banned word, marked degraded, rather than holding", async () => {
    const promptStore = makePromptStore();
    const badCopy = copyOutputWithBannedWord();
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(badCopy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(badCopy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(badCopy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "instagram_run_selfcheck_exhausted";
    const result = await engine.run(workflowFn, { ...params, runId });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(14);

    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(stepIds).toContain("05-write-copy-attempt-1");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("05-write-copy-attempt-3");
    expect(stepIds).toContain("07-self-check-attempt-3");
    // The half that could not happen before: the attempt got past `07` to a render and a judgment.
    expect(stepIds).toContain("07c-emit-slides-data-attempt-3");
    expect(stepIds).toContain("08-render-carousel-attempt-3");

    // THE PREMISE (RFC-19 §8.2). The gate refused on the final attempt; the delivery is AFTER that refusal,
    // not instead of it. Without this assertion the case would pass just as happily if `checkSlidesData` had
    // silently stopped running — six recorded instances of that shape in this codebase say so.
    const selfCheck3 = (await durableStore.getStep(runId, "07-self-check-attempt-3")) as { output: { ok: boolean; reason?: string } };
    expect(selfCheck3.output.ok).toBe(false);
    expect(selfCheck3.output.reason).toMatch(/guaranteed/);

    // The client gets the carousel, AND the truth about it.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect(deliverables).toHaveLength(1);
    const record = await env.store.readJson<{
      deliverable: { selfCheck?: { status: string; reason: string; attempt: number; attemptsSpent: number; checks: Array<{ gate: string; detail: string }> } };
    }>("acme", ["ledger", "deliverables", runId, "_", "instagram-carousel"]);
    const marker = record?.deliverable.selfCheck;
    expect(marker?.status).toBe("degraded");
    expect(marker?.attempt).toBe(3);
    expect(marker?.attemptsSpent).toBe(3);
    expect(marker?.checks.find((c) => c.gate === "slides")?.detail).toMatch(/guaranteed/);
    // ONE sentence across every destination.
    expect((result.output as { selfCheck?: { reason: string } }).selfCheck?.reason).toBe(marker?.reason);
  }, 60000);
});
