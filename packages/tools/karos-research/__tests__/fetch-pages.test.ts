import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { ScraperError, type ScrapedRecord, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { createKarosResearchTools } from "../src/index.js";
import { DEFAULT_PAGE_CHARS, type FetchPagesResult } from "../src/fetch-pages.js";

/**
 * `research.fetchPages` (2026-09, Instagram Phase 1 item H): read the pages a
 * caller already holds the URL of — the client's own site for the Client
 * Brief, the report a secondary article cites for fact extraction.
 *
 * The three behaviours under test are the ones the tool exists to guarantee:
 * one billed scrape per URL per window (never per call, never per caller), a
 * dead URL that costs the caller nothing but a named problem, and an
 * unconfigured deployment that says so instead of returning a page.
 */

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

type PageMap = Record<string, ScrapedRecord | Error | undefined>;

/** A scraper whose `extractUrl` answers from a map and records every call, so a cache hit is provable by absence. */
function fakeScraper(pages: PageMap): ScraperProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    calls,
    async extractUrl(url) {
      calls.push(url);
      const answer = pages[url];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async searchKeyword() {
      return [];
    },
    async socialHistory() {
      return [];
    },
    async fetchRaw() {
      return undefined;
    },
    async searchSocial() {
      return [];
    },
  };
}

const page = (url: string, text: string, title?: string): ScrapedRecord => ({ id: url, url, text, ...(title ? { title } : {}) });

const ABOUT = "https://acme.test/about";
const PRICING = "https://acme.test/pricing";
const HOME = "https://acme.test";

function toolsWith(store: WorkspaceStore, scraper: ScraperProvider | null) {
  return createKarosResearchTools(store, { scraper, visibilityAdapters: null });
}

