import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosLedgerTools } from "../src/index.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

describe("karos-ledger", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createKarosLedgerTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-ledger-"));
    store = new WorkspaceStore(rootDir);
    tools = createKarosLedgerTools(store);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  describe("ledger.writeDeliverable", () => {
    it("is idempotent on (runId, slotId, kind): a retried write does not duplicate the record", async () => {
      const args = { runId: "run_1", slotId: "slot_1", kind: "linkedin-post", deliverable: { body: "v1" } };
      const first = await tools["ledger.writeDeliverable"]!.execute(args, { ctx });
      const second = await tools["ledger.writeDeliverable"]!.execute({ ...args, deliverable: { body: "v2" } }, { ctx });

      expect(first).toEqual({ status: "success", result: { id: "run_1__slot_1__linkedin-post", created: true } });
      expect(second).toEqual({ status: "success", result: { id: "run_1__slot_1__linkedin-post", created: false } });

      const stored = await store.readJson<{ deliverable: { body: string } }>("acme", [
        "ledger",
        "deliverables",
        "run_1",
        "slot_1",
        "linkedin-post",
      ]);
      expect(stored?.deliverable).toEqual({ body: "v2" });
    });

    it("keeps different kinds for the same runId/slotId as separate records", async () => {
      await tools["ledger.writeDeliverable"]!.execute({ runId: "run_1", slotId: "slot_1", kind: "linkedin-post", deliverable: {} }, { ctx });
      await tools["ledger.writeDeliverable"]!.execute({ runId: "run_1", slotId: "slot_1", kind: "twitter-post", deliverable: {} }, { ctx });

      const entries = await store.listJson("acme", ["ledger", "deliverables", "run_1", "slot_1"]);
      expect(entries.map((e) => e.id).sort()).toEqual(["linkedin-post", "twitter-post"]);
    });
  });

  describe("ledger.appendEvent", () => {
    it("is idempotent on (runId, eventId): replaying the same eventId does not grow the log", async () => {
      const args = { runId: "run_1", eventId: "evt_1", level: "info" as const, message: "started" };
      await tools["ledger.appendEvent"]!.execute(args, { ctx });
      const second = await tools["ledger.appendEvent"]!.execute(args, { ctx });

      expect(second).toEqual({ status: "success", result: { id: "run_1__evt_1", created: false } });
      const events = await store.listJson("acme", ["ledger", "events", "run_1"]);
      expect(events).toHaveLength(1);
    });

    it("appends distinct events under the same run", async () => {
      await tools["ledger.appendEvent"]!.execute({ runId: "run_1", eventId: "evt_1", level: "info", message: "started" }, { ctx });
      await tools["ledger.appendEvent"]!.execute({ runId: "run_1", eventId: "evt_2", level: "success", message: "done" }, { ctx });

      const events = await store.listJson("acme", ["ledger", "events", "run_1"]);
      expect(events).toHaveLength(2);
    });
  });

  describe("ledger.upsertBrief", () => {
    it("is idempotent on briefId: the second call overwrites rather than duplicating", async () => {
      const first = await tools["ledger.upsertBrief"]!.execute({ briefId: "brief_1", content: { v: 1 } }, { ctx });
      const second = await tools["ledger.upsertBrief"]!.execute({ briefId: "brief_1", content: { v: 2 } }, { ctx });

      expect(first).toEqual({ status: "success", result: { id: "brief_1", created: true } });
      expect(second).toEqual({ status: "success", result: { id: "brief_1", created: false } });

      const entries = await store.listJson("acme", ["ledger", "briefs"]);
      expect(entries).toHaveLength(1);
      expect((entries[0]?.data as { content: unknown }).content).toEqual({ v: 2 });
    });
  });

  describe("ledger.dashboardSnapshot", () => {
    it("is idempotent on runId", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute({ runId: "run_1", snapshot: { a: 1 } }, { ctx });
      const second = await tools["ledger.dashboardSnapshot"]!.execute({ runId: "run_1", snapshot: { a: 2 } }, { ctx });

      expect(second).toEqual({ status: "success", result: { id: "run_1", created: false } });
      const entries = await store.listJson("acme", ["ledger", "dashboard-snapshots"]);
      expect(entries).toHaveLength(1);
    });
  });

  // `ledger.feedbackAppend` retired (AU22): it was a write-only log with no
  // reader anywhere in the codebase. See `createKarosLedgerTools`'s own doc
  // comment in `../src/index.ts` for the full story and its replacement
  // (`memory.appendFeedback`/`memory.readFeedback`), which is covered by
  // `packages/tools/karos-memory/__tests__/memory.test.ts` and by
  // `agents/intel-report-agent/__tests__/workflow-e2e.test.ts`'s
  // write-then-read test.

  describe("ledger.recordUsedImages / ledger.listUsedImages (cross-post image-reuse prevention, P0 parity audit Fix 3)", () => {
    it("records image paths and lists them back, deduped and idempotent on replay", async () => {
      const first = await tools["ledger.recordUsedImages"]!.execute({ imagePaths: ["a.png", "b.png"] }, { ctx });
      expect(first).toEqual({ status: "success", result: { added: 2, total: 2 } });

      // Replaying the same paths (e.g. a retried/resumed delivery) adds nothing new.
      const second = await tools["ledger.recordUsedImages"]!.execute({ imagePaths: ["a.png", "c.png"] }, { ctx });
      expect(second).toEqual({ status: "success", result: { added: 1, total: 3 } });

      const listed = await tools["ledger.listUsedImages"]!.execute({}, { ctx });
      expect(listed).toEqual({ status: "success", result: { imagePaths: ["a.png", "b.png", "c.png"] } });
    });

    it("returns an empty list for a client with nothing recorded yet", async () => {
      const listed = await tools["ledger.listUsedImages"]!.execute({}, { ctx });
      expect(listed).toEqual({ status: "success", result: { imagePaths: [] } });
    });

    it("keeps two tenants' used-image sets fully separate", async () => {
      const acmeCtx: AgentContext = { ...ctx, clientSlug: "acme" };
      const globexCtx: AgentContext = { ...ctx, clientSlug: "globex" };

      await tools["ledger.recordUsedImages"]!.execute({ imagePaths: ["acme-only.png"] }, { ctx: acmeCtx });
      const globexList = await tools["ledger.listUsedImages"]!.execute({}, { ctx: globexCtx });
      expect(globexList).toEqual({ status: "success", result: { imagePaths: [] } });
    });
  });

  describe("tenant scoping", () => {
    it("ignores a model-supplied clientSlug override and writes under ctx.clientSlug instead", async () => {
      await tools["ledger.writeDeliverable"]!.execute(
        { runId: "run_1", kind: "linkedin-post", deliverable: {}, clientSlug: "attacker-corp" } as never,
        { ctx },
      );

      const acmeEntries = await store.listJson("acme", ["ledger", "deliverables", "run_1", "_"]);
      expect(acmeEntries).toHaveLength(1);
      const attackerExists = await store.exists("attacker-corp", ["ledger", "deliverables", "run_1", "_", "linkedin-post"]);
      expect(attackerExists).toBe(false);
    });

    it("keeps two tenants' deliverables fully separate on disk", async () => {
      const acmeCtx: AgentContext = { ...ctx, clientSlug: "acme" };
      const globexCtx: AgentContext = { ...ctx, clientSlug: "globex" };

      await tools["ledger.writeDeliverable"]!.execute({ runId: "run_1", kind: "linkedin-post", deliverable: { body: "acme" } }, { ctx: acmeCtx });
      await tools["ledger.writeDeliverable"]!.execute({ runId: "run_1", kind: "linkedin-post", deliverable: { body: "globex" } }, { ctx: globexCtx });

      const acme = await store.readJson<{ deliverable: { body: string } }>("acme", ["ledger", "deliverables", "run_1", "_", "linkedin-post"]);
      const globex = await store.readJson<{ deliverable: { body: string } }>("globex", ["ledger", "deliverables", "run_1", "_", "linkedin-post"]);
      expect(acme?.deliverable.body).toBe("acme");
      expect(globex?.deliverable.body).toBe("globex");
    });
  });
});
