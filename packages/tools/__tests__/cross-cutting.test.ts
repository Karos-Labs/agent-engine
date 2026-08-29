import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createAllKarosTools } from "../src/index.js";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";

/**
 * These tests exercise the NINE karos-* servers through the one merged
 * registry (`createAllKarosTools`) rather than re-deriving every case each
 * package's own test suite already covers — the point here is proving the
 * composed registry behaves correctly end to end on the four properties
 * RFC-01 §9.1 treats as non-negotiable, not duplicating per-package coverage.
 */

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

describe("Layer 3 tool registry — cross-cutting", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createAllKarosTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-tools-cross-"));
    store = new WorkspaceStore(rootDir);
    // `createOfflineScraper()` passed explicitly: `research.pull` reports
    // not_available without a real scraper rather than returning a placeholder
    // (see karos-research/src/pull.ts). Tests still need deterministic offline
    // data, so they opt in; nothing in `apps/src` does.
    tools = createAllKarosTools(store, undefined, { scraper: createOfflineScraper() });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("merges all ten servers' tools into one registry with no name collisions", () => {
    const expectedPrefixes = ["client.", "gate.", "intel.", "ledger.", "memory.", "publish.", "reputation.", "research.", "seoGeo.", "topics."];
    const names = Object.keys(tools);
    // 9 client + 6 gates + 2 intel + 8 ledger + 7 memory + 4 publish + 3 reputation + 5 research + 2 seoGeo + 4 topics = 50
    // (client grew from 8 to 9: client.getKnowledge reads the knowledge base the
    // portal's sync mirrors into the workspace — onboarding context docs, recent
    // meeting summaries, the reference-asset index. See
    // packages/tools/karos-client/src/get-knowledge.ts.)
    // (client grew from 7 to 8: client.getStrategy reads a client's per-agent
    // setup document — the filled-in account intake saying what an account is
    // chartered to post and what it must never post — which nothing in the
    // engine could read before. See packages/tools/karos-client/src/get-strategy.ts.)
    // (ledger grew from 5 to 7: P0 parity-audit Fix 3 added ledger.recordUsedImages/ledger.listUsedImages
    // for cross-post image-reuse prevention — see agents/instagram-agent/src/workflow/craft-hygiene.ts's
    // sibling, create-instagram-agent-workflow.ts. reputation.* is new: RFC-08's triage/capture/doctrineGate —
    // reputation.publish is deliberately absent, permanently gated inside agents/reputation-agent's own workflow.)
    // (ledger grew from 7 to 9: ledger.recordOutputExcerpt/ledger.listOutputExcerpts
    // back the dynamic runner's output de-duplication — a bounded per-client,
    // per-agent excerpt log, kept separate from writeDeliverable's records
    // because those nest by runId and cannot be enumerated for comparison.)
    // (memory grew from 5 to 7: memory.appendFeedback/memory.readFeedback back
    // the universal review cycle's feedback flywheel — every approve/revise/
    // reject decision persists here, and the next drafting prompt reads it
    // back. See packages/workflow/src/primitives/review-cycle.ts.)
    // (ledger shrank from 9 to 8, AU22: ledger.feedbackAppend retired — it wrote
    // to ["ledger","feedback",...] but nothing ever read that path. Every
    // former caller now goes through memory.appendFeedback/memory.readFeedback
    // above instead, the one real feedback pipeline. See createKarosLedgerTools's
    // own doc comment in packages/tools/karos-ledger/src/index.ts.)
    expect(names.length).toBe(50);
    for (const prefix of expectedPrefixes) {
      expect(names.some((n) => n.startsWith(prefix))).toBe(true);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  describe("1. idempotency — ledger and topic reservation writes", () => {
    it("ledger.writeDeliverable: a retried write on the same (runId, slotId, kind) never duplicates the record", async () => {
      const args = { runId: "run_1", slotId: "slot_1", kind: "linkedin-post", deliverable: { body: "v1" } };
      const first = await tools["ledger.writeDeliverable"]!.execute(args, { ctx });
      const second = await tools["ledger.writeDeliverable"]!.execute({ ...args, deliverable: { body: "v2" } }, { ctx });

      expect(first).toEqual({ status: "success", result: { id: "run_1__slot_1__linkedin-post", created: true } });
      expect(second).toEqual({ status: "success", result: { id: "run_1__slot_1__linkedin-post", created: false } });

      const rows = await store.listJson("acme", ["ledger", "deliverables", "run_1", "slot_1"]);
      expect(rows).toHaveLength(1);
      expect((rows[0]!.data as { deliverable: unknown }).deliverable).toEqual({ body: "v2" });
    });

    it("topics.reserve: a retried reservation on the same reservationKey returns the same topics instead of consuming more of the floor", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a", "b", "c"] }, { ctx });

      const first = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 2, excludeTopics: [] }, { ctx });
      const second = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 2, excludeTopics: [] }, { ctx });

      expect(first.status === "success" ? first.result : null).toMatchObject({ created: true });
      expect(second.status === "success" ? second.result : null).toMatchObject({ created: false });
      expect((first as { result: { topics: string[] } }).result.topics).toEqual((second as { result: { topics: string[] } }).result.topics);

      // Only 1 topic left ("c") — a THIRD, different reservation can take at most that one.
      const third = await tools["topics.reserve"]!.execute({ reservationKey: "res_2", count: 2, excludeTopics: [] }, { ctx });
      expect(third.status).toBe("content_fail");
    });

    it("topics.commit: committing the same reservationKey twice is a no-op, never double-consuming the catalog", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a"] }, { ctx });
      await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 1, excludeTopics: [] }, { ctx });

      const first = await tools["topics.commit"]!.execute({ reservationKey: "res_1" }, { ctx });
      const second = await tools["topics.commit"]!.execute({ reservationKey: "res_1" }, { ctx });

      expect(first.status === "success" ? first.result : null).toMatchObject({ alreadyCommitted: false });
      expect(second.status === "success" ? second.result : null).toMatchObject({ alreadyCommitted: true });
    });
  });

  describe("2. freshness window validation — karos-research", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("checkFreshness is not_available before the job has ever run, then fresh, then stale as the window elapses", async () => {
      const beforeAnyRun = await tools["research.checkFreshness"]!.execute({ job: "competitor-scan", window: "24h" }, { ctx });
      expect(beforeAnyRun.status).toBe("not_available");

      await tools["research.writeRun"]!.execute({ job: "competitor-scan", runId: "r1", query: "q", result: {} }, { ctx });

      vi.setSystemTime(new Date("2026-01-01T12:00:00Z")); // +12h
      const fresh = await tools["research.checkFreshness"]!.execute({ job: "competitor-scan", window: "24h" }, { ctx });
      expect((fresh as { result: { fresh: boolean } }).result.fresh).toBe(true);

      vi.setSystemTime(new Date("2026-01-03T00:00:00Z")); // +48h
      const stale = await tools["research.checkFreshness"]!.execute({ job: "competitor-scan", window: "24h" }, { ctx });
      expect((stale as { result: { fresh: boolean } }).result.fresh).toBe(false);
    });

    it("research.pull serves the cached run inside the window, and re-pulls once it goes stale", async () => {
      const first = await tools["research.pull"]!.execute({ job: "trend-scan", query: "acme trends", window: "24h" }, { ctx });
      expect((first as { result: { fromCache: boolean } }).result.fromCache).toBe(false);

      vi.setSystemTime(new Date("2026-01-01T06:00:00Z")); // +6h, inside window
      const cached = await tools["research.pull"]!.execute({ job: "trend-scan", query: "acme trends", window: "24h" }, { ctx });
      expect((cached as { result: { fromCache: boolean; runId: string } }).result.fromCache).toBe(true);
      expect((cached as { result: { runId: string } }).result.runId).toBe((first as { result: { runId: string } }).result.runId);

      vi.setSystemTime(new Date("2026-01-03T00:00:00Z")); // +48h, outside window
      const refetched = await tools["research.pull"]!.execute({ job: "trend-scan", query: "acme trends", window: "24h" }, { ctx });
      expect((refetched as { result: { fromCache: boolean } }).result.fromCache).toBe(false);

      const runs = await store.listJson("acme", ["research", "trend-scan", "runs"]);
      expect(runs).toHaveLength(2);
    });
  });

  describe("3. deterministic pass/fail across every karos-gate", () => {
    it.each([
      ["gate.lintPost", { text: "A perfectly fine post.", platform: "linkedin" }, "pass"],
      ["gate.lintPost", { text: "   " }, "content_fail"],
      ["gate.noPlaceholder", { text: "The launch ships next week." }, "pass"],
      ["gate.noPlaceholder", { text: "TODO: fill this in" }, "content_fail"],
      ["gate.brandCompliance", { text: "We help you grow." }, "pass"],
      ["gate.brandCompliance", { text: "This is the cheapest option.", forbiddenTerms: ["cheapest"] }, "content_fail"],
      ["gate.leakCheck", { text: "We shipped a new feature." }, "pass"],
      ["gate.leakCheck", { text: "key: sk-abcdefghijklmnopqrstuvwxyz123456" }, "content_fail"],
      ["gate.numbersSourced", { text: "We had a good quarter." }, "pass"],
      ["gate.numbersSourced", { text: "Revenue grew 43% year over year." }, "content_fail"],
    ] as const)("%s is deterministic: %j -> %s", async (toolName, args, expectedVerdict) => {
      const tool = tools[toolName]!;
      const outcomeA = await tool.execute(args, { ctx });
      const outcomeB = await tool.execute(args, { ctx });

      expect(outcomeA.status).toBe("success");
      expect(outcomeA).toEqual(outcomeB); // deterministic: same input, same verdict, every time
      const verdict = (outcomeA as { result: { verdict: string } }).result.verdict;
      expect(verdict).toBe(expectedVerdict);
    });
  });

  describe("4. tenant-override rejection across servers", () => {
    const attacker = "attacker-corp";

    it("client.getProfile ignores a model-supplied clientSlug override", async () => {
      await store.writeJson("acme", ["client", "profile"], { name: "Acme Corp" });
      const outcome = await tools["client.getProfile"]!.execute({ clientSlug: attacker } as never, { ctx });
      expect(outcome).toEqual({ status: "success", result: { name: "Acme Corp" } });
      expect(await store.exists(attacker, ["client", "profile"])).toBe(false);
    });

    it("ledger.writeDeliverable ignores a model-supplied clientSlug override", async () => {
      await tools["ledger.writeDeliverable"]!.execute(
        { runId: "run_1", kind: "linkedin-post", deliverable: {}, clientSlug: attacker } as never,
        { ctx },
      );
      expect(await store.exists(attacker, ["ledger", "deliverables", "run_1", "_", "linkedin-post"])).toBe(false);
      expect(await store.exists("acme", ["ledger", "deliverables", "run_1", "_", "linkedin-post"])).toBe(true);
    });

    it("topics.topUp ignores a model-supplied clientSlug override", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a"], clientSlug: attacker } as never, { ctx });
      expect(await store.exists(attacker, ["topics", "catalog"])).toBe(false);
      expect(await store.exists("acme", ["topics", "catalog"])).toBe(true);
    });

    it("research.writeRun ignores a model-supplied clientSlug override", async () => {
      await tools["research.writeRun"]!.execute(
        { job: "j", runId: "r1", query: "q", result: {}, clientSlug: attacker } as never,
        { ctx },
      );
      expect(await store.exists(attacker, ["research", "j", "runs", "r1"])).toBe(false);
      expect(await store.exists("acme", ["research", "j", "runs", "r1"])).toBe(true);
    });

    it("memory.updateBeliefs ignores a model-supplied clientSlug override", async () => {
      await tools["memory.updateBeliefs"]!.execute({ diff: { a: 1 }, clientSlug: attacker } as never, { ctx });
      expect(await store.exists(attacker, ["memory", "beliefs"])).toBe(false);
      expect(await store.readJson("acme", ["memory", "beliefs"])).toEqual({ a: 1 });
    });

    it("publish.draft ignores a model-supplied clientSlug override", async () => {
      await tools["publish.draft"]!.execute(
        { draftId: "d1", platform: "linkedin", content: {}, clientSlug: attacker } as never,
        { ctx },
      );
      expect(await store.exists(attacker, ["publish", "drafts", "d1"])).toBe(false);
      expect(await store.exists("acme", ["publish", "drafts", "d1"])).toBe(true);
    });
  });
});
