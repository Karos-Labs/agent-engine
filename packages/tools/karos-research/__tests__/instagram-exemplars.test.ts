import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import type { ScrapedRecord, ScraperProvider, SocialHistoryPageRequest } from "@agent-engine/tool-karos-scraper";
import {
  createInstagramExemplarHarvest,
  harvestAccount,
  instagramHandlesFromHtml,
  instagramPostFromRecord,
  rankHarvest,
  selectExemplars,
  summarizeAccounts,
  type HarvestedPost,
} from "../src/instagram-exemplars.js";

/**
 * RFC-26 Phase 1. The fixture is two real pages of @semrush (24 posts) from
 * ScrappyCoco, probed 2026-09-24 and trimmed to the fields the harvest reads.
 */
const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "instagram-account-posts-semrush.json"), "utf8")) as { records: Array<Record<string, unknown>> };

/** The vendor record as `createScrappyCocoScraper`'s `toRecord` hands it over: the normalised fields, and the whole item as `raw`. */
function asScraped(item: Record<string, unknown>): ScrapedRecord {
  const engagement = item["engagement"] as { likes?: number | null; comments?: number | null; views?: number | null };
  return {
    id: item["id"] as string,
    url: item["url"] as string,
    ...(typeof item["text"] === "string" ? { text: item["text"] } : {}),
    publishedAt: item["published_at"] as string,
    author: item["author"] as string,
    engagement: {
      ...(typeof engagement.likes === "number" ? { likes: engagement.likes } : {}),
      ...(typeof engagement.comments === "number" ? { comments: engagement.comments } : {}),
      ...(typeof engagement.views === "number" ? { views: engagement.views } : {}),
    },
    raw: item,
  };
}

const RECORDS = FIXTURE.records.map(asScraped);

function post(handle: string, likes: number, overrides: Partial<HarvestedPost> = {}): HarvestedPost {
  return { handle, role: "competitor", url: `https://instagram.com/${handle}/p/${likes}`, format: "carousel", frames: ["f"], frameCount: 1, likes, comments: 0, caption: "", hook: "", ...overrides };
}

describe("a vendor record becomes one harvested post", () => {
  it("reads every real record, one full-size frame per carousel slide, in order", () => {
    const posts = RECORDS.map((r) => instagramPostFromRecord(r, "@Semrush", "reference")).filter((p) => p !== undefined);
    expect(posts).toHaveLength(24);
    const carousel = posts.find((p) => p.format === "carousel" && p.likes === 251)!;
    expect(carousel.frameCount).toBe(8);
    expect(carousel.frames).toHaveLength(8);
    expect(new Set(carousel.frames).size).toBe(8);
    expect(carousel.handle).toBe("semrush");
    expect(carousel.likes).toBe(251);
    expect(carousel.comments).toBe(10);
    // The normalised `imageUrls` regex would have handed over every size of
    // every frame; the harvest keeps the largest candidate only.
    expect(carousel.frames.every((u) => u.startsWith("https://"))).toBe(true);
  });

  it("ranks a reel on plays and keeps its caption's first line as the hook", () => {
    const reel = RECORDS.map((r) => instagramPostFromRecord(r, "semrush", "reference")).find((p) => p?.format === "reel" && p.views === 14750)!;
    expect(reel.frameCount).toBe(1);
    expect(reel.likes).toBe(124);
    expect(reel.hook.length).toBeGreaterThan(0);
    expect(reel.hook).not.toContain("\n");
    expect(reel.postedAt).toMatch(/^2026-09-/u);
  });

  it("refuses a record with no provider JSON rather than guessing", () => {
    expect(instagramPostFromRecord({ id: "x", url: "u" }, "a", "client")).toBeUndefined();
  });
});

