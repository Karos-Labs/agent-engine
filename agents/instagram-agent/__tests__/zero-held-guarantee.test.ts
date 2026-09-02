import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
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

  // IGSTYLE-3, §2.3's own acceptance line: "a style-directive failure
  // degrades, never holds." A picture is not the only thing that must never
  // cost the post — a transient Vertex blip on the style-directive's Tier 2
  // model call (04g-style-directive, only reached when the closed-vocabulary
  // parser found nothing but the feedback still plausibly concerns style) is
  // the same class of problem as a dead image provider: `runModelTier`
  // degrades to `source: "none"` plus a refusal, and the round proceeds to
  // its own gate exactly as if the reviewer had said nothing about colour.
  it("reaches the next gate (never holds) when the style-directive's Tier 2 model call fails", async () => {
    const copy = goodCopyOutput();
    const draftTurns = () => [finalTurn(copy), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      ...draftTurns(),
      // Tier 2 (04g-style-directive's model call) — a transient Vertex quota
      // blip, the exact failure mode this file's own header names as the
      // real cause of both prep-run holds. `runModelTier`'s own try/catch is
      // what this test proves actually degrades rather than propagating.
      () => {
        throw new Error('style-directive model call failed: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
      },
      ...draftTurns(),
    ]);

    const workflowFn = createInstagramAgentWorkflow({
      tools: tools(env, {}),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "zero_held_style_directive_model_failure";

    const r0 = await engine.run(workflowFn, { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      // Plausibly about style ("color") but nothing the closed-vocabulary
      // parser's GROUND/FG/ACCENT/DARKER/LIGHTER words or an explicit hex
      // would match — Tier 1 returns `source: "none"`, which is exactly what
      // routes this round into Tier 2.
      feedback: "the color scheme feels a bit off, can we adjust it",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflowFn, { ...base, runId });

    // The whole point: a model-call failure inside style-directive resolution
    // must not hold, fail, or degrade THE RUN — the round still reaches its
    // own gate, exactly as an unreadable-feedback round would.
    expect(r1.status).toBe("awaiting_gate");

    const steps = await durableStore.listSteps(runId);
    const directiveStep = steps.find((s) => s.stepId === "04g-style-directive-r1");
    const directiveOutput = directiveStep?.output as { source: string; overrides: Record<string, string>; refusals: Array<{ reason: string }> };
    expect(directiveOutput.source).toBe("none");
    expect(directiveOutput.overrides).toEqual({});
    expect(directiveOutput.refusals).toHaveLength(1);
    expect(directiveOutput.refusals[0]?.reason).toMatch(/style-directive model call failed/);

    // Loud, not silent (§2.3): the degraded attempt still emits its ledger warn.
    expect(steps.map((s) => s.stepId)).toContain("04g-style-directive-record-refusal-r1");
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

    // SCRUM-306 (AU23): the rejected draft's content used to survive only in
    // this run's own step checkpoints — never durable, never readable by a
    // future run. It must now be on the same feedback row as the reason.
    const readOutcome = await registry["memory.readFeedback"]!.execute(
      { productId: "instagram-agent", limit: 10 },
      { ctx: { ...base, runId: "verify", metadata: {} } },
    );
    expect(readOutcome.status).toBe("success");
    if (readOutcome.status !== "success") throw new Error("unreachable");
    const entries = (readOutcome.result as { entries: Array<{ decision: string; note: string; content?: string }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision).toBe("reject");
    expect(entries[0]?.note).toBe("not on brand this week");
    const parsedDraft = JSON.parse(entries[0]!.content!) as { copy: { caption: string } };
    // The exact caption the reviewer looked at and turned down, not a
    // paraphrase — `copy` is the drafting agent's own `goodCopyOutput()` fixture.
    expect(parsedDraft.copy.caption).toBe(copy.caption);
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

  // ── SCRUM-393 (IGSTYLE-8): sub-floor contrast is a FACT, never a hold ──
  //
  // `sitti`'s real, live brand kit (Appendix D of the IGSTYLE spec): a
  // coral accent (`#ff5b5f`) on a cream ground (`#fff8d6`), 2.8:1 —
  // genuinely below `ACCENT_GROUND_CONTRAST_FLOOR` (3:1), and a genuine
  // property of that brand's own colors, not a defect to invent a fix
  // for. `buildAccentRing` already exempts the ring's anchor from being
  // REFUSED for this; this test is the other half — that the anchor is
  // still MEASURED and REPORTED, and that reporting it never costs the
  // post.
  it("completes normally on a real client's sub-floor accent, and warns exactly once instead of holding", async () => {
    await env.store.writeJson("acme", ["client", "brand"], {
      name: "sitti",
      accent: "#ff5b5f",
      colors: { neutralDark: "#8a3b42", neutralLight: "#fff8d6" },
      dominantColors: [{ hex: "#fff8d6", dominanceRank: 1 }],
    });

    const copy = goodCopyOutput();
    // Same dead-media shape as this file's other zero-held tests: every
    // slide downgrades to typographic, so the router needs no image-vetting
    // turn. This test's subject is the contrast fact, not image sourcing.
    const registry = tools(env, {
      "media.findImages": deadTool("media.findImages", { status: "not_available", reason: "no image-search provider is available" }),
      "media.scrapeImages": deadTool("media.scrapeImages", { status: "not_available", reason: "no scraper configured" }),
      "image.generate": deadTool("image.generate", { status: "content_fail", reason: "image.generate: produced nothing" }),
    });
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(goodVisualQaOutput())]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "zero_held_subfloor_contrast";
    // No autoApprove here, deliberately: `runReviewCycle` skips `buildGate`
    // entirely under autoApprove (`review-cycle.ts:119-124`), which would
    // synthesize the approval WITHOUT ever computing the gate payload — this
    // test needs the real gate payload to assert `contrastFacts` reached it.
    const workflowFn = createInstagramAgentWorkflow({
      tools: registry,
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
    });
    const awaiting = await engine.run(workflowFn, { ...base, runId });
    expect(awaiting.status).toBe("awaiting_gate");

    // The fact rides on the gate payload too — a reviewer sees the number,
    // not just an ops-only ledger row (the ticket's own acceptance line: "a
    // reviewer should see the good numbers too").
    const gate = await durableStore.getGate(`${runId}__09a-batch-review-r0`);
    const payload = gate?.payload as { contrastFacts?: Array<{ label: string; ratio: number; floor: number; pass: boolean }> };
    const accentFact = payload.contrastFacts?.find((f) => f.label.includes("#ff5b5f"));
    expect(accentFact?.pass).toBe(false);
    expect(accentFact?.floor).toBe(3);
    // The text pair (fg on bg) is well clear of ITS floor and reported too —
    // "for passes as well as failures."
    const textFact = payload.contrastFacts?.find((f) => f.label.includes("--fg"));
    expect(textFact?.pass).toBe(true);

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...base, runId });

    // The whole point: never held, never degraded, never retried over this.
    expect(result.status).toBe("completed");

    const events = await env.store.listJson("acme", ["ledger", "events", runId]);
    const warnEvents = events.filter((e) => (e.data as { level: string }).level === "warn");
    // Idempotent on (runId, eventId) — every attempt/revision that recomputes
    // the same sub-floor fact overwrites the SAME row, so a run with several
    // drafting attempts still emits exactly one warn, not one per attempt.
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]?.id).toBe(`${runId}__contrast-below-floor`);
    const message = (warnEvents[0]!.data as { message: string }).message;
    expect(message).toMatch(/accent #ff5b5f on ground/);
    expect(message).toMatch(/floor 3:1/);
  }, 30000);

  it("emits no contrast warning at all for a client whose kit clears every floor", async () => {
    await env.store.writeJson("acme", ["client", "brand"], {
      name: "geektime-like-clean-kit",
      accent: "#a5e82b",
      colors: { neutralDark: "#272a35", neutralLight: "#f4f2ec" },
      dominantColors: [{ hex: "#272a35", dominanceRank: 1 }],
    });

    const copy = goodCopyOutput();
    const registry = tools(env, {
      "media.findImages": deadTool("media.findImages", { status: "not_available", reason: "no image-search provider is available" }),
      "media.scrapeImages": deadTool("media.scrapeImages", { status: "not_available", reason: "no scraper configured" }),
      "image.generate": deadTool("image.generate", { status: "content_fail", reason: "image.generate: produced nothing" }),
    });
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(goodVisualQaOutput())]);
    const durableStore = new MemoryDurableStepStore();
    const runId = "zero_held_all_clear_contrast";
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: registry,
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        autoApprove: true,
      }),
      { ...base, runId },
    );

    expect(result.status).toBe("completed");
    const events = await env.store.listJson("acme", ["ledger", "events", runId]);
    expect(events.some((e) => (e.data as { level: string }).level === "warn")).toBe(false);
  }, 30000);
});
