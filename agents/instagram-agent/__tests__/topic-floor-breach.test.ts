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

  it("holds only when the catalog breach leaves NOTHING to fall back on -- no requested subject, no declared industry", async () => {
    // A breach alone no longer ends the run. This fixture has an empty catalog
    // AND no `requestedSubject` AND no client profile, which is the one case
    // where a hold is still the honest answer — and the message now names all
    // three misses instead of blaming the catalog for a run that had no subject
    // from any source.
    env = await setupTestEnvironment({ seedTopics: [] }); // an empty catalog: topics.reserve has nothing to give
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — must never be reached" })]);
    const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/no subject available/i);
    expect(result.reason).toMatch(/requestedSubject/);
    expect(result.reason).toMatch(/industry/);
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    // 00-auto-setup runs first; with no declared industry it seeds nothing, so
    // the breach below is reached exactly as it was before that step existed.
    expect(stepRecords.map((s) => s.stepId)).toEqual(["00-auto-setup", "01-open-run", "02-freeze-style-config", "03-claim-topic"]);

    // Nothing was ever reserved/committed -- the catalog stays exactly as empty as it started.
    const catalog = await env.store.readJson<unknown[]>("acme", ["topics", "catalog"]);
    expect(catalog ?? []).toHaveLength(0);
  });

  /**
   * THE REGRESSION THIS SUITE NOW GUARDS FROM BOTH SIDES.
   *
   * Nothing in this repo ever seeds a topics catalog with real rows —
   * `topics.topUp` has exactly one production caller, `topics.reserve`'s own
   * proactive top-up, and it passes an empty array (a documented no-op). So a
   * client whose catalog was never seeded out of band could not run this agent
   * AT ALL: every run died at step 03, because instagram-agent was the only
   * caller of `topics.reserve` in the repo that threw `WorkflowHeld` on a
   * `content_fail` instead of falling through to a research-derived candidate
   * the way x-agent, linkedin-agent, blog-agent, newsletter-agent,
   * reddit-agent and campaign-orchestrator all do.
   */
  describe("falling back when the catalog cannot serve the run", () => {
    async function runWithEmptyCatalog(runId: string) {
      const promptStore = makePromptStore();
      const router = fakeRouterSequence([finalTurn({ text: "unused — this test only exercises step 03" })]);
      const workflowFn = createInstagramAgentWorkflow({ tools: env.tools, promptStore, router, repoRoot: env.repoRoot });
      const durableStore = new MemoryDurableStepStore();
      await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId });
      const step03 = (await durableStore.listSteps(runId)).find((s) => s.stepId === "03-claim-topic");
      return step03;
    }

    it("uses the client's own requestedSubject, which step 01 captured and nothing ever read", async () => {
      env = await setupTestEnvironment({ seedTopics: [] });
      await env.store.writeJson("acme", ["client", "config"], {
        instagramStyleConfig: goodStyleConfig(),
        instagramBrandTokens: goodBrandTokens(),
        requestedSubject: "our new onboarding flow",
      });

      const step03 = await runWithEmptyCatalog("instagram_run_fallback_requested");
      expect(step03?.status).toBe("completed");
      expect(step03?.output).toEqual({ topic: "our new onboarding flow", source: "requested" });
      // No reservationKey: the catalog issued nothing, and must not be told it did.
      expect((step03?.output as Record<string, unknown>)["reservationKey"]).toBeUndefined();
    });

    it("derives a subject from the client's declared industry when there is no requested one", async () => {
      env = await setupTestEnvironment({ seedTopics: [] });
      await env.store.writeJson("acme", ["client", "profile"], { name: "Acme", industry: "B2B SaaS" });

      const step03 = await runWithEmptyCatalog("instagram_run_fallback_research");
      expect(step03?.status).toBe("completed");
      expect(step03?.output).toEqual({ topic: "B2B SaaS trends this week", source: "research" });
    });

    it("prefers a real catalog reservation over either fallback, so a healthy client's dedup lock is unchanged", async () => {
      // The happy path must not move: a client with a seeded catalog keeps
      // getting a real reservation even when a requestedSubject is also set.
      env = await setupTestEnvironment();
      await env.store.writeJson("acme", ["client", "config"], {
        instagramStyleConfig: goodStyleConfig(),
        instagramBrandTokens: goodBrandTokens(),
        requestedSubject: "this must not win over the catalog",
      });
      await env.store.writeJson("acme", ["client", "profile"], { industry: "B2B SaaS" });

      const step03 = await runWithEmptyCatalog("instagram_run_fallback_prefers_catalog");
      expect(step03?.status).toBe("completed");
      const output = step03?.output as { source: string; reservationKey?: string; topic: string };
      expect(output.source).toBe("reserved");
      expect(output.reservationKey).toBe("instagram_run_fallback_prefers_catalog__topic");
      expect(output.topic).not.toBe("this must not win over the catalog");
    });

    it("never commits a reservation the catalog never issued", async () => {
      // The dedup honesty half of the trade: a fallback run gives up dedup
      // PROTECTION, but it must not corrupt the catalog's own accounting by
      // committing a key that was never reserved.
      env = await setupTestEnvironment({ seedTopics: [] });
      await env.store.writeJson("acme", ["client", "config"], {
        instagramStyleConfig: goodStyleConfig(),
        instagramBrandTokens: goodBrandTokens(),
        requestedSubject: "our new onboarding flow",
      });

      await runWithEmptyCatalog("instagram_run_fallback_no_commit");
      const reservation = await env.store.readJson("acme", ["topics", "reservations", "instagram_run_fallback_no_commit__topic"]);
      expect(reservation).toBeUndefined();
      expect(await env.store.readJson<unknown[]>("acme", ["topics", "catalog"]) ?? []).toHaveLength(0);
    });
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
    it("reports the lane-specific breach in the hold reason when the client's requested lane is at the floor of 5 -- not just an empty catalog", async () => {
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
      // Still holds — this fixture has no requestedSubject and no profile — and
      // the underlying `topics.reserve` reason is still carried through verbatim,
      // which is what proves the run's `requestedLane` really reached the tool
      // rather than being accepted and dropped. That is what this Fix-1 suite is
      // about; the surrounding wording is now the fallback chain's, not the
      // catalog's alone.
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
