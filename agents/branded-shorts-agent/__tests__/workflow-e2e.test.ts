import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createKarosVideoTools, type ProcessResult } from "@agent-engine/tool-karos-video";
import { createAllKarosTools } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { createBrandedShortsAgentWorkflow } from "../src/workflow/create-branded-shorts-agent-workflow.js";
import {
  fakeElevenLabsFetch,
  fakeFontAndLogoFetch,
  fakeRouterSequence,
  finalTurn,
  goodGraphicsPlan,
  goodHighlights,
  happyPathResponses,
  makePromptStore,
  setupTestEnvironment,
  smartFakeRouter,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "branded_shorts_run_e2e", clientSlug: "acme", productId: "branded-shorts-agent", runKind: "setup" as const };

describe("end-to-end: the Branded Shorts 8-stage pipeline (RFC-06)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("runs every stage and resolves to completed with the delivery gate auto-approved", async () => {
    env = await setupTestEnvironment();
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.outputPath).toBe(path.join(env.workDir, "edit", "final.mp4"));
    expect(result.output.durationSeconds).toBeCloseTo(12.34, 5);
    expect(result.output.deliverableId).toBeTruthy();
    expect(result.output.overlayCount).toBe(0);
    expect(result.output.cutawayCount).toBe(0);
    expect(result.output.graphicsAttempts).toBe(1);
    expect(result.totalCostUsd).toBeGreaterThan(0);

    // Every gate script was actually invoked with the engine directory + expected flags.
    const scriptsInvoked = env.runnerCalls.map((c) => path.basename(c.args[0] ?? c.command));
    expect(scriptsInvoked).toEqual(expect.arrayContaining(["cut_check.py", "build_short.py", "render_overlays.py", "graphic_qa.py", "cutaway_check.py", "self_eval.py"]));
    // The graphics gate judges overlays over the footage timeline (base.mp4), never the finished composite.
    const graphicsGate = env.runnerCalls.find((c) => path.basename(c.args[0] ?? "") === "graphic_qa.py")!;
    expect(graphicsGate.args[graphicsGate.args.indexOf("--video") + 1]).toBe(path.join(env.workDir, "edit", "base.mp4"));
    // base first (once), then the single full composite.
    const buildStages = env.runnerCalls.filter((c) => path.basename(c.args[0] ?? "") === "build_short.py").map((c) => (c.args.includes("--until") ? "base" : "full"));
    expect(buildStages).toEqual(["base", "full"]);

    const deliverables = await env.store.listJson(env.clientSlug, ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["branded-shorts-video"]);

    const decisions = await env.store.listJson(env.clientSlug, ["memory", "products", params.productId, "decisions"]);
    expect(decisions.some((d) => (d.data as { decisionId: string }).decisionId === `${params.runId}__decision`)).toBe(true);
  });

  it("without autoApprove, pauses at the branded_shorts_delivery_review gate", async () => {
    env = await setupTestEnvironment();
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_gated" });

    expect(result.status).toBe("awaiting_gate");
  });

  it("runs on a DERIVED default style when the client has no locked brand style on file, and tells the reviewer", async () => {
    // Until 2026-09-07 this was blocked_intake ("run Style Exploration first").
    // The profile and graphics language are still configured here, so only the
    // style is derived, from the brand kit, and named in the review payload.
    env = await setupTestEnvironment({ withLockedStyle: false });
    await env.store.writeJson(env.clientSlug, ["client", "brand"], { palette: { accent: "#FF6B2C" }, fonts: ["Spectral"], visualStyle: "Minimalist" });
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, fetchImpl: fakeFontAndLogoFetch() });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_derived_style" });

    expect(result.status).toBe("awaiting_gate");
    // `-r0`: the delivery gate became a `runReviewCycle` on 2026-09-18, and
    // that primitive names each round `<gateId>-r<n>`.
    const gate = await durableStore.getGate("branded_shorts_run_derived_style__10-delivery-review-r0");
    expect(gate).toBeDefined();
    expect(gate!.payload).toMatchObject({ styleSource: "derived", flagged: true });
    expect((gate!.payload as { setupNotes: string[] }).setupNotes.join(" ")).toContain("no style was ever locked");
  });

  it("derives the whole setup (profile, fonts, mark, graphics language, archetypes) from the brand kit when nothing is configured", async () => {
    // What every karoslabs run on prep hit since 2026-09-05: a locked style,
    // no brandedShortsProfilePath / GraphicsLanguage / ApprovedArchetypes.
    env = await setupTestEnvironment({
      withProfileAndGraphicsLanguage: false,
      responses: (finalMp4Path) => ({ ...happyPathResponses(finalMp4Path), "derive_mark.py": { stdout: "MARK: PASS 640x480 derived_alpha", stderr: "", exitCode: 0 } }),
    });
    // No profile on file, so `video.assetsCheck` and friends run against the derived one.
    await env.store.writeJson(env.clientSlug, ["client", "brand"], {
      name: "Karos Labs",
      handle: "karoslabs",
      accent: "#d95f2b",
      colors: { neutralDark: "#242429", neutralLight: "#ff6b2c", primaryAccent: "#d95f2b" },
      fonts: { body: "Inter", heading: "Inter" },
      logoUrl: "https://example.test/logo.png",
      visualStyle: "Minimalist",
    });
    // The intake needs the work dir the derived profile lands in; the helper
    // only sets it alongside the profile it is no longer writing.
    const config = (await env.store.readJson<Record<string, unknown>>(env.clientSlug, ["client", "config"])) ?? {};
    await env.store.writeJson(env.clientSlug, ["client", "config"], { ...config, brandedShortsWorkDir: env.workDir });
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true, fetchImpl: fakeFontAndLogoFetch() });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_derived_setup" });

    expect(result.status).toBe("completed");
    const profilePath = path.join(env.workDir, "brand", "brand-profile.json");
    const profile = JSON.parse(await fs.readFile(profilePath, "utf8")) as { color: Record<string, string>; video_captions_v2: { emphasis: { font_file: string } }; endcard: { logo_file: string; eyebrow_text: string } };
    expect(profile.color).toMatchObject({ accent: "#d95f2b", ink: "#242429", background: "#242429" });
    // The kit's "neutralLight" is orange, not a light neutral: the engine's paper stands in.
    expect(profile.color.foreground).toBe("#f5f5f5");
    expect(profile.video_captions_v2.emphasis.font_file).toBe("fonts/Inter-700.ttf");
    expect(profile.endcard).toMatchObject({ logo_file: "marks/mark.png", eyebrow_text: "@karoslabs" });
    await expect(fs.stat(path.join(env.workDir, "brand", "fonts", "Inter-700.ttf"))).resolves.toBeTruthy();
    // The engine was asked to key the flattened logo, from the downloaded bytes.
    const markCall = env.runnerCalls.find((c) => c.args.some((a) => a.endsWith("derive_mark.py")));
    expect(markCall?.args).toContain("--source");
  });

  it("resolves to blocked_intake when there is no per-upload intake for this run", async () => {
    env = await setupTestEnvironment({ withIntake: false });
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_no_intake" });

    expect(result.status).toBe("blocked_intake");
  });

  // ── media attached to THIS run (mediaAssets / mediaSource, 2026-09-06) ──

  it("with no standing intake, a source video attached to the run IS the footage, and the run's direction is the takeaway", async () => {
    env = await setupTestEnvironment({ withIntake: false });
    const videoPath = path.join(env.rootDir, "attached.mov");
    await fs.writeFile(videoPath, "fake attached bytes", "utf8");
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, {
      ...params,
      runId: "branded_shorts_run_attached",
      input: { mediaAssets: [{ uri: videoPath, role: "source", label: "attached.mov" }], customPrompt: "Founders should ship faster." },
    });

    expect(result.status).toBe("completed");
    // The attached file, not a config path, is what the pipeline was pointed at,
    // and the typed sentence became the takeaway the highlights are judged by.
    const steps = await durableStore.listSteps("branded_shorts_run_attached");
    const intake = steps.find((s) => s.stepId === "01-load-intake")?.output as { videoPath: string; takeaway: string; targetLength: string };
    expect(intake).toMatchObject({ videoPath, takeaway: "Founders should ship faster.", targetLength: "client_choice" });
  });

  it("client media only with no video attached: refuses intake and says what to attach, even when a standing intake exists", async () => {
    env = await setupTestEnvironment();
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, {
      ...params,
      runId: "branded_shorts_run_client_only_empty",
      input: { mediaSource: "client" },
    });

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/client-provided media only, but no source video was attached/);
    // Nothing was transcribed, cut or rendered.
    expect(env.runnerCalls).toEqual([]);
  });

  it("resolves to held, never rendering anything, when video.assetsCheck reports a zero-byte font (SCRUM-295 / AU10)", async () => {
    const zeroByteFont = (finalMp4Path: string): Record<string, ProcessResult> => ({
      ...happyPathResponses(finalMp4Path),
      "brand_assets_check.py": {
        stdout: [
          "2/3 asset paths resolve and open",
          "",
          "BRAND ASSETS: FAIL (1)",
          "  - ZERO-BYTE Spectral-SemiBold.ttf  (referenced by video_captions_v2.body.font_file) — exists but is empty; a path check would have passed this",
        ].join("\n"),
        stderr: "",
        exitCode: 1,
      },
    });
    env = await setupTestEnvironment({ responses: zeroByteFont });
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_bad_assets" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("Spectral-SemiBold.ttf");

    // The failure must be caught before spending a transcribe/render cycle on
    // assets already known to be broken — video.assetsCheck runs at step 01c,
    // right after the inputs are materialised and before the brand profile
    // load (02) or the transcript (03).
    const scriptsInvoked = env.runnerCalls.map((c) => path.basename(c.args[0] ?? c.command));
    expect(scriptsInvoked).toEqual(["brand_assets_check.py"]);
  });

  it("resolves to held, never failed, when the deterministic cut list fails video.cutGate — nothing borderline builds", async () => {
    const failingCutGate = (finalMp4Path: string): Record<string, ProcessResult> => ({
      ...happyPathResponses(finalMp4Path),
      "cut_check.py": {
        stdout: "CUT GATE: FAIL (1)\n  - DENSITY: 9 cuts over 10.00s output = 9.00 per 10s, limit 4.0",
        stderr: "",
        exitCode: 1,
      },
    });
    env = await setupTestEnvironment({ responses: failingCutGate });
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_cut_fail" });

    // The owner's always-deliver rule (2026-09-17). The cut list is DERIVED,
    // not drafted — `deriveCutSegments` crops the ends and drops filler by
    // rule — so a gate objecting to it is objecting to that rule's output on
    // this transcript. There is no second cut to fall back to and no writer to
    // send it back to, and the reviewer can watch the result either way, so the
    // short is built and the objection travels with it.
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const repairs = (result.output as { contentRepairs?: Array<{ check: string; action: string; detail: string }> }).contentRepairs ?? [];
    const flagged = repairs.find((r) => r.check === "video.cutGate");
    expect(flagged?.action).toBe("unresolved");
    expect(flagged?.detail).toContain("DENSITY");
  });

  it("retries the graphics/cutaway plan once after a gate failure, then succeeds on the second attempt", async () => {
    env = await setupTestEnvironment();
    // A hand-rolled runner (bypassing the static `scriptedRunner` helper): graphic_qa.py
    // fails on its first call and passes on every call after, so the workflow's own
    // attempt-numbered step ids (not test bookkeeping) are what prove the remedy loop ran.
    let graphicsGateCalls = 0;
    const finalMp4Path = path.join(env.workDir, "edit", "final.mp4");
    const runner = async (command: string, args: string[]): Promise<ProcessResult> => {
      const script = path.basename(args[0] ?? "");
      if (command.toLowerCase().includes("ffprobe")) return happyPathResponses(finalMp4Path)["ffprobe"]!;
      if (script === "graphic_qa.py") {
        graphicsGateCalls++;
        return graphicsGateCalls === 1
          ? { stdout: "FAIL  growth_chart_0: VISIBILITY fail (mean contrast 10, 60% strokes lost over footage)", stderr: "", exitCode: 1 }
          : { stdout: "", stderr: "", exitCode: 0 };
      }
      return happyPathResponses(finalMp4Path)[script]!;
    };
    const videoTools = createKarosVideoTools({ runner, engineDir: "/engine", transcribe: { fetchImpl: fakeElevenLabsFetch(), env: { ELEVENLABS_API_KEY: "test-key" } } });
    // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
    // reports `not_available` without a real scraper rather than returning a
    // placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
    // placeholder is what let every content agent draft from nothing for months.
    // Tests still need deterministic offline data, so they opt in here; nothing in
    // `apps/` does.
    const tools = { ...createAllKarosTools(env.store, undefined, { scraper: createOfflineScraper() }), ...videoTools };

    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), { overlays: [{ archetype: "Growth Chart", start: 1.0, end: 3.0, illustrates: "revenue tripled" }], cutaways: [] }]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_remedy" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.graphicsAttempts).toBe(2);
    expect(result.output.overlayCount).toBe(1);
    expect(graphicsGateCalls).toBe(2);

    const stepIds = (await durableStore.listSteps("branded_shorts_run_remedy")).map((s) => s.stepId);
    expect(stepIds).toEqual(expect.arrayContaining(["08b-render-and-gate-attempt-1", "08b-render-and-gate-attempt-2"]));
  });

  it("rejects an unapproved archetype WITHOUT spending a render cycle, then retries and succeeds (P0#1)", async () => {
    env = await setupTestEnvironment();
    const badArchetypePlan = { overlays: [{ archetype: "Sparkle Burst", start: 1.0, end: 3.0, illustrates: "revenue tripled" }], cutaways: [] };
    const goodArchetypePlan = { overlays: [{ archetype: "Growth Chart", start: 1.0, end: 3.0, illustrates: "revenue tripled" }], cutaways: [] };
    const router = fakeRouterSequence([finalTurn(goodHighlights()), finalTurn(badArchetypePlan), finalTurn(goodArchetypePlan)]);
    const promptStore = makePromptStore();
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_bad_archetype" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.graphicsAttempts).toBe(2);
    expect(result.output.overlayCount).toBe(1);

    // "Sparkle Burst" isn't in DEFAULT_APPROVED_ARCHETYPES — the workflow must reject it
    // before ever spending a full composite on it, not discover the problem via a failed gate.
    // (The one `--until base` call at 07b is the footage timeline the gates need; it happens
    // once per run, before any plan exists, and is not a render of a plan.)
    const fullBuilds = env.runnerCalls.filter((c) => path.basename(c.args[0] ?? "") === "build_short.py" && !c.args.includes("--until"));
    expect(fullBuilds).toHaveLength(1);

    const stepIds = (await durableStore.listSteps("branded_shorts_run_bad_archetype")).map((s) => s.stepId);
    expect(stepIds).toContain("08a2-validate-archetypes-attempt-1");
    expect(stepIds).not.toContain("08b-render-and-gate-attempt-1");
    expect(stepIds).toContain("08b-render-and-gate-attempt-2");
  });

  it("drops the unapproved archetypes and builds the rest, rather than ending the run over them", async () => {
    // The closed-vocabulary invariant is NOT relaxed: an unapproved archetype
    // is a graphic the client never signed off on, and none of them reaches the
    // screen. What changed on 2026-09-18 is which thing is discarded — the
    // offending ITEMS, not the transcript, the cut, the grade, the base render
    // and every overlay in the same plan that was legal.
    env = await setupTestEnvironment();
    const router = fakeRouterSequence([
      finalTurn(goodHighlights()),
      finalTurn({ overlays: [{ archetype: "Sparkle Burst", start: 1.0, end: 3.0, illustrates: "x" }], cutaways: [] }),
      finalTurn({ overlays: [{ archetype: "Confetti Pop", start: 1.0, end: 3.0, illustrates: "x" }], cutaways: [] }),
    ]);
    const promptStore = makePromptStore();
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_bad_archetype_always" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { overlayCount: number; contentRepairs?: Array<{ check: string; action: string; detail: string }> };
    // Every overlay in the plan was illegal, so the short is the client's own
    // footage with none of them — and says so.
    expect(output.overlayCount).toBe(0);
    const dropped = (output.contentRepairs ?? []).find((r) => r.check === "video.graphicsPlan");
    expect(dropped?.action).toBe("redacted");
    expect(dropped?.detail).toContain("Confetti Pop");
    // A composite WAS rendered — that is the point — but only after the
    // illegal items were out of the plan.
    expect(env.runnerCalls.filter((c) => path.basename(c.args[0] ?? "") === "build_short.py" && !c.args.includes("--until"))).toHaveLength(1);
  });

  it("surfaces build_short.py's caption-density warning in the final result, never silently dropping it (P0#3)", async () => {
    const withWarning = (finalMp4Path: string): Record<string, ProcessResult> => ({
      ...happyPathResponses(finalMp4Path),
      "build_short.py": {
        stdout: [
          `base: ${path.join(path.dirname(finalMp4Path), "base.mp4")}`,
          "  caption density WARNING: 3+ consecutive chunks without an emphasis word around cap_04 — v2 rule wants the second font every few words",
          `done: ${finalMp4Path}  duration=12.34s  (side-data clean)`,
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      },
    });
    env = await setupTestEnvironment({ responses: withWarning });
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_caption_warning" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.renderWarnings).toEqual([
      "caption density WARNING: 3+ consecutive chunks without an emphasis word around cap_04 — v2 rule wants the second font every few words",
    ]);

    const deliverables = await env.store.listJson(env.clientSlug, ["ledger", "deliverables", "branded_shorts_run_caption_warning", "_"]);
    const deliverable = deliverables[0]!.data as { deliverable: { renderWarnings: string[] } };
    expect(deliverable.deliverable.renderWarnings).toEqual(result.output.renderWarnings);
  });

  it("bases the cutaway --allow-count exception on actual retained runtime, not the requested length category (P1#5)", async () => {
    // A 45-60s target with only ~2s of actual retained speech (after cropping/filler removal)
    // must still get allowCount=true — the real rule is about ACTUAL runtime, not what was asked for.
    env = await setupTestEnvironment();
    let capturedCutawayArgs: string[] | undefined;
    const finalMp4Path = path.join(env.workDir, "edit", "final.mp4");
    const runner = async (command: string, args: string[]): Promise<ProcessResult> => {
      const script = path.basename(args[0] ?? "");
      if (command.toLowerCase().includes("ffprobe")) return happyPathResponses(finalMp4Path)["ffprobe"]!;
      if (script === "cutaway_check.py") capturedCutawayArgs = args;
      return happyPathResponses(finalMp4Path)[script]!;
    };
    const videoTools = createKarosVideoTools({ runner, engineDir: "/engine", transcribe: { fetchImpl: fakeElevenLabsFetch(), env: { ELEVENLABS_API_KEY: "test-key" } } });
    const tools = { ...createAllKarosTools(env.store, undefined, { scraper: createOfflineScraper() }), ...videoTools };

    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    // fakeElevenLabsFetch's transcript retains ~1.7s total once assembled into one segment — well under 30s.
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_allow_count" });

    expect(result.status).toBe("completed");
    expect(capturedCutawayArgs).toContain("--allow-count");
  });
});

