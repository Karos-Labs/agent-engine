import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosResearchTools } from "../src/index.js";

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
    tools = createKarosResearchTools(store);
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
