import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { CLIENT_SITE_LICENCE, createMediaLibraryTools, type MediaLibraryEntry } from "@agent-engine/tool-karos-media";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  goodCopyOutput,
  goodResearchOutput,
  goodTrendScoutOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { standardTurns } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import {
  buildClientSiteLibraryEntry,
  CLIENT_SITE_HARVEST_CAP,
  CLIENT_SITE_RIGHTS_SOURCE,
  CLIENT_SITE_STOCK_TARGET,
  CLIENT_UPLOAD_RIGHTS,
  clientSiteRights,
  describeLibraryCandidate,
  isClientOwnedFrame,
  isClientSiteFrame,
  libraryRightsSentence,
  planClientSiteHarvest,
  selectLibraryCandidates,
} from "../src/workflow/media-library.js";
import { licenceClassFor } from "../src/workflow/entity-imagery.js";

/**
 * 2026-09-24 — the client's OWN website stocks the media library.
 *
 * Hanky Panky (a lingerie brand) shipped a carousel with ZERO pictures on
 * 2026-09-23. The writer named its product "Signature Lace"; no licensed
 * picture of it existed anywhere except on the client's own website; and stock
 * lace was, correctly, refused by the image vet as an unnamed subject for a
 * slide that names one. The fix is generic: every client with a website gets
 * pictures of its own products, filed once in its media library and reused.
 *
 * Three properties matter and each is pinned here:
 *
 * 1. **The rights read as the client's own.** A site picture is described to
 *    the vet under the `[client library, …]` prefix its §6 rule already knows
 *    (client-owned, `blanket`, rights-usable), with an honest sentence saying
 *    it came from the client's website — no prompt change needed.
 * 2. **The product NAME reaches the vet.** The vision model sees "a black lace
 *    thong"; the client's page calls it "Signature Lace Original Rise Thong".
 *    Only the second can match a slide that names the product.
 * 3. **The site is read once, not every run.** Harvesting stops while the
 *    library holds enough OFFERABLE site frames, and a picture already filed
 *    is never downloaded or described again.
 */

const SITE_ENTRY_BASE: MediaLibraryEntry = {
  assetId: "site000000000000",
  sha256: "s".repeat(64),
  gcsUri: "https://cdn.shop.test/files/signature-lace-thong_1080x.jpg",
  contentType: "image/jpeg",
  bytes: 100,
  addedAt: "2026-09-24T00:00:00.000Z",
  addedByRunId: "ig_site",
  rights: clientSiteRights("https://hankypanky.test/products/original-rise-thong"),
  description:
    'A model wearing a black lace thong against a plain backdrop. Published on the client\'s own website on the page "Original Rise Thong | Hanky Panky", where the client captions it "Signature Lace Original Rise Thong".',
  subjects: ["Signature Lace Original Rise Thong", "black lace thong"],
  textInImage: [],
  mood: "intimate",
  inspectedByToolVersion: "1.2.0",
  sceneTags: [],
  knownPaths: [".media-cache/ig_site/n1-abc.jpg"],
  usedIn: [],
};

function siteEntry(i: number, overrides: Partial<MediaLibraryEntry> = {}): MediaLibraryEntry {
  return { ...SITE_ENTRY_BASE, assetId: `site${String(i).padStart(12, "0")}`, gcsUri: `https://cdn.shop.test/files/p${i}.jpg`, knownPaths: [`.media-cache/ig_site/n${i}-x.jpg`], ...overrides };
}