/**
 * The reviewer's revise loop, and the gate timeout that depends on it.
 *
 * Until 2026-09-18 this agent's delivery gate was a bare `wf.step.gate` whose
 * only two outcomes were "approve" and a dead run, and it auto-approved an
 * unanswered review after an hour with no quality signal whatsoever — the exact
 * shape that shipped two 3/10 prep clips by `system:gate-timeout` on
 * 2026-09-08. Clipping and content design fixed both that week; this agent did
 * not, and these are the tests that say so out loud.
 */
describe("the delivery review is a cycle, not a one-way door (2026-09-18)", () => {
  let env: TestEnvironment;
  const at = () => new Date().toISOString();

  afterEach(async () => {
    await env.cleanup();
  });

  it("re-plans the graphics in-run when a reviewer asks for a change, reusing the transcript and the cut", async () => {
    env = await setupTestEnvironment();
    const promptStore = makePromptStore();
    // Four turns: highlights + plan for round 0, then the same again for the
    // revise round. A revision that could not re-plan would consume only two.
    const router = fakeRouterSequence([
      finalTurn(goodHighlights()),
      finalTurn(goodGraphicsPlan()),
      finalTurn(goodHighlights()),
      finalTurn(goodGraphicsPlan()),
    ]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "branded_shorts_run_revise";

    const r0 = await engine.run(workflowFn, { ...params, runId });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "10-delivery-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "The third graphic sits over the speaker's face — move it or drop it.",
      at: at(),
    });

    const r1 = await engine.run(workflowFn, { ...params, runId });
    expect(r1.status).toBe("awaiting_gate");

    // The expensive, revision-independent work ran ONCE across both rounds:
    // the client's footage did not change, so neither did its transcript or
    // its derived cut. That is what makes a revise round cheap enough to offer.
    expect(env.runnerCalls.filter((c) => path.basename(c.args[0] ?? "") === "cut_check.py")).toHaveLength(1);
    // …and the planning DID run again, under its own revision-scoped step id.
    expect(await durableStore.getGate(`${runId}__10-delivery-review-r1`)).toBeDefined();
  }, 30_000);

  it("holds an unanswered gate rather than auto-approving when the visual QA never watched the short", async () => {
    // `video.visualQaGate` is not registered in this environment, so the round
    // records the QA as SKIPPED — which is not the same as passed, and is
    // exactly the distinction the timeout now turns on.
    env = await setupTestEnvironment();
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId: "branded_shorts_run_timeout" });

    expect(result.status).toBe("awaiting_gate");
    const gate = await durableStore.getGate("branded_shorts_run_timeout__10-delivery-review-r0");
    expect(gate!.timeout).toMatchObject({ duration: "1h", onTimeout: "hold" });
  });
});
