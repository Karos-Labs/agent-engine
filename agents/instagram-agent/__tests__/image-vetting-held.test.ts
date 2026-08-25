import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentToolRegistry } from "@agent-engine/core";
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

const params = { runId: "instagram_run_novimg", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** Chromium-free `publish.renderCarousel` stand-in -- same rationale as `workflow-e2e.test.ts`. Needed now that an unfillable slide reaches rendering instead of holding before it. */
function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

describe("06-vet-images: no viable image ships text-only rather than holding (guaranteed delivery, 2026-08)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("downgrades exactly one unfillable slide to text-only and still delivers -- never a placeholder, never a silently-dropped slide", async () => {
    const promptStore = makePromptStore();
    const copy = goodCopyOutput();
    const vetting = {
      selections: copy.slides.map((s) => ({
        n: s.n,
        imagePath: s.n === 3 ? null : goodImageCandidatePool()[0]!.path,
        reason: s.n === 3 ? "nothing in the pool shows this slide's specific visual need" : "candidate matches closely enough",
        license: s.n === 3 ? "n/a — no candidate qualified" : "CC0, test fixture",
        rightsUsable: s.n !== 3,
        watermarkFree: s.n !== 3,
      })),
    };
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
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

    // The downgrade is checkpointed and named, the run proceeds through
    // self-check and rendering, and a deliverable is actually produced --
    // none of which happened under the old "hold the whole post" behavior.
    const stepRecords = await durableStore.listSteps(params.runId);
    const stepIds = stepRecords.map((s) => s.stepId);
    expect(stepIds).toContain("06-vet-images-attempt-1");
    const downgradeStep = stepRecords.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1");
    expect((downgradeStep?.output as { downgraded: number[] } | undefined)?.downgraded).toEqual([3]);
    expect(stepIds).toContain("07-self-check-attempt-1");
    expect(stepIds).toContain("08-render-carousel-attempt-1");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(1);
  });

  it("downgrades every slide to text-only and still delivers when the whole pool is empty/irrelevant", async () => {
    const promptStore = makePromptStore();
    const copy = goodCopyOutput();
    // No "vetting" turn queued: an empty pool skips step 06's model call
    // entirely (see the workflow's own comment on why), straight to research
    // -> copy -> visual QA.
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn(goodVisualQaOutput()),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: [], // Phase-1 stand-in pool is empty this run -- nothing to vet against
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_novimg_all" });

    expect(result.status).toBe("completed");
    const stepRecords = await durableStore.listSteps("instagram_run_novimg_all");
    const downgradeStep = stepRecords.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1");
    expect((downgradeStep?.output as { downgraded: number[] } | undefined)?.downgraded).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
