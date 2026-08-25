import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentToolRegistry } from "@agent-engine/core";
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
  isChromiumInstalled,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "instagram_run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

const HAPPY_PATH_STEP_IDS = [
  // Inline onboarding, ahead of the run proper.
  "00-auto-setup",
  "01-open-run",
  "02-freeze-style-config",
  // The client's own profile description + voice-rules guidelines,
  // best-effort — this is where a language requirement like Geektime's
  // "Hebrew-language technology site" actually lives.
  "02b-load-client-voice-context",
  // The client's Brand Kit (client/brand.json), best-effort — frozen once so
  // a portal edit mid-run can't change the tokens between attempts.
  "02c-load-brand-kit",
  "03-claim-topic",
  "04a-research-pull",
  "04b-research-extract-facts",
  // Resolves the run's template directory and which archetype files are in
  // it: materialized from the registry when one is configured, otherwise the
  // client's own templateDir probed for the bundled files. Either way a slide
  // routed to a file that is not there degrades instead of failing the run.
  "04c-resolve-templates",
  // The read side of the feedback flywheel: what this client asked for on
  // previous runs, injected into the drafting prompt.
  "04d-read-past-feedback",
  "05a-list-used-images",
  // Tier 0: the client's own uploads, resolved before any sourcing tier.
  "05z-attach-user-media",
  "05-write-copy-attempt-1",
  "06-vet-images-attempt-1",
  // Zero-held guarantee: confirms every selected image is still on disk, so a
  // file lost since vetting degrades that slide instead of failing the render.
  "06f-verify-images-on-disk-attempt-1",
  "07-self-check-attempt-1",
  "07b-craft-hygiene-attempt-1",
  "07c-emit-slides-data-attempt-1",
  "08-render-carousel-attempt-1",
  "08b-visual-qa-attempt-1",
  // Revision-scoped: `-r0` is the first review round. A `revise` decision
  // registers `-r1` after re-drafting.
  "09a-batch-review-r0",
  "09b-deliver-and-log",
];

function happyRouter() {
  return fakeRouterSequence([
    finalTurn(goodResearchOutput()),
    finalTurn(goodCopyOutput()),
    finalTurn(goodImageVettingOutput()),
    finalTurn(goodVisualQaOutput()),
  ]);
}

/**
 * Every test below EXCEPT the Chromium-gated one uses `fakeRenderCarousel`
 * for `publish.renderCarousel` — real path-guard/missing-file validation
 * (via the tool package's own exported `validateRenderInputs`), fake
 * Chromium. This matches `packages/tools/karos-publish`'s own package
 * tests' explicit choice to keep launching a real browser out of unit tests
 * (see `test-helpers.ts`'s own doc comment on `fakeRenderCarousel`).
 */
function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