describe("client-site frames — rights and description", () => {
  it("are the client's own frames, and say so honestly", () => {
    expect(SITE_ENTRY_BASE.rights.source).toBe(CLIENT_SITE_RIGHTS_SOURCE);
    expect(isClientSiteFrame(SITE_ENTRY_BASE)).toBe(true);
    expect(isClientOwnedFrame(SITE_ENTRY_BASE)).toBe(true);
    expect(isClientSiteFrame({ rights: CLIENT_UPLOAD_RIGHTS })).toBe(false);
    expect(isClientOwnedFrame({ rights: CLIENT_UPLOAD_RIGHTS })).toBe(true);
    expect(isClientOwnedFrame({ rights: { source: "unsplash", licence: "Unsplash licence" } })).toBe(false);

    const sentence = libraryRightsSentence(SITE_ENTRY_BASE);
    expect(sentence).toContain("publishes this image on its own website");
    expect(sentence).toContain("rights-cleared for the client's own channel");
    expect(sentence).toContain(`[licence: ${CLIENT_SITE_LICENCE}; published at https://hankypanky.test/products/original-rise-thong]`);
    // Not the upload sentence: the client did not hand this frame over for a post.
    expect(sentence).not.toContain("supplied it deliberately");
  });

  it("classify as blanket from their licence text — no editorial-only cue in the words", () => {
    expect(licenceClassFor("client-supplied", CLIENT_SITE_LICENCE)).toBe("blanket");
    expect(licenceClassFor(undefined, CLIENT_SITE_LICENCE)).toBe("unknown");
  });

  it("reach the vet under the [client library] prefix its §6 ownership rule already reads, with the product name", () => {
    const text = describeLibraryCandidate(SITE_ENTRY_BASE);
    expect(text.startsWith("[client library, filed 2026-09-24]")).toBe(true);
    expect(text).toContain("Signature Lace Original Rise Thong");
    expect(text).toContain("subjects: Signature Lace Original Rise Thong");
  });

  it("file the page's caption and title with the vision description, the caption leading subjects", () => {
    const entry = buildClientSiteLibraryEntry(
      { description: "A model wearing a black lace thong.", subjects: ["black lace thong", "model"], mood: "intimate", toolVersion: "1.2.0" },
      {
        path: ".media-cache/run/n1-abc.jpg",
        imageUrl: "https://cdn.shop.test/files/signature-lace-thong_1080x.jpg",
        pageUrl: "https://hankypanky.test/",
        pageTitle: "Hanky Panky | Lingerie",
        altText: "Signature Lace Original Rise Thong",
      },
    );
    expect(entry.gcsUri).toBe("https://cdn.shop.test/files/signature-lace-thong_1080x.jpg");
    expect(entry.rights).toEqual({ source: "client-site", licence: CLIENT_SITE_LICENCE, note: "published at https://hankypanky.test/" });
    expect(entry.description).toBe(
      'A model wearing a black lace thong. Published on the client\'s own website on the page "Hanky Panky | Lingerie", where the client captions it "Signature Lace Original Rise Thong".',
    );
    expect(entry.subjects).toEqual(["Signature Lace Original Rise Thong", "black lace thong", "model"]);
    expect(entry.inspectedByToolVersion).toBe("1.2.0");
  });

  it("rank after the client's deliberate uploads at equal match, whatever their age", () => {
    const upload: MediaLibraryEntry = { ...siteEntry(1), assetId: "upload0000000000", rights: CLIENT_UPLOAD_RIGHTS, addedAt: "2026-01-01T00:00:00.000Z" };
    const newerSite = siteEntry(2, { addedAt: "2026-09-24T00:00:00.000Z" });
    const picked = selectLibraryCandidates([newerSite, upload], "");
    expect(picked.candidates.map((c) => c.entry.assetId)).toEqual(["upload0000000000", newerSite.assetId]);
  });
});

