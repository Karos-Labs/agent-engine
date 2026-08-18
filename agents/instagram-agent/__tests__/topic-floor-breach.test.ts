import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodBrandTokens, goodStyleConfig, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "instagram_run_floor", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

describe("03-claim-topic: the topics catalog is the only dedup gate (RFC-03 §2.3)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("holds the whole post -- not a crash -- when the catalog floor is breached (nothing left to reserve)", async () => {
    env = await setupTestEnvironment({ seedTopics: [] }); // an empty catalog: topics.reserve has nothing to give
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — must never be reached" })]);
    const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/topics catalog floor breached/i);
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId)).toEqual(["01-open-run", "02-freeze-style-config", "03-claim-topic"]);

    // Nothing was ever reserved/committed -- the catalog stays exactly as empty as it started.
    const catalog = await env.store.readJson<unknown[]>("acme", ["topics", "catalog"]);
    expect(catalog ?? []).toHaveLength(0);
  });

  it("still claims a topic normally when the catalog has enough unused rows", async () => {
    env = await setupTestEnvironment(); // the default seed has 6 topics
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — this test only exercises step 03" })]);
    const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    // Runs past step 03 into step 04, which will fail (unused text output) --
    // this test only cares that step 03 itself succeeded rather than holding.
    await engine.run(workflowFn, { ...params, runId: "instagram_run_floor_ok" });

    const stepRecords = await durableStore.listSteps("instagram_run_floor_ok");
    const step03 = stepRecords.find((s) => s.stepId === "03-claim-topic");
    expect(step03?.status).toBe("completed");
  });

  // P0 parity-audit Fix 1: the floor is a LANE-scoped guard, not a whole-
  // catalog one — these prove the run's `requestedLane` (client config,
  // captured at step 01 as `InstagramRunClaim.requestedLane`) is actually
  // wired into step 03's `topics.reserve` call, not just accepted and dropped.
  describe("Fix 1: lane-scoped floor breach (carousel-agent-v2 SKILL.md step 03)", () => {
    it("holds the whole post with a lane-specific reason when the client's requested lane is at the floor of 5 -- not just an empty catalog", async () => {
      env = await setupTestEnvironment({
        seedTopics: [], // nothing in the default lane -- this run targets "quarterly-wins" instead
        seedTopicsByLane: { "quarterly-wins": ["t1", "t2", "t3", "t4", "t5"] },
      });
      await env.store.writeJson("acme", ["client", "config"], {
        instagramStyleConfig: goodStyleConfig(),
        instagramBrandTokens: goodBrandTokens(),
        requestedLane: "quarterly-wins",
      });

      const promptStore = makePromptStore();
      const router = fakeRouterSequence([finalTurn({ text: "unused — must never be reached" })]);
      const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_floor_lane" });

      expect(result.status).toBe("held");
      if (result.status !== "held") throw new Error("unreachable");
      expect(result.reason).toMatch(/topics catalog floor breached/i);
      expect(result.reason).toMatch(/lane "quarterly-wins"/);
      expect(result.reason).toMatch(/floor of 5/);
      expect(router.complete).not.toHaveBeenCalled();
    });

    it("reserving from a DIFFERENT lane than the one near its floor is completely unaffected", async () => {
      env = await setupTestEnvironment({
        seedTopics: [],
        seedTopicsByLane: {
          "quarterly-wins": ["t1", "t2", "t3", "t4", "t5"], // at the floor
          "behind-the-scenes": ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"], // healthy
        },
      });
      await env.store.writeJson("acme", ["client", "config"], {
        instagramStyleConfig: goodStyleConfig(),
        instagramBrandTokens: goodBrandTokens(),
        requestedLane: "behind-the-scenes",
      });

      const promptStore = makePromptStore();
      const router = fakeRouterSequence([finalTurn({ text: "unused — this test only exercises step 03" })]);
      const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      await engine.run(workflowFn, { ...params, runId: "instagram_run_floor_other_lane" });

      const stepRecords = await durableStore.listSteps("instagram_run_floor_other_lane");
      const step03 = stepRecords.find((s) => s.stepId === "03-claim-topic");
      expect(step03?.status).toBe("completed");

      // The "quarterly-wins" lane, still at the floor, is untouched by the other lane's reservation.
      const catalog = await env.store.readJson<Array<{ lane: string; status: string }>>("acme", ["topics", "catalog"]);
      const quarterlyWinsRows = catalog?.filter((r) => r.lane === "quarterly-wins") ?? [];
      expect(quarterlyWinsRows.every((r) => r.status === "available")).toBe(true);
    });
  });
});
