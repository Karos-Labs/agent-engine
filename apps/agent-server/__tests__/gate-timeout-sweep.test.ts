import { describe, expect, it, afterEach, beforeEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment, inProcessEnqueue } from "./test-helpers.js";

/**
 * "A client who starts an agent and hears nothing back gets the deliverable
 * approved within the hour" (2026-09-08). Two halves make that true: every
 * review gate is now `1h` / `auto_approve`, and this sweep is what calls
 * `run()` on a waiting run once the hour is up — the engine resolves the
 * timeout lazily and nothing else in it ever calls `run()` unprompted.
 */
describe("POST /api/v1/maintenance/sweep-gate-timeouts", () => {
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

  it("leaves a fresh gate alone, then approves and completes the run once its hour has elapsed", async () => {
    const started = await request(app).post("/api/v1/runs/start").send({ clientSlug: "acme", productId: "x-agent", runKind: "recurring", inputParams: {} });
    expect(started.status).toBe(202);
    const runId = started.body.runId as string;
    expect((await env.durableStore.getRun(runId))?.status).toBe("awaiting_gate");

    // 30 minutes in: due for nothing.
    clock += 30 * 60 * 1000;
    const early = await request(app).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(early.status).toBe(200);
    expect(early.body.scanned).toBe(1);
    expect(early.body.due).toBe(0);
    expect(early.body.resumed).toEqual([]);
    expect((await env.durableStore.getRun(runId))?.status).toBe("awaiting_gate");

    // 61 minutes in: the sweep resumes it, the engine's own timeout rule
    // approves it, and the workflow runs to delivery.
    clock += 31 * 60 * 1000;
    const late = await request(app).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(late.status).toBe(200);
    expect(late.body.due).toBe(1);
    expect(late.body.resumed).toEqual([{ runId, productId: "x-agent", status: "completed" }]);
    expect(late.body.skipped).toEqual([]);

    const run = await env.durableStore.getRun(runId);
    expect(run?.status).toBe("completed");
    // The approval is the engine's, recorded as such — never a fabricated person.
    const gate = await env.durableStore.getGate(`${runId}__15-batch-review-r0`);
    expect(gate?.response?.decision).toBe("approve");
    expect(gate?.response?.actor).toBe("system:gate-timeout");
  }, 90_000);

  it("reports an empty sweep when nothing is waiting", async () => {
    const res = await request(app).post("/api/v1/maintenance/sweep-gate-timeouts").send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scanned: 0, due: 0, resumed: [], skipped: [] });
  });
});