describe("research.fetchPages", () => {
  let rootDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-fetch-pages-"));
    store = new WorkspaceStore(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("is registered on the research tool registry", () => {
    expect(toolsWith(store, createOfflineScraper())["research.fetchPages"]).toBeDefined();
  });

  it("reports not_available, naming the credential, when no scraper is configured", async () => {
    const outcome = await toolsWith(store, null)["research.fetchPages"]!.execute({ urls: [ABOUT] }, { ctx });
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toMatch(/SCRAPPYCOCO_API_KEY/);
    // The refusal is one fact about the deployment, not four broken pages.
    expect((outcome as { reason: string }).reason).toMatch(/no scraper is configured/);
  });

  it("returns one page per URL with its title and text, and truncates to maxChars with a marker", async () => {
    const long = "a".repeat(5000);
    const scraper = fakeScraper({ [ABOUT]: page(ABOUT, long, "About Acme"), [PRICING]: page(PRICING, "Three plans.", "Pricing") });
    const outcome = await toolsWith(store, scraper)["research.fetchPages"]!.execute({ urls: [ABOUT, PRICING], maxChars: 1200 }, { ctx });

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: FetchPagesResult }).result;
    expect(result.problems).toEqual([]);
    expect(result.pages.map((p) => p.url)).toEqual([ABOUT, PRICING]);
    expect(result.pages[0]!.title).toBe("About Acme");
    expect(result.pages[0]!.text.startsWith("a".repeat(1200))).toBe(true);
    expect(result.pages[0]!.text).toMatch(/\[truncated at 1200 characters\]/);
    // The page's own content is cut at the ceiling; only the marker follows it.
    expect(result.pages[0]!.text.replace(/\n\n\[truncated at 1200 characters\]$/u, "")).toHaveLength(1200);
    expect(result.pages[1]!.text).toBe("Three plans.");
    expect(result.pages.every((p) => p.fromCache === false)).toBe(true);
    expect(result.pages.every((p) => Number.isFinite(Date.parse(p.fetchedAt)))).toBe(true);
  });

  it("caches per URL: a second call inside the window scrapes nothing and reports fromCache", async () => {
    const scraper = fakeScraper({ [ABOUT]: page(ABOUT, "We automate intake."), [PRICING]: page(PRICING, "Three plans.") });
    const tools = toolsWith(store, scraper);

    const first = await tools["research.fetchPages"]!.execute({ urls: [ABOUT], window: "7d" }, { ctx });
    expect(first.status).toBe("success");
    expect(scraper.calls).toEqual([ABOUT]);

    const second = await tools["research.fetchPages"]!.execute({ urls: [ABOUT], window: "7d" }, { ctx });
    expect(second.status).toBe("success");
    const result = (second as { result: FetchPagesResult }).result;
    expect(result.pages[0]!.fromCache).toBe(true);
    expect(result.pages[0]!.text).toBe("We automate intake.");
    expect(scraper.calls).toEqual([ABOUT]);

    // A mixed call scrapes only the cold URL — the cache is per page, not per call.
    const third = await tools["research.fetchPages"]!.execute({ urls: [ABOUT, PRICING], window: "7d" }, { ctx });
    expect((third as { result: FetchPagesResult }).result.pages.map((p) => p.fromCache)).toEqual([true, false]);
    expect(scraper.calls).toEqual([ABOUT, PRICING]);
  });

  it("re-scrapes when the window has passed, and when the cached page was fetched at a smaller maxChars than this caller asked for", async () => {
    const scraper = fakeScraper({ [ABOUT]: page(ABOUT, "b".repeat(9000)) });
    const tools = toolsWith(store, scraper);

    await tools["research.fetchPages"]!.execute({ urls: [ABOUT], maxChars: 2000, window: "7d" }, { ctx });
    expect(scraper.calls).toHaveLength(1);

    // A 2000-character record cannot answer an 8000-character request: it
    // would look like a page that simply ends early.
    const bigger = await tools["research.fetchPages"]!.execute({ urls: [ABOUT], maxChars: 8000, window: "7d" }, { ctx });
    expect((bigger as { result: FetchPagesResult }).result.pages[0]!.fromCache).toBe(false);
    expect(scraper.calls).toHaveLength(2);

    // The reverse is served from the cache and re-truncated on the way out.
    const smaller = await tools["research.fetchPages"]!.execute({ urls: [ABOUT], maxChars: 1000, window: "7d" }, { ctx });
    const page0 = (smaller as { result: FetchPagesResult }).result.pages[0]!;
    expect(page0.fromCache).toBe(true);
    expect(page0.text.startsWith("b".repeat(1000))).toBe(true);
    expect(page0.text).toMatch(/\[truncated at 1000 characters\]/);
    expect(scraper.calls).toHaveLength(2);

    // Zero window: nothing is fresh enough, so the page is read again.
    await tools["research.fetchPages"]!.execute({ urls: [ABOUT], maxChars: 1000, window: "0s" }, { ctx });
    expect(scraper.calls).toHaveLength(3);
  });

  it("names the URL that failed in problems while the others still come back", async () => {
    const scraper = fakeScraper({
      [ABOUT]: page(ABOUT, "We automate intake."),
      [PRICING]: new ScraperError("403 from the origin", 403),
      [HOME]: page(HOME, "Acme"),
    });
    const outcome = await toolsWith(store, scraper)["research.fetchPages"]!.execute({ urls: [ABOUT, PRICING, HOME] }, { ctx });

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: FetchPagesResult }).result;
    expect(result.pages.map((p) => p.url)).toEqual([ABOUT, HOME]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(PRICING);
    expect(result.problems[0]).toContain("403 from the origin");
  });

  it("names a URL that resolved with no readable body, and does not cache it as an empty page", async () => {
    const scraper = fakeScraper({ [ABOUT]: page(ABOUT, "   "), [PRICING]: page(PRICING, "Three plans.") });
    const tools = toolsWith(store, scraper);
    const outcome = await tools["research.fetchPages"]!.execute({ urls: [ABOUT, PRICING] }, { ctx });

    const result = (outcome as { result: FetchPagesResult }).result;
    expect(result.pages.map((p) => p.url)).toEqual([PRICING]);
    expect(result.problems[0]).toMatch(/no readable text/);

    // Nothing was stored for it, so a later run retries rather than serving
    // "this client has no about page" for a week.
    await tools["research.fetchPages"]!.execute({ urls: [ABOUT] }, { ctx });
    expect(scraper.calls.filter((u) => u === ABOUT)).toHaveLength(2);
  });

  it("reports tooling_error when EVERY page fails — an outage is not a set of empty pages", async () => {
    const scraper = fakeScraper({ [ABOUT]: new ScraperError("connection reset"), [PRICING]: new ScraperError("connection reset") });
    const outcome = await toolsWith(store, scraper)["research.fetchPages"]!.execute({ urls: [ABOUT, PRICING] }, { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toMatch(/no page could be read/);
  });

  it("reads a duplicated URL once, treating a trailing slash as the same page", async () => {
    const scraper = fakeScraper({ [ABOUT]: page(ABOUT, "We automate intake.") });
    const outcome = await toolsWith(store, scraper)["research.fetchPages"]!.execute({ urls: [ABOUT, `${ABOUT}/`, ABOUT] }, { ctx });
    expect((outcome as { result: FetchPagesResult }).result.pages).toHaveLength(1);
    expect(scraper.calls).toEqual([ABOUT]);
  });

  it("is tenant-scoped: another client's cache never answers this client's read", async () => {
    const scraper = fakeScraper({ [ABOUT]: page(ABOUT, "We automate intake.") });
    const tools = toolsWith(store, scraper);
    await tools["research.fetchPages"]!.execute({ urls: [ABOUT] }, { ctx });
    await tools["research.fetchPages"]!.execute({ urls: [ABOUT] }, { ctx: { ...ctx, clientSlug: "geektime" } });
    expect(scraper.calls).toEqual([ABOUT, ABOUT]);
  });

  it("holds its own input bounds: more than four URLs, a non-URL string, and an out-of-range maxChars are all refused", async () => {
    const tools = toolsWith(store, createOfflineScraper());
    const five = ["https://a.test/1", "https://a.test/2", "https://a.test/3", "https://a.test/4", "https://a.test/5"];
    expect((await tools["research.fetchPages"]!.execute({ urls: five }, { ctx })).status).toBe("tooling_error");
    expect((await tools["research.fetchPages"]!.execute({ urls: [] }, { ctx })).status).toBe("tooling_error");
    expect((await tools["research.fetchPages"]!.execute({ urls: ["acme.test/about"] }, { ctx })).status).toBe("tooling_error");
    expect((await tools["research.fetchPages"]!.execute({ urls: [ABOUT], maxChars: 999 }, { ctx })).status).toBe("tooling_error");
    expect((await tools["research.fetchPages"]!.execute({ urls: [ABOUT], maxChars: 12_001 }, { ctx })).status).toBe("tooling_error");
  });

  it("defaults maxChars to DEFAULT_PAGE_CHARS and the window to 7d", async () => {
    const scraper = fakeScraper({ [ABOUT]: page(ABOUT, "c".repeat(DEFAULT_PAGE_CHARS + 500)) });
    const outcome = await toolsWith(store, scraper)["research.fetchPages"]!.execute({ urls: [ABOUT] }, { ctx });
    const text = (outcome as { result: FetchPagesResult }).result.pages[0]!.text;
    expect(text.startsWith("c".repeat(DEFAULT_PAGE_CHARS))).toBe(true);
    expect(text).toMatch(new RegExp(`\\[truncated at ${DEFAULT_PAGE_CHARS} characters\\]`));

    // 7d is the default window, so a read six days later is still a cache hit.
    // Proven through the record's own timestamp rather than a fake clock: the
    // record is rewritten with an `at` six days in the past.
    const runs = await store.listJson<{ job: string; runId: string; query: string; result: unknown; at: number }>("acme", ["research", "page-fetch", "runs"]);
    expect(runs).toHaveLength(1);
    const sixDaysAgo = { ...runs[0]!.data, at: Date.now() - 6 * 86_400_000 };
    await store.writeJson("acme", ["research", "page-fetch", "runs", runs[0]!.id], sixDaysAgo);
    await store.writeJson("acme", ["research", "page-fetch", "latest"], sixDaysAgo);

    const again = await toolsWith(store, scraper)["research.fetchPages"]!.execute({ urls: [ABOUT] }, { ctx });
    expect((again as { result: FetchPagesResult }).result.pages[0]!.fromCache).toBe(true);
    expect(scraper.calls).toHaveLength(1);
  });

  it("keeps one cache record per URL: a re-read after the window replaces it instead of piling up", async () => {
    const scraper = fakeScraper({ [ABOUT]: page(ABOUT, "We automate intake."), [PRICING]: page(PRICING, "Three plans.") });
    const tools = toolsWith(store, scraper);
    for (let i = 0; i < 3; i++) {
      await tools["research.fetchPages"]!.execute({ urls: [ABOUT, PRICING], window: "0s" }, { ctx });
    }
    expect(scraper.calls).toHaveLength(6);
    const runs = await store.listJson<unknown>("acme", ["research", "page-fetch", "runs"]);
    expect(runs).toHaveLength(2);
  });

  it("works against the offline scraper the workflow fixtures use", async () => {
    const outcome = await toolsWith(store, createOfflineScraper())["research.fetchPages"]!.execute({ urls: [ABOUT] }, { ctx });
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: FetchPagesResult }).result;
    expect(result.pages).toHaveLength(1);
    // The offline provider labels every record as synthetic; that label has to
    // survive into the page text, or a fixture leak would look like real data.
    expect(result.pages[0]!.text).toMatch(/SYNTHETIC TEST DATA/);
  });
});
