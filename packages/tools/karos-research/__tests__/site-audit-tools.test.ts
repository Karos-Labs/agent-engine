import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createOfflineScraper, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { chooseAuditUrls, createAuditOnPage, isArchivePageUrl, isEntityPageUrl, summariseSitemapFreshness, type OnPageAuditSnapshot } from "../src/audit-on-page.js";
import { createFetchCoreWebVitals, parsePageSpeedResponse } from "../src/core-web-vitals.js";
import { createLookupEntity, summariseWikidataEntity, type EntitySnapshot } from "../src/entity-lookup.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring", metadata: {} };

describe("research.auditOnPage", () => {
  let rootDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-audit-"));
    store = new WorkspaceStore(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("reports not_available with no HTML-capable scraper, never a placeholder snapshot", async () => {
    const outcome = await createAuditOnPage(store, undefined).execute({ seedUrl: "https://acme.example" }, { ctx });
    expect(outcome.status).toBe("not_available");
    const bare: ScraperProvider = {
      name: "bare",
      async searchKeyword() {
        return [];
      },
      async socialHistory() {
        return [];
      },
      async extractUrl() {
        return undefined;
      },
      async searchSocial() {
        return [];
      },
      async fetchRaw() {
        return undefined;
      },
    };
    expect((await createAuditOnPage(store, bare).execute({ seedUrl: "https://acme.example" }, { ctx })).status).toBe("not_available");
  });

  it("audits the seed plus discovered pages from the offline fixture, reads /llms.txt and the sitemap, and records the run", async () => {
    const tool = createAuditOnPage(store, createOfflineScraper({ documentsPerQuery: 3 }));
    const outcome = await tool.execute({ seedUrl: "https://acme.example", limit: 3 }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const { snapshot } = outcome.result;
    expect(snapshot.pages.length).toBe(3);
    expect(snapshot.pages[0]!.url).toBe("https://acme.example/");
    for (const page of snapshot.pages) {
      expect(page.status).toBe(200);
      expect(page.h1Count).toBe(1);
      expect(page.title).toContain("Offline fixture");
      expect(page.jsonLd.types).toContain("Organization");
      expect(page.dateModified).toBe("2026-01-01T00:00:00.000Z");
    }
    // The fixture's llms.txt "fetch" returns an HTML page, which is a soft-404, not an llms.txt.
    expect(snapshot.llmsTxt.present).toBe(false);
    expect(snapshot.sitemap?.entryCount).toBeGreaterThan(0);
    expect(snapshot.sitemap?.entriesWithLastmod).toBe(snapshot.sitemap?.entryCount);
    expect(snapshot.changedSince).toBeUndefined();
    expect(outcome.result.fromCache).toBe(false);
  });

  it("compares content hashes against the previous audit of the SAME seed and serves a cached audit inside the window", async () => {
    const tool = createAuditOnPage(store, createOfflineScraper());
    const first = await tool.execute({ seedUrl: "https://acme.example", limit: 2 }, { ctx });
    // An audit of a different seed in between must not become "the previous audit" of the client site.
    await tool.execute({ seedUrl: "https://rival.example", limit: 1 }, { ctx });
    const second = await tool.execute({ seedUrl: "https://acme.example", limit: 2 }, { ctx });
    expect(second.status).toBe("success");
    if (first.status !== "success" || second.status !== "success") throw new Error("unreachable");
    expect(second.result.snapshot.changedSince).toMatchObject({ pagesCompared: 2, pagesChanged: 0 });
    expect(second.result.snapshot.changedSince?.previousAt).toBe(new Date(first.result.runId ? (await store.readJson<{ at: number }>("acme", ["research", "on-page-audit", "runs", first.result.runId]))!.at : 0).toISOString());

    const cached = await tool.execute({ seedUrl: "https://acme.example", limit: 2, window: "1h" }, { ctx });
    expect(cached.status).toBe("success");
    if (cached.status !== "success") throw new Error("unreachable");
    expect(cached.result.fromCache).toBe(true);
    expect(cached.result.runId).toBe(second.result.runId);
  });

  it("chooseAuditUrls puts the seed first, then entity pages, then priority pages, then the rest, without duplicates", () => {
    const chosen = chooseAuditUrls(
      "https://acme.example/",
      ["https://acme.example/blog/post-1", "https://acme.example/pricing", "https://acme.example/about", "https://acme.example/#top", "https://acme.example/blog/post-2"],
      4,
    );
    expect(chosen).toEqual(["https://acme.example/", "https://acme.example/about", "https://acme.example/pricing", "https://acme.example/blog/post-1"]);
    // Tag/category/author listings go to the back: a sample of them says nothing about the site's articles.
    const withArchives = chooseAuditUrls("https://acme.example/", ["https://acme.example/tag/ai", "https://acme.example/category/news", "https://acme.example/2026/09/a-real-article", "https://acme.example/תגית/סייבר"], 3);
    expect(withArchives).toEqual(["https://acme.example/", "https://acme.example/2026/09/a-real-article", "https://acme.example/tag/ai"]);
    expect(isArchivePageUrl("https://acme.example/author/dana")).toBe(true);
    expect(isArchivePageUrl("https://acme.example/page/3")).toBe(true);
    expect(isArchivePageUrl("https://acme.example/2026/09/a-real-article")).toBe(false);
    expect(isEntityPageUrl("https://acme.example/about-us")).toBe(true);
    expect(isEntityPageUrl("https://acme.example/אודות")).toBe(true);
    expect(isEntityPageUrl("https://acme.example/blog/about-time")).toBe(false);
  });

  it("summariseSitemapFreshness derives volume and cadence from lastmod dates only", () => {
    const now = Date.parse("2026-09-07T00:00:00Z");
    const entries = [
      { url: "a", lastModified: "2026-09-01T00:00:00Z" },
      { url: "b", lastModified: "2026-08-01T00:00:00Z" },
      { url: "c", lastModified: "2026-06-20T00:00:00Z" },
      { url: "d" },
      { url: "e", lastModified: "not-a-date" },
    ];
    const summary = summariseSitemapFreshness(entries, false, now);
    expect(summary).toMatchObject({ entryCount: 5, entriesWithLastmod: 3, entriesTrailing6mo: 3, truncated: false, newestLastmod: "2026-09-01T00:00:00.000Z" });
    // Longest gap: 20 Jun -> 1 Aug is 42 days; the tail gap 1 Sep -> now is 6.
    expect(summary.maxGapDaysTrailing6mo).toBe(42);
    expect(summary.lastmodByUrl).toEqual({ a: "2026-09-01T00:00:00Z", b: "2026-08-01T00:00:00Z", c: "2026-06-20T00:00:00Z" });
    expect(summariseSitemapFreshness([{ url: "only", lastModified: "2026-09-01T00:00:00Z" }], true, now).maxGapDaysTrailing6mo).toBeUndefined();
  });
});

describe("research.fetchCoreWebVitals", () => {
  const PSI_BODY = {
    loadingExperience: {
      origin_fallback: true,
      overall_category: "AVERAGE",
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900, category: "AVERAGE" },
        INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: "AVERAGE" },
      },
    },
    lighthouseResult: {
      lighthouseVersion: "12.0.0",
      categories: { performance: { score: 0.61 }, seo: { score: 0.92 } },
      audits: {
        "largest-contentful-paint": { score: 0.4, numericValue: 4100 },
        "cumulative-layout-shift": { score: 0.9, numericValue: 0.05 },
        "total-blocking-time": { score: 0.7, numericValue: 250 },
        viewport: { score: 1 },
        "is-crawlable": { score: 1 },
        "document-title": { score: 0 },
      },
    },
  };

  it("parsePageSpeedResponse reads CrUX p75 field data (marking the origin fallback), CLS scaled by 100, and the Lighthouse audits", () => {
    const snapshot = parsePageSpeedResponse("https://acme.example", "mobile", PSI_BODY, false, "2026-09-07T00:00:00.000Z");
    expect(snapshot.field).toEqual({ source: "origin", overallCategory: "AVERAGE", lcpP75Ms: 2900, inpP75Ms: 180, clsP75: 0.12 });
    expect(snapshot.lab).toMatchObject({ performanceScore: 61, seoScore: 92, lcpMs: 4100, cls: 0.05, totalBlockingTimeMs: 250, lighthouseVersion: "12.0.0" });
    expect(snapshot.lab?.audits).toEqual({ viewport: true, "is-crawlable": true, "document-title": false });
    expect(snapshot.anonymous).toBe(false);
    // A response with no field data at all has no `field` — never a zeroed one.
    expect(parsePageSpeedResponse("https://acme.example", "mobile", { lighthouseResult: PSI_BODY.lighthouseResult }, true).field).toBeUndefined();
  });

  it("sends the key when configured, caches inside the window, and reports not_available on a 429", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-cwv-"));
    const store = new WorkspaceStore(rootDir);
    const requested: string[] = [];
    let status = 200;
    const fetchImpl = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(status === 200 ? JSON.stringify(PSI_BODY) : JSON.stringify({ error: { message: "quota" } }), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const tool = createFetchCoreWebVitals(store, { env: { PSI_API_KEY: "test-key" }, fetchImpl });
      const first = await tool.execute({ url: "https://acme.example" }, { ctx });
      expect(first.status).toBe("success");
      expect(requested[0]).toContain("key=test-key");
      expect(requested[0]).toContain("strategy=mobile");
      const second = await tool.execute({ url: "https://acme.example" }, { ctx });
      expect(second.status).toBe("success");
      if (second.status !== "success") throw new Error("unreachable");
      expect(second.result.fromCache).toBe(true);
      expect(requested.length).toBe(1);

      status = 429;
      const limited = await createFetchCoreWebVitals(store, { env: {}, fetchImpl }).execute({ url: "https://other.example" }, { ctx });
      expect(limited.status).toBe("not_available");
      expect((limited as { reason: string }).reason).toContain("PSI_API_KEY");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("research.lookupEntity", () => {
  const GEEKTIME = {
    id: "Q17003493",
    labels: { en: { value: "Geektime" } },
    descriptions: { en: { value: "Israeli technology news website" } },
    claims: {
      P856: [{ mainsnak: { datavalue: { value: "https://www.geektime.co.il/" } }, references: [{}] }],
      P31: [{ mainsnak: { datavalue: { value: {} } }, references: [{}] }],
      P571: [{ mainsnak: { datavalue: { value: {} } } }],
    },
    sitelinks: { enwiki: { title: "Geektime" }, hewiki: { title: "גיקטיים" }, commonswiki: { title: "Category:Geektime" } },
  };

  it("summariseWikidataEntity reads P856, referenced vs total statements and the Wikipedia editions", () => {
    const summary = summariseWikidataEntity(GEEKTIME, ["geektime.co.il"]);
    expect(summary).toMatchObject({
      qid: "Q17003493",
      label: "Geektime",
      officialWebsite: "https://www.geektime.co.il/",
      officialWebsiteMatchesClient: true,
      referencedStatementCount: 2,
      statementCount: 3,
      wikipediaLanguages: ["en", "he"],
    });
    expect(summariseWikidataEntity(GEEKTIME, ["other.example"]).officialWebsiteMatchesClient).toBe(false);
  });

  it("accepts only the candidate whose official website is the client's, then checks the preferred-language Wikipedia intro", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-entity-"));
    const store = new WorkspaceStore(rootDir);
    const OTHER = { id: "Q1", labels: { en: { value: "Geektime" } }, claims: { P856: [{ mainsnak: { datavalue: { value: "https://geektime.example.com" } } }] }, sitelinks: {} };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("wbsearchentities")) return Response.json({ search: [{ id: "Q1" }, { id: "Q17003493" }] });
      if (url.includes("wbgetentities")) return Response.json({ entities: { Q1: OTHER, Q17003493: GEEKTIME } });
      if (url.includes("he.wikipedia.org")) return Response.json({ extract: "ג".repeat(900), content_urls: { desktop: { page: "https://he.wikipedia.org/wiki/גיקטיים" } } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const tool = createLookupEntity(store, { fetchImpl });
      const outcome = await tool.execute({ brandName: "Geektime", aliases: ["גיקטיים"], clientDomains: ["geektime.co.il"], preferredLanguages: ["he", "en"] }, { ctx });
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      const snapshot: EntitySnapshot = outcome.result.snapshot;
      expect(snapshot.match).toBe("official-website");
      expect(snapshot.wikidata?.qid).toBe("Q17003493");
      expect(snapshot.wikidata?.candidatesConsidered).toBe(2);
      expect(snapshot.wikipedia).toMatchObject({ language: "he", title: "גיקטיים", extractLength: 900, nonStub: true });

      const cached = await tool.execute({ brandName: "Geektime", clientDomains: ["geektime.co.il"] }, { ctx });
      expect(cached.status).toBe("success");
      if (cached.status !== "success") throw new Error("unreachable");
      expect(cached.result.fromCache).toBe(true);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("reports match: none when no candidate's official website is the client's — a measured absence, not an error", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-entity-none-"));
    const store = new WorkspaceStore(rootDir);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("wbsearchentities")) return Response.json({ search: [] });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    try {
      const outcome = await createLookupEntity(store, { fetchImpl }).execute({ brandName: "Nobody Inc", clientDomains: ["nobody.example"] }, { ctx });
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      expect(outcome.result.snapshot.match).toBe("none");
      expect(outcome.result.snapshot.wikidata).toBeUndefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

// Type-level check that the snapshot shape the workflow layer reads is what this package exports.
const _shape: OnPageAuditSnapshot | undefined = undefined;
void _shape;
