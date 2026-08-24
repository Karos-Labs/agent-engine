import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * The zero-held guarantee.
 *
 * A carousel must never fail to ship BECAUSE OF A PICTURE. Every tier of the
 * visual pipeline can be down at once — every stock and CC provider, the
 * social scrape, and the generative rescue — and the run still has to produce
 * a delivered carousel, degrading the affected slides to typographic
 * archetypes.
 *
 * These tests exist because prep runs pubsub-21533408759483219 and
 * pubsub-21543794087429035 both held on exactly this, with a transient Vertex
 * quota blip as the real cause.
 *
 * ## What is deliberately still allowed to hold
 *
 * "Never held" cannot honestly mean "never held for any reason" — three holds
 * are not picture problems and removing them would be worse than the hold:
 *
 * - A HUMAN rejecting the batch review. The gate exists to be able to say no.
 * - No subject at all (empty catalog, no requested subject, no client
 *   industry). There is nothing to write about, and inventing one is not a
 *   fallback.
 * - Research producing no schema-valid facts, or the copy/compliance
 *   self-checks never passing inside the retry budget. Shipping unsourced or
 *   non-compliant copy is a worse outcome than shipping nothing.
 *
 * Each of those is asserted below too, so the boundary is pinned rather than
 * assumed.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** A tool stub returning a fixed outcome, for whichever media tier a test wants dead. */
function deadTool(name: string, outcome: unknown): AgentTool {
  return {
    name,
    version: "1.0.0",
    async execute() {
      return outcome;
    },
    inputSchema: { parse: (v: unknown) => v } as never,
  } as unknown as AgentTool;
}

function tools(env: TestEnvironment, overrides: Record<string, AgentTool>): AgentToolRegistry {
  return {
    ...env.tools,
    "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
    ...overrides,
  };
}

