import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { CAMPAIGN_PLATE_FILE, type ProductCampaignReport } from "../src/workflow/product-campaign.js";
import {
  copyTurnInputs,
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodBrandTokens,
  goodCopyOutput,
  goodImageCandidatePool,
  goodResearchOutput,
  goodStyleConfig,
  goodTrendScoutOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns, standardTurns } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

/**
 * Stage 4 of the owner's reference-looks plan (approved 2026-09-24): a
 * requested PRODUCT CAMPAIGN is a picture-only carousel of full-bleed scenes,
 * each generated with the client's real product photo as a reference, and no
 * frame whose in-image words are misspelled ever ships. Without a product
 * photo the run delivers the normal carousel and says why.
 */

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5a80000000049454e44ae426082", "hex");

function stub(name: string, execute: (args: unknown) => Promise<unknown>): AgentTool {
  return { name, version: "1.0.0", inputSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) } as never, execute } as unknown as AgentTool;
}

/** What the fake vision pass reads on a generated frame: by the scene's slide number and the round it was drawn in. */
type SceneReader = (scene: number, round: number) => { textInImage: string[]; fitScore?: number };

const correctReader: SceneReader = (scene) => ({
  textInImage: scene === 3 ? ["SIGNATURE LACE", "Made to be seen"] : scene === 5 ? ["Signature Lace"] : scene === 1 ? ["SIGNATURE LACE"] : [],
  fitScore: 4,
});

interface Recorded {
  generate: Array<{ needs: Array<{ n: number; prompt: string; references?: Array<{ path: string; role: string }>; lettering?: string }> }>;
  ingested?: string[];
  /** Simulate the instance recycling right after a scene is staged: the local file is gone, only the bucket copy remains. */
  recycleAfterStage?: boolean;
}

function campaignTools(env: TestEnvironment, runId: string, reader: SceneReader, recorded: Recorded): AgentToolRegistry {
  const cache = path.join(env.repoRoot, ".media-cache", runId);
  return {
    ...env.tools,
    "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
    // The client's upload, ingested to a REAL file (the reference must be readable).
    "media.ingestAssets": stub("media.ingestAssets", async (args) => {
      await fs.mkdir(cache, { recursive: true });
      const assets = (args as { assets: Array<{ uri: string; slot: number; label?: string }> }).assets;
      const candidates = [];
      for (const a of assets) {
        recorded.ingested?.push(a.uri);
        const rel = `.media-cache/${runId}/n${a.slot}-client.png`;
        await fs.writeFile(path.join(env.repoRoot, rel), PNG);
        candidates.push({ path: rel, description: `slide ${a.slot} candidate -- CLIENT-SUPPLIED asset uploaded with this run${a.label ? ` ("${a.label}")` : ""}. [licence: client-supplied]`, provider: "client-upload", licenseConfidence: "client-supplied" });
      }
      return { status: "success", result: { candidates, unmet: [] } };
    }),
    "media.inspectImages": stub("media.inspectImages", async (args) => {
      const images = (args as { images: Array<{ ref: string; path?: string }> }).images;
      const inspections = images.map((image) => {
        const base = { ref: image.ref, description: "A glass perfume bottle labelled Signature Lace on a white background.", subjects: ["perfume bottle"], mood: "calm", quality: "usable", hasWatermark: false, looksLikeScreenshot: false };
        if (image.ref.startsWith("attached-") || image.ref.startsWith("product")) return { ...base, textInImage: ["SIGNATURE LACE"], fitScore: 5 };
        const need = Number(/n(\d+)-gen/.exec(image.path ?? "")?.[1]);
        const read = reader(need % 10, Math.floor((need % 100) / 10) + 1);
        return { ...base, description: "A generated advertising scene.", ...read };
      });
      if (images.some((i) => !i.ref.startsWith("attached-") && !i.ref.startsWith("product") && !i.ref.startsWith("scene-"))) {
        return { status: "content_fail", reason: "no vision backend in this fixture" };
      }
      return { status: "success", result: { inspections, unreadable: [], model: "fake" } };
    }),
    "image.generate": stub("image.generate", async (args) => {
      const input = args as Recorded["generate"][number];
      recorded.generate.push(input);
      await fs.mkdir(cache, { recursive: true });
      const candidates = [];
      for (const need of input.needs) {
        const rel = `.media-cache/${runId}/n${need.n}-gen0.png`;
        await fs.writeFile(path.join(env.repoRoot, rel), PNG);
        candidates.push({ path: rel, description: `slide ${need.n} candidate — generated`, provider: "gemini-image", licenseConfidence: "generated" });
      }
      return { status: "success", result: { candidates, unmet: [], model: "fake-image" } };
    }),
    "media.stageAsset": stub("media.stageAsset", async (args) => {
      const rel = (args as { path: string }).path;
      if (recorded.recycleAfterStage === true && /-gen0\.png$/.test(rel)) await fs.rm(path.join(env.repoRoot, rel), { force: true });
      return { status: "success", result: { gcsUri: `gs://media/agent-engine/${runId}/${path.basename(rel)}` } };
    }),
  } as unknown as AgentToolRegistry;
}

