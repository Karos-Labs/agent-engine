import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import pathMod from "node:path";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import {
  createInstagramAgentWorkflow,
  effectiveBrandKit,
} from "../src/workflow/create-instagram-agent-workflow.js";
import { deriveBrandRenderTokens, type BrandRenderTokens } from "../src/workflow/brand-render-tokens.js";
import type { BrandTokens } from "../src/workflow/types.js";
import {
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

/**
 * IGSTYLE-3 — active revision pipeline: the directive reaches the render.
 *
 * The literal invariant test (§3's own acceptance line) lives in this file:
 * a revise with "make the background darker and the text orange" must yield
 * a round-1 render whose `--bg`/`--fg` differ from round 0's. This module
 * has no field literally called `RenderCarouselInput.headFragment` — the
 * head fragment is spliced into the MATERIALIZED TEMPLATE FILE on disk
 * (`ensureTemplatesOnDisk`/`brandFragments`), which `publish.renderCarousel`
 * reads directly — so that materialized file's `:root` block is what these
 * tests read, exactly as `brand-kit.test.ts` already does for the
 * non-revision case.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** Ground/fg only, no ring member near orange — every "orange" resolution below exercises `resolveNamedColor`'s NAMED_COLORS fallback, not the kit-first path (both are covered by `style-directive.test.ts`; this file only cares that whichever hex comes back actually reaches the render). */
const PLAIN_BRAND = {
  name: "Plain Co",
  colors: { neutralDark: "#17181C", neutralLight: "#F2F2F2" },
  // `deriveGroundAndFg` needs a real signal (dominant-colour rank or a
  // lexical visualStyle match) to decide WHICH neutral is ground vs fg —
  // two valid hexes alone aren't enough (REFUSE — no signal, no override).
  // "Dark Mode" is the same lexical signal `brand-kit.test.ts`'s own
  // GEEKTIME_BRAND fixture uses.
  visualStyle: "Dark Mode",
};

function draftTurns(copyOutput: ReturnType<typeof goodCopyOutput>) {
  return [finalTurn(copyOutput), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
}

describe("effectiveBrandKit (IGSTYLE-3, §2.3) — pure, no checkpoint", () => {
  const brandTokens: BrandTokens = { templateDir: "fixtures/templates", slideTemplate: "slide.html" };
  const rawBrand = PLAIN_BRAND;
  const baseline = deriveBrandRenderTokens(rawBrand, brandTokens);

  it("returns the baseline verbatim when rawBrand is absent and both patches are empty", () => {
    const result = effectiveBrandKit(undefined, brandTokens, {}, {}, baseline);
    expect(result).toEqual({ kit: baseline, refusals: [] });
  });

  it("re-derives with the merged overrides when a directive patch is present", () => {
    // `deriveBrandRenderTokens`'s explicit path needs BOTH ground and fg —
    // a single-key patch alone falls through to derivation and changes
    // nothing, which is that function's own existing ladder, not something
    // this ticket touches.
    const result = effectiveBrandKit(rawBrand, brandTokens, {}, { ground: "#000000", fg: "#eeeeee" }, baseline);
    expect(result.refusals).toEqual([]);
    expect(result.kit?.cssVars["--bg"]).toBe("#000000");
    expect(result.kit?.cssVars["--fg"]).toBe("#eeeeee");
  });

  it("falls back to baseline and refuses when the merged overrides would drop a ground/fg pair the baseline had", () => {
    // Same hex for both roles collapses contrast to 1:1 — well under the
    // 4.5:1 floor `deriveBrandRenderTokens` itself enforces, so re-derivation
    // returns no ground/fg pair at all even though baseline had one.
    const result = effectiveBrandKit(rawBrand, brandTokens, {}, { ground: "#808080", fg: "#808080" }, baseline);
    expect(result.kit).toEqual(baseline);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({ role: "pair" });
  });

  it("is a true no-op (reference-equal) on the empty-patches path — never a needless re-derivation", () => {
    const result = effectiveBrandKit(undefined, brandTokens, {}, {}, baseline);
    expect(result.kit).toBe(baseline);
  });
});

describe("active revision palette: the directive reaches the render (IGSTYLE-3)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFn(router: ReturnType<typeof fakeRouterSequence>) {
    return createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });
  }

  it("revision 0 resolves the style directive to {} unconditionally — no directive, no refusal, byte-identical to a pre-IGSTYLE-3 run", async () => {
    await env.store.writeJson("acme", ["client", "brand"], PLAIN_BRAND);
    const workflowFnAuto = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router: fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(goodCopyOutput())]),
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
    const durableStore2 = new MemoryDurableStepStore();
    const runId2 = "igstyle3_revision0_unconditional_auto";
    const outcome = await new WorkflowEngine(durableStore2).run(workflowFnAuto, { ...base, runId: runId2 });
    expect(outcome.status).toBe("completed");

    const step = (await durableStore2.listSteps(runId2)).find((s) => s.stepId === "04g-style-directive");
    expect(step?.output).toEqual({ overrides: {}, applied: [], intents: [], refusals: [], source: "none" });
    // No refusal-recording step, since there was nothing to refuse.
    expect((await durableStore2.listSteps(runId2)).map((s) => s.stepId)).not.toContain("04g-style-directive-record-refusal");
  }, 30000);

  it("THE required invariant: a revise asking for a darker background and orange text changes --bg/--fg in the round-1 render", async () => {
    await env.store.writeJson("acme", ["client", "brand"], PLAIN_BRAND);
    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy), ...draftTurns(copy)]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "igstyle3_invariant";

    const r0 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    const round0Html = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, "slide.html"), "utf8");
    expect(round0Html).toContain("--bg: #17181C;");
    expect(round0Html).toContain("--fg: #F2F2F2;");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "make the background darker and the text orange",
      at: new Date().toISOString(),
    });
    const r1 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r1.status).toBe("awaiting_gate");

    const round1Html = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, "slide.html"), "utf8");
    // Different from round 0's own values — the actual acceptance line.
    expect(round1Html).not.toContain("--bg: #17181C;");
    expect(round1Html).not.toContain("--fg: #F2F2F2;");
    // And a real, resolved orange landed on --fg (kit has no ring member near
    // orange in this fixture, so the NAMED_COLORS fallback hex ships).
    expect(round1Html).toContain("--fg: #FFA500;");

    const directiveStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "04g-style-directive-r1");
    const directiveOutput = directiveStep?.output as { source: string; overrides: Record<string, string> };
    expect(directiveOutput.source).toBe("parsed");
    expect(directiveOutput.overrides.fg).toBe("#FFA500");
  }, 60000);

  it("edits.style on a revise outranks parsed free text (Tier 0 beats Tier 1)", async () => {
    await env.store.writeJson("acme", ["client", "brand"], PLAIN_BRAND);
    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy), ...draftTurns(copy)]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "igstyle3_structured_outranks_parsed";

    const r0 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      // Free text asks for orange; the structured pick says a different blue.
      // Structured wins. (#6699FF, not the primary #0000FF: against this
      // fixture's #17181C ground, pure blue's contrast ratio is only ~2.06 —
      // well under the 4.5:1 floor `finalize` enforces regardless of source,
      // which the sibling "a refused style directive..." test below already
      // covers on purpose. This test is about Tier 0 vs Tier 1 precedence, so
      // the structured pick must itself be a pair the floor actually allows.)
      feedback: "make the text orange",
      actor: "jane@karoslabs.com",
      edits: { style: { fg: "#6699FF" } },
      at: new Date().toISOString(),
    });
    const r1 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r1.status).toBe("awaiting_gate");

    const directiveStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "04g-style-directive-r1");
    const directiveOutput = directiveStep?.output as { source: string; overrides: Record<string, string>; intents: unknown[] };
    expect(directiveOutput.source).toBe("structured");
    expect(directiveOutput.overrides.fg).toBe("#6699FF");
    expect(directiveOutput.intents).toEqual([]);

    const round1Html = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, "slide.html"), "utf8");
    expect(round1Html).toContain("--fg: #6699FF;");
    expect(round1Html).not.toContain("--fg: #FFA500;");
  }, 60000);

  it("a refused style directive emits a ledger warn AND appears in the next gate payload as styleDirectiveOutcome — never silently dropped", async () => {
    await env.store.writeJson("acme", ["client", "brand"], PLAIN_BRAND);
    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy), ...draftTurns(copy)]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "igstyle3_refusal";

    const r0 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    // An explicit structured pick that collapses ground/fg to the SAME hex —
    // a real reviewer pick, still refused: contrast is a Tier 1 hard
    // constraint (§2.6), never overridden by a structured source.
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      feedback: "make it monochrome",
      actor: "jane@karoslabs.com",
      edits: { style: { ground: "#808080", fg: "#808080" } },
      at: new Date().toISOString(),
    });
    const r1 = await engine.run(workflowFn(router), { ...base, runId });
    expect(r1.status).toBe("awaiting_gate");

    // (1) the ledger warn.
    const events = await env.store.listJson<{ level: string; eventId: string; message: string }>("acme", [
      "ledger",
      "events",
      runId,
    ]);
    const refusalEvent = events.find((e) => e.data.eventId === `${runId}__style-directive-refused-r1`);
    expect(refusalEvent).toBeDefined();
    expect(refusalEvent?.data.level).toBe("warn");
    expect(refusalEvent?.data.message).toMatch(/4\.5/);

    // (2) styleDirectiveOutcome in the round-1 gate payload.
    const gate = await durableStore.getGate(`${runId}__09a-batch-review-r1`);
    const payload = gate?.payload as { styleDirectiveOutcome?: { refusals: Array<{ role: string }> } };
    expect(payload.styleDirectiveOutcome?.refusals.length).toBeGreaterThan(0);
    expect(payload.styleDirectiveOutcome?.refusals[0]?.role).toBe("pair");

    // The round-1 render still shipped — a refusal degrades to the baseline
    // kit, it never holds the run.
    await engine.resolveGate(runId, "09a-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn(router), { ...base, runId });
    expect(final.status).toBe("completed");
  }, 60000);
});
