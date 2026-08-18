import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext } from "@agent-engine/core";
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
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "instagram_run_render", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

describe("08-render-carousel: the three-way outcome mapping, never confused (RFC-03 §1/§3 step 08)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("maps a real CONTENT failure (an image file missing on disk at render time) to WorkflowHeld, through the actual publish.renderCarousel tool", async () => {
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
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(vetting)]);
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
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/render step reported a content failure/i);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("08-render-carousel-attempt-1");
    expect(stepIds).not.toContain("09b-deliver-and-log");
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
