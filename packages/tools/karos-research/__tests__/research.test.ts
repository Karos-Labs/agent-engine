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
});
