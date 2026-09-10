import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosResearchTools } from "../src/index.js";
import { ScraperError, type ScrapedRecord, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { outputHistorySegments } from "@agent-engine/tool-karos-ledger";

/**
 * A `ScraperProvider` stand-in that records every query, so a cache hit is
 * provable by the absence of a call rather than only by a `fromCache` flag.
 */
function fakeScraper(
  records: ScrapedRecord[] = [{ id: "a", url: "https://example.org/a", title: "T", text: "body" }],
  history: ScrapedRecord[] = [],
) {
  const queries: string[] = [];
  const historyCalls: Array<{ platform: string; username: string }> = [];
  const scraper: ScraperProvider = {
    name: "fake/scraper",
    async searchKeyword(query: string) {
      queries.push(query);
      return records;
    },
    async socialHistory(request) {
      historyCalls.push({ platform: request.platform, username: request.username });
      return history;
    },
    async extractUrl() {
      return records[0];
    },
    async searchSocial() {
      return records;
    },
    async fetchRaw() {
      return { url: "https://example.org/a", text: "body" };
    },
  };
  return { queries, historyCalls, scraper };
}

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

describe("karos-research", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createKarosResearchTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-research-"));
    store = new WorkspaceStore(rootDir);
    tools = createKarosResearchTools(store, { scraper: fakeScraper().scraper });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  describe("research.writeRun", () => {
    it("is idempotent on (job, runId)", async () => {
      const args = { job: "competitor-scan", runId: "run_a", query: "acme competitors", result: { hits: 3 } };
      const first = await tools["research.writeRun"]!.execute(args, { ctx });
      const second = await tools["research.writeRun"]!.execute(args, { ctx });

      expect(first).toEqual({ status: "success", result: { id: "competitor-scan__run_a", created: true } });
      expect(second).toEqual({ status: "success", result: { id: "competitor-scan__run_a", created: false } });

      const runs = await store.listJson("acme", ["research", "competitor-scan", "runs"]);
      expect(runs).toHaveLength(1);
    });
  });

  describe("research.getRuns", () => {
    it("returns runs newest-first, as summaries without the full result payload", async () => {
      await tools["research.writeRun"]!.execute({ job: "j", runId: "r1", query: "q1", result: { big: "payload" } }, { ctx });
      vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
      await tools["research.writeRun"]!.execute({ job: "j", runId: "r2", query: "q2", result: { big: "payload" } }, { ctx });

      const outcome = await tools["research.getRuns"]!.execute({ job: "j", limit: 20 }, { ctx });
      expect(outcome.status).toBe("success");
      const result = (outcome as { result: { runs: Array<{ runId: string }> } }).result;
      expect(result.runs.map((r) => r.runId)).toEqual(["r2", "r1"]);
      expect(result.runs[0]).not.toHaveProperty("result");
    });

    it("returns an empty list, not an error, for a job that has never run", async () => {
      const outcome = await tools["research.getRuns"]!.execute({ job: "never-run", limit: 20 }, { ctx });
      expect(outcome).toEqual({ status: "success", result: { runs: [] } });
    });
  });

  describe("research.checkFreshness", () => {
    it("returns not_available when the job has never run", async () => {
      const outcome = await tools["research.checkFreshness"]!.execute({ job: "never-run", window: "24h" }, { ctx });
      expect(outcome.status).toBe("not_available");
    });

    it("reports fresh when the latest run is inside the window", async () => {
      await tools["research.writeRun"]!.execute({ job: "j", runId: "r1", query: "q", result: {} }, { ctx });
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z")); // +1h

      const outcome = await tools["research.checkFreshness"]!.execute({ job: "j", window: "24h" }, { ctx });
      expect(outcome.status).toBe("success");
      const result = (outcome as { result: { fresh: boolean; ageMs: number } }).result;
      expect(result.fresh).toBe(true);
      expect(result.ageMs).toBe(60 * 60 * 1000);
    });

    it("reports stale once the latest run falls outside the window", async () => {
      await tools["research.writeRun"]!.execute({ job: "j", runId: "r1", query: "q", result: {} }, { ctx });
      vi.setSystemTime(new Date("2026-01-02T01:00:00Z")); // +25h

      const outcome = await tools["research.checkFreshness"]!.execute({ job: "j", window: "24h" }, { ctx });
      expect(outcome.status).toBe("success");
      expect((outcome as { result: { fresh: boolean } }).result.fresh).toBe(false);
    });

    it("treats the window boundary itself as fresh (age <= window)", async () => {
      await tools["research.writeRun"]!.execute({ job: "j", runId: "r1", query: "q", result: {} }, { ctx });
      vi.setSystemTime(new Date("2026-01-02T00:00:00Z")); // exactly +24h

      const outcome = await tools["research.checkFreshness"]!.execute({ job: "j", window: "24h" }, { ctx });
      expect((outcome as { result: { fresh: boolean } }).result.fresh).toBe(true);
    });

    it("AU12: answers from the latest.json pointer alone — never lists runs/ once the pointer exists", async () => {
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00Z") + i * 1000));
        await tools["research.writeRun"]!.execute({ job: "j", runId: `r${i}`, query: "q", result: {} }, { ctx });
      }
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));

      const listJsonSpy = vi.spyOn(store, "listJson");
      const outcome = await tools["research.checkFreshness"]!.execute({ job: "j", window: "24h" }, { ctx });

      expect(outcome.status).toBe("success");
      expect((outcome as { result: { lastRunId: string } }).result.lastRunId).toBe("r4");
      // The whole point of AU12's fix: a bounded pointer read, not a scan of
      // every historical run record on this "cache check" hot path.
      expect(listJsonSpy).not.toHaveBeenCalled();
      listJsonSpy.mockRestore();
    });
  });

  describe("research.pull", () => {
    it("performs a fresh pull and records a new run when nothing is cached", async () => {
      const outcome = await tools["research.pull"]!.execute({ job: "j", query: "acme trends", window: "24h" }, { ctx });
      expect(outcome.status).toBe("success");
      expect((outcome as { result: { fromCache: boolean } }).result.fromCache).toBe(false);

      const runs = await store.listJson("acme", ["research", "j", "runs"]);
      expect(runs).toHaveLength(1);
    });

    it("returns the cached run without pulling again when inside the freshness window", async () => {
      const first = await tools["research.pull"]!.execute({ job: "j", query: "acme trends", window: "24h" }, { ctx });
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z")); // +1h, inside 24h window
      const second = await tools["research.pull"]!.execute({ job: "j", query: "acme trends", window: "24h" }, { ctx });

      const firstRunId = (first as { result: { runId: string } }).result.runId;
      const secondResult = (second as { result: { runId: string; fromCache: boolean } }).result;
      expect(secondResult.fromCache).toBe(true);
      expect(secondResult.runId).toBe(firstRunId);

      const runs = await store.listJson("acme", ["research", "j", "runs"]);
      expect(runs).toHaveLength(1);
    });

    /**
     * THE CACHE IS KEYED ON THE QUESTION, NOT JUST THE JOB.
     *
     * It was keyed on `(clientSlug, job)` alone, and a live prep run showed the
     * cost. `instagram-agent` always passes `job: "instagram-carousel-research"`
     * with a 24h window, so its second run that day was handed the FIRST run's
     * research — about a different subject entirely — and drafted from it. The
     * trace even echoed the other run's query back, and nothing errored.
     *
     * The reuse this cache exists for is unaffected: the same question inside
     * the window still costs one pull, which the test above pins.
     */
    it("pulls again for a different subject inside the same window", async () => {
      const first = await tools["research.pull"]!.execute({ job: "j", query: "acme trends", window: "24h" }, { ctx });
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z")); // +1h, well inside the window
      const second = await tools["research.pull"]!.execute(
        { job: "j", query: "a completely different subject", window: "24h" },
        { ctx },
      );

      const secondResult = (second as { result: { runId: string; query: string; fromCache: boolean } }).result;
      expect(secondResult.fromCache).toBe(false);
      expect(secondResult.runId).not.toBe((first as { result: { runId: string } }).result.runId);
      // The returned query is the one that was ASKED. Returning the cached
      // run's query is how the original defect announced itself in the trace.
      expect(secondResult.query).toBe("a completely different subject");

      // Both runs recorded, so a later run of either subject can still reuse.
      const runs = await store.listJson("acme", ["research", "j", "runs"]);
      expect(runs).toHaveLength(2);
    });

    it("still reuses a cached subject that differs only in case or spacing", async () => {
      // Same question, typed differently. Refetching here would spend a scrape
      // to answer something already answered.
      const first = await tools["research.pull"]!.execute({ job: "j", query: "Acme Trends", window: "24h" }, { ctx });
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
      const second = await tools["research.pull"]!.execute({ job: "j", query: "  acme   trends ", window: "24h" }, { ctx });

      const secondResult = (second as { result: { runId: string; fromCache: boolean } }).result;
      expect(secondResult.fromCache).toBe(true);
      expect(secondResult.runId).toBe((first as { result: { runId: string } }).result.runId);
    });

    it("maps the scraper's records into citable documents, not a placeholder", async () => {
      const { scraper, queries } = fakeScraper([
        {
          id: "q3",
          url: "https://example.org/q3",
          title: "Q3 report",
          text: "body text",
          publishedAt: "2026-08-01T00:00:00.000Z",
          author: "Ann",
        },
      ]);
      const scoped = createKarosResearchTools(store, { scraper });

      const outcome = await scoped["research.pull"]!.execute({ job: "j2", query: "acme trends", window: "24h" }, { ctx });

      expect(outcome.status).toBe("success");
      const payload = (outcome as { result: { result: Record<string, unknown> } }).result.result;
      expect(payload["provider"]).toBe("fake/scraper");
      expect(payload["query"]).toBe("acme trends");
      expect(typeof payload["fetchedAt"]).toBe("string");
      expect(payload["documents"]).toEqual([
        {
          title: "Q3 report",
          url: "https://example.org/q3",
          content: "body text",
          publishedAt: "2026-08-01T00:00:00.000Z",
          author: "Ann",
        },
      ]);
      // No `note` when there are real documents, and no `history` key when the
      // caller asked for none.
      expect(payload["note"]).toBeUndefined();
      expect(payload["history"]).toBeUndefined();
      expect(queries).toEqual(["acme trends"]);
    });

    it("reports not_available with no scraper, rather than a placeholder that reads like data", async () => {
      // The whole point of the change: prep run pubsub-21066191524607951 had
      // the copy agent write a client-facing carousel about the missing
      // research pipeline, because a stand-in payload is indistinguishable
      // from a topic with nothing to say.
      const unconfigured = createKarosResearchTools(store, { scraper: null });

      const outcome = await unconfigured["research.pull"]!.execute({ job: "j3", query: "acme trends", window: "24h" }, { ctx });

      expect(outcome.status).toBe("not_available");
      expect((outcome as { reason: string }).reason).toContain("SCRAPPYCOCO_API_KEY");
      // Nothing is recorded, so a later configured run is not served a stale
      // placeholder from cache.
      expect(await store.listJson("acme", ["research", "j3", "runs"])).toHaveLength(0);
    });

    it("surfaces a scraper outage as tooling_error, never as an empty-but-successful payload", async () => {
      const { scraper } = fakeScraper();
      const broken = createKarosResearchTools(store, {
        scraper: {
          ...scraper,
          async searchKeyword() {
            throw new ScraperError("scrappycoco web.search_web returned 402 (account out of credit)", 402);
          },
        },
      });

      const outcome = await broken["research.pull"]!.execute({ job: "j4", query: "x", window: "24h" }, { ctx });

      expect(outcome.status).toBe("tooling_error");
      expect((outcome as { reason: string }).reason).toContain("out of credit");
    });

    it("marks an honestly-empty result with a note, so it is not mistaken for a failure", async () => {
      const empty = createKarosResearchTools(store, { scraper: fakeScraper([]).scraper });

      const outcome = await empty["research.pull"]!.execute({ job: "j5", query: "nothing at all", window: "24h" }, { ctx });

      expect(outcome.status).toBe("success");
      const payload = (outcome as { result: { result: Record<string, unknown> } }).result.result;
      expect(payload["documents"]).toEqual([]);
      expect(String(payload["note"])).toContain("no results");
    });

    it("folds this agent's prior deliverables in as anti-repetition context", async () => {
      // Written at the ledger's OWN path helper, not a string literal: that is
      // what proves research.pull and the ledger agree on where history lives.
      // A hardcoded path here would still pass if one side later moved.
      await store.writeJson("acme", outputHistorySegments("instagram-agent"), [
        { runId: "r1", excerpt: "Why AI pilots stall\nbody", recordedAt: 1_700_000_000_000 },
      ]);

      const { scraper } = fakeScraper();
      const scoped = createKarosResearchTools(store, { scraper });

      const outcome = await scoped["research.pull"]!.execute(
        { job: "j6", query: "acme trends", window: "24h", historyAgentId: "instagram-agent" },
        { ctx },
      );

      const payload = (outcome as { result: { result: Record<string, unknown> } }).result.result;
      const history = payload["history"] as { priorPosts: Array<Record<string, unknown>>; priorTopics: string[] };
      expect(history.priorPosts[0]).toMatchObject({ origin: "output-history", excerpt: expect.stringContaining("Why AI pilots stall") });
      // Topics are derived from the posts, so there is no second store to drift.
      expect(history.priorTopics).toEqual(["Why AI pilots stall"]);
    });

    it("reads the client's own recent social posts when accounts are named", async () => {
      const { scraper, historyCalls } = fakeScraper(undefined, [
        {
          id: "p1",
          url: "https://x.com/karoslabs/status/1",
          text: "Our take on AI bottlenecks",
          publishedAt: "2026-08-01T00:00:00.000Z",
          engagement: { likes: 12 },
        },
      ]);
      const scoped = createKarosResearchTools(store, { scraper });

      const outcome = await scoped["research.pull"]!.execute(
        { job: "j7", query: "acme trends", window: "24h", socialAccounts: [{ platform: "x", username: "@karoslabs" }] },
        { ctx },
      );

      const payload = (outcome as { result: { result: Record<string, unknown> } }).result.result;
      const history = payload["history"] as { priorPosts: Array<Record<string, unknown>> };
      expect(historyCalls).toEqual([{ platform: "x", username: "@karoslabs" }]);
      expect(history.priorPosts[0]).toMatchObject({
        origin: "x",
        url: "https://x.com/karoslabs/status/1",
        engagement: { likes: 12 },
      });
    });

    it("degrades a history failure to a note instead of failing the whole pull", async () => {
      // Live research is what a run cannot proceed without; losing the
      // anti-repetition context is a quality regression, not a reason to
      // publish nothing.
      const { scraper } = fakeScraper();
      const scoped = createKarosResearchTools(store, {
        scraper: {
          ...scraper,
          async socialHistory() {
            throw new ScraperError("scrappycoco x.account_posts returned 404");
          },
        },
      });

      const outcome = await scoped["research.pull"]!.execute(
        { job: "j8", query: "acme trends", window: "24h", socialAccounts: [{ platform: "x", username: "ghost" }] },
        { ctx },
      );

      expect(outcome.status).toBe("success");
      const payload = (outcome as { result: { result: Record<string, unknown> } }).result.result;
      const history = payload["history"] as { priorPosts: unknown[]; note?: string };
      expect(history.priorPosts).toEqual([]);
      // Named per account: "history unavailable" is useless when one of three
      // handles is wrong and the others worked.
      expect(String(history.note)).toContain("x/@ghost");
    });

    it("pulls again and records a new run once the cached run goes stale", async () => {
      const first = await tools["research.pull"]!.execute({ job: "j", query: "acme trends", window: "24h" }, { ctx });
      vi.setSystemTime(new Date("2026-01-02T01:00:00Z")); // +25h, outside 24h window
      const second = await tools["research.pull"]!.execute({ job: "j", query: "acme trends", window: "24h" }, { ctx });

      const firstRunId = (first as { result: { runId: string } }).result.runId;
      const secondResult = (second as { result: { runId: string; fromCache: boolean } }).result;
      expect(secondResult.fromCache).toBe(false);
      expect(secondResult.runId).not.toBe(firstRunId);

      const runs = await store.listJson("acme", ["research", "j", "runs"]);
      expect(runs).toHaveLength(2);
    });
  });

  /**
   * RFC-13 §J — per-call breadth and depth.
   *
   * One number used to serve two different jobs: the trend scout skimming a
   * dozen headlines and a fact-card extraction reading the paragraph a figure
   * sits in both got `maxResults: 4` (ceiling 10) and a hard-wired 4000
   * characters per document. Deep research needs 12+ documents at 6000
   * characters, and — the part that is not just a bigger number — it must
   * never be handed the scout's shallower answer out of the cache, because a
   * thin cache hit is indistinguishable from a thin web.
   */
  describe("research.pull — per-call breadth and depth (RFC-13 §J)", () => {
    /** A scraper whose documents are long enough to be truncated at any of the sizes under test, and which records the `SearchOptions` it was handed. */
    function sizedScraper(bodyChars = 9000) {
      const searchOptions: Array<Record<string, unknown> | undefined> = [];
      const { scraper } = fakeScraper();
      return {
        searchOptions,
        scraper: {
          ...scraper,
          async searchKeyword(query: string, opts: Record<string, unknown> = {}) {
            searchOptions.push(opts);
            const limit = typeof opts["limit"] === "number" ? opts["limit"] : 4;
            return Array.from({ length: limit }, (_, i) => ({
              id: `s${i}`,
              url: `https://example.org/${encodeURIComponent(query)}/${i}`,
              title: `Doc ${i}`,
              text: "x".repeat(bodyChars),
            }));
          },
        } as ScraperProvider,
      };
    }

    function documentsOf(outcome: unknown): Array<{ content?: string }> {
      return ((outcome as { result: { result: { documents: Array<{ content?: string }> } } }).result.result.documents);
    }

    it("truncates each document at `contentChars`, not at the module default", async () => {
      const scoped = createKarosResearchTools(store, { scraper: sizedScraper().scraper });

      const deep = await scoped["research.pull"]!.execute({ job: "deep", query: "q", window: "24h", contentChars: 6000 }, { ctx });
      const shallow = await scoped["research.pull"]!.execute({ job: "shallow", query: "q", window: "24h" }, { ctx });

      // `truncate` appends its own "[truncated at N characters]" marker, so the
      // assertion is on the prefix length and on the marker naming the size
      // actually asked for.
      expect(documentsOf(deep)[0]!.content!.startsWith("x".repeat(6000))).toBe(true);
      expect(documentsOf(deep)[0]!.content).toContain("truncated at 6000 characters");
      expect(documentsOf(shallow)[0]!.content).toContain("truncated at 4000 characters");
    });

    it("accepts maxResults up to 16 and rejects 17", async () => {
      const scoped = createKarosResearchTools(store, { scraper: sizedScraper().scraper });

      const wide = await scoped["research.pull"]!.execute({ job: "wide", query: "q", window: "24h", maxResults: 16 }, { ctx });
      expect(wide.status).toBe("success");
      expect(documentsOf(wide)).toHaveLength(16);

      const tooWide = await scoped["research.pull"]!.execute({ job: "wider", query: "q", window: "24h", maxResults: 17 }, { ctx });
      // `defineTool` rejects on the schema before `execute` ever runs.
      expect(tooWide.status).not.toBe("success");
    });

    it("refetches a shallower cached record for a deeper request, and still serves it for an equal one", async () => {
      const scoped = createKarosResearchTools(store, { scraper: sizedScraper().scraper });

      const shallow = await scoped["research.pull"]!.execute({ job: "j9", query: "acme trends", window: "24h" }, { ctx });
      const shallowRunId = (shallow as { result: { runId: string } }).result.runId;

      // Same question, same window, MORE depth: a 4000-character record cannot
      // honestly answer it.
      const deeper = await scoped["research.pull"]!.execute({ job: "j9", query: "acme trends", window: "24h", contentChars: 6000 }, { ctx });
      const deeperResult = (deeper as { result: { runId: string; fromCache: boolean } }).result;
      expect(deeperResult.fromCache).toBe(false);
      expect(deeperResult.runId).not.toBe(shallowRunId);
      expect(documentsOf(deeper)[0]!.content).toContain("truncated at 6000 characters");

      // The same question at a size the newest record covers is a cache hit
      // again — the reuse this cache exists for is unaffected.
      const equal = await scoped["research.pull"]!.execute({ job: "j9", query: "acme trends", window: "24h", contentChars: 6000 }, { ctx });
      expect((equal as { result: { fromCache: boolean; runId: string } }).result).toMatchObject({ fromCache: true, runId: deeperResult.runId });

      // And so is a request for LESS than what was fetched: a deep record
      // answers a shallow question.
      const narrower = await scoped["research.pull"]!.execute({ job: "j9", query: "acme trends", window: "24h", maxResults: 2 }, { ctx });
      expect((narrower as { result: { fromCache: boolean } }).result.fromCache).toBe(true);
    });

    it("treats a domain-restricted search as a different question from the open-web one", async () => {
      const { scraper, searchOptions } = sizedScraper();
      const scoped = createKarosResearchTools(store, { scraper });

      await scoped["research.pull"]!.execute({ job: "j10", query: "agency pricing", window: "7d", maxResults: 6 }, { ctx });
      const restricted = await scoped["research.pull"]!.execute(
        { job: "j10", query: "agency pricing", window: "7d", maxResults: 6, includeDomains: ["reddit.com", "quora.com"] },
        { ctx },
      );

      expect((restricted as { result: { fromCache: boolean } }).result.fromCache).toBe(false);
      // The restriction reaches the provider's own `SearchOptions` — the field
      // the ScrappyCoco adapter has always sent and no tool exposed.
      expect(searchOptions[0]).toEqual({ limit: 6 });
      expect(searchOptions[1]).toEqual({ limit: 6, includeDomains: ["reddit.com", "quora.com"] });

      // Asking the restricted question again is a hit; the open one is too.
      const again = await scoped["research.pull"]!.execute(
        { job: "j10", query: "agency pricing", window: "7d", maxResults: 6, includeDomains: ["QUORA.com", "reddit.com"] },
        { ctx },
      );
      expect((again as { result: { fromCache: boolean } }).result.fromCache).toBe(true);
      expect(searchOptions).toHaveLength(2);

      expect(await scoped["research.pull"]!.execute({ job: "j10", query: "agency pricing", window: "7d", maxResults: 6 }, { ctx })).toMatchObject({
        result: { fromCache: true },
      });
      expect(searchOptions).toHaveLength(2);
      expect(await scoped["research.pull"]!.execute({ job: "j10", query: "agency pricing", window: "7d", maxResults: 6, includeDomains: [] }, { ctx })).toMatchObject({
        result: { fromCache: true },
      });
    });

    it("keeps the cache-check hot path a pointer read: an identical repeat never lists runs/", async () => {
      // AU12's fix, preserved through the size-aware lookup: the historical
      // scan runs only when the pointer's record exists and cannot serve the
      // request, never for the ordinary same-question-same-size hit.
      const scoped = createKarosResearchTools(store, { scraper: sizedScraper().scraper });
      await scoped["research.pull"]!.execute({ job: "j11", query: "acme trends", window: "24h" }, { ctx });

      const listJsonSpy = vi.spyOn(store, "listJson");
      const again = await scoped["research.pull"]!.execute({ job: "j11", query: "acme trends", window: "24h" }, { ctx });

      expect((again as { result: { fromCache: boolean } }).result.fromCache).toBe(true);
      expect(listJsonSpy).not.toHaveBeenCalled();
      listJsonSpy.mockRestore();
    });

    /**
     * THE BYTE-IDENTICAL GUARANTEE.
     *
     * Every other agent in the engine calls this tool with `job`/`query`/
     * `window` and nothing else. Three new options are worth nothing if one of
     * them silently changed what those callers get, so this pins the whole
     * payload — including the truncation marker's size — for that exact call.
     */
    it("leaves a default-options caller's payload unchanged", async () => {
      const scoped = createKarosResearchTools(store, {
        scraper: {
          ...fakeScraper().scraper,
          async searchKeyword() {
            return [{ id: "q3", url: "https://example.org/q3", title: "Q3 report", text: "body text", publishedAt: "2026-08-01T00:00:00.000Z", author: "Ann" }];
          },
        } as ScraperProvider,
      });

      const outcome = await scoped["research.pull"]!.execute({ job: "snapshot", query: "acme trends", window: "24h" }, { ctx });

      expect(outcome.status).toBe("success");
      expect((outcome as { result: { result: unknown } }).result.result).toEqual({
        provider: "fake/scraper",
        query: "acme trends",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        documents: [
          {
            title: "Q3 report",
            url: "https://example.org/q3",
            content: "body text",
            publishedAt: "2026-08-01T00:00:00.000Z",
            author: "Ann",
          },
        ],
      });
    });
  });

  describe("research.captureVisibility", () => {
    const args = {
      promptId: "p1",
      promptText: "who are the best acme alternatives?",
      engine: "chatgpt" as const,
      clientDomains: ["acme.com"],
      window: "24h",
    };

    it("performs a fresh capture and records a new run when nothing is cached for this (engine, promptId)", async () => {
      const outcome = await tools["research.captureVisibility"]!.execute(args, { ctx });
      expect(outcome.status).toBe("success");
      const result = (outcome as { result: { fromCache: boolean; cell: { captureTier: string; engine: string } } }).result;
      expect(result.fromCache).toBe(false);
      expect(result.cell.engine).toBe("chatgpt");
      // Phase 1 has no real capture adapter wired up — honestly UNAVAILABLE, never a fabricated answer.
      expect(result.cell.captureTier).toBe("UNAVAILABLE");
    });

    it("caches per (engine, promptId), not per generic job — a different prompt or engine never collides", async () => {
      await tools["research.captureVisibility"]!.execute(args, { ctx });
      const otherPrompt = await tools["research.captureVisibility"]!.execute({ ...args, promptId: "p2" }, { ctx });
      const otherEngine = await tools["research.captureVisibility"]!.execute({ ...args, engine: "claude" }, { ctx });

      expect((otherPrompt as { result: { fromCache: boolean } }).result.fromCache).toBe(false);
      expect((otherEngine as { result: { fromCache: boolean } }).result.fromCache).toBe(false);
    });

    it("returns the cached cell without recapturing when inside the freshness window", async () => {
      const first = await tools["research.captureVisibility"]!.execute(args, { ctx });
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z")); // +1h, inside 24h window
      const second = await tools["research.captureVisibility"]!.execute(args, { ctx });

      const firstRunId = (first as { result: { runId: string } }).result.runId;
      const secondResult = (second as { result: { runId: string; fromCache: boolean } }).result;
      expect(secondResult.fromCache).toBe(true);
      expect(secondResult.runId).toBe(firstRunId);
    });

    it("recaptures once the cached cell goes stale", async () => {
      const first = await tools["research.captureVisibility"]!.execute(args, { ctx });
      vi.setSystemTime(new Date("2026-01-02T01:00:00Z")); // +25h, outside 24h window
      const second = await tools["research.captureVisibility"]!.execute(args, { ctx });

      const firstRunId = (first as { result: { runId: string } }).result.runId;
      const secondResult = (second as { result: { runId: string; fromCache: boolean } }).result;
      expect(secondResult.fromCache).toBe(false);
      expect(secondResult.runId).not.toBe(firstRunId);
    });
  });

  // SCRUM-320 (AU29): frozen raw-payload hashing, immutable capture_tier, and
  // the pre-flight credit probe's per-cell 402 mapping to UNAVAILABLE.
  describe("research.captureVisibility — raw-payload freeze + credit probe (SCRUM-320 / AU29)", () => {
    const args = {
      promptId: "p1",
      promptText: "who are the best acme alternatives?",
      engine: "perplexity" as const,
      clientDomains: ["acme.com"],
      window: "24h",
    };

    it("freezes a rawSha256 on every cell, including the honest UNAVAILABLE stand-in, and tags the reason distinctly from a credit-probe rejection", async () => {
      const outcome = await tools["research.captureVisibility"]!.execute(args, { ctx });
      const result = (outcome as { result: { cell: { rawSha256?: string; unavailableReason?: string } } }).result;
      expect(result.cell.rawSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.cell.unavailableReason).toBe("no_adapter_wired");
    });

    it("maps a per-cell 402 credit-probe rejection to UNAVAILABLE without affecting a sibling cell in the same batch (tiering is per cell, not a binary per-engine flip)", async () => {
      const rejectedPromptIds = new Set(["p1"]);
      const probeTools = createKarosResearchTools(store, {
        visibilityCreditProbe: async (_engine, promptId) => (rejectedPromptIds.has(promptId) ? { ok: false, status: 402 } : { ok: true }),
      });

      const rejected = await probeTools["research.captureVisibility"]!.execute({ ...args, promptId: "p1" }, { ctx });
      const allowed = await probeTools["research.captureVisibility"]!.execute({ ...args, promptId: "p2" }, { ctx });

      const rejectedCell = (rejected as { result: { cell: { captureTier: string; unavailableReason?: string } } }).result.cell;
      const allowedCell = (allowed as { result: { cell: { captureTier: string; unavailableReason?: string } } }).result.cell;
      expect(rejectedCell.captureTier).toBe("UNAVAILABLE");
      expect(rejectedCell.unavailableReason).toBe("credit_probe_402");
      // The sibling cell in the same batch was never touched by the other cell's 402 — its own probe passed.
      expect(allowedCell.captureTier).toBe("UNAVAILABLE");
      expect(allowedCell.unavailableReason).toBe("no_adapter_wired");
    });

    it("never silently upgrades a frozen cell on a cache hit, even if the probe would now behave differently — the probe is not re-consulted inside the freshness window", async () => {
      let probeCalls = 0;
      const probeTools = createKarosResearchTools(store, {
        visibilityCreditProbe: async () => {
          probeCalls += 1;
          // If the tool re-probed on the cache-hit path, this second call would
          // flip the reason from credit_probe_402 to no_adapter_wired — proving
          // any observed change came from a live re-probe, not from freezing.
          return probeCalls === 1 ? { ok: false, status: 402 } : { ok: true };
        },
      });

      const first = await probeTools["research.captureVisibility"]!.execute(args, { ctx });
      const firstResult = (first as { result: { runId: string; cell: { unavailableReason?: string } } }).result;
      expect(firstResult.cell.unavailableReason).toBe("credit_probe_402");

      vi.setSystemTime(new Date("2026-01-01T01:00:00Z")); // +1h, inside the 24h window
      const second = await probeTools["research.captureVisibility"]!.execute(args, { ctx });
      const secondResult = (second as { result: { runId: string; fromCache: boolean; cell: { unavailableReason?: string } } }).result;

      expect(secondResult.fromCache).toBe(true);
      expect(secondResult.runId).toBe(firstResult.runId);
      expect(secondResult.cell.unavailableReason).toBe("credit_probe_402"); // frozen, not silently upgraded
      expect(probeCalls).toBe(1); // the probe was never re-consulted for a cache hit
    });

    it("does re-probe once the cached cell goes stale — freezing applies within the window, not forever", async () => {
      let probeCalls = 0;
      const probeTools = createKarosResearchTools(store, {
        visibilityCreditProbe: async () => {
          probeCalls += 1;
          return { ok: false, status: 402 };
        },
      });

      const first = await probeTools["research.captureVisibility"]!.execute(args, { ctx });
      vi.setSystemTime(new Date("2026-01-02T01:00:00Z")); // +25h, outside the 24h window
      const second = await probeTools["research.captureVisibility"]!.execute(args, { ctx });

      const firstRunId = (first as { result: { runId: string } }).result.runId;
      const secondResult = (second as { result: { runId: string; fromCache: boolean } }).result;
      expect(secondResult.fromCache).toBe(false);
      expect(secondResult.runId).not.toBe(firstRunId);
      expect(probeCalls).toBe(2);
    });
  });

  describe("tenant scoping", () => {
    it("ignores a model-supplied clientSlug override in favor of ctx.clientSlug", async () => {
      await tools["research.writeRun"]!.execute(
        { job: "j", runId: "r1", query: "q", result: {}, clientSlug: "attacker-corp" } as never,
        { ctx },
      );

      const attackerRuns = await store.listJson("attacker-corp", ["research", "j", "runs"]);
      expect(attackerRuns).toHaveLength(0);
      const acmeRuns = await store.listJson("acme", ["research", "j", "runs"]);
      expect(acmeRuns).toHaveLength(1);
    });
  });

  /**
   * SCRUM-321 (AU37) — the additive visual-pattern read path on `research.pull`.
   *
   * Self-contained on purpose: it touches nothing the blocks above set up, so
   * a later merge that restructures the documents/history half of the payload
   * (Batch 2's SCRUM-236 rewires seo-geo steps 05/06 around exactly that)
   * collides with none of it.
   */
  describe("research.pull — visual patterns (SCRUM-321/AU37)", () => {
    /** The shape `media.ingestVisualPatterns` writes. Seeded directly here so this test needs no vision model. */
    const profile = {
      schema: "karos.visual-patterns/v1",
      version: 1,
      versionId: "v0001",
      clientSlug: "acme",
      generatedAt: "2026-01-01T00:00:00.000Z",
      generatedBy: { tool: "media.ingestVisualPatterns", toolVersion: "1.0.0", visionModel: "m", scraper: "fake/scraper" },
      consent: { grantedBy: "ops@karoslabs.test", accountsRead: [{ platform: "instagram", username: "acmecoffee" }] },
      review: { status: "unreviewed" },
      summary: "Warm interiors, one human subject, captions that open on a question.",
      patterns: [
        {
          label: "warm interior light",
          observation: "Every top post is lit by low, warm indoor light.",
          appliesTo: "colour",
          evidence: ["https://social.test/p1"],
          confidence: "high",
        },
      ],
      templateHints: ["full-bleed photo with the caption below"],
      sourcePosts: [],
      coverage: { accountsRequested: 1, accountsConsented: 1, postsSeen: 3, postsAnalysed: 2, problems: [] },
    };

    async function seedProfile(): Promise<void> {
      await store.writeJson("acme", ["client", "visual-patterns", "v0001"], profile);
    }
    async function seedConsent(status: "granted" | "revoked"): Promise<void> {
      await store.writeJson("acme", ["client", "consent"], {
        visualPatternIngestion: { status, accounts: [{ platform: "instagram", username: "acmecoffee" }] },
      });
    }
    async function pull(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const outcome = await tools["research.pull"]!.execute(
        { job: "j", query: "acme trends", window: "24h", ...args } as never,
        { ctx },
      );
      expect(outcome.status).toBe("success");
      return (outcome as { result: { result: Record<string, unknown> } }).result.result;
    }

    it("folds the client's own house style into the payload when the caller opts in and consent is granted", async () => {
      await seedConsent("granted");
      await seedProfile();

      const payload = await pull({ includeVisualPatterns: true });
      const patterns = payload["visualPatterns"] as {
        versionId: string;
        reviewStatus: string;
        reference: string;
        templateHints: string[];
      };

      expect(patterns.versionId).toBe("v0001");
      expect(patterns.reviewStatus).toBe("unreviewed");
      expect(patterns.reference).toContain("warm interior light");
      expect(patterns.reference).toContain("has not been reviewed by a human yet");
      expect(patterns.templateHints).toEqual(["full-bleed photo with the caption below"]);
      // Still a third key beside the two halves the payload already had.
      expect(payload["documents"]).toBeDefined();
    });

    it("omits the key entirely when the caller does not opt in", async () => {
      await seedConsent("granted");
      await seedProfile();

      const payload = await pull({});
      expect(payload).not.toHaveProperty("visualPatterns");
    });

    it("omits the key when a profile exists but consent has been revoked", async () => {
      await seedConsent("revoked");
      await seedProfile();

      const payload = await pull({ includeVisualPatterns: true });
      expect(payload).not.toHaveProperty("visualPatterns");
    });

    it("omits the key when no consent record exists at all, even with a stored profile", async () => {
      await seedProfile();

      const payload = await pull({ includeVisualPatterns: true });
      expect(payload).not.toHaveProperty("visualPatterns");
    });

    it("omits the key for a consenting client that has never been ingested", async () => {
      await seedConsent("granted");

      const payload = await pull({ includeVisualPatterns: true });
      expect(payload).not.toHaveProperty("visualPatterns");
    });
  });
});
