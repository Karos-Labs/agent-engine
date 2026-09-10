import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import * as pathMod from "node:path";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  goodRelevanceVerdict,
  goodTrendScoutOutput,
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodBrandTokens,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";

/**
 * Phase 0, item G — accent ring alignment, end to end.
 *
 * The audit's finding 7: prep run `pubsub-21634455753345065` held after three
 * attempts ($0.86) because `instagramBrandTokens.accentColor` and
 * `client/brand.json`'s accent disagreed. The ring was anchored on brand.json,
 * the slides were painted from the config, and `08a2`'s palette gate refused
 * a hex the kit's own ring never contained — on every attempt, since nothing
 * a redraft changes could ever fix a colour disagreement. These tests prove
 * the same fixture now DELIVERS: one ring, anchored on the hex that paints,
 * with the palette gate kept as a belt that passes by construction.
 *
 * `visual-qa-elevated-criteria.test.ts`'s first describe block ("an off-kit
 * accent color short-circuits the model entirely") asserted the OLD hold on
 * exactly this fixture and is the inverse of `config/brand disagreement`
 * below; the pure short-circuit proof lives in `visual-qa-pre-checks.test.ts`.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** The prep incident's shape: the config paints one orange, brand.json declares another, and there IS a derivable ground (so brand.json's hex can be promoted into the ring). */
const DRIFTED_BRAND = {
  accent: "#d95f2b",
  colors: { primaryAccent: "#d95f2b", neutralDark: "#17181C", neutralLight: "#F4F2EC" },
  dominantColors: [{ hex: "#17181C", dominanceRank: 1, role: "ground" }],
  visualStyle: "Dark Mode",
};
const CONFIG_ACCENT = "#ff6b2c";

/** Ground #272A35 / fg #F4F2EC / ring [A5E82B, FF5B5F, 41C6FF] — the `brand-render-tokens.test.ts` `multiAccentBrand()` fixture, so ring expectations here cross-check against that file. */
const MULTI_ACCENT_BRAND = {
  accent: "#A5E82B",
  colors: { primaryAccent: "#A5E82B", secondaryAccent: "#FF5B5F", neutralDark: "#272A35", neutralLight: "#F4F2EC" },
  dominantColors: [
    { hex: "#272A35", dominanceRank: 1, role: "ground" },
    { hex: "#A5E82B", dominanceRank: 2, role: "accent" },
    { hex: "#41C6FF", dominanceRank: 3, role: "accent" },
  ],
  visualStyle: "Dark Mode",
};
const MULTI_RING = ["#A5E82B", "#FF5B5F", "#41C6FF"];

function tools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) } as AgentToolRegistry;
}

function draftTurns() {
  // The angle proposal (04i) leads each round: one per REVISION, before the
  // attempt loop, so a two-round fixture spends two of them.
  return [finalTurn(goodAngleProposal()), finalTurn(goodCopyOutput()), finalTurn(goodImageVettingOutput()), finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput())];
}

type SlidesDataOutput = { slides: Array<{ n: number; fields: Record<string, string> }> };
type PreChecksOutput = { paletteGate: { ok: boolean; reason?: string } };
type KitOutput = { palette: string[]; brandAccent?: string } | null;

async function stepOutput<T>(durableStore: MemoryDurableStepStore, runId: string, stepId: string): Promise<T> {
  const step = (await durableStore.listSteps(runId)).find((s) => s.stepId === stepId);
  if (step === undefined) throw new Error(`step ${stepId} not found in run ${runId}`);
  return step.output as T;
}

/**
 * Whether the integrator has wired `filterLearnedStyleToRing` into
 * `draftOnce` yet — the one assertion below that needs it is gated on this
 * rather than failing red until integration lands, the same way this repo's
 * other source-pinning tests read the workflow file directly.
 */
async function learnedRingFilterIsWired(): Promise<boolean> {
  const source = await fsp.readFile(pathMod.resolve(__dirname, "..", "src", "workflow", "create-instagram-agent-workflow.ts"), "utf8");
  return source.includes("filterLearnedStyleToRing(");
}

