import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
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
import type { InstagramCopyOutput } from "../src/workflow/types.js";

const params = { runId: "instagram_run_selfcheck", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** `goodCopyOutput()` with a banned word ("guaranteed" -- banned by `goodStyleConfig()`) injected into one slide's body -- everything else stays valid, so this fails step 07's self-check for exactly one reason. */
function copyOutputWithBannedWord(): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return {
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
      finalTurn(goodResearchOutput()),
      finalTurn(badCopy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
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

    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(6);

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

  it("holds the whole post after exhausting all 3 attempts (initial + 2 returns) with a self-check that never passes", async () => {
    const promptStore = makePromptStore();
    const badCopy = copyOutputWithBannedWord();
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(badCopy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(badCopy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(badCopy),
      finalTurn(goodImageVettingOutput()),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_selfcheck_exhausted" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/self-check never passed after 3 attempt/i);
    expect(router.complete).toHaveBeenCalledTimes(7);

    const stepIds = (await durableStore.listSteps("instagram_run_selfcheck_exhausted")).map((s) => s.stepId);
    expect(stepIds).toContain("05-write-copy-attempt-1");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("05-write-copy-attempt-3");
    expect(stepIds).toContain("07-self-check-attempt-3");
    expect(stepIds).not.toContain("07-emit-slides-data");
    expect(stepIds).not.toContain("08-render-carousel");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "instagram_run_selfcheck_exhausted", "_"]);
    expect(deliverables).toHaveLength(0);
  }, 60000);
});
