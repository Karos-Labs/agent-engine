import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import pathMod from "node:path";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { invertedTemplateFileName } from "../src/workflow/slides-data.js";
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
 * IGSTYLE-10, §10a/10b/10c/10e — the end-to-end proof that ground/fg
 * inversion actually reaches materialized template files and the gate, not
 * just `decideGroundFgInversion`/`buildVariationPlan` unit isolation (see
 * `slides-data.test.ts`'s own IGSTYLE-10 describe blocks for those). §10d's
 * template-row axis is covered at the pure-function level only (see
 * `slides-data.test.ts`) — no test here wires it through the registry.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/**
 * Ground #17181C / fg #F4F2EC (the templates' own literal defaults, derived
 * here from real brand fields rather than left as the fallback) / accent
 * #C4552F — the templates' own documented legacy default accent, chosen
 * because it clears the 3:1 accent-ground floor against BOTH this ground AND
 * what becomes the ground once inverted (3.96:1 and 4.00:1 respectively —
 * verified independently, not assumed), so this fixture exercises the WALK
 * rather than the accent-contrast refusal (see the `thepitchbydeel`-style
 * fixture below for that). A single accent candidate — ring stays one-colour
 * throughout — so this run doubles as the "one-colour ring still inverts"
 * proof end to end, not only at the pure-function level.
 */
const INVERTIBLE_BRAND = {
  accent: "#C4552F",
  colors: { primaryAccent: "#C4552F", neutralDark: "#17181C", neutralLight: "#F4F2EC" },
  dominantColors: [{ hex: "#17181C", dominanceRank: 1, role: "ground" }],
  visualStyle: "Dark Mode",
};

function tools(env: TestEnvironment): AgentToolRegistry {
  return {
    ...env.tools,
    "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
  } as AgentToolRegistry;
}

function draftTurns(copyOutput: ReturnType<typeof goodCopyOutput>) {
  return [finalTurn(copyOutput), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
}

describe("ground/fg inversion, end to end (IGSTYLE-10, §10a/10b/10c/10e)", () => {
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

  it("materializes an inverted sibling template with ground/fg swapped, points the seeded slide at it, and reports it in the gate's variationPlan", async () => {
    await env.store.writeJson("acme", ["client", "brand"], INVERTIBLE_BRAND);
    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy)]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    // Verified empirically (see this ticket's own implementation notes): this
    // runId's seeded walk lands on slide 5 of 6 — one genuine alternate,
    // spread out, matching §10b's own "not a per-slide coin flip" shape.
    const runId = "igstyle10_ground_fg_inversion";

    const r0 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    const slidesStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "07c-emit-slides-data-attempt-1");
    const slidesData = slidesStep?.output as { slides: Array<{ n: number; template: string }> };
    const invertedFile = invertedTemplateFileName("slide.html");
    const invertedSlides = slidesData.slides.filter((s) => s.template === invertedFile);
    expect(invertedSlides.map((s) => s.n)).toEqual([5]);
    // Every other slide keeps the primary file, unchanged.
    for (const s of slidesData.slides) {
      if (s.n !== 5) expect(s.template).toBe("slide.html");
    }

    // The inverted file actually exists on disk, with the swap baked in —
    // not just named in the slide data.
    const primaryHtml = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, "slide.html"), "utf8");
    expect(primaryHtml).toContain("--bg: #17181C;");
    expect(primaryHtml).toContain("--fg: #F4F2EC;");
    const invertedHtml = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, invertedFile), "utf8");
    expect(invertedHtml).toContain("--bg: #F4F2EC;");
    expect(invertedHtml).toContain("--fg: #17181C;");
    // The inverted file is the SAME document plus one appended override — not
    // a second, divergently-authored copy: strip the extra `<style>` block
    // this materialization step alone adds and what's left is byte-identical
    // to the primary file.
    const appendedBlock = `<style>\n:root {\n  --bg: #F4F2EC;\n  --fg: #17181C;\n}\n</style>\n`;
    expect(invertedHtml.replace(appendedBlock, "")).toBe(primaryHtml);

    const gate = await durableStore.getGate(`${runId}__09a-batch-review-r0`);
    const payload = gate?.payload as { variationPlan?: Array<{ slide: number; axis: string; used: boolean; reason?: string }> };
    expect(payload.variationPlan).toBeDefined();
    const groundFgEntries = payload.variationPlan!.filter((e) => e.axis === "groundFg");
    expect(groundFgEntries).toHaveLength(6);
    expect(groundFgEntries.find((e) => e.slide === 5)?.used).toBe(true);
    expect(groundFgEntries.filter((e) => e.used)).toHaveLength(1);
    // The accent axis is reported too, honestly — a one-colour ring here.
    const accentEntries = payload.variationPlan!.filter((e) => e.axis === "accent");
    expect(accentEntries.every((e) => e.used === false && e.reason === "ring=1")).toBe(true);
  }, 60000);

  it("§10c-4 directive supremacy: a round with its own colour directive produces zero groundFg alternates, even on a seed that would otherwise invert", async () => {
    await env.store.writeJson("acme", ["client", "brand"], INVERTIBLE_BRAND);
    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy), ...draftTurns(copy)]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "igstyle10_ground_fg_inversion"; // same seed that inverted slide 5 above

    const r0 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "use this exact accent instead",
      edits: { style: { accent: "#0057B8" } },
      at: new Date().toISOString(),
    });
    const r1 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r1.status).toBe("awaiting_gate");

    const slidesStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "07c-emit-slides-data-attempt-1-r1");
    const slidesData = slidesStep?.output as { slides: Array<{ n: number; template: string }> };
    // Same seed that inverted slide 5 on revision 0 — this round's directive
    // suppresses it entirely, so every slide keeps the primary file.
    for (const s of slidesData.slides) expect(s.template, `slide ${s.n}`).toBe("slide.html");

    const gate = await durableStore.getGate(`${runId}__09a-batch-review-r1`);
    const payload = gate?.payload as { variationPlan?: Array<{ axis: string; used: boolean; reason?: string }> };
    const groundFgEntries = payload.variationPlan!.filter((e) => e.axis === "groundFg");
    expect(groundFgEntries.every((e) => e.used === false && e.reason === "directive-pinned")).toBe(true);
  }, 90000);
});