describe("ranking is inside the account, not across accounts", () => {
  it("lets a small account's best post outrank a big account's median", () => {
    const big = [100, 500, 900, 1300, 1700].map((l) => post("bigbrand", l));
    const small = [5, 12, 60].map((l) => post("smallshop", l));
    const ranked = rankHarvest([...big, ...small]);
    const smallBest = ranked.find((p) => p.handle === "smallshop" && p.likes === 60)!;
    const bigMedian = ranked.find((p) => p.handle === "bigbrand" && p.likes === 900)!;
    expect(smallBest.percentile).toBe(1);
    expect(bigMedian.percentile).toBe(0.5);
    expect(ranked.indexOf(smallBest)).toBeLessThan(ranked.indexOf(bigMedian));
  });

  it("ranks reels apart from stills, so plays never swamp likes", () => {
    const ranked = rankHarvest([post("a", 50), post("a", 10), post("a", 1, { format: "reel", views: 90_000 })]);
    expect(ranked.find((p) => p.format === "reel")!.percentile).toBe(0.5);
    expect(ranked.find((p) => p.likes === 50)!.percentile).toBe(1);
  });

  it("takes each account's top quarter and puts the client's own winners first", () => {
    const ranked = rankHarvest([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((l) => post("rival", l * 100)),
      ...[1, 2, 3, 4].map((l) => post("me", l, { role: "client" })),
    ]);
    const picked = selectExemplars(ranked, { max: 10 });
    expect(picked[0]!.role).toBe("client");
    expect(picked.filter((p) => p.handle === "rival")).toHaveLength(2);
    expect(picked.filter((p) => p.handle === "me")).toHaveLength(1);
  });
});

describe("competitor handles come from their own sites, never guessed", () => {
  it("finds account links and ignores post, reel and explore paths", () => {
    const html = `<a href="https://www.instagram.com/p/DdrXz1UjKPP/">post</a>
      <a href="https://instagram.com/reel/abc">reel</a><a href="https://www.instagram.com/explore/tags/x/">tag</a>
      <a href="https://www.instagram.com/Acme.Studio/">IG</a><a href='https://instagram.com/acme.studio?hl=en'>again</a>`;
    expect(instagramHandlesFromHtml(html)).toEqual(["acme.studio"]);
    expect(instagramHandlesFromHtml("<p>no social links</p>")).toEqual([]);
  });
});

/** Serves the fixture as pages of `size`, with a cursor between them, and counts calls. */
function pagingScraper(size = 12): ScraperProvider & { calls: SocialHistoryPageRequest[] } {
  const calls: SocialHistoryPageRequest[] = [];
  return {
    name: "fake",
    calls,
    async socialHistoryPage(request: SocialHistoryPageRequest) {
      calls.push(request);
      const start = request.cursor !== undefined ? Number(request.cursor) : 0;
      const records = RECORDS.slice(start, start + size);
      const next = start + size;
      return { records, ...(next < RECORDS.length ? { nextCursor: String(next) } : {}) };
    },
  } as unknown as ScraperProvider & { calls: SocialHistoryPageRequest[] };
}

describe("paging stops at the first limit it meets", () => {
  it("stops at maxPosts", async () => {
    const scraper = pagingScraper();
    const { posts, calls } = await harvestAccount(scraper, { handle: "semrush", role: "reference" }, { maxPosts: 15, since: new Date("2020-01-01") });
    expect(posts).toHaveLength(15);
    expect(calls).toBe(2);
    expect(scraper.calls[1]!.cursor).toBe("12");
  });

  it("stops at the end of the account's history", async () => {
    const { posts, calls } = await harvestAccount(pagingScraper(), { handle: "semrush", role: "reference" }, { maxPosts: 300, since: new Date("2020-01-01") });
    expect(posts).toHaveLength(24);
    expect(calls).toBe(2);
  });

  it("stops at the since date", async () => {
    const { posts, calls } = await harvestAccount(pagingScraper(), { handle: "semrush", role: "reference" }, { maxPosts: 300, since: new Date("2026-09-10T00:00:00Z") });
    expect(calls).toBe(1);
    expect(posts.every((p) => new Date(p.postedAt!) >= new Date("2026-09-10T00:00:00Z"))).toBe(true);
    expect(posts.length).toBeGreaterThan(0);
  });
});

function memoryStore(): WorkspaceStoreLike & { written: Map<string, unknown> } {
  const written = new Map<string, unknown>();
  return {
    written,
    async exists(slug, segments) {
      return written.has(`${slug}/${segments.join("/")}`);
    },
    async readJson(slug, segments) {
      return written.get(`${slug}/${segments.join("/")}`) as never;
    },
    async writeJson(slug, segments, data) {
      written.set(`${slug}/${segments.join("/")}`, data);
      return { path: segments.join("/") } as never;
    },
    async listJson() {
      return [];
    },
  };
}

