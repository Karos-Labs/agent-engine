import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosResearchTools } from "../src/index.js";
import { ScraperError, type ScrapedRecord, type ScraperProvider } from "@agent-engine/tool-karos-scraper";

/**
 * `research.socialHistory` (2026-09): the client's own recent posts, cached
 * per account set, for the cross-channel anti-repetition read.
 */

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", metadata: {} };

function fakeScraper(posts: Record<string, ScrapedRecord[] | Error>): ScraperProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    calls,
    async socialHistory(request) {
      const key = `${request.platform}/${request.username}`;
      calls.push(key);
      const answer = posts[key];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    async searchKeyword() {
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

const post = (url: string, text: string): ScrapedRecord => ({ id: url, url, text, publishedAt: "2026-09-05T10:00:00.000Z" });

describe("research.socialHistory", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-social-history-"));
    store = new WorkspaceStore(rootDir);
  });
  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("reads every account, strips the @, excerpts the text, and serves the second read from the cache", async () => {
    const scraper = fakeScraper({
      "x/acmehq": [post("https://x.com/acmehq/status/1", "We shipped four-day scheduling."), post("https://x.com/acmehq/status/2", "")],
      "instagram/acme": [post("https://instagram.com/p/9", "A carousel about anchor days.")],
    });
    const tool = createKarosResearchTools(store, { scraper })["research.socialHistory"]!;
    const first = await tool.execute({ accounts: [{ platform: "x", username: "@acmehq" }, { platform: "instagram", username: "acme" }] }, { ctx });
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("unreachable");
    const result = first.result as { posts: Array<{ platform: string; username: string; excerpt: string }>; fromCache: boolean; problems: string[] };
    // The empty post is dropped; the handle lost its @.
    expect(result.posts.map((p) => `${p.platform}/${p.username}: ${p.excerpt}`)).toEqual([
      "x/acmehq: We shipped four-day scheduling.",
      "instagram/acme: A carousel about anchor days.",
    ]);
    expect(result.fromCache).toBe(false);
    expect(scraper.calls).toEqual(["x/acmehq", "instagram/acme"]);

    // Same accounts, different order and casing: the cache answers, no scrape.
    const second = await tool.execute({ accounts: [{ platform: "instagram", username: "Acme" }, { platform: "x", username: "acmehq" }] }, { ctx });
    expect(second.status).toBe("success");
    if (second.status !== "success") throw new Error("unreachable");
    expect((second.result as { fromCache: boolean }).fromCache).toBe(true);
    expect(scraper.calls).toHaveLength(2);
  });

  it("names a single unreadable account as a problem, fails as tooling only when every account failed, and is not_available without a scraper", async () => {
    const scraper = fakeScraper({ "x/acmehq": [post("https://x.com/acmehq/status/1", "Fine.")], "tiktok/acme": new ScraperError("429 rate limited", 429) });
    const tool = createKarosResearchTools(store, { scraper })["research.socialHistory"]!;
    const mixed = await tool.execute({ accounts: [{ platform: "x", username: "acmehq" }, { platform: "tiktok", username: "acme" }] }, { ctx });
    expect(mixed.status).toBe("success");
    if (mixed.status !== "success") throw new Error("unreachable");
    expect((mixed.result as { problems: string[] }).problems.join(" ")).toMatch(/tiktok\/@acme: 429/);

    const allFailing = fakeScraper({ "x/other": new ScraperError("down", 503) });
    const failing = createKarosResearchTools(store, { scraper: allFailing })["research.socialHistory"]!;
    expect((await failing.execute({ accounts: [{ platform: "x", username: "other" }] }, { ctx })).status).toBe("tooling_error");

    const none = createKarosResearchTools(store, { scraper: null })["research.socialHistory"]!;
    expect((await none.execute({ accounts: [{ platform: "x", username: "acmehq" }] }, { ctx })).status).toBe("not_available");
  });
});