/** The packager turn for a campaign of `n` slides: alt text that describes each picture. */
function packagerTurn(n: number) {
  return finalTurn({
    hashtags: ["content", "founders", "pipeline", "editorial", "cadence"],
    altText: Array.from({ length: n }, (_, i) => ({ n: i + 1, alt: `A perfume bottle photographed in campaign scene ${i + 1}` })),
    firstCommentText: "The scenes of this campaign, in order.",
  });
}

async function runCampaign(env: TestEnvironment, runId: string, reader: SceneReader, scenesShipped: number, recorded: Recorded = { generate: [] }) {
  const router = fakeRouterSequence([
    ...standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy: goodCopyOutput() }),
    packagerTurn(scenesShipped),
  ]);
  const store = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(store);
  const workflowFn = createInstagramAgentWorkflow({ tools: campaignTools(env, runId, reader, recorded) as never, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true });
  const runParams = {
    runId,
    clientSlug: "acme",
    productId: "instagram-agent",
    runKind: "recurring" as const,
    input: { requestedMode: "product_campaign", mediaAssets: [{ uri: "gs://bucket/signature-lace.png", role: "source", label: "Signature Lace" }] },
  };
  const result = await engine.run(workflowFn, runParams);
  const steps = await store.listSteps(runId);
  const rows = await env.store.listJson<{ deliverable: Record<string, unknown> }>("acme", ["ledger", "deliverables", runId, "_"]);
  const deliverable = (rows[0] as unknown as { data: { deliverable: Record<string, unknown> } } | undefined)?.data.deliverable;
  return { result, steps, deliverable, recorded, router, rerun: () => engine.run(workflowFn, runParams) };
}

