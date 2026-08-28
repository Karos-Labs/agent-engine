import { describe, expect, it, afterEach } from "vitest";
import * as path from "node:path";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createKarosVideoTools, type ProcessResult } from "@agent-engine/tool-karos-video";
import { createAllKarosTools } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { createBrandedShortsAgentWorkflow } from "../src/workflow/create-branded-shorts-agent-workflow.js";
import {
  fakeElevenLabsFetch,
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
    expect(scriptsInvoked).toEqual(expect.arrayContaining(["cut_check.py", "build_short.py", "cutaway_check.py"]));

    const deliverables = await env.store.listJson(env.clientSlug, ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["branded-shorts-video"]);

    const decisions = await env.store.listJson(env.clientSlug, ["memory", "decisions"]);
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

  it("resolves to blocked_intake when the client has no locked brand style on file", async () => {
    env = await setupTestEnvironment({ withLockedStyle: false });
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "branded_shorts_run_no_style" });

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toContain("Style Exploration");
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
    // assets already known to be broken — video.assetsCheck runs at step 00a,
    // before intake (01) or the brand profile load (02).
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

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("DENSITY");
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
    // before ever calling build_short.py, not discover the problem via a failed gate.
    const buildCalls = env.runnerCalls.filter((c) => path.basename(c.args[0] ?? "") === "build_short.py");
    expect(buildCalls).toHaveLength(1);

    const stepIds = (await durableStore.listSteps("branded_shorts_run_bad_archetype")).map((s) => s.stepId);
    expect(stepIds).toContain("08a2-validate-archetypes-attempt-1");
    expect(stepIds).not.toContain("08b-render-and-gate-attempt-1");
    expect(stepIds).toContain("08b-render-and-gate-attempt-2");
  });

  it("resolves to held, never renders anything, when every attempt keeps using unapproved archetypes", async () => {
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

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("Confetti Pop");
    expect(env.runnerCalls.filter((c) => path.basename(c.args[0] ?? "") === "build_short.py")).toHaveLength(0);
  });

  it("surfaces build_short.py's caption-density warning in the final result, never silently dropping it (P0#3)", async () => {
    const withWarning = (finalMp4Path: string): Record<string, ProcessResult> => ({
      ...happyPathResponses(finalMp4Path),
      "build_short.py": {
        stdout: [
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
