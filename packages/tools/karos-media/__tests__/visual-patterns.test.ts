import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { ScraperError, type ScrapedRecord, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import {
  createKarosMediaTools,
  readVisualPatternConsent,
  readVisualPatternProfile,
  renderVisualPatternReference,
  type ClientConsentRecord,
  type VisionAnalysisClient,
  type VisualPatternProfile,
} from "../src/index.js";

/**
 * SCRUM-321 (AU37) — historical post ingestion and per-client visual pattern
 * profiles.
 *
 * The load-bearing test in this file is the consent one, and it is written the
 * hard way on purpose: it asserts that `ScraperProvider.socialHistory` is
 * **never called**, not that the result came back empty. An empty result is
 * what you get from a feature that fetched a client's account history and then
 * threw it away, which is exactly the outcome a consent gate exists to
 * prevent and exactly the outcome a result-shaped assertion cannot tell apart.
 */

const CTX = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;

/** A 1x1 PNG — enough for the vision step to have real bytes to be handed. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const pngFetch = (async () =>
  new Response(Buffer.from(PNG_B64, "base64"), {
    status: 200,
    headers: { "content-type": "image/png" },
  })) as unknown as typeof fetch;

/**
 * A `ScraperProvider` stand-in that records every account-history request, so
 * "no ingestion" is provable by the absence of a call. Same shape as
 * `karos-research`'s own `fakeScraper` — the established stub in this repo.
 */
function recordingScraper(posts: ScrapedRecord[], failWith?: Error) {
  const historyCalls: Array<{ platform: string; username: string; limit?: number | undefined }> = [];
  const scraper: ScraperProvider = {
    name: "fake/scraper",
    async socialHistory(request) {
      historyCalls.push({ platform: request.platform, username: request.username, limit: request.limit });
      if (failWith) throw failWith;
      return posts;
    },
    async searchKeyword() {
      return [];
    },
    async searchSocial() {
      return [];
    },
    async extractUrl() {
      return undefined;
    },
    async fetchRaw() {
      return undefined;
    },
  };
  return { historyCalls, scraper };
}

/** The vision model, stubbed the way `generate-image.test.ts` stubs `ImageGenerationClient`: a fake `models.generateContent`. */
function recordingVision(responseText: string) {
  const calls: Array<{ model: string; textParts: string[]; imageParts: number }> = [];
  const client: VisionAnalysisClient = {
    models: {
      async generateContent(request) {
        const parts = request.contents.flatMap((c) => c.parts);
        calls.push({
          model: request.model,
          textParts: parts.filter((p): p is { text: string } => "text" in p).map((p) => p.text),
          imageParts: parts.filter((p) => "inlineData" in p).length,
        });
        return { candidates: [{ finishReason: "STOP", content: { parts: [{ text: responseText }] } }] };
      },
    },
  };
  return { calls, client };
}

const ANALYSIS_JSON = JSON.stringify({
  summary: "Warm, close-cropped interiors with a single human subject; captions open on a question.",
  patterns: [
    {
      label: "warm interior light",
      observation: "Every top post is lit by low, warm indoor light rather than daylight or flash.",
      appliesTo: "colour",
      evidence: ["https://social.test/p1", "https://social.test/p2"],
      confidence: "high",
    },
    {
      label: "question-first caption",
      observation: "The three highest-engagement captions all open with a direct question to the reader.",
      appliesTo: "caption",
      evidence: ["https://social.test/p1"],
      confidence: "medium",
    },
  ],
  templateHints: ["full-bleed photo with the caption below, no overlay text"],
});

const post = (id: string, likes: number, extra: Partial<ScrapedRecord> = {}): ScrapedRecord => ({
  id,
  url: `https://social.test/${id}`,
  text: `caption for ${id}`,
  imageUrls: [`https://cdn.test/${id}.png`],
  engagement: { likes, comments: 2, views: 100 },
  ...extra,
});

let rootDir: string;
let store: WorkspaceStore;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-visual-patterns-"));
  store = new WorkspaceStore(rootDir);
});
afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

const GRANTED: ClientConsentRecord = {
  visualPatternIngestion: {
    status: "granted",
    grantedAt: "2026-08-01T09:00:00Z",
    grantedBy: "ops@karoslabs.test",
    accounts: [{ platform: "instagram", username: "@acmecoffee" }],
  },
};