describe("planClientSiteHarvest — read the site only while the library is short of offerable site frames", () => {
  it("harvests for an empty library, asking for the cap", () => {
    expect(planClientSiteHarvest([])).toEqual({ offerable: 0, filedImageUrls: [], harvest: true, want: CLIENT_SITE_HARVEST_CAP });
  });

  it("stops once the target is on file", () => {
    const stocked = Array.from({ length: CLIENT_SITE_STOCK_TARGET }, (_, i) => siteEntry(i + 1));
    const plan = planClientSiteHarvest(stocked);
    expect(plan.harvest).toBe(false);
    expect(plan.offerable).toBe(CLIENT_SITE_STOCK_TARGET);
    expect(plan.want).toBe(0);
  });

  it("counts OFFERABLE frames: shipped ones (the ledger retires them) do not stock the library, but are never re-downloaded", () => {
    const stocked = Array.from({ length: CLIENT_SITE_STOCK_TARGET }, (_, i) => siteEntry(i + 1));
    const plan = planClientSiteHarvest(stocked, { ledgerUsed: stocked.map((e) => e.knownPaths[0]!) });
    expect(plan.offerable).toBe(0);
    expect(plan.harvest).toBe(true);
    expect(plan.filedImageUrls).toEqual(stocked.map((e) => e.gcsUri));
  });

  it("does not count the client's uploads as site stock", () => {
    const uploads = Array.from({ length: 10 }, (_, i) => ({ ...siteEntry(i + 1), rights: CLIENT_UPLOAD_RIGHTS }));
    expect(planClientSiteHarvest(uploads).harvest).toBe(true);
    expect(planClientSiteHarvest(uploads).filedImageUrls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The workflow half — `05y0-stock-client-site-images` feeding `05y`.
// ─────────────────────────────────────────────────────────────────────────────

const params = { runId: "ig_client_site", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
const THONG_URL = "https://cdn.shop.test/files/signature-lace-thong_1080x.jpg";

describe("05y0-stock-client-site-images — the client's website stocks the library, and 05y offers it", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
    await env.store.writeJson("acme", ["client", "profile"], { name: "Hanky Panky", website: "hankypanky.test" });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function stub(name: string, execute: (args: unknown, context: unknown) => Promise<unknown>): AgentTool {
    return { name, version: "1.0.0", inputSchema: { parse: (v: unknown) => v } as never, execute } as unknown as AgentTool;
  }

  async function run(calls: Array<{ name: string; args: unknown }>) {
    const libraryTools = createMediaLibraryTools({ store: env.store });
    const recording = (tool: AgentTool): AgentTool =>
      stub(tool.name, async (args, context) => {
        calls.push({ name: tool.name, args });
        return tool.execute(args as never, context as never);
      });
    const harvest = stub("media.harvestSiteImages", async (args) => {
      calls.push({ name: "media.harvestSiteImages", args });
      const rel = `.media-cache/${params.runId}/n1-site.jpg`;
      await fs.mkdir(path.join(env.repoRoot, ".media-cache", params.runId), { recursive: true });
      await fs.writeFile(path.join(env.repoRoot, rel), Buffer.from("signature-lace-thong-bytes"));
      return {
        status: "success",
        result: {
          candidates: [
            {
              path: rel,
              description: "picture published on the client's own website",
              provider: "client-site",
              licenseConfidence: "client-supplied",
              imageUrl: THONG_URL,
              pageUrl: "https://hankypanky.test/products/original-rise-thong",
              pageTitle: "Original Rise Thong | Hanky Panky",
              altText: "Signature Lace Original Rise Thong",
            },
          ],
          pagesRead: [{ url: "https://hankypanky.test/", via: "direct", found: 1 }],
          notes: [],
          scraperCalls: 0,
        },
      };
    });
    const inspect = stub("media.inspectImages", async (args) => {
      calls.push({ name: "media.inspectImages", args });
      const images = (args as { images: Array<{ ref: string }> }).images;
      if (!images.every((i) => i.ref.startsWith("site-"))) return { status: "content_fail", reason: "no vision backend in this fixture" };
      return {
        status: "success",
        result: {
          inspections: images.map((i) => ({
            ref: i.ref,
            description: "A model wearing a black lace thong against a plain backdrop.",
            subjects: ["black lace thong"],
            textInImage: [],
            mood: "intimate",
            quality: "usable",
            hasWatermark: false,
            looksLikeScreenshot: false,
          })),
          unreadable: [],
          model: "fake",
        },
      };
    });
    const ingest = stub("media.ingestAssets", async (args) => {
      calls.push({ name: "media.ingestAssets", args });
      const assets = (args as { assets: Array<{ uri: string; slot: number }> }).assets;
      return {
        status: "success",
        result: {
          candidates: assets.map((a) => ({ path: `.media-cache/${params.runId}/n${a.slot}-re.jpg`, description: "CLIENT-SUPPLIED", provider: "client-upload", licenseConfidence: "client-supplied" })),
          unmet: [],
        },
      };
    });

    const tools = {
      ...env.tools,
      "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
      "media.libraryList": recording(libraryTools["media.libraryList"] as unknown as AgentTool),
      "media.libraryAdd": recording(libraryTools["media.libraryAdd"] as unknown as AgentTool),
      "media.harvestSiteImages": harvest,
      "media.inspectImages": inspect,
      "media.ingestAssets": ingest,
    } as unknown as AgentToolRegistry;

    const router = fakeRouterSequence(
      standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy: goodCopyOutput() }),
    );
    const store = new MemoryDurableStepStore();
    const workflowFn = createInstagramAgentWorkflow({ tools: tools as never, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true });
    await new WorkflowEngine(store).run(workflowFn, { ...params, input: {} });
    return store.listSteps(params.runId);
  }

  it("files the client's own product picture with its product name, and 05y offers it to the vet as the client's own", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const steps = await run(calls);
    const ids = steps.map((s) => s.stepId);
    expect(ids.indexOf("05y0-stock-client-site-images")).toBeGreaterThan(ids.indexOf("05z-attach-user-media"));
    expect(ids.indexOf("05y0-stock-client-site-images")).toBeLessThan(ids.indexOf("05y-read-media-library"));

    const harvestCall = calls.find((c) => c.name === "media.harvestSiteImages");
    expect(harvestCall, "the site must be read when the library holds no site pictures").toBeDefined();
    // The profile's bare domain, normalised to the homepage.
    expect((harvestCall!.args as { siteUrl: string }).siteUrl).toBe("https://hankypanky.test");
    expect((harvestCall!.args as { maxImages: number }).maxImages).toBe(CLIENT_SITE_HARVEST_CAP);

    const stocked = steps.find((s) => s.stepId === "05y0-stock-client-site-images")?.output as { filed: string[]; note: string; inspected: number };
    expect(stocked.filed).toHaveLength(1);
    expect(stocked.inspected).toBe(1);
    expect(stocked.note).toContain("client's own website");

    // Filed durably, under the client-site rights, with the page's own words.
    const doc = await env.store.readJson<{ entries: MediaLibraryEntry[] }>("acme", ["client", "media-library"]);
    const filed = doc?.entries.find((e) => e.gcsUri === THONG_URL);
    expect(filed?.rights.source).toBe("client-site");
    expect(filed?.description).toContain("Signature Lace Original Rise Thong");

    // And the SAME run's 05y offers it, described as the client's own product picture.
    const read = steps.find((s) => s.stepId === "05y-read-media-library")?.output as { candidates: Array<{ description: string }>; offered: string[] };
    expect(read.offered).toContain(stocked.filed[0]);
    const offered = read.candidates.find((c) => c.description.includes("Signature Lace Original Rise Thong"));
    expect(offered?.description.startsWith("[client library, filed")).toBe(true);
    expect(offered?.description).toContain("publishes this image on its own website");
    expect(offered?.description).toContain(`[licence: ${CLIENT_SITE_LICENCE}`);
  });

  it("does not read the site again once the library holds enough offerable site pictures", async () => {
    // Six site pictures already on file, none shipped.
    const add = createMediaLibraryTools({ store: env.store })["media.libraryAdd"] as unknown as AgentTool;
    await fs.mkdir(path.join(env.repoRoot, ".media-cache", "ig_old"), { recursive: true });
    const entries = [];
    for (let i = 1; i <= CLIENT_SITE_STOCK_TARGET; i++) {
      const rel = `.media-cache/ig_old/n${i}-site.jpg`;
      await fs.writeFile(path.join(env.repoRoot, rel), Buffer.from(`site-picture-${i}`));
      entries.push({ path: rel, gcsUri: `https://cdn.shop.test/files/p${i}.jpg`, rights: clientSiteRights("https://hankypanky.test/"), description: `Product picture ${i}.`, subjects: ["lace"], mood: "calm" });
    }
    const seeded = await add.execute({ repoRoot: env.repoRoot, entries }, { ctx: { runId: "ig_old", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } } as never);
    expect(seeded.status).toBe("success");

    const calls: Array<{ name: string; args: unknown }> = [];
    const steps = await run(calls);
    expect(calls.some((c) => c.name === "media.harvestSiteImages")).toBe(false);
    const stocked = steps.find((s) => s.stepId === "05y0-stock-client-site-images")?.output as { note: string; offerableBefore: number };
    expect(stocked.offerableBefore).toBe(CLIENT_SITE_STOCK_TARGET);
    expect(stocked.note).toContain("not read again");
    // No vision call was spent on the site either: the stored descriptions are the saving.
    expect(calls.some((c) => c.name === "media.inspectImages" && (c.args as { images: Array<{ ref: string }> }).images.some((i) => i.ref.startsWith("site-")))).toBe(false);
  });

  it("degrades to a note — never a failed or held run — when the site cannot be read", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    // Same fixture, but the harvester reports the site unreadable.
    const libraryTools = createMediaLibraryTools({ store: env.store });
    const tools = {
      ...env.tools,
      "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
      "media.libraryList": libraryTools["media.libraryList"],
      "media.libraryAdd": libraryTools["media.libraryAdd"],
      "media.harvestSiteImages": stub("media.harvestSiteImages", async (args) => {
        calls.push({ name: "media.harvestSiteImages", args });
        return { status: "content_fail", reason: "media.harvestSiteImages: the client's website could not be read — HTTP 403" };
      }),
    } as unknown as AgentToolRegistry;
    const router = fakeRouterSequence(
      standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy: goodCopyOutput() }),
    );
    const store = new MemoryDurableStepStore();
    const workflowFn = createInstagramAgentWorkflow({ tools: tools as never, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...params, input: {} });
    expect(result.status).toBe("completed");
    const steps = await store.listSteps(params.runId);
    const stocked = steps.find((s) => s.stepId === "05y0-stock-client-site-images")?.output as { filed: string[]; note: string };
    expect(stocked.filed).toEqual([]);
    expect(stocked.note).toContain("HTTP 403");
  });
});
