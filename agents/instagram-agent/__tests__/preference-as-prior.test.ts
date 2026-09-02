import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import pathMod from "node:path";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine, varyLearnedStyle } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { applyIntents } from "../src/workflow/style-directive.js";
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
 * IGSTYLE-7 — "preference as prior, not pin" (§2.6): the end-to-end proof
 * that 7b (spend the variation budget on a low-confidence learned role) and
 * 7c (satisfy an intent even when its hex lost the distillation vote) really
 * compose through the workflow, not just in `varyLearnedStyle`/`applyIntents`
 * unit isolation (see `style-preferences.test.ts` and
 * `slides-data.test.ts`'s own 7a describe block for those). §7a's per-slide
 * ring wiring and §7d's honest-limit reporting are covered at the
 * `assembleSlidesData` level in `slides-data.test.ts` — this file is about
 * what reaches the RENDER and the GATE once real client feedback history is
 * involved.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** Ground #272A35 / fg #F4F2EC / ring [A5E82B, FF5B5F, 41C6FF] — the exact fixture `brand-render-tokens.test.ts`'s own `multiAccentBrand()` uses, so this file's expectations about the ring can be cross-checked against that one. */
const MULTI_ACCENT_BRAND = {
  accent: "#A5E82B",
  colors: {
    primaryAccent: "#A5E82B",
    secondaryAccent: "#FF5B5F",
    neutralDark: "#272A35",
    neutralLight: "#F4F2EC",
  },
  dominantColors: [
    { hex: "#272A35", dominanceRank: 1, role: "ground" },
    { hex: "#A5E82B", dominanceRank: 2, role: "accent" },
    { hex: "#41C6FF", dominanceRank: 3, role: "accent" },
  ],
  visualStyle: "Dark Mode",
};
const RING = ["#A5E82B", "#FF5B5F", "#41C6FF"];
const BASELINE_GROUND = "#272A35";
const BASELINE_FG = "#F4F2EC";

function tools(env: TestEnvironment): AgentToolRegistry {
  return {
    ...env.tools,
    "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
  } as AgentToolRegistry;
}

function draftTurns(copyOutput: ReturnType<typeof goodCopyOutput>) {
  return [finalTurn(copyOutput), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
}

describe("preference as prior, not pin (IGSTYLE-7, §7b/§7c end-to-end)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFn(router: ReturnType<typeof fakeRouterSequence>) {
    return createInstagramAgentWorkflow({
      tools: tools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });
  }

  it("7b: a weak learned accent (strength < 0.75) varies within the kit's own ring on revision 0, with no human input this run — reported in the gate's styleVariation", async () => {
    await env.store.writeJson("acme", ["client", "brand"], MULTI_ACCENT_BRAND);
    const append = env.tools["memory.appendFeedback"]!;
    const ctx: AgentContext = { runId: "seed", ...base, metadata: {} };
    // 2 structured votes for the anchor (#A5E82B), 1 for a competing ring
    // member (#FF5B5F): the anchor still wins (2 of 3), but only at ~0.67
    // strength — below VARIATION_THRESHOLD (0.75).
    for (const [i, hex] of ["#A5E82B", "#A5E82B", "#FF5B5F"].entries()) {
      await append.execute(
        {
          feedbackId: `seed-accent-${i}`,
          productId: "instagram-agent",
          decision: "approve",
          actor: "jane@karoslabs.com",
          note: "love the vibe",
          revision: 0,
          style: { overrides: { accent: hex }, source: "structured", intents: [], applied: [] },
        },
        { ctx },
      );
    }

    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy)]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "igstyle7_budget_accent";

    const r0 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    const learnedStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "02h-learned-style-preferences");
    const learned = learnedStep?.output as { overrides: Record<string, string>; strength: Record<string, number> };
    expect(learned.overrides.accent).toBe("#A5E82B");
    expect(learned.strength.accent).toBeLessThan(0.75);

    // What `assembleSlidesData` actually received this round — the
    // checkpointed `RenderCarouselInput`, before any rendering happens.
    const slidesStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "07c-emit-slides-data-attempt-1");
    const slidesData = slidesStep?.output as { slides: Array<{ fields: Record<string, string> }> };
    const usedAccents = new Set(slidesData.slides.map((s) => s.fields["accentColor"]));

    // Recompute the SAME expected departure independently (same seed —
    // `wf.runId` — and the SAME strength this run's own 02h just measured),
    // proving the wiring composes rather than merely "doing something."
    const { varied } = varyLearnedStyle({ accent: "#A5E82B" }, { accent: learned.strength.accent }, runId, { ring: RING });
    expect(varied.accent).not.toBe("#A5E82B");
    expect(usedAccents).toContain(varied.accent);
    // Never off-kit, whichever member it moved to.
    for (const hex of usedAccents) expect(RING).toContain(hex);

    const gate = await durableStore.getGate(`${runId}__09a-batch-review-r0`);
    const payload = gate?.payload as { styleVariation?: Array<{ role: string; prior: string; used: string }> };
    const accentVariation = payload.styleVariation?.find((v) => v.role === "accent");
    expect(accentVariation).toMatchObject({ role: "accent", prior: "#A5E82B", used: varied.accent });
  }, 60000);

  it("7c: an intent survives even when every one of its hexes individually lost the distillation vote — satisfied against Layer 0's own baseline, reported in styleVariation", async () => {
    await env.store.writeJson("acme", ["client", "brand"], MULTI_ACCENT_BRAND);
    const append = env.tools["memory.appendFeedback"]!;
    const ctx: AgentContext = { runId: "seed", ...base, metadata: {} };
    // Three DIFFERENT literal hexes for ground (as `shade()` would produce
    // against a slightly different baseline each time), each a lone `parsed`
    // pick (weight 0.5 < 1.0 — no single hex is individually promoted), but
    // the SAME intent — whose vote sums independently to 1.5, well over the
    // threshold. Exactly `distillStylePreferences`'s own rule-10 fixture.
    for (const [i, hex] of ["#111111", "#121212", "#131313"].entries()) {
      await append.execute(
        {
          feedbackId: `seed-ground-intent-${i}`,
          productId: "instagram-agent",
          decision: "approve",
          actor: "jane@karoslabs.com",
          note: "a bit darker please",
          revision: 0,
          style: { overrides: { ground: hex }, source: "parsed", intents: [{ role: "ground", direction: "darker" }], applied: [] },
        },
        { ctx },
      );
    }

    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy)]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "igstyle7_intent_satisfaction";

    const r0 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    const learnedStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "02h-learned-style-preferences");
    const learned = learnedStep?.output as { overrides: Record<string, string>; intents: Array<{ role: string; direction: string }> };
    // The hex genuinely lost — nothing was promoted for ground...
    expect(learned.overrides.ground).toBeUndefined();
    // ...but the direction survived (rule 10).
    expect(learned.intents).toEqual([{ role: "ground", direction: "darker" }]);

    // Independently recompute the expected satisfied hex against the SAME
    // baseline the workflow itself resolves 7c against (Layer 0's own
    // ground/fg/ring — never a previous round's already-adjusted colours).
    const expected = applyIntents([{ role: "ground", direction: "darker" }], { ground: BASELINE_GROUND, fg: BASELINE_FG, ring: RING });
    expect(expected.overrides.ground).toBeDefined();
    expect(expected.overrides.ground).not.toBe(BASELINE_GROUND);

    const templateHtml = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, "slide.html"), "utf8");
    expect(templateHtml).not.toContain(`--bg: ${BASELINE_GROUND};`);
    expect(templateHtml).toContain(`--bg: ${expected.overrides.ground};`);
    // fg was never touched by this intent — Layer 0's own value ships.
    expect(templateHtml).toContain(`--fg: ${BASELINE_FG};`);

    const gate = await durableStore.getGate(`${runId}__09a-batch-review-r0`);
    const payload = gate?.payload as { styleVariation?: Array<{ role: string; used: string; reason: string }> };
    const groundVariation = payload.styleVariation?.find((v) => v.role === "ground");
    expect(groundVariation?.used).toBe(expected.overrides.ground);
    expect(groundVariation?.reason).toContain("rule 10");
  }, 60000);

  it("in-run supremacy: this round's own explicit directive still outranks whatever the learned-preference budget would have varied to", async () => {
    // Deliberately a kit with NO other legible accent candidates (unlike
    // `MULTI_ACCENT_BRAND` above) — the ring stays one-colour throughout, so
    // 7a's own per-slide rotation (a SEPARATE, orthogonal axis of variation
    // this ticket also adds) cannot itself be the reason every slide agrees;
    // this test is isolating supremacy over the LEARNED BUDGET specifically.
    const NEUTRAL_ONLY_BRAND = { colors: { neutralDark: "#17181C", neutralLight: "#F2F2F2" }, visualStyle: "Dark Mode" };
    await env.store.writeJson("acme", ["client", "brand"], NEUTRAL_ONLY_BRAND);
    const append = env.tools["memory.appendFeedback"]!;
    const ctx: AgentContext = { runId: "seed", ...base, metadata: {} };
    // A weak learned accent that WOULD vary if nothing overrode it (same
    // shape as the 7b test above, just against a one-colour kit here).
    for (const [i, hex] of ["#A5E82B", "#A5E82B", "#FF5B5F"].entries()) {
      await append.execute(
        {
          feedbackId: `seed-accent-supremacy-${i}`,
          productId: "instagram-agent",
          decision: "approve",
          actor: "jane@karoslabs.com",
          note: "love the vibe",
          revision: 0,
          style: { overrides: { accent: hex }, source: "structured", intents: [], applied: [] },
        },
        { ctx },
      );
    }

    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy), ...draftTurns(copy)]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "igstyle7_in_run_supremacy";

    const r0 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    // A reviewer's own explicit, structured pick for THIS round.
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "use this exact accent instead",
      edits: { style: { accent: "#FFA500" } },
      at: new Date().toISOString(),
    });
    const r1 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r1.status).toBe("awaiting_gate");

    const slidesStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "07c-emit-slides-data-attempt-1-r1");
    const slidesData = slidesStep?.output as { slides: Array<{ fields: Record<string, string> }> };
    const usedAccents = new Set(slidesData.slides.map((s) => s.fields["accentColor"]));
    // Every slide uses the DIRECTIVE's accent — the budget never gets a say
    // once this round has an explicit, binding instruction of its own, and
    // the one-colour ring means 7a's rotation has nothing to walk either.
    expect(usedAccents).toEqual(new Set(["#FFA500"]));
  }, 90000);
});
