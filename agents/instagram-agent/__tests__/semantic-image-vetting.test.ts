import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentContext, AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { InstagramImageVettingAgent } from "../src/agent/instagram-image-vetting-agent.js";
import { ImageSelectionSchema, ImageVettingOutputSchema, MIN_CLAIM_MATCH, type ImageVettingOutput } from "../src/workflow/types.js";
import {
  PROMPTS_ROOT,
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns } from "./turns.js";

/**
 * Semantic image vetting (RFC-13 §F, `instagram-image-vet@3`).
 *
 * The audit's worst image defect: a client's photographs of one football
 * club's fans shipped under headlines about two other clubs, because v2
 * judged the OBJECTS `visualNeed` listed and never the slide's claim. v3
 * receives each slide's headline + body and returns `claimMatch` 1-5 per
 * selection; a selection needs 3+, and the workflow re-checks that floor
 * deterministically before anything renders.
 */

const params = { runId: "ig_semantic_vet", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
const ctx: AgentContext = { ...params, metadata: {} };

function testTools(env: TestEnvironment, extra: Record<string, AgentTool> = {}): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!), ...extra } as AgentToolRegistry;
}

describe("ImageSelectionSchema: claimMatch is required on every selection", () => {
  const base = goodImageVettingOutput().selections[0]!;

  it("rejects a selection without claimMatch / claimMatchReason — the v2 shape is no longer valid output", () => {
    const { claimMatch: _c, claimMatchReason: _r, ...v2Shape } = base;
    void _c;
    void _r;
    expect(ImageSelectionSchema.safeParse(v2Shape).success).toBe(false);
    expect(ImageSelectionSchema.safeParse({ ...base, claimMatchReason: "" }).success).toBe(false);
  });

  it("accepts 1..5 integers only", () => {
    for (const ok of [1, 2, 3, 4, 5]) expect(ImageSelectionSchema.safeParse({ ...base, claimMatch: ok }).success).toBe(true);
    for (const bad of [0, 6, 2.5, "3"]) expect(ImageSelectionSchema.safeParse({ ...base, claimMatch: bad }).success).toBe(false);
  });

  it("requires the score on a null selection too — an unfillable verdict still says how close the best candidate came", () => {
    const nullSelection = { ...base, imagePath: null, rightsUsable: false, watermarkFree: false, license: "n/a — no candidate qualified" };
    expect(ImageSelectionSchema.safeParse(nullSelection).success).toBe(true);
    const { claimMatch: _c, ...withoutScore } = nullSelection;
    void _c;
    expect(ImageSelectionSchema.safeParse(withoutScore).success).toBe(false);
  });

  it("MIN_CLAIM_MATCH is 3: compatible-and-generic is the floor for a selection", () => {
    expect(MIN_CLAIM_MATCH).toBe(3);
  });
});

