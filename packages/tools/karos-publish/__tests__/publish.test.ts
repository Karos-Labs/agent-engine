import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosPublishTools } from "../src/index.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

describe("karos-publish", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createKarosPublishTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-publish-"));
    store = new WorkspaceStore(rootDir);
    tools = createKarosPublishTools(store);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  describe("publish.draft", () => {
    it("is idempotent on draftId: calling twice overwrites the same record, never duplicates", async () => {
      const first = await tools["publish.draft"]!.execute(
        { draftId: "d1", platform: "linkedin", content: { text: "v1" } },
        { ctx },
      );
      expect(first).toEqual({ status: "success", result: { id: "d1", created: true } });

      const second = await tools["publish.draft"]!.execute(
        { draftId: "d1", platform: "linkedin", content: { text: "v2" } },
        { ctx },
      );
      expect(second).toEqual({ status: "success", result: { id: "d1", created: false } });

      const records = await store.listJson("acme", ["publish", "drafts"]);
      expect(records).toHaveLength(1);
      expect(records[0]!.data).toMatchObject({ draftId: "d1", status: "draft", content: { text: "v2" } });
    });
  });

  describe("publish.schedule", () => {
    it("returns not_available for an unknown draftId", async () => {
      const outcome = await tools["publish.schedule"]!.execute({ draftId: "nope", publishAt: "2026-09-01T00:00:00Z" }, { ctx });
      expect(outcome.status).toBe("not_available");
    });

    it("transitions an existing draft to status: scheduled, reflected afterward by publish.status", async () => {
      await tools["publish.draft"]!.execute({ draftId: "d1", platform: "linkedin", content: { text: "v1" } }, { ctx });

      const scheduled = await tools["publish.schedule"]!.execute({ draftId: "d1", publishAt: "2026-09-01T00:00:00Z" }, { ctx });
      expect(scheduled).toEqual({
        status: "success",
        result: { draftId: "d1", status: "scheduled", publishAt: "2026-09-01T00:00:00Z", alreadyScheduled: false },
      });

      const status = await tools["publish.status"]!.execute({ draftId: "d1" }, { ctx });
      expect(status.status).toBe("success");
      expect(status.status === "success" ? status.result : null).toMatchObject({
        draftId: "d1",
        platform: "linkedin",
        status: "scheduled",
        publishAt: "2026-09-01T00:00:00Z",
      });
    });

    it("is idempotent: scheduling twice with the same publishAt is a no-op, no duplicate record", async () => {
      await tools["publish.draft"]!.execute({ draftId: "d1", platform: "linkedin", content: { text: "v1" } }, { ctx });
      const first = await tools["publish.schedule"]!.execute({ draftId: "d1", publishAt: "2026-09-01T00:00:00Z" }, { ctx });
      const second = await tools["publish.schedule"]!.execute({ draftId: "d1", publishAt: "2026-09-01T00:00:00Z" }, { ctx });

      expect(first.status === "success" ? first.result : null).toMatchObject({ alreadyScheduled: false });
      expect(second).toEqual({
        status: "success",
        result: { draftId: "d1", status: "scheduled", publishAt: "2026-09-01T00:00:00Z", alreadyScheduled: true },
      });

      const records = await store.listJson("acme", ["publish", "drafts"]);
      expect(records).toHaveLength(1);
    });
  });

  describe("publish.status", () => {
    it("returns not_available for an unknown draftId", async () => {
      const outcome = await tools["publish.status"]!.execute({ draftId: "nope" }, { ctx });
      expect(outcome.status).toBe("not_available");
    });

    it("returns the correct record for a known draftId", async () => {
      await tools["publish.draft"]!.execute({ draftId: "d1", platform: "twitter", content: { text: "hello" } }, { ctx });
      const outcome = await tools["publish.status"]!.execute({ draftId: "d1" }, { ctx });

      expect(outcome.status).toBe("success");
      expect(outcome.status === "success" ? outcome.result : null).toMatchObject({
        draftId: "d1",
        platform: "twitter",
        status: "draft",
      });
      expect((outcome as { result: { publishAt?: string } }).result.publishAt).toBeUndefined();
    });
  });

  describe("tenant scoping", () => {
    it("ignores a model-supplied clientSlug override in favor of ctx.clientSlug", async () => {
      await tools["publish.draft"]!.execute(
        { draftId: "d1", platform: "linkedin", content: { text: "v1" }, clientSlug: "attacker-corp" } as never,
        { ctx },
      );

      const attackerHasIt = await store.exists("attacker-corp", ["publish", "drafts", "d1"]);
      expect(attackerHasIt).toBe(false);

      const acmeHasIt = await store.exists("acme", ["publish", "drafts", "d1"]);
      expect(acmeHasIt).toBe(true);
    });
  });
});
