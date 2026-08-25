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
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "instagram_run_reuse_rights", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/** All 6 slides vetted with a real fixture image, uniformly stamped with the given rights/watermark verdicts. */
function selectionsWith(overrides: { imagePath?: (n: number) => string; rightsUsable?: boolean; watermarkFree?: boolean } = {}) {
  const pool = goodImageCandidatePool();
  return {
    selections: goodCopyOutput().slides.map((s, i) => ({
      n: s.n,
      imagePath: overrides.imagePath ? overrides.imagePath(s.n) : pool[i % pool.length]!.path,
      reason: "candidate matches closely enough",
      license: "CC0, test fixture",
      rightsUsable: overrides.rightsUsable ?? true,
      watermarkFree: overrides.watermarkFree ?? true,
    })),
  };
}

describe("P0 parity-audit Fix 4: image rights/watermark verification holds the whole post", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("downgrades to text-only rather than shipping it when a slide's selected image is rightsUsable: false, exactly like no candidate existing at all", async () => {
    const promptStore = makePromptStore();
    const vetting = selectionsWith({ rightsUsable: false });
    // Only slide 3 is actually rights-encumbered; make the others clean so we
    // can pin the failure to that one slide.
    vetting.selections = vetting.selections.map((s) => (s.n === 3 ? s : { ...s, rightsUsable: true }));
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(vetting),
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

    const stepRecords = await durableStore.listSteps(params.runId);
    const downgradeStep = stepRecords.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1");
    expect((downgradeStep?.output as { downgraded: number[]; reason: string } | undefined)?.downgraded).toEqual([3]);
    expect((downgradeStep?.output as { reason: string } | undefined)?.reason).toMatch(/not rights-usable/i);
    // Never shipped WITH the rights-encumbered image — the guarantee this
    // whole test exists to protect is unchanged, only the alternative to
    // holding is: text-only, not that image.
    const slidesData = stepRecords.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { slides: Array<{ n: number; images: Record<string, string> }> }
      | undefined;
    expect(slidesData?.slides.find((s) => s.n === 3)?.images).toEqual({});

    expect(stepRecords.map((s) => s.stepId)).toContain("08-render-carousel-attempt-1");
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(1);
  });

  it("downgrades to text-only rather than shipping it when a slide's selected image is watermarkFree: false", async () => {
    const promptStore = makePromptStore();
    const vetting = selectionsWith();
    vetting.selections = vetting.selections.map((s) => (s.n === 5 ? { ...s, watermarkFree: false } : s));
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(vetting),
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
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_reuse_rights_watermark" });

    expect(result.status).toBe("completed");
    const stepRecords = await durableStore.listSteps("instagram_run_reuse_rights_watermark");
    const downgradeStep = stepRecords.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1");
    expect((downgradeStep?.output as { downgraded: number[] } | undefined)?.downgraded).toEqual([5]);
    expect((downgradeStep?.output as { reason: string } | undefined)?.reason).toMatch(/not watermark-free/i);
  });
});

describe("P0 parity-audit Fix 3: cross-post image-reuse prevention", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("rejects a candidate whose path matches a prior post's already-used image, downgrading that slide to text-only rather than shipping it", async () => {
    const pool = goodImageCandidatePool();
    const alreadyUsedPath = pool[0]!.path;
    await env.tools["ledger.recordUsedImages"]!.execute(
      { imagePaths: [alreadyUsedPath] },
      { ctx: { runId: "prior_run", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } },
    );

    const promptStore = makePromptStore();
    // Slide 1 (incorrectly) reselects the already-used image; every other
    // slide gets a distinct, never-collide-with-index-0 candidate so the
    // failure can be pinned to exactly slide 1. The workflow's own
    // deterministic check must catch the reuse even though nothing in the
    // model's own selections array flagged it.
    const otherPaths = [pool[1]!.path, pool[2]!.path];
    const vetting = selectionsWith({ imagePath: (n) => (n === 1 ? alreadyUsedPath : otherPaths[n % otherPaths.length]!) });
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(vetting),
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
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_reuse_cross_post" });

    expect(result.status).toBe("completed");
    const stepRecords = await durableStore.listSteps("instagram_run_reuse_cross_post");
    const downgradeStep = stepRecords.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1");
    expect((downgradeStep?.output as { downgraded: number[] } | undefined)?.downgraded).toEqual([1]);
    expect((downgradeStep?.output as { reason: string } | undefined)?.reason).toMatch(/already used in a prior post/i);
  });

  it("records every shipped image as used at delivery, so a LATER post's cross-post check picks it up", async () => {
    const promptStore = makePromptStore();
    const vetting = selectionsWith();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(goodCopyOutput()), finalTurn(vetting), finalTurn({ pass: true, findings: [] })]);
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
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_reuse_records" });
    expect(result.status).toBe("completed");

    const usedImages = await env.tools["ledger.listUsedImages"]!.execute(
      {},
      { ctx: { runId: "check", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } },
    );
    expect(usedImages.status).toBe("success");
    const paths = (usedImages as { result: { imagePaths: string[] } }).result.imagePaths;
    const shippedPaths = new Set(vetting.selections.map((s) => s.imagePath));
    for (const shipped of shippedPaths) {
      expect(paths).toContain(shipped);
    }
  }, 60000);
});
