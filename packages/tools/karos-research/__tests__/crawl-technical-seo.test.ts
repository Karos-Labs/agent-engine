import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import { createOfflineScraper, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { createCrawlTechnicalSeo } from "../src/crawl-technical-seo.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring", metadata: {} };

describe("research.crawlTechnicalSeo (T-A1 crawl capabilities wired up as a tool, T-A2/SCRUM-236)", () => {
  it("reports not_available when no scraper is configured", async () => {
    const tool = createCrawlTechnicalSeo(undefined);
    const outcome = await tool.execute({ seedUrl: "https://acme.example" }, { ctx });
    expect(outcome.status).toBe("not_available");
  });

  it("reports not_available when the configured scraper doesn't implement the crawl capabilities", async () => {
    const bareScraper: ScraperProvider = {
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
      // No crawlSite/fetchRobots/fetchStatus/fetchSitemap — every crawl capability is optional.
    };
    const tool = createCrawlTechnicalSeo(bareScraper);
    const outcome = await tool.execute({ seedUrl: "https://acme.example" }, { ctx });
    expect(outcome.status).toBe("not_available");
  });

  it("returns a real, HTTP-derived snapshot from the offline fixture scraper — never a fabricated pass", async () => {
    const tool = createCrawlTechnicalSeo(createOfflineScraper());
    const outcome = await tool.execute({ seedUrl: "https://acme.example", limit: 5 }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const { snapshot } = outcome.result;
    expect(snapshot.seedUrl).toBe("https://acme.example");
    expect(snapshot.robots?.sitemaps).toEqual(["https://acme.example/sitemap.xml"]);
    expect(snapshot.sitemap?.entries.length).toBeGreaterThan(0);
    expect(snapshot.pages.length).toBeGreaterThan(0);
    for (const page of snapshot.pages) {
      expect(page.status).toBe(200);
      // The offline fixture never sends x-robots-tag, so noindex is a KNOWN false, not undefined.
      expect(page.noindex).toBe(false);
    }
  });

  it("detects a noindex header via x-robots-tag, and reports it distinctly from an unreadable page", async () => {
    const scraper: ScraperProvider = {
      name: "fake-headers",
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
      async crawlSite(seedUrl) {
        return {
          seedUrl,
          pages: [
            { url: `${seedUrl}/a`, status: 200 },
            { url: `${seedUrl}/b`, status: 200 },
            { url: `${seedUrl}/unreadable`, status: 200 },
          ],
          truncated: false,
        };
      },
      async fetchRobots(url) {
        return { url: `${new URL(url).origin}/robots.txt`, status: 200, groups: [{ userAgent: "*", disallow: [], allow: [] }], sitemaps: [] };
      },
      async fetchStatus(url) {
        if (url.endsWith("/a")) return { url, status: 200, ok: true, headers: { "x-robots-tag": "noindex" } };
        if (url.endsWith("/b")) return { url, status: 200, ok: true, headers: { "content-type": "text/html" } };
        throw new Error("simulated fetchStatus failure");
      },
    };
    const tool = createCrawlTechnicalSeo(scraper);
    const outcome = await tool.execute({ seedUrl: "https://acme.example" }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const byUrl = Object.fromEntries(outcome.result.snapshot.pages.map((p) => [p.url, p]));
    expect(byUrl["https://acme.example/a"]?.noindex).toBe(true);
    expect(byUrl["https://acme.example/b"]?.noindex).toBe(false);
    // The page whose per-page status re-check itself failed degrades to "unknown", never a guessed false.
    expect(byUrl["https://acme.example/unreadable"]?.noindex).toBeUndefined();
  });
});
