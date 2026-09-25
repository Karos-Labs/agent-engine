import { describe, expect, it, afterEach, beforeEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { RUN_LEASE_TTL_MS } from "@agent-engine/workflow";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment, inProcessEnqueue } from "./test-helpers.js";

/**
 * A RECOVERY MECHANISM WITH NOTHING THAT TRIGGERS IT.
 *
 * `WorkflowEngine.run()` has taken over an abandoned run since the lease
 * landed: `claimRun` accepts a `running` record whose heartbeat stopped more
 * than `RUN_LEASE_TTL_MS` ago, says out loud that it reclaimed it, and carries
 * on from the last checkpoint. It is complete, it is tested, and nothing ever
 * called it — because nothing in this engine calls `run()` unprompted, and the
 * portal only calls it when a person acts.
 *
 * So a run whose worker died is `running` forever, and the portal shows it as
 * in progress forever. Measured in prep on 2026-09-25: SIX instagram runs
 * (thepitchbydeel, geektime, kindlyyours, hankypanky) stuck since 2026-09-24
 * with no reason recorded — a worker roll, which is the routine event the
 * lease was written to survive.
 *
 * Exactly the shape of the gate-timeout defect this route already fixes, so it
 * is the same route: the scheduler job calling it exists in both environments,
 * and ten of this fleet's fourteen cron routes have no scheduler pointing at
 * them. An eleventh unwired route would fix nothing on a real deployment.
 */