describe("the product campaign, end to end", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
    await env.store.writeJson("acme", ["client", "profile"], { name: "Hanky Panky" });
    await env.store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: goodStyleConfig(),
      instagramBrandTokens: goodBrandTokens(),
      instagramProductCampaign: { slogan: "Made to be seen" },
    });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("requested with a product photo: a carousel of full-bleed scenes, every one generated with the client's photo as a reference", async () => {
    const runId = "ig_campaign_ship";
    const { result, steps, deliverable, recorded, router } = await runCampaign(env, runId, correctReader, 6);
    expect(result.status).toBe("completed");
    const ids = steps.map((s) => s.stepId);

    const plan = steps.find((s) => s.stepId === "04q-plan-product-campaign")?.output as { active: boolean; productPhoto: { path: string; origin: string }; scenes: Array<{ id: string; lettering?: string }> };
    expect(plan.active).toBe(true);
    expect(plan.productPhoto.origin).toBe("client-upload");
    expect(plan.scenes.map((s) => s.id)).toEqual(["hero", "detail", "billboard", "lifestyle", "street-poster", "flat-lay"]);

    // Every scene is drawn ON the client's own photograph, and the two lettered
    // scenes are asked for the client's own words, exactly.
    expect(recorded.generate).toHaveLength(1);
    const needs = recorded.generate[0]!.needs;
    expect(needs).toHaveLength(6);
    for (const need of needs) expect(need.references).toEqual([{ path: plan.productPhoto.path, role: "product" }]);
    expect(needs.find((n) => n.n === 3)?.lettering).toBe("Made to be seen");
    expect(needs.find((n) => n.n === 5)?.lettering).toBe("Signature Lace");
    expect(needs.filter((n) => n.lettering !== undefined)).toHaveLength(2);

    // The campaign replaced the carousel's loop: a caption, the scenes, a render — and no carousel draft.
    for (const id of ["05pc-write-campaign-caption", "05pc-generate-scenes-round-1", "05pc-check-scenes-round-1", "05pc-stage-scenes", "08pc-render-campaign", "08c-package-post", "09b-deliver-and-log"]) {
      expect(ids, id).toContain(id);
    }
    expect(ids).not.toContain("05-write-copy-attempt-1");
    expect(ids).not.toContain("08-render-carousel-attempt-1");
    expect(ids).not.toContain("05pc-generate-scenes-round-2");
    // The writer was told, on its existing field, that the slides are pictures.
    expect(String(copyTurnInputs(router)[0]!["runDirection"])).toContain("PRODUCT CAMPAIGN");

    // The deliverable: six full-bleed plates over six verified scenes.
    const slides = deliverable!["slides"] as Array<{ template: string; images: Record<string, string>; fields: Record<string, string> }>;
    expect(slides).toHaveLength(6);
    expect(slides.every((s) => s.template === CAMPAIGN_PLATE_FILE && s.images["hero"]!.startsWith(`.media-cache/${runId}/n`))).toBe(true);
    expect(slides[2]!.fields["lettering"]).toBe("Made to be seen");
    const selections = deliverable!["selections"] as Array<{ rightsUsable: boolean; license: string }>;
    expect(selections.every((s) => s.rightsUsable && s.license.includes("Generated image") && s.license.includes("a photo the client uploaded"))).toBe(true);
    const report = deliverable!["productCampaign"] as ProductCampaignReport;
    expect(report.status).toBe("shipped");
    expect(report.requestedBy).toBe("run-input");
    expect(report.generated).toBe(6);
    expect(report.scenes?.every((s) => s.status === "shipped" && s.rounds === 1)).toBe(true);
    expect((deliverable!["rendered"] as unknown[]).length).toBe(6);
  });

  it("a frame whose lettering is misspelled is redrawn, and the misspelled frame is never shipped", async () => {
    const runId = "ig_campaign_redraw";
    const reader: SceneReader = (scene, round) =>
      scene === 3 && round === 1 ? { textInImage: ["SIGNATURE LACE", "Made to be sen"], fitScore: 4 } : correctReader(scene, round);
    const { result, steps, deliverable, recorded } = await runCampaign(env, runId, reader, 6);
    expect(result.status).toBe("completed");

    // Round 2 redraws ONLY the billboard, under a brief naming what went wrong.
    expect(recorded.generate).toHaveLength(2);
    const redraw = recorded.generate[1]!.needs;
    expect(redraw.map((n) => n.n)).toEqual([13]);
    expect(redraw[0]!.lettering).toBe("Made to be seen");
    expect(redraw[0]!.prompt).toContain('the lettering reads "SIGNATURE LACE Made to be sen", not "Made to be seen" letter for letter');
    expect(steps.map((s) => s.stepId)).toContain("05pc-check-scenes-round-2");

    const shippedImages = (deliverable!["slides"] as Array<{ images: Record<string, string> }>).map((s) => s.images["hero"]);
    expect(shippedImages).toContain(`.media-cache/${runId}/n13-gen0.png`);
    expect(shippedImages).not.toContain(`.media-cache/${runId}/n3-gen0.png`);
    const selected = (deliverable!["selections"] as Array<{ imagePath: string }>).map((s) => s.imagePath);
    expect(selected).not.toContain(`.media-cache/${runId}/n3-gen0.png`);
    const report = deliverable!["productCampaign"] as ProductCampaignReport;
    expect(report.scenes?.find((s) => s.id === "billboard")).toMatchObject({ status: "shipped", rounds: 2 });
    expect(report.generated).toBe(7);
  });

  it("a frame misspelled on every draw is DROPPED: the campaign ships without it rather than with a wrong word", async () => {
    const runId = "ig_campaign_drop";
    const reader: SceneReader = (scene, round) => (scene === 3 ? { textInImage: ["Made to be seeen"], fitScore: 4 } : correctReader(scene, round));
    const { result, deliverable } = await runCampaign(env, runId, reader, 5);
    expect(result.status).toBe("completed");
    const slides = deliverable!["slides"] as Array<{ images: Record<string, string>; fields: Record<string, string> }>;
    expect(slides).toHaveLength(5);
    expect(slides.some((s) => s.fields["sceneLabel"] === "billboard")).toBe(false);
    expect(slides.map((s) => s.images["hero"])).not.toContain(`.media-cache/${runId}/n3-gen0.png`);
    expect(slides.map((s) => s.images["hero"])).not.toContain(`.media-cache/${runId}/n13-gen0.png`);
    const report = deliverable!["productCampaign"] as ProductCampaignReport;
    const billboard = report.scenes?.find((s) => s.id === "billboard");
    expect(billboard?.status).toBe("dropped");
    expect(billboard?.reasons.join(" ")).toContain('not "Made to be seen" letter for letter');
  });
});

