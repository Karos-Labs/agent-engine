import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosResearchTools } from "../src/index.js";
import { ScraperError, type ScrapedRecord, type ScraperProvider, type SearchOptions } from "@agent-engine/tool-karos-scraper";

/**
 * `web.search_web` (2026-09-23): the search Instagram's entity-imagery route
 * had been asking for since RFC-24 and no registry provided.
 */

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram", runKind: "recurring", metadata: {} };

function fakeScraper(answer: ScrapedRecord[] | Error): ScraperProvider & { calls: Array<{ query: string; opts: SearchOptions }> } {
  const calls: Array<{ query: string; opts: SearchOptions }> = [];
  return {
    name: "fake",
    calls,
    async searchKeyword(query, opts = {}) {
      calls.push({ query, opts });
      if (answer instanceof Error) throw answer;
      return answer;
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
    async searchSocial() {
      return [];
    },
  };
}

const hit = (url: string, title?: string, text?: string): ScrapedRecord => ({ id: url, url, ...(title ? { title } : {}), ...(text ? { text } : {}) });

describe("web.search_web", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-search-web-"));
    store = new WorkspaceStore(rootDir);
  });
  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("is registered under the exact name the Instagram workflow asks for", () => {
    const tools = createKarosResearchTools(store, { scraper: fakeScraper([]) });
    expect(tools["web.search_web"]).toBeDefined();
  });

  it("returns URLs in the shape `05b1` reads, drops non-http and duplicate rows, and caps at maxResults", async () => {
    const scraper = fakeScraper([
      hit("https://openai.com/news/", "Newsroom | OpenAI", "Press   releases and\nmedia assets."),
      hit("https://openai.com/news/"),
      hit("mailto:press@openai.com"),
      hit("https://openai.com/brand/", "Brand guidelines"),
      hit("https://example.com/extra"),
    ]);
    const tool = createKarosResearchTools(store, { scraper })["web.search_web"]!;
    const out = await tool.execute({ query: "OpenAI press room", maxResults: 2, includeDomains: ["openai.com"] }, { ctx });

    expect(out.status).toBe("success");
    const result = (out as { result: { results: Array<{ url: string; title?: string; snippet?: string }>; fromCache: boolean } }).result;
    expect(result.results.map((r) => r.url)).toEqual(["https://openai.com/news/", "https://openai.com/brand/"]);
    expect(result.results[0]!.snippet).toBe("Press releases and media assets.");
    expect(result.fromCache).toBe(false);
    expect(scraper.calls).toEqual([{ query: "OpenAI press room", opts: { limit: 2, includeDomains: ["openai.com"] } }]);
  });

  it("serves the same query from the cache inside the window, without a second billed search", async () => {
    const scraper = fakeScraper([hit("https://openai.com/news/")]);
    const tool = createKarosResearchTools(store, { scraper })["web.search_web"]!;
    await tool.execute({ query: "OpenAI press room" }, { ctx });
    const second = await tool.execute({ query: "  openai PRESS room " }, { ctx });

    expect(second.status).toBe("success");
    expect((second as { result: { fromCache: boolean } }).result.fromCache).toBe(true);
    expect(scraper.calls).toHaveLength(1);
  });

  it("reports not_available without a scraper, and a provider failure as a tooling_error, never an empty success", async () => {
    const bare = createKarosResearchTools(store, { scraper: null })["web.search_web"]!;
    expect((await bare.execute({ query: "OpenAI press room" }, { ctx })).status).toBe("not_available");

    const broken = createKarosResearchTools(store, { scraper: fakeScraper(new ScraperError("scrappycoco web.search_web returned 503", 503)) })["web.search_web"]!;
    expect((await broken.execute({ query: "OpenAI press room" }, { ctx })).status).toBe("tooling_error");
  });
});