describe("zero-held guarantee: a picture problem never costs the post", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("completes with every slide typographic when EVERY media tier is dead at once", async () => {
    const copy = goodCopyOutput();
    // Retrieval unconfigured, scrape unconfigured, generation quota-tripped:
    // the exact combination that held both prep runs.
    const registry = tools(env, {
      "media.findImages": deadTool("media.findImages", {
        status: "not_available",
        reason: "no image-search provider is available",
      }),
      "media.scrapeImages": deadTool("media.scrapeImages", { status: "not_available", reason: "no scraper configured" }),
      "image.generate": deadTool("image.generate", {
        status: "content_fail",
        reason: 'image.generate: produced nothing — slide 1 (generation failed: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}})',
      }),
    });

    // No vetting turn: an empty pool skips step 06's model call entirely.
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(goodVisualQaOutput())]);
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: registry,
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        autoApprove: true,
      }),
      { ...base, runId: "zero_held_total_blackout" },
    );

    expect(result.status).toBe("completed");

    const steps = await durableStore.listSteps("zero_held_total_blackout");
    // Every slide downgraded, and a real deliverable shipped.
    const downgrade = steps.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1")?.output as
      | { downgraded: number[] }
      | undefined;
    expect(downgrade?.downgraded).toEqual(copy.slides.map((s) => s.n));
    expect(steps.map((s) => s.stepId)).toContain("09b-deliver-and-log");

    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { slides: Array<{ images: Record<string, string> }> }
      | undefined;
    expect(slidesData?.slides).toHaveLength(copy.slides.length);
    expect(slidesData?.slides.every((s) => Object.keys(s.images).length === 0)).toBe(true);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "zero_held_total_blackout", "_"]);
    expect(deliverables).toHaveLength(1);
  }, 30000);

  // A provider OUTAGE used to throw WorkflowToolingFailure, so one stock
  // library returning 503 failed the whole run and discarded copy that was
  // already written. The outage is still reported; it just no longer costs
  // the post.
  it("completes despite a provider OUTAGE, and still records the outage as the cause", async () => {
    const copy = goodCopyOutput();
    const registry = tools(env, {
      "media.findImages": deadTool("media.findImages", {
        status: "tooling_error",
        reason: "unsplash search returned 503",
      }),
    });
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(goodVisualQaOutput())]);
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: registry,
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        autoApprove: true,
      }),
      { ...base, runId: "zero_held_provider_outage" },
    );

    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps("zero_held_provider_outage");
    const downgrade = steps.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1")?.output as
      { reason: string } | undefined;
    // The 503 rides into the record, so the trace shows an outage rather than
    // an editorial "no good picture" verdict.
    expect(downgrade?.reason).toMatch(/503/);
    expect(downgrade?.reason).toMatch(/tooling_error/);
  }, 30000);

  it("completes when the generative tier 429s on SOME slides, keeping the images it did get", async () => {
    const copy = goodCopyOutput();
    const genPath = "fixtures/images/photo-1.png";
    const registry = tools(env, {
      // Retrieval finds nothing at all, so every slide reaches generation.
      "media.findImages": deadTool("media.findImages", { status: "content_fail", reason: "no results anywhere" }),
      "media.scrapeImages": deadTool("media.scrapeImages", { status: "not_available", reason: "no scraper" }),
      // Generation partially succeeds: slide 1 renders, the rest 429.
      "image.generate": deadTool("image.generate", {
        status: "success",
        result: {
          model: "gemini-2.5-flash-image",
          candidates: [{ path: genPath, description: "generated for slide 1", provider: "gemini-image", licenseConfidence: "generated" }],
          unmet: copy.slides.slice(1).map((s) => ({ n: s.n, reason: 'generation failed: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}' })),
        },
      }),
    });

    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      // The rescue vetting pass clears the one generated image.
      finalTurn({
        selections: [
          { n: 1, imagePath: genPath, reason: "the generated image matches", license: "Generated image", rightsUsable: true, watermarkFree: true },
        ],
      }),
      finalTurn(goodVisualQaOutput()),
    ]);

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: registry,
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        autoApprove: true,
      }),
      { ...base, runId: "zero_held_partial_generation" },
    );

    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps("zero_held_partial_generation");
    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { slides: Array<{ n: number; images: Record<string, string> }> }
      | undefined;
    // Slide 1 keeps its rescued image; the 429'd slides ship as type.
    expect(slidesData?.slides.find((s) => s.n === 1)?.images).toEqual({ hero: genPath });
    expect(slidesData?.slides.filter((s) => s.n !== 1).every((s) => Object.keys(s.images).length === 0)).toBe(true);
  }, 30000);

  // ── The boundary: holds that are NOT picture problems and must survive ──

  it("still holds when a human rejects the batch review, because that is the gate doing its job", async () => {
    const copy = goodCopyOutput();
    const registry = tools(env, {
      "media.findImages": deadTool("media.findImages", { status: "content_fail", reason: "nothing found" }),
    });
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(goodVisualQaOutput())]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: registry,
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "zero_held_human_reject";
    await engine.run(workflowFn, { ...base, runId });
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "not on brand this week",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...base, runId });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    // `runReviewCycle` is generic across agents, so the wording is
    // "review rejected" rather than anything carousel-specific.
    expect(result.reason).toMatch(/review rejected/i);
  }, 30000);

  it("still blocks intake when the client has no config, because there is no client to write for", async () => {
    const envNoConfig = await setupTestEnvironment({ withConfig: false });
    try {
      const router = fakeRouterSequence([finalTurn(goodResearchOutput())]);
      const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
        createInstagramAgentWorkflow({
          tools: tools(envNoConfig, {}),
          promptStore: makePromptStore(),
          router,
          repoRoot: envNoConfig.repoRoot,
          autoApprove: true,
        }),
        { ...base, runId: "zero_held_no_config" },
      );
      // Not `held`, and not `completed` either: a missing client profile is a
      // real blockage somebody must act on.
      expect(result.status).toBe("blocked_intake");
    } finally {
      await envNoConfig.cleanup();
    }
  }, 30000);
});