describe("InstagramImageVettingAgent @3", () => {
  it("is pinned to instagram-image-vet@3, whose 3.md is byte-identical to latest.md and titled v3 with the two new sections", () => {
    const agent = new InstagramImageVettingAgent({ router: fakeRouterSequence([]), tools: {}, promptStore: makePromptStore() });
    expect((agent as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-image-vet@3");

    const v3 = readFileSync(path.join(PROMPTS_ROOT, "instagram-image-vet", "3.md"), "utf8");
    const latest = readFileSync(path.join(PROMPTS_ROOT, "instagram-image-vet", "latest.md"), "utf8");
    expect(v3).toBe(latest);
    expect(v3.split(/\r?\n/)[0]).toBe("# Instagram Image Vetting Craft Guide — v3");
    expect(v3).toMatch(/## 1b\. CLAIM MATCH/);
    expect(v3).toMatch(/## 6\. CLIENT PHOTOS/);
    expect(v3).toMatch(/\[client upload, slot N\]/);
    expect(v3).toMatch(/`claimMatch` of 3 or more/);
    // v2 stays frozen for the runs that were judged by it.
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-image-vet", "2.md"), "utf8").split(/\r?\n/)[0]).toBe("# Instagram Image Vetting Craft Guide — v2");
  });

  it("fails its own output validation (content_fail, never a crash) when the model omits claimMatch", async () => {
    const v2Output = { selections: goodImageVettingOutput().selections.map(({ claimMatch: _c, claimMatchReason: _r, ...rest }) => (void _c, void _r, rest)) };
    const router = fakeRouterSequence([finalTurn(v2Output)]);
    const agent = new InstagramImageVettingAgent({ router, tools: {}, promptStore: makePromptStore() });
    const exec = await agent.run(ctx, { slides: [], candidatePool: [], usedImages: [] });
    expect(exec.status).toBe("content_fail");
  });

  it("accepts claimMatch 3 as a valid selection", async () => {
    const output: ImageVettingOutput = { selections: goodImageVettingOutput().selections.map((s) => ({ ...s, claimMatch: 3, claimMatchReason: "generic desk scene, nothing contradicts the claim" })) };
    expect(ImageVettingOutputSchema.safeParse(output).success).toBe(true);
    const router = fakeRouterSequence([finalTurn(output)]);
    const agent = new InstagramImageVettingAgent({ router, tools: {}, promptStore: makePromptStore() });
    const exec = await agent.run(ctx, { slides: [], candidatePool: [], usedImages: [] });
    expect(exec.status).toBe("completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Workflow-level: the deterministic belt and the tier-0 re-offer. These use
// the Phase 0 step ids and turn order (`turns.ts`) and need the integrator's
// wiring of `isUnfillable`, the vet input, 05z's prefix and
// `slidesNeedingSource` (see WP0-5 integrationNotes).
// ─────────────────────────────────────────────────────────────────────────────

/** A `media.ingestAssets` stand-in — repo-relative paths, as the renderer's `assertInside` requires; the FILE is written by the test so 06f/08 find it. */
function stubIngestAssets(): AgentTool {
  return {
    name: "media.ingestAssets",
    version: "1.0.0",
    inputSchema: { parse: (v: unknown) => v } as never,
    async execute(args: unknown) {
      const assets = (args as { assets: Array<{ uri: string; label?: string; slot: number }> }).assets;
      return {
        status: "success",
        result: {
          candidates: assets.map((a) => ({
            path: `.media-cache/run/n${a.slot}-client.png`,
            description: `CLIENT-SUPPLIED asset uploaded with this run${a.label ? ` ("${a.label}")` : ""}: supporters in yellow and blue scarves outside a stadium at night. rights-cleared. [licence: client-supplied]`,
            provider: "client-upload",
            licenseConfidence: "client-supplied",
          })),
          unmet: [],
        },
      };
    },
  } as unknown as AgentTool;
}

/** A `media.findImages` stand-in that answers every requested need with a real fixture file and records what it was asked for. */
function stubFindImages(seen: { needs?: Array<{ n: number }> }): AgentTool {
  const pool = goodImageCandidatePool();
  return {
    name: "media.findImages",
    version: "1.0.0",
    inputSchema: { parse: (v: unknown) => v } as never,
    async execute(args: unknown) {
      const needs = (args as { needs: Array<{ n: number; query: string }> }).needs;
      seen.needs = needs;
      return {
        status: "success",
        result: { candidates: needs.map((need, i) => ({ path: pool[i % pool.length]!.path, description: `harvested for slide ${need.n}: ${pool[i % pool.length]!.description}` })), unmet: [] },
      };
    },
  } as unknown as AgentTool;
}

describe("workflow: claimMatch is re-checked deterministically", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a selection the vet scored claimMatch 2 ships text-only, with the downgrade reason quoting claimMatchReason", async () => {
    const vetting = goodImageVettingOutput();
    const slide2 = vetting.selections.find((s) => s.n === 2)!;
    slide2.claimMatch = 2;
    slide2.claimMatchReason = "the photograph shows Maccabi Tel Aviv supporters; the slide is about Juventus";
    const router = fakeRouterSequence(happyTurns({ vet: vetting }));
    const workflowFn = createInstagramAgentWorkflow({ tools: testTools(env), promptStore: makePromptStore(), router, repoRoot: env.repoRoot, imageCandidatePool: goodImageCandidatePool(), autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);
    expect(result.status).toBe("completed");

    const steps = await durableStore.listSteps(params.runId);
    const downgrade = steps.find((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1")?.output as { downgraded: number[]; reason: string } | undefined;
    expect(downgrade?.downgraded).toEqual([2]);
    expect(downgrade?.reason).toContain("Maccabi Tel Aviv supporters");
    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as { slides: Array<{ n: number; template: string; images: Record<string, string> }> };
    expect(slidesData.slides.find((s) => s.n === 2)?.images["hero"]).toBeUndefined();
    expect(slidesData.slides.find((s) => s.n === 1)?.images["hero"]).toBeDefined();
  });

  it("a claimMatch of exactly 3 is accepted — the floor is inclusive", async () => {
    const vetting: ImageVettingOutput = { selections: goodImageVettingOutput().selections.map((s) => ({ ...s, claimMatch: 3, claimMatchReason: "generic, nothing contradicts" })) };
    const router = fakeRouterSequence(happyTurns({ vet: vetting }));
    const workflowFn = createInstagramAgentWorkflow({ tools: testTools(env), promptStore: makePromptStore(), router, repoRoot: env.repoRoot, imageCandidatePool: goodImageCandidatePool(), autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId: "ig_semantic_vet_floor" });
    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps("ig_semantic_vet_floor");
    expect(steps.some((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1")).toBe(false);
  });
});

describe("workflow: a client upload serves the slide it fits", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
    // The ingest stub reports this path; the renderer and 06f need the file to exist.
    await fs.mkdir(path.join(env.repoRoot, ".media-cache", "run"), { recursive: true });
    await fs.copyFile(path.join(env.repoRoot, "fixtures", "images", "photo-1.png"), path.join(env.repoRoot, ".media-cache", "run", "n1-client.png"));
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("05z tags the upload `[client upload, slot 1]`, the harvesters are asked for slot 1 too, and the vet's move to slide 3 is what renders", async () => {
    const seen: { needs?: Array<{ n: number }> } = {};
    const copy = goodCopyOutput();
    const pool = goodImageCandidatePool();
    const vetting: ImageVettingOutput = {
      selections: copy.slides.map((s) => ({
        n: s.n,
        // The vet judged the upload against every slide and found slide 3's claim is what it shows.
        imagePath: s.n === 3 ? ".media-cache/run/n1-client.png" : pool[(s.n - 1) % pool.length]!.path,
        reason: s.n === 3 ? "the client's stadium photograph is the subject of slide 3's claim" : "harvested candidate matches the slide",
        license: s.n === 3 ? "client-owned asset" : "CC0, test fixture",
        rightsUsable: true,
        watermarkFree: true,
        claimMatch: s.n === 3 ? 5 : 4,
        claimMatchReason: s.n === 3 ? "shows exactly the supporters the slide names" : "same subject, one step of abstraction",
      })),
    };
    const router = fakeRouterSequence(happyTurns({ copy, vet: vetting }));
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env, { "media.ingestAssets": stubIngestAssets(), "media.findImages": stubFindImages(seen) }),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      autoApprove: true,
    });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId: "ig_semantic_vet_tier0", input: { mediaAssets: [{ uri: "gs://bucket/fans.jpg", role: "source", label: "match night" }] } });
    expect(result.status).toBe("completed");

    const steps = await durableStore.listSteps("ig_semantic_vet_tier0");
    const tier0 = steps.find((s) => s.stepId === "05z-attach-user-media")?.output as { candidates: Array<{ description: string }>; slots: number[] };
    expect(tier0.slots).toEqual([1]);
    expect(tier0.candidates[0]!.description.startsWith("[client upload, slot 1] ")).toBe(true);

    // Slot 1 is harvested for as well (mediaSource is not "client"): if the
    // vet moves the upload, slide 1 has alternatives instead of a forced
    // text-only downgrade.
    expect(seen.needs?.map((n) => n.n)).toContain(1);
    expect(seen.needs?.map((n) => n.n)).toContain(3);

    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as { slides: Array<{ n: number; images: Record<string, string> }> };
    expect(slidesData.slides.find((s) => s.n === 3)?.images["hero"]).toBe(".media-cache/run/n1-client.png");
    expect(slidesData.slides.find((s) => s.n === 1)?.images["hero"]).toBe(pool[0]!.path);
    expect(steps.some((s) => s.stepId === "07a-downgrade-unfillable-slides-attempt-1")).toBe(false);
  });

  it("mediaSource 'client' keeps today's behaviour: no harvester is asked, even for the slot the vet might move an upload off", async () => {
    const calls: string[] = [];
    const never = (name: string): AgentTool =>
      ({ name, version: "1.0.0", inputSchema: { parse: (v: unknown) => v } as never, async execute() { calls.push(name); return { status: "content_fail", reason: "must not be asked" }; } }) as unknown as AgentTool;
    const router = fakeRouterSequence(happyTurns());
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env, { "media.ingestAssets": stubIngestAssets(), "media.findImages": never("media.findImages"), "media.scrapeImages": never("media.scrapeImages"), "image.generate": never("image.generate") }),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      autoApprove: true,
    });
    const durableStore = new MemoryDurableStepStore();
    await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId: "ig_semantic_vet_client_only", input: { mediaSource: "client", mediaAssets: [{ uri: "gs://bucket/a.jpg" }] } });
    expect(calls).toEqual([]);
    const steps = await durableStore.listSteps("ig_semantic_vet_client_only");
    expect(steps.some((s) => /05b-source-images|06[bd]-(scrape|generate)-images/.test(s.stepId))).toBe(false);
  });
});