describe("end-to-end: the 9-step Instagram agent workflow (RFC-03)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes all 9 (12 sub-)steps and delivers a carousel with a matching rendered PNG count", async () => {
    const promptStore = makePromptStore();
    const router = happyRouter();
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
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.slideCount).toBe(6);
    expect(result.output.renderedCount).toBe(6);
    expect(result.output.deliverableId).toBeTruthy();
    expect(router.complete).toHaveBeenCalledTimes(4);

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual([...HAPPY_PATH_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["instagram-carousel"]);

    // The reserved topic was actually committed at step 09b, not left dangling.
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.some((t) => t.status === "committed")).toBe(true);

    // Six real PNG files exist at the exact repo-relative output path this
    // workflow's own `assembleSlidesData` computed (no rogue rendering path,
    // RFC-03 §2.2) — not merely claimed by the tool's return value.
    const outDir = path.join(env.repoRoot, "instagram-output", "acme", params.runId);
    for (let n = 1; n <= 6; n++) {
      const stat = await fs.stat(path.join(outDir, `slide-${n}.png`));
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(0);
    }
  }, 60000);

  // Regression test for prep job hcf9ymPGJC7mDS5pcEQ4 (client Geektime,
  // "Israel's largest Hebrew-language technology... site"): the workflow
  // never called client.getProfile/getVoiceRules at all, so no language
  // signal from either ever reached the copy-writing prompt and the post
  // shipped in English regardless of what the client's own profile said.
  it("reads the client's profile description and voice-rules guidelines, and forwards them to the copy step", async () => {
    await env.store.writeJson("acme", ["client", "profile"], {
      name: "Acme",
      description: "Acme covers enterprise software for a Spanish-speaking audience and publishes exclusively in Spanish.",
    });
    await env.store.writeJson("acme", ["client", "voice-rules"], {
      guidelines: "Direct, no corporate jargon.",
    });

    const promptStore = makePromptStore();
    const router = happyRouter();
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

    const stepRecords = await durableStore.listSteps(params.runId);
    const voiceContextStep = stepRecords.find((s) => s.stepId === "02b-load-client-voice-context");
    expect(voiceContextStep?.output).toContain("publishes exclusively in Spanish");
    expect(voiceContextStep?.output).toContain("Direct, no corporate jargon.");

    // The copy-writing model call actually received it, not just the step
    // that read it — a plumbing gap between the two would look identical
    // from the step record alone.
    const copyCallArgs = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]!;
    const serializedInput = JSON.stringify(copyCallArgs);
    expect(serializedInput).toContain("publishes exclusively in Spanish");
  }, 60000);

  it("completes normally when the client has no profile or voice rules set up yet — best-effort, never blocking", async () => {
    // Neither client/profile nor client/voice-rules exists in this env
    // (setupTestEnvironment's withConfig only seeds instagramStyleConfig/
    // instagramBrandTokens) — the step must degrade to no context, not fail.
    const promptStore = makePromptStore();
    const router = happyRouter();
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

    const stepRecords = await durableStore.listSteps(params.runId);
    const voiceContextStep = stepRecords.find((s) => s.stepId === "02b-load-client-voice-context");
    expect(voiceContextStep?.status).toBe("completed");
    // `undefined` round-trips through the durable step store as `null` — the
    // step ran and found nothing, which is the correct, non-blocking outcome.
    expect(voiceContextStep?.output ?? undefined).toBeUndefined();
  }, 60000);

  it("pauses at the human batch-review gate by default, then resumes to completed on approval", async () => {
    const promptStore = makePromptStore();
    const router = happyRouter();
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, { ...params, runId: "instagram_run_gate" });
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("09a-batch-review");

    // Regression test for a real prep run (rWb2EutSDjHzkPnsoeEY) where a
    // reviewer approved a carousel they could not see: the gate payload
    // carried template metadata but never the drafted text or the rendered
    // images. `preview` and `images` are what the review panel actually reads.
    const pendingGate = await durableStore.getGate(first.pendingGateId);
    const payload = pendingGate?.payload as { preview?: string; images?: Array<{ n: number; url?: string }> } | undefined;
    expect(typeof payload?.preview).toBe("string");
    expect(payload?.preview!.length).toBeGreaterThan(0);
    expect(payload?.images).toBeDefined();
    expect(payload!.images!.length).toBeGreaterThan(0);
    expect(payload!.images![0]).toHaveProperty("url");

    const deliverablesBeforeApproval = await env.store.listJson("acme", ["ledger", "deliverables", "instagram_run_gate", "_"]);
    expect(deliverablesBeforeApproval).toHaveLength(0);

    await engine.resolveGate("instagram_run_gate", "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });

    const second = await engine.run(workflowFn, { ...params, runId: "instagram_run_gate" });
    expect(second.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(4);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "instagram_run_gate", "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["instagram-carousel"]);
  }, 60000);

  it("rejects the batch review with a reason -> held, and no deliverable ships", async () => {
    const promptStore = makePromptStore();
    const router = happyRouter();
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "instagram_run_gate_reject";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "not on brand this week",
      at: new Date().toISOString(),
    });

    const result = await engine.run(workflowFn, { ...params, runId });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    // `runReviewCycle` is generic across agents, so the wording is
    // "review rejected" rather than anything carousel-specific.
    expect(result.reason).toMatch(/review rejected/i);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect(deliverables).toHaveLength(0);
  }, 60000);

  // Skips itself when Chromium hasn't actually been downloaded for Playwright
  // in this environment (RFC-03 §5's documented "known gap": "playwright is
  // not installed... the render step will exit 2 until this is fixed") —
  // every test above already proves this workflow's own logic end to end via
  // `fakeRenderCarousel`; this one additionally proves the REAL
  // `publish.renderCarousel` tool (real Chromium, real screenshot) slots in
  // without any change to the workflow at all, whenever a real browser
  // binary happens to be available.
  it.skipIf(!isChromiumInstalled())("(real Chromium) renders and delivers using the actual publish.renderCarousel tool, unmodified", async () => {
    const promptStore = makePromptStore();
    const router = happyRouter();
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
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_real_chromium" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.renderedCount).toBe(6);

    const outDir = path.join(env.repoRoot, "instagram-output", "acme", "instagram_run_real_chromium");
    for (let n = 1; n <= 6; n++) {
      const stat = await fs.stat(path.join(outDir, `slide-${n}.png`));
      expect(stat.size).toBeGreaterThan(1000); // a real PNG screenshot, not the tiny 1x1 test fixture
    }
  }, 60000);
});