function tools(options: {
  scraper: ScraperProvider;
  visionClient: VisionAnalysisClient;
  fetchImpl?: typeof fetch;
}) {
  return createKarosMediaTools({
    env: {},
    store,
    scraper: options.scraper,
    visionClient: options.visionClient,
    generationClient: null,
    fetchImpl: options.fetchImpl ?? pngFetch,
  });
}

describe("media.ingestVisualPatterns — the consent gate", () => {
  /**
   * ACCEPTANCE 2. The assertion that matters is `historyCalls` staying empty:
   * a test that only checked for an empty profile would pass just as happily
   * against a version that scraped the client's whole back catalogue first.
   */
  it("never invokes the scraper for a client with no consent record at all", async () => {
    const { historyCalls, scraper } = recordingScraper([post("p1", 500)]);
    const { calls: visionCalls, client } = recordingVision(ANALYSIS_JSON);

    const outcome = await tools({ scraper, visionClient: client })["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    expect(historyCalls).toEqual([]);
    expect(visionCalls).toEqual([]);
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain("explicit, recorded opt-in");
    // And nothing was written, so a later read cannot mistake this for an ingestion.
    expect(await readVisualPatternProfile(store, "acme")).toBeUndefined();
  });

  it.each([
    ["denied", { visualPatternIngestion: { status: "denied" as const } }],
    ["revoked", { visualPatternIngestion: { status: "revoked" as const, accounts: [{ platform: "instagram" as const, username: "acmecoffee" }] } }],
    ["a block that is absent entirely", { someOtherConsent: true }],
    ["granted but naming no accounts", { visualPatternIngestion: { status: "granted" as const } }],
  ])("never invokes the scraper when consent is %s", async (_label, record) => {
    await store.writeJson("acme", ["client", "consent"], record);
    const { historyCalls, scraper } = recordingScraper([post("p1", 500)]);
    const { calls: visionCalls, client } = recordingVision(ANALYSIS_JSON);

    const outcome = await tools({ scraper, visionClient: client })["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    expect(historyCalls).toEqual([]);
    expect(visionCalls).toEqual([]);
    expect(outcome.status).toBe("not_available");
  });

  it("never invokes the scraper for an account the consent record does not name", async () => {
    await store.writeJson("acme", ["client", "consent"], GRANTED);
    const { historyCalls, scraper } = recordingScraper([post("p1", 500)]);
    const { calls: visionCalls, client } = recordingVision(ANALYSIS_JSON);

    // Consent covers instagram/@acmecoffee. This asks for a different handle
    // on a different platform.
    const outcome = await tools({ scraper, visionClient: client })["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "tiktok", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    expect(historyCalls).toEqual([]);
    expect(visionCalls).toEqual([]);
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain("recorded consent");
  });

  it("fails closed when the consent record itself cannot be read", async () => {
    const exploding = {
      ...store,
      readJson: async () => {
        throw new Error("store offline");
      },
    } as unknown as WorkspaceStore;
    const { historyCalls, scraper } = recordingScraper([post("p1", 500)]);
    const { client } = recordingVision(ANALYSIS_JSON);

    const decision = await readVisualPatternConsent(exploding, "acme");
    expect(decision.granted).toBe(false);
    expect(decision.reason).toContain("failing closed");

    const registry = createKarosMediaTools({
      env: {},
      store: exploding,
      scraper,
      visionClient: client,
      generationClient: null,
      fetchImpl: pngFetch,
    });
    const outcome = await registry["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    expect(historyCalls).toEqual([]);
    expect(outcome.status).toBe("not_available");
  });

  it("reads only the consented account when a run asks for a consented one and an unconsented one together", async () => {
    await store.writeJson("acme", ["client", "consent"], GRANTED);
    const { historyCalls, scraper } = recordingScraper([post("p1", 500), post("p2", 300)]);
    const { client } = recordingVision(ANALYSIS_JSON);

    const outcome = await tools({ scraper, visionClient: client })["media.ingestVisualPatterns"]!.execute(
      {
        accounts: [
          { platform: "instagram", username: "@AcmeCoffee" },
          { platform: "x", username: "acme_corp" },
        ],
      },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("success");
    expect(historyCalls).toEqual([{ platform: "instagram", username: "acmecoffee", limit: 12 }]);
    const profile = (outcome as { result: { profile: VisualPatternProfile } }).result.profile;
    expect(profile.coverage.accountsConsented).toBe(1);
    expect(profile.coverage.problems.join(" ")).toContain("x/@acme_corp");
    expect(profile.coverage.problems.join(" ")).toContain("skipped, not read");
  });
});

describe("media.ingestVisualPatterns — ingestion for a consenting client", () => {
  /** ACCEPTANCE 1. */
  it("writes a populated, human-readable profile a reviewer can read back out", async () => {
    await store.writeJson("acme", ["client", "consent"], GRANTED);
    const { historyCalls, scraper } = recordingScraper([post("p1", 900), post("p2", 400), post("p3", 100)]);
    const { calls: visionCalls, client } = recordingVision(ANALYSIS_JSON);
    const registry = tools({ scraper, visionClient: client });

    const outcome = await registry["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }], topPosts: 2 },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("success");
    expect(historyCalls).toHaveLength(1);
    // The vision model was actually shown pictures, not just captions.
    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0]!.imageParts).toBe(2);

    const result = (outcome as { result: { version: number; versionId: string; patternCount: number; profile: VisualPatternProfile } }).result;
    expect(result.version).toBe(1);
    expect(result.versionId).toBe("v0001");
    expect(result.patternCount).toBe(2);

    // Stored under the ticket's path, as its own version document.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(rootDir, "clients", "acme", "client", "visual-patterns", "v0001.json"), "utf8"),
    ) as VisualPatternProfile;
    expect(onDisk.schema).toBe("karos.visual-patterns/v1");
    expect(onDisk.review.status).toBe("unreviewed");
    expect(onDisk.consent.grantedBy).toBe("ops@karoslabs.test");
    expect(onDisk.consent.accountsRead).toEqual([{ platform: "instagram", username: "acmecoffee" }]);

    // Human-readable: named patterns with prose observations and evidence
    // URLs — nothing opaque, nothing a reviewer cannot argue with.
    expect(onDisk.patterns.map((p) => p.label)).toEqual(["warm interior light", "question-first caption"]);
    expect(onDisk.patterns[0]!.observation).toContain("warm indoor light");
    expect(onDisk.patterns[0]!.evidence).toContain("https://social.test/p1");
    expect(onDisk.summary).toContain("Warm, close-cropped interiors");

    // Ranked, not just taken in order: p3 (score 100+6+1) fell outside topPosts: 2.
    expect(onDisk.sourcePosts.map((p) => p.url)).toEqual(["https://social.test/p1", "https://social.test/p2"]);
    expect(onDisk.sourcePosts[0]!.engagementScore).toBeGreaterThan(onDisk.sourcePosts[1]!.engagementScore);
    expect(onDisk.coverage).toMatchObject({ accountsRequested: 1, accountsConsented: 1, postsSeen: 3, postsAnalysed: 2 });

    // ACCEPTANCE 1, read back out through the tool.
    const read = await registry["media.getVisualPatterns"]!.execute({}, { ctx: CTX });
    expect(read.status).toBe("success");
    const readResult = (read as { result: { profile: VisualPatternProfile; versions: unknown[]; reference: string } }).result;
    expect(readResult.profile.versionId).toBe("v0001");
    expect(readResult.versions).toHaveLength(1);
    expect(readResult.reference).toContain("warm interior light");
    expect(readResult.reference).toContain("full-bleed photo");
    expect(readResult.reference).toContain("has not been reviewed by a human yet");
  });

  it("appends a new version rather than overwriting, and can read an older one back", async () => {
    await store.writeJson("acme", ["client", "consent"], GRANTED);
    const { scraper } = recordingScraper([post("p1", 900), post("p2", 400)]);
    const first = recordingVision(ANALYSIS_JSON);
    const registryOne = tools({ scraper, visionClient: first.client });
    await registryOne["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    const revised = JSON.parse(ANALYSIS_JSON) as { summary: string; patterns: unknown[] };
    revised.summary = "Cooler daylight now; the warm-interior look has been retired.";
    const second = recordingVision(JSON.stringify(revised));
    const registryTwo = tools({ scraper, visionClient: second.client });
    const outcome = await registryTwo["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    expect((outcome as { result: { versionId: string } }).result.versionId).toBe("v0002");

    const latest = await registryTwo["media.getVisualPatterns"]!.execute({}, { ctx: CTX });
    const latestResult = (latest as { result: { profile: VisualPatternProfile; versions: Array<{ version: number }> } }).result;
    expect(latestResult.profile.version).toBe(2);
    expect(latestResult.profile.summary).toContain("Cooler daylight");
    expect(latestResult.versions.map((v) => v.version)).toEqual([1, 2]);

    // The superseded version is still there to diff against.
    const older = await registryTwo["media.getVisualPatterns"]!.execute({ version: 1 }, { ctx: CTX });
    expect((older as { result: { profile: VisualPatternProfile } }).result.profile.summary).toContain("Warm, close-cropped");
  });

  it("names a per-account scrape failure instead of reporting a clean slate", async () => {
    await store.writeJson("acme", ["client", "consent"], GRANTED);
    const { scraper } = recordingScraper([], new ScraperError("upstream 503", 503));
    const { client } = recordingVision(ANALYSIS_JSON);

    const outcome = await tools({ scraper, visionClient: client })["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toContain("instagram/@acmecoffee");
    expect((outcome as { reason: string }).reason).toContain("upstream 503");
  });

  it("refuses to learn an aesthetic from posts with no engagement figures", async () => {
    await store.writeJson("acme", ["client", "consent"], GRANTED);
    const { scraper } = recordingScraper([
      { id: "p1", url: "https://social.test/p1", imageUrls: ["https://cdn.test/p1.png"] },
    ]);
    const { calls: visionCalls, client } = recordingVision(ANALYSIS_JSON);

    const outcome = await tools({ scraper, visionClient: client })["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toContain("unranked sample");
    expect(visionCalls).toEqual([]);
    expect(await readVisualPatternProfile(store, "acme")).toBeUndefined();
  });

  it("stores nothing when the vision model's analysis will not parse", async () => {
    await store.writeJson("acme", ["client", "consent"], GRANTED);
    const { scraper } = recordingScraper([post("p1", 900)]);
    const { client } = recordingVision("I looked at the pictures and they were nice.");

    const outcome = await tools({ scraper, visionClient: client })["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("content_fail");
    expect(await readVisualPatternProfile(store, "acme")).toBeUndefined();
  });

  it("reports not_available, without touching the scraper, when no vision model is configured", async () => {
    await store.writeJson("acme", ["client", "consent"], GRANTED);
    const { historyCalls, scraper } = recordingScraper([post("p1", 900)]);

    const registry = createKarosMediaTools({
      env: {},
      store,
      scraper,
      visionClient: null,
      generationClient: null,
      fetchImpl: pngFetch,
    });
    const outcome = await registry["media.ingestVisualPatterns"]!.execute(
      { accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("not_available");
    expect(historyCalls).toEqual([]);
  });
});

describe("media.getVisualPatterns", () => {
  it("reports not_available for a client that has never been ingested", async () => {
    const { scraper } = recordingScraper([]);
    const { client } = recordingVision(ANALYSIS_JSON);
    const outcome = await tools({ scraper, visionClient: client })["media.getVisualPatterns"]!.execute({}, { ctx: CTX });

    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain("media.ingestVisualPatterns");
  });

  it("renders a reference block that carries the review caveat with it", () => {
    const profile: VisualPatternProfile = {
      schema: "karos.visual-patterns/v1",
      version: 1,
      versionId: "v0001",
      clientSlug: "acme",
      generatedAt: "2026-08-30T00:00:00Z",
      generatedBy: { tool: "media.ingestVisualPatterns", toolVersion: "1.0.0", visionModel: "m", scraper: "s" },
      consent: { accountsRead: [{ platform: "instagram", username: "acmecoffee" }] },
      review: { status: "approved", reviewedBy: "strategy@karoslabs.test" },
      summary: "House style summary.",
      patterns: [{ label: "l", observation: "o", appliesTo: "layout", evidence: [], confidence: "low" }],
      templateHints: ["hint"],
      sourcePosts: [],
      coverage: { accountsRequested: 1, accountsConsented: 1, postsSeen: 1, postsAnalysed: 1, problems: [] },
    };

    const reference = renderVisualPatternReference(profile);
    expect(reference).toContain("review: approved");
    expect(reference).toContain("[layout] l (low confidence): o");
    // Reviewed profiles do not carry the caveat.
    expect(reference).not.toContain("has not been reviewed");
  });
});