describe("research.harvestInstagramExemplars", () => {
  const ctx = { runId: "r", clientSlug: "acme", productId: "instagram-agent", runKind: "setup", metadata: {} } as never;

  it("harvests, resolves a competitor from its site, ranks, stores and prices the run", async () => {
    const store = memoryStore();
    const fetchImpl = (async () => new Response(`<a href="https://www.instagram.com/semrush/">Instagram</a>`, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const tool = createInstagramExemplarHarvest(store, pagingScraper(), fetchImpl);
    const outcome = await tool.execute(
      { accounts: [], competitorSites: [{ name: "Semrush", website: "https://www.semrush.com" }], maxPostsPerAccount: 120 },
      { ctx },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome));
    const result = outcome.result;
    expect(result.postCount).toBe(24);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.role).toBe("competitor");
    expect(result.exemplars.length).toBe(6);
    expect(result.calls).toBe(2);
    expect(result.estimatedCostUsd).toBeCloseTo(0.0038, 4);
    expect([...store.written.keys()][0]).toMatch(/^acme\/exemplars\/harvest-\d{4}-\d{2}-\d{2}$/u);
    const summary = summarizeAccounts(result.exemplars);
    expect(summary[0]!.handle).toBe("semrush");
  });

  it("names a competitor whose site links no Instagram account, and harvests the rest", async () => {
    const fetchImpl = (async () => new Response("<p>no social</p>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const tool = createInstagramExemplarHarvest(memoryStore(), pagingScraper(), fetchImpl);
    const outcome = await tool.execute(
      { accounts: [{ handle: "@semrush", role: "reference" }], competitorSites: [{ name: "Quiet Co", website: "https://quiet.example" }] },
      { ctx },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome));
    expect(outcome.result.problems.some((p) => p.includes("Quiet Co"))).toBe(true);
    expect(outcome.result.postCount).toBe(24);
  });

  it("is not_available without a paging scraper", async () => {
    const outcome = await createInstagramExemplarHarvest(memoryStore(), undefined).execute({ accounts: [{ handle: "a", role: "client" }] }, { ctx });
    expect(outcome.status).toBe("not_available");
  });
});

describe("what the live harvest taught (2026-09-24)", () => {
  it("never ranks a post whose like count is hidden: the vendor reports a placeholder", () => {
    const ranked = rankHarvest([post("a", 3, { comments: 131, likesHidden: true }), post("a", 40), post("a", 20)]);
    const hidden = ranked.find((p) => p.likesHidden === true)!;
    expect(hidden.percentile).toBe(0);
    expect(selectExemplars(ranked).some((p) => p.likesHidden === true)).toBe(false);
  });

  it("ranks a giveaway on likes alone: its comments were bought", () => {
    const giveaway = post("a", 740, { comments: 2831, commentBait: true });
    const ranked = rankHarvest([giveaway, post("a", 1200, { comments: 20 })]);
    expect(ranked[0]!.likes).toBe(1200);
  });

  it("recognises the real captions that buy comments, and not ordinary ones", () => {
    const fromCaption = (caption: string) => {
      const record = asScraped({ ...FIXTURE.records[3]!, outputs: { json: { ...(FIXTURE.records[3]!["outputs"] as { json: Record<string, unknown> }).json, caption: { text: caption } } } });
      return instagramPostFromRecord(record, "a", "competitor")!.commentBait === true;
    };
    expect(fromCaption("We're getting lucky this Valentine's Day.\n\nThree winners will each receive $500\n\nHOW TO ENTER")).toBe(true);
    expect(fromCaption("Comment \u201cOpus\u201d and I'll send you the link")).toBe(true);
    expect(fromCaption("no need to complicate a summer outfit! Comment OUTFIT below to receive a DM with the links")).toBe(true);
    expect(fromCaption("Lingerie for every winter aesthetic coming right up. Which vibe are you?")).toBe(false);
  });

  it("tries a site's next Instagram link when the first account is silent", async () => {
    const fetchImpl = (async () =>
      new Response(`<a href="https://instagram.com/negative">old</a><a href="https://instagram.com/semrush">live</a>`, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const base = pagingScraper();
    const scraper = {
      ...base,
      async socialHistoryPage(request: SocialHistoryPageRequest) {
        return request.username === "negative" ? { records: [] } : base.socialHistoryPage!(request);
      },
    } as unknown as ScraperProvider;
    const outcome = await createInstagramExemplarHarvest(memoryStore(), scraper, fetchImpl).execute(
      { competitorSites: [{ name: "Negative", website: "https://negative.example" }] },
      { ctx: { runId: "r", clientSlug: "acme", productId: "instagram-agent", runKind: "setup", metadata: {} } as never },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome));
    expect(outcome.result.resolvedFromSites[0]!.handles).toEqual(["negative", "semrush"]);
    expect(outcome.result.postCount).toBe(24);
    expect(outcome.result.problems.some((p) => p.includes("@negative"))).toBe(true);
  });
});