describe("the sweep picks up runs whose worker died", () => {
  let env: TestEnvironment;
  let app: Application;
  let clock: number;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    clock = Date.now();
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, enqueueRunJob: inProcessEnqueue(env), clock: () => clock });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  /** A run left `running` with its heartbeat `ageMs` in the past — what a SIGTERM'd worker leaves behind. */
  async function abandonedRun(runId: string, ageMs: number) {
    await env.durableStore.createRunIfNotExists({
      runId,
      clientSlug: "acme",
      productId: "x-agent",
      runKind: "recurring",
      status: "running",
      createdAt: clock - ageMs,
      updatedAt: clock - ageMs,
      leaseOwner: "worker-that-died",
    });
  }

  it("picks up a run abandoned past the lease and carries it to completion", async () => {
    await abandonedRun("run_orphan", RUN_LEASE_TTL_MS + 60_000);

    const res = await request(app).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(res.status).toBe(200);
    expect(res.body.reclaimed).toHaveLength(1);
    expect(res.body.reclaimed[0]).toMatchObject({ runId: "run_orphan", productId: "x-agent" });
    // How long it sat there is reported, not merely that it did: "six minutes"
    // and "a day and a half" are different incidents.
    expect(res.body.reclaimed[0].abandonedForMs).toBeGreaterThan(RUN_LEASE_TTL_MS);

    // It ran from its last checkpoint to a real terminal state, rather than
    // being marked failed or left where it was.
    const run = await env.durableStore.getRun("run_orphan");
    expect(run?.status).not.toBe("running");
    expect(["completed", "awaiting_gate", "degraded", "held"]).toContain(run?.status);
  }, 90_000);

  it("recovers the exact shape the six stuck prep runs are in: killed AT the gate step", async () => {
    // NOT a hypothetical shape. Each of the six (`pubsub-21255267599312000`
    // and friends, 2026-09-24) holds a finished carousel -- copy drafted, two
    // revision passes paid for -- with its LAST step record reading
    // `09a-batch-review-r0 | gate | running`. The worker died with the gate
    // half-registered, so the run never reached `awaiting_gate` and no human
    // was ever shown anything.
    //
    // The recovery turns on `running` not being a checkpointed step status,
    // which is a claim about `isCheckpointedStepStatus` that a test with no
    // steps at all cannot make. This one makes it: the gate step re-executes,
    // the gate is registered, and the run parks where it should have parked.
    const started = await request(app).post("/api/v1/runs/start").send({ clientSlug: "acme", productId: "x-agent", runKind: "recurring", inputParams: {} });
    expect(started.status).toBe(202);
    const runId = started.body.runId as string;
    expect((await env.durableStore.getRun(runId))?.status).toBe("awaiting_gate");

    // Rewind to the instant before the gate finished registering: the worker
    // is gone, the run says `running`, and its gate step says `running` too.
    const gateStepId = "15-batch-review-r0";
    const gateStep = await env.durableStore.getStep(runId, gateStepId);
    expect(gateStep?.kind).toBe("gate");
    await env.durableStore.saveStep(runId, { stepId: gateStepId, kind: "gate", status: "running", startedAt: clock - RUN_LEASE_TTL_MS - 60_000 });
    await env.durableStore.updateRun(runId, {
      status: "running",
      updatedAt: clock - RUN_LEASE_TTL_MS - 60_000,
      leaseOwner: "worker-that-died",
      pendingGateId: null,
    });

    const res = await request(app).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(res.status).toBe(200);
    expect(res.body.reclaimed).toHaveLength(1);
    expect(res.body.reclaimed[0].runId).toBe(runId);

    // Parked for a person, which is where it was always meant to end up --
    // and the drafted work is still on its earlier checkpoints, unpaid-for
    // twice.
    const run = await env.durableStore.getRun(runId);
    expect(run?.status).toBe("awaiting_gate");
    expect(run?.pendingGateId).toBe(`${runId}__${gateStepId}`);
  }, 90_000);

  it("leaves a run whose heartbeat is still fresh completely alone", async () => {
    // THE BOUNDARY, and it is the one that matters: a live worker mid-step is
    // `running` with a recent heartbeat, and stealing its run would double-run
    // the workflow. The rule is not restated in the sweep — it asks the
    // engine's own `isReclaimableRunning`, so it cannot answer differently
    // from the claim it is about to attempt.
    await abandonedRun("run_alive", RUN_LEASE_TTL_MS - 60_000);

    const res = await request(app).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(res.status).toBe(200);
    expect(res.body.reclaimed).toBeUndefined();
    expect((await env.durableStore.getRun("run_alive"))?.status).toBe("running");
    // AND IT NEVER TRIED. `reclaimed` alone cannot tell "the sweep filtered it
    // out" from "the sweep attempted it and `claimRun` refused" -- the engine
    // applies the same cutoff a second time, so a sweep with a broken filter
    // still produces no reclaim here. It produces a `skipped` row instead.
    // Verified by breaking the filter: without this line the test passed.
    expect(res.body.skipped).toEqual([]);
  });

  it("shares one resume budget with the gate pass, and says what it deferred", async () => {
    // Each resume runs the rest of a workflow inline. A tick that picked up
    // twenty orphans would be a tick that never answers, so the cap is real
    // and what it left behind is reported rather than silently dropped.
    const narrow = createApp({
      durableStore: env.durableStore,
      runtimeDeps: env.runtimeDeps,
      enqueueRunJob: inProcessEnqueue(env),
      clock: () => clock,
      sweepMaxResumes: 1,
    });
    await abandonedRun("run_orphan_a", RUN_LEASE_TTL_MS + 60_000);
    await abandonedRun("run_orphan_b", RUN_LEASE_TTL_MS + 60_000);

    const res = await request(narrow).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(res.status).toBe(200);
    expect(res.body.reclaimed).toHaveLength(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toContain("resume budget");

    // The next tick takes the other one.
    const second = await request(narrow).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(second.body.reclaimed).toHaveLength(1);
    const reclaimedIds = [res.body.reclaimed[0].runId, second.body.reclaimed[0].runId].sort();
    expect(reclaimedIds).toEqual(["run_orphan_a", "run_orphan_b"]);
  }, 90_000);

  it("stops feeding a run that keeps killing the worker it is given, and fails it visibly", async () => {
    // FOUND BY WATCHING THE SWEEP IN PRODUCTION, an hour after it shipped.
    // Prep run `pubsub-20296536359058757` (instagram, hankypanky) was one of
    // the six this sweep recovered: it was reclaimed, it ran, and it lost its
    // heartbeat AGAIN on the same step, `00h3-persist-exemplar-library`.
    //
    // Left alone, that is a loop with a real cost: a fresh worker every tick,
    // taken down every tick, occupying a resume slot another run needed.
    // Reclaiming is right for a deploy rolling a worker mid-step, which
    // succeeds on the first retry. It is wrong for a run that kills workers.
    const store = env.durableStore;
    const stale = () => clock - RUN_LEASE_TTL_MS - 60_000;
    await store.createRunIfNotExists({
      runId: "run_wedged",
      clientSlug: "acme",
      productId: "x-agent",
      runKind: "recurring",
      status: "running",
      createdAt: stale(),
      updatedAt: stale(),
      leaseOwner: "worker-that-died",
      currentStepId: "00h3-persist-exemplar-library",
      // Three reclaims already spent, every one of them at THIS step.
      reclaimedFromStepId: "00h3-persist-exemplar-library",
      reclaimAttempts: 3,
    });

    const res = await request(app).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(res.status).toBe(200);
    expect(res.body.reclaimed).toBeUndefined();
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toContain("00h3-persist-exemplar-library");
    expect(res.body.skipped[0].reason).toContain("takes down the worker");

    // FAILED, not left `running`. Leaving it is the exact defect this sweep
    // closed: a run nobody will ever move, shown as in progress forever.
    const run = await store.getRun("run_wedged");
    expect(run?.status).toBe("failed");
    expect(run?.failureReason).toContain("without moving past it");
  });

  it("starts the count over for a run that HAS moved since its last reclaim", async () => {
    // The other half, and what makes the count mean anything: a run being
    // carried forward one step per reclaim is being helped, however many
    // reclaims that takes. Counting those would fail a run that is working.
    const store = env.durableStore;
    const stale = clock - RUN_LEASE_TTL_MS - 60_000;
    await store.createRunIfNotExists({
      runId: "run_moving",
      clientSlug: "acme",
      productId: "x-agent",
      runKind: "recurring",
      status: "running",
      createdAt: stale,
      updatedAt: stale,
      leaseOwner: "worker-that-died",
      // Three reclaims spent, but the run has moved on since the last one.
      currentStepId: "09-check-engagement-cap",
      reclaimedFromStepId: "00-intake-check",
      reclaimAttempts: 3,
    });

    const res = await request(app).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(res.status).toBe(200);
    expect(res.body.reclaimed).toHaveLength(1);
    expect(res.body.reclaimed[0].runId).toBe("run_moving");
    expect((await store.getRun("run_moving"))?.status).not.toBe("failed");
  }, 90_000);

  it("still reports an empty sweep when nothing is waiting and nothing is abandoned", async () => {
    // `reclaimed` is ABSENT rather than an empty array on a clean tick — the
    // same convention every marker in this fleet follows, so a field that is
    // there means something happened.
    const res = await request(app).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scanned: 0, due: 0, resumed: [], skipped: [] });
  });
});
