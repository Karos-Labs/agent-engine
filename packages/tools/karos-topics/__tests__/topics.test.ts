import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosTopicsTools } from "../src/index.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

describe("karos-topics", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createKarosTopicsTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-topics-"));
    store = new WorkspaceStore(rootDir);
    tools = createKarosTopicsTools(store);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  describe("topics.topUp", () => {
    it("adds new topics and dedupes by trimmed, lowercased form", async () => {
      const first = await tools["topics.topUp"]!.execute({ topics: ["Remote Work", "AI Tools"] }, { ctx });
      expect(first).toEqual({ status: "success", result: { added: 2, catalogSize: 2 } });

      const second = await tools["topics.topUp"]!.execute({ topics: ["remote work  ", "New Topic"] }, { ctx });
      expect(second).toEqual({ status: "success", result: { added: 1, catalogSize: 3 } });
    });
  });

  describe("topics.reserve", () => {
    it("reserves the requested count from the available floor", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a", "b", "c"] }, { ctx });
      const result = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 2, excludeTopics: [] }, { ctx });

      expect(result.status).toBe("success");
      expect(result.status === "success" ? result.result : null).toMatchObject({ reservationKey: "res_1", created: true });
      expect((result as { result: { topics: string[] } }).result.topics).toHaveLength(2);
    });

    it("is idempotent on reservationKey: replaying returns the same topics without consuming more", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a", "b", "c", "d"] }, { ctx });
      const first = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 2, excludeTopics: [] }, { ctx });
      const second = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 2, excludeTopics: [] }, { ctx });

      expect(first).toEqual({ status: "success", result: { reservationKey: "res_1", topics: ["a", "b"], created: true } });
      expect(second).toEqual({ status: "success", result: { reservationKey: "res_1", topics: ["a", "b"], created: false } });
    });

    it("fails when fewer topics are available than requested", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a"] }, { ctx });
      const result = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 5, excludeTopics: [] }, { ctx });
      expect(result.status).toBe("content_fail");
    });

    it("never reserves the same topic for two different reservation keys", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a", "b"] }, { ctx });
      const first = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 2, excludeTopics: [] }, { ctx });
      const second = await tools["topics.reserve"]!.execute({ reservationKey: "res_2", count: 1, excludeTopics: [] }, { ctx });

      // The floor only had 2 topics, both consumed by res_1 — res_2 must find none available.
      expect(second.status).toBe("content_fail");
      expect(first.status).toBe("success");
    });

    it("respects excludeTopics", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a", "b"] }, { ctx });
      const result = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 1, excludeTopics: ["a"] }, { ctx });
      expect((result as { result: { topics: string[] } }).result.topics).toEqual(["b"]);
    });
  });

  describe("topics.commit", () => {
    it("consumes the reservation's topics for good, and is idempotent on replay", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a", "b"] }, { ctx });
      await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 2, excludeTopics: [] }, { ctx });

      const first = await tools["topics.commit"]!.execute({ reservationKey: "res_1" }, { ctx });
      const second = await tools["topics.commit"]!.execute({ reservationKey: "res_1" }, { ctx });

      expect(first).toEqual({ status: "success", result: { reservationKey: "res_1", topics: ["a", "b"], alreadyCommitted: false } });
      expect(second).toEqual({ status: "success", result: { reservationKey: "res_1", topics: ["a", "b"], alreadyCommitted: true } });
    });

    it("returns not_available for an unknown reservationKey", async () => {
      const outcome = await tools["topics.commit"]!.execute({ reservationKey: "nope" }, { ctx });
      expect(outcome.status).toBe("not_available");
    });
  });

  describe("topics.release", () => {
    it("returns released topics to the available floor so they can be reserved again", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a"] }, { ctx });
      await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 1, excludeTopics: [] }, { ctx });

      const released = await tools["topics.release"]!.execute({ reservationKey: "res_1" }, { ctx });
      expect(released).toEqual({ status: "success", result: { reservationKey: "res_1", alreadyReleased: false } });

      const reReserved = await tools["topics.reserve"]!.execute({ reservationKey: "res_2", count: 1, excludeTopics: [] }, { ctx });
      expect(reReserved.status).toBe("success");
    });

    it("is idempotent: releasing twice is a no-op", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a"] }, { ctx });
      await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 1, excludeTopics: [] }, { ctx });
      await tools["topics.release"]!.execute({ reservationKey: "res_1" }, { ctx });
      const second = await tools["topics.release"]!.execute({ reservationKey: "res_1" }, { ctx });

      expect(second).toEqual({ status: "success", result: { reservationKey: "res_1", alreadyReleased: true } });
    });

    it("refuses to release an already-committed reservation", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a"] }, { ctx });
      await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 1, excludeTopics: [] }, { ctx });
      await tools["topics.commit"]!.execute({ reservationKey: "res_1" }, { ctx });

      const outcome = await tools["topics.release"]!.execute({ reservationKey: "res_1" }, { ctx });
      expect(outcome.status).toBe("content_fail");
    });
  });

  describe("tenant scoping", () => {
    it("keeps two tenants' catalogs fully separate", async () => {
      const acmeCtx: AgentContext = { ...ctx, clientSlug: "acme" };
      const globexCtx: AgentContext = { ...ctx, clientSlug: "globex" };

      await tools["topics.topUp"]!.execute({ topics: ["acme-only-topic"] }, { ctx: acmeCtx });
      const globexReserve = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 1, excludeTopics: [] }, { ctx: globexCtx });

      expect(globexReserve.status).toBe("content_fail");
    });

    it("ignores a model-supplied clientSlug override in favor of ctx.clientSlug", async () => {
      await tools["topics.topUp"]!.execute({ topics: ["a"], clientSlug: "attacker-corp" } as never, { ctx });
      const attackerCatalog = await store.readJson("attacker-corp", ["topics", "catalog"]);
      expect(attackerCatalog).toBeUndefined();
      const acmeCatalog = await store.readJson<unknown[]>("acme", ["topics", "catalog"]);
      expect(acmeCatalog).toHaveLength(1);
    });
  });
});
