import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodBrandTokens,
  goodCopyOutput,
  goodImageCandidatePool,
  goodResearchOutput,
  goodStyleConfig,
  goodVisualQaOutput,
  fakeRenderCarousel,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

/** Chromium-free render stand-in; the tool-level validation it wraps is the real one. */
function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

const params = { runId: "instagram_run_render", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

describe("08-render-carousel: the three-way outcome mapping, never confused (RFC-03 §1/§3 step 08)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // Zero-held guarantee: an image file that vanished between vetting and
  // render used to be the last image-caused `WorkflowHeld` in the pipeline.
  // It is now caught by step 06f's on-disk pre-flight and degraded to a
  // typographic slide, so the post still ships.
  it("degrades a slide whose image file is missing on disk and still DELIVERS, rather than holding", async () => {
    const promptStore = makePromptStore();
    const copy = goodCopyOutput();
    // Every slide vets to a path that resolves under repoRoot but does not
    // actually exist on disk -- exactly the "well-formed path, missing file"
    // case `validateRenderInputs` classifies as CONTENT, never tooling.
    const vetting = {
      selections: copy.slides.map((s) => ({
        n: s.n,
        imagePath: "fixtures/images/does-not-exist.png",
        reason: "chosen",
        license: "CC0, test fixture",
        rightsUsable: true,
        watermarkFree: true,
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

    const steps = await durableStore.listSteps(params.runId);
    // The pre-flight is what caught it, upstream of the renderer.
    const gone = steps.find((s) => s.stepId === "06f-verify-images-on-disk-attempt-1")?.output as number[] | undefined;
    expect(gone).toEqual(copy.slides.map((s) => s.n));
    // And it flowed into the ordinary downgrade path, not a bespoke one.
    const downgrade = steps.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1")?.output as
      | { downgraded: number[]; reason: string }
      | undefined;
    expect(downgrade?.downgraded).toEqual(copy.slides.map((s) => s.n));
    expect(downgrade?.reason).toMatch(/no longer on disk/i);
    // Delivered, with no image attached to any slide.
    expect(steps.map((s) => s.stepId)).toContain("09b-deliver-and-log");
    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { slides: Array<{ images: Record<string, string> }> }
      | undefined;
    expect(slidesData?.slides.every((s) => Object.keys(s.images).length === 0)).toBe(true);
  }, 30000);

  it("maps a real TOOLING failure (a missing slide template file) to WorkflowToolingFailure, through the actual publish.renderCarousel tool", async () => {
    const promptStore = makePromptStore();
    const copy = goodCopyOutput();
    const vetting = {
      selections: copy.slides.map((s, i) => ({
        n: s.n,
        imagePath: goodImageCandidatePool()[i % 3]!.path,
        reason: "chosen",
        license: "CC0, test fixture",
        rightsUsable: true,
        watermarkFree: true,
      })),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(vetting)]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    // Re-seed the client config with a brand-tokens `slideTemplate` that does
    // not exist in the fixtures directory -- passes step 02's parse-check
    // (it's a well-formed string) but step 08's real render call cannot find
    // the file, which `validateRenderInputs` classifies as TOOLING, not content.
    await env.store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: goodStyleConfig(),
      instagramBrandTokens: goodBrandTokens({ slideTemplate: "does-not-exist.html" }),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_render_tooling" });

    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("unreachable");
    expect(result.failureReason).toMatch(/render step reported a tooling failure/i);
    expect(result.failureReason).toMatch(/not found/i);
  }, 30000);

  it("(tool-level, Chromium-free) canvas.scale !== 2 classifies as a TOOLING failure directly from publish.renderCarousel", async () => {
    const ctx: AgentContext = { runId: "direct_render_probe", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };
    const outcome = await env.tools["publish.renderCarousel"]!.execute(
      {
        client: "acme",
        postId: "post_1",
        templateDir: "fixtures/templates",
        outDir: "instagram-output/acme/post_1",
        repoRoot: env.repoRoot,
        slides: [{ n: 1, template: "slide.html", fields: {}, images: {} }],
        canvas: { w: 1080, h: 1440, scale: 1, slides_min: 6, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
      },
      { ctx },
    );

    expect(outcome.status).toBe("tooling_error");
    if (outcome.status !== "tooling_error") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/canvas\.scale must be exactly 2/i);
  });
});