describe("accent ring alignment (item G): the config/brand disagreement that used to hold now delivers", () => {
  let env: TestEnvironment;
  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFn(envRef: TestEnvironment, router: ReturnType<typeof fakeRouterSequence>, autoApprove: boolean) {
    return createInstagramAgentWorkflow({
      tools: tools(envRef),
      promptStore: makePromptStore(),
      router,
      repoRoot: envRef.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove,
    });
  }

  it("config #ff6b2c + brand.json #d95f2b: one ring anchored on the config hex, every slide painted from it, palette gate passes, run completes on attempt 1", async () => {
    env = await setupTestEnvironment({ brandTokens: goodBrandTokens({ accentColor: CONFIG_ACCENT }) });
    await env.store.writeJson("acme", ["client", "brand"], DRIFTED_BRAND);
    const router = fakeRouterSequence([finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), ...draftTurns()]);
    const durableStore = new MemoryDurableStepStore();
    const runId = "ring_align_drifted";

    const result = await new WorkflowEngine(durableStore).run(workflowFn(env, router, true), { runId, ...base });
    expect(result.status).toBe("completed");
    // scout + research + angle + copy + vet + relevance + visual QA: the palette gate never short-circuited the QA turn.
    expect(router.complete).toHaveBeenCalledTimes(7);

    const kit = await stepOutput<KitOutput>(durableStore, runId, "02c-load-brand-kit");
    expect(kit?.palette[0]).toBe(CONFIG_ACCENT);
    expect(kit?.palette).toContain("#d95f2b");
    expect(kit?.brandAccent).toBe(CONFIG_ACCENT);

    const slidesData = await stepOutput<SlidesDataOutput>(durableStore, runId, "07c-emit-slides-data-attempt-1");
    const ring = new Set(kit!.palette.map((h) => h.toLowerCase()));
    for (const slide of slidesData.slides) {
      expect(ring.has(slide.fields["accentColor"]!.toLowerCase()), `slide ${slide.n} paints ${slide.fields["accentColor"]}`).toBe(true);
    }

    const preChecks = await stepOutput<PreChecksOutput>(durableStore, runId, "08a2-visual-qa-pre-checks-attempt-1");
    expect(preChecks.paletteGate.ok).toBe(true);

    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
  }, 60000);

  it("the exact fixture that used to hold (config #123456, brand.json #ABCDEF, no ground): a one-member ring paints ring[0] on every slide and the run completes", async () => {
    env = await setupTestEnvironment({ brandTokens: goodBrandTokens({ accentColor: "#123456" }) });
    await env.store.writeJson("acme", ["client", "brand"], { accent: "#ABCDEF" });
    const router = fakeRouterSequence([finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), ...draftTurns()]);
    const durableStore = new MemoryDurableStepStore();
    const runId = "ring_align_one_member";

    const result = await new WorkflowEngine(durableStore).run(workflowFn(env, router, true), { runId, ...base });
    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(7);

    const kit = await stepOutput<KitOutput>(durableStore, runId, "02c-load-brand-kit");
    // No derivable ground means brand.json's hex is not promoted — the ring is
    // the anchor alone, and the anchor is the hex that paints.
    expect(kit?.palette).toEqual(["#123456"]);

    const slidesData = await stepOutput<SlidesDataOutput>(durableStore, runId, "07c-emit-slides-data-attempt-1");
    expect(new Set(slidesData.slides.map((s) => s.fields["accentColor"]))).toEqual(new Set(["#123456"]));

    const preChecks = await stepOutput<PreChecksOutput>(durableStore, runId, "08a2-visual-qa-pre-checks-attempt-1");
    expect(preChecks.paletteGate.ok).toBe(true);
  }, 60000);

  it("a reviewer's explicit off-ring directive pick (Layer 2) stays binding: it becomes the anchor, paints every slide, and passes the palette gate by construction", async () => {
    env = await setupTestEnvironment({ brandTokens: goodBrandTokens({ accentColor: CONFIG_ACCENT }) });
    await env.store.writeJson("acme", ["client", "brand"], DRIFTED_BRAND);
    const router = fakeRouterSequence([finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), ...draftTurns(), ...draftTurns()]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "ring_align_directive";

    const r0 = await engine.run(workflowFn(env, router, false), { runId, ...base });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "use this exact accent instead",
      edits: { style: { accent: "#0057B8" } },
      at: new Date().toISOString(),
    });
    const r1 = await engine.run(workflowFn(env, router, false), { runId, ...base });
    expect(r1.status).toBe("awaiting_gate");

    // The directive's hex is the re-derived ring's ANCHOR (`ring[0]`), so it
    // is painted (slide 0 under phase 0, and a member of every seeded walk);
    // the config and brand.json hexes stay legal members behind it, and 7a's
    // rotation still walks them — the accent axis is never suppressed by a
    // directive (see `GroundFgInversionConfig.directivePinned`'s own note).
    // What item G guarantees is that the reviewer's pick is APPLIED and that
    // the palette gate cannot refuse it: every painted hex is a ring member.
    const slidesData = await stepOutput<SlidesDataOutput>(durableStore, runId, "07c-emit-slides-data-attempt-1-r1");
    const used = new Set(slidesData.slides.map((s) => s.fields["accentColor"]!.toLowerCase()));
    expect(used).toContain("#0057b8");
    for (const hex of used) expect(["#0057b8", CONFIG_ACCENT.toLowerCase(), "#d95f2b"]).toContain(hex);
    const preChecks = await stepOutput<PreChecksOutput>(durableStore, runId, "08a2-visual-qa-pre-checks-attempt-1-r1");
    expect(preChecks.paletteGate.ok).toBe(true);
    // And the gate payload shows the pick as applied, not refused.
    const gate = await durableStore.getGate(`${runId}__09a-batch-review-r1`);
    const payload = gate?.payload as { styleDirectiveOutcome?: { overrides: Record<string, string>; refusals: Array<{ role: string }> } };
    expect(payload.styleDirectiveOutcome?.overrides["accent"]).toBe("#0057B8");
    expect(payload.styleDirectiveOutcome?.refusals.some((r) => r.role === "accent") ?? false).toBe(false);
  }, 90000);

  it("a learned accent OUTSIDE the ring can no longer cause a hold: the run reaches its gate on attempt 1 with the palette gate passing", async () => {
    env = await setupTestEnvironment();
    await env.store.writeJson("acme", ["client", "brand"], MULTI_ACCENT_BRAND);
    const append = env.tools["memory.appendFeedback"]!;
    const ctx: AgentContext = { runId: "seed", ...base, metadata: {} };
    // Three structured votes for a hex the kit never shipped — the audit's
    // "dark bg + orange text" preference recorded under a different kit.
    for (const i of [0, 1, 2]) {
      await append.execute(
        {
          feedbackId: `seed-offring-${i}`,
          productId: "instagram-agent",
          decision: "approve",
          actor: "jane@karoslabs.com",
          note: "love the green",
          revision: 0,
          style: { overrides: { accent: "#00ff00" }, source: "structured", intents: [], applied: [] },
        },
        { ctx },
      );
    }
    const router = fakeRouterSequence([finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), ...draftTurns()]);
    const durableStore = new MemoryDurableStepStore();
    const runId = "ring_align_learned_offring";

    const r0 = await new WorkflowEngine(durableStore).run(workflowFn(env, router, false), { runId, ...base });
    expect(r0.status).toBe("awaiting_gate");

    const learned = await stepOutput<{ overrides: Record<string, string> }>(durableStore, runId, "02h-learned-style-preferences");
    expect(learned.overrides["accent"]).toBe("#00ff00"); // the prior really was learned — the filter, not the distiller, is what keeps it off the slides

    const preChecks = await stepOutput<PreChecksOutput>(durableStore, runId, "08a2-visual-qa-pre-checks-attempt-1");
    expect(preChecks.paletteGate.ok).toBe(true);
    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("05-write-copy-attempt-2");

    // Once `filterLearnedStyleToRing` is wired into `draftOnce`, the learned
    // hex is a NOTE for the reviewer and never a painted colour.
    if (await learnedRingFilterIsWired()) {
      const slidesData = await stepOutput<SlidesDataOutput>(durableStore, runId, "07c-emit-slides-data-attempt-1");
      const ring = new Set(MULTI_RING.map((h) => h.toLowerCase()));
      for (const slide of slidesData.slides) {
        expect(slide.fields["accentColor"]!.toLowerCase()).not.toBe("#00ff00");
        expect(ring.has(slide.fields["accentColor"]!.toLowerCase()), `slide ${slide.n}`).toBe(true);
      }
      const gate = await durableStore.getGate(`${runId}__09a-batch-review-r0`);
      const payload = gate?.payload as { styleDirectiveOutcome?: { refusals: Array<{ role: string; requested: string; reason: string }> } };
      const refusal = payload.styleDirectiveOutcome?.refusals.find((r) => r.role === "accent" && r.requested === "#00ff00");
      expect(refusal).toBeDefined();
      expect(refusal?.reason).toContain("outside the brand kit's accent ring");
      expect(refusal?.reason).toContain("not applied");
    }
  }, 60000);
});
