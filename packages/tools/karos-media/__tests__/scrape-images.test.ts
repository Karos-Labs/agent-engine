import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScraperError, type ScrapedRecord, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { createKarosMediaTools } from "../src/index.js";

/**
 * `media.scrapeImages` — tier 2 of the visual pipeline.
 *
 * The tier that finds a photograph of the ACTUAL subject, which stock and CC
 * libraries do not hold. Every candidate is `licenseConfidence: "unknown"`,
 * and these tests pin that: the value of this tier is breadth for a
 * human-reviewed pick, not an unattended publish.
 */

const CTX = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;

let repoRoot: string;
beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-scrape-"));
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

const jpeg = (async () => new Response(Buffer.alloc(64, 1), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;

function stubScraper(bySearch: (platform: string, query: string) => ScrapedRecord[]): ScraperProvider {
  return {
    name: "stub",
    async searchSocial(platform, query) {
      return bySearch(platform, query);
    },
    async searchKeyword() {
      return [];
    },
    async socialHistory() {
      return [];
    },
    async extractUrl() {
      return undefined;
    },
    async fetchRaw() {
      return undefined;
    },
  };
}

const tool = (scraper: ScraperProvider | null, fetchImpl: typeof fetch = jpeg) =>
  createKarosMediaTools({ env: {}, scraper, fetchImpl, generationClient: null })["media.scrapeImages"]!;

const post = (id: string, images: string[], extra: Partial<ScrapedRecord> = {}): ScrapedRecord => ({
  id,
  url: `https://social.test/${id}`,
  imageUrls: images,
  ...extra,
});

describe("media.scrapeImages", () => {
  it("downloads scraped images and labels every one as unknown provenance", async () => {
    const scraper = stubScraper(() => [post("p1", ["https://cdn.test/a.jpg"], { text: "a real desk", author: "someone" })]);

    // perNeed 1: the stub answers for both platforms, and the tier correctly
    // keeps going until its budget is met rather than stopping at the first.
    const outcome = await tool(scraper).execute(
      { repoRoot, runId: "run_1", needs: [{ n: 2, query: "cluttered desk" }], perNeed: 1 },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { candidates: Array<{ provider: string; licenseConfidence: string; description: string; path: string }> } }).result;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.provider).toBe("scrape:instagram");
    // UGC copyright stays with the poster; the gate must be told so.
    expect(result.candidates[0]!.licenseConfidence).toBe("unknown");
    expect(result.candidates[0]!.description).toContain("UNKNOWN / user-generated");
    expect(result.candidates[0]!.description).toContain("cluttered desk");
    // The caption and author reach the gate, which is what lets it judge the subject.
    expect(result.candidates[0]!.description).toContain("a real desk");
    expect(result.candidates[0]!.description).toContain("someone");

    const bytes = await fs.readFile(path.join(repoRoot, result.candidates[0]!.path));
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("tries tiktok when instagram has nothing, since a need one lacks the other often has", async () => {
    const asked: string[] = [];
    const scraper = stubScraper((platform) => {
      asked.push(platform);
      return platform === "tiktok" ? [post("t1", ["https://cdn.test/t.jpg"])] : [];
    });

    const outcome = await tool(scraper).execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    expect(asked).toEqual(["instagram", "tiktok"]);
    expect((outcome as { result: { platformsUsed: string[] } }).result.platformsUsed).toEqual(["tiktok"]);
  });

  it("stops at perNeed rather than downloading every image a post carries", async () => {
    const scraper = stubScraper(() => [
      post("p1", ["https://cdn.test/1.jpg", "https://cdn.test/2.jpg", "https://cdn.test/3.jpg", "https://cdn.test/4.jpg"]),
    ]);

    const outcome = await tool(scraper).execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }], perNeed: 2 },
      { ctx: CTX },
    );

    expect((outcome as { result: { candidates: unknown[] } }).result.candidates).toHaveLength(2);
  });

  it("content-fails, naming what was searched, when no platform has an image", async () => {
    const scraper = stubScraper(() => [post("p1", [])]);

    const outcome = await tool(scraper).execute(
      { repoRoot, runId: "run_1", needs: [{ n: 4, query: "a labelled roadmap" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toContain("slide 4");
    expect((outcome as { reason: string }).reason).toContain("no images on 1 result");
  });

  it("reports an unrecovered scraper outage as tooling_error, not as an empty result", async () => {
    // Same distinction the whole codebase turns on: a provider that broke is
    // not a query that legitimately found nothing.
    const scraper = stubScraper(() => {
      throw new ScraperError("scrappycoco instagram.search_posts returned 402 (account out of credit)", 402);
    });

    const outcome = await tool(scraper).execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("out of credit");
  });

  it("still fills a need from tiktok when instagram is the platform that broke", async () => {
    const scraper = stubScraper((platform) => {
      if (platform === "instagram") throw new ScraperError("instagram down");
      return [post("t1", ["https://cdn.test/t.jpg"])];
    });

    const outcome = await tool(scraper).execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    // The outage was absorbed by the other platform, so it is correctly forgotten.
    expect(outcome.status).toBe("success");
  });

  it("reports not_available with no scraper configured", async () => {
    const outcome = await tool(null).execute({ repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] }, { ctx: CTX });
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain("SCRAPPYCOCO_API_KEY");
  });

  it("refuses a runId that would escape repoRoot", async () => {
    const scraper = stubScraper(() => [post("p1", ["https://cdn.test/a.jpg"])]);
    const outcome = await tool(scraper).execute(
      { repoRoot, runId: "../../escape", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("escaped repoRoot");
  });

  it("refuses a non-image response instead of saving an error page as .jpg", async () => {
    // Shares `downloadImage` with media.findImages precisely so this guarantee
    // cannot drift between the two tiers.
    const html = (async () => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const scraper = stubScraper(() => [post("p1", ["https://cdn.test/a.jpg"])]);

    const outcome = await tool(scraper, html).execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("content_fail");
  });

  it("is registered unconditionally, so a workflow checks for the tool not the config", () => {
    expect(createKarosMediaTools({ env: {} })["media.scrapeImages"]).toBeDefined();
  });
});