describe("the product campaign survives a resume and an instance recycle", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
    await env.store.writeJson("acme", ["client", "profile"], { name: "Hanky Panky" });
    await env.store.writeJson("acme", ["client", "config"], { instagramStyleConfig: goodStyleConfig(), instagramBrandTokens: goodBrandTokens(), instagramProductCampaign: { slogan: "Made to be seen" } });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a resumed run replays every campaign step: no scene is drawn or read back twice, and the output is identical", async () => {
    const { result, recorded, router, rerun } = await runCampaign(env, "ig_campaign_resume", correctReader, 6);
    expect(result.status).toBe("completed");
    const turns = (router.complete as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const second = await rerun();
    expect(second.status).toBe("completed");
    if (result.status !== "completed" || second.status !== "completed") throw new Error("unreachable");
    expect(second.output).toEqual(result.output);
    expect(recorded.generate).toHaveLength(1);
    expect((router.complete as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(turns);
  });

  it("scenes lost with the instance are re-fetched from the media bucket before the render, and the campaign still ships every scene", async () => {
    const runId = "ig_campaign_recycle";
    const recorded: Recorded = { generate: [], ingested: [], recycleAfterStage: true };
    const { result, deliverable } = await runCampaign(env, runId, correctReader, 6, recorded);
    expect(result.status).toBe("completed");
    // Six re-fetches from the bucket, one per staged scene.
    expect(recorded.ingested!.filter((u) => u.startsWith(`gs://media/agent-engine/${runId}/`))).toHaveLength(6);
    const slides = deliverable!["slides"] as Array<{ images: Record<string, string> }>;
    expect(slides).toHaveLength(6);
    for (const slide of slides) {
      const rel = slide.images["hero"]!;
      await expect(fs.access(path.join(env.repoRoot, rel)), `${rel} must be on disk`).resolves.toBeUndefined();
      // Never the client's own upload path: a recovered scene lands on its own slot.
      expect(rel).not.toBe(`.media-cache/${runId}/n1-client.png`);
    }
    expect((deliverable!["productCampaign"] as ProductCampaignReport).status).toBe("shipped");
  });
});

describe("the product campaign, when it cannot run", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("configured for a client with no product photo: the normal carousel ships, with the reason recorded — never a hold", async () => {
    // The config road (`instagramPostModes`), the one news mode already uses.
    await env.store.writeJson("acme", ["client", "config"], { instagramStyleConfig: goodStyleConfig(), instagramBrandTokens: goodBrandTokens(), instagramPostModes: ["product_campaign"] });
    const runId = "ig_campaign_no_photo";
    const store = new MemoryDurableStepStore();
    // A deployment that CAN generate and read back: the only thing missing is the product photo.
    const recorded: Recorded = { generate: [] };
    const result = await new WorkflowEngine(store).run(
      createInstagramAgentWorkflow({
        tools: campaignTools(env, runId, correctReader, recorded) as never,
        promptStore: makePromptStore(),
        router: fakeRouterSequence(happyTurns()),
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" },
    );
    expect(result.status).toBe("completed");
    const steps = await store.listSteps(runId);
    const ids = steps.map((s) => s.stepId);
    expect((steps.find((s) => s.stepId === "01-open-run")?.output as { productCampaign?: { requestedBy: string } }).productCampaign).toEqual({ requestedBy: "client-config" });
    const plan = steps.find((s) => s.stepId === "04q-plan-product-campaign")?.output as { active: boolean; reason: string };
    expect(plan.active).toBe(false);
    expect(plan.reason).toContain("no product photo");
    // The normal carousel: written, sourced, rendered.
    expect(ids).toContain("05-write-copy-attempt-1");
    expect(ids).toContain("08-render-carousel-attempt-1");
    expect(ids.some((id) => id.startsWith("05pc-") || id.startsWith("08pc-"))).toBe(false);
    // Nothing was generated on a product that is not there.
    expect(recorded.generate.flatMap((g) => g.needs).some((n) => n.references !== undefined)).toBe(false);
    const rows = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    const deliverable = (rows[0] as unknown as { data: { deliverable: Record<string, unknown> } }).data.deliverable;
    expect(deliverable["productCampaign"]).toMatchObject({ status: "fell-back", requestedBy: "client-config" });
    expect(String((deliverable["productCampaign"] as ProductCampaignReport).reason)).toContain("no product photo");
  });

  it("a run that did not ask never plans a campaign (the premise)", async () => {
    const runId = "ig_campaign_not_asked";
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(
      createInstagramAgentWorkflow({
        tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) } as never,
        promptStore: makePromptStore(),
        router: fakeRouterSequence(happyTurns()),
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" },
    );
    expect(result.status).toBe("completed");
    const steps = await store.listSteps(runId);
    expect(steps.some((s) => s.stepId === "04q-plan-product-campaign")).toBe(false);
    expect((steps.find((s) => s.stepId === "01-open-run")?.output as Record<string, unknown>)["productCampaign"]).toBeUndefined();
    const rows = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect((rows[0] as unknown as { data: { deliverable: Record<string, unknown> } }).data.deliverable["productCampaign"]).toBeUndefined();
  });
});
