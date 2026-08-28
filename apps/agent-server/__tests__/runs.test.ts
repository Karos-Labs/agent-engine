import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import request from "supertest";
import type { Application } from "express";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment, inProcessEnqueue } from "./test-helpers.js";
import { startRunJob } from "../src/run-job.js";

/**
 * Starts a run through the route and returns the state it reached (AU66 /
 * SCRUM-364).
 *
 * `/runs/start` enqueues and returns 202 now, so everything these tests used to
 * assert on the START response — status, pendingGateId, report — lives on
 * `/status`. That split is the point of the change and not an inconvenience to
 * paper over: the route's job is the handoff, and a run's state is a separate
 * question with a separate answer.
 *
 * The 202 itself is asserted here rather than in each caller, so a route that
 * silently went back to executing would fail every one of them at once.
 */
async function startAndRead(app: Application, body: Record<string, unknown>) {
  const startRes = await request(app).post("/api/v1/runs/start").send(body);
  if (startRes.status !== 202) return { startRes, body: startRes.body };
  expect(startRes.body.status, "the route hands off; it must not report a run's state").toBe("queued");
  const statusRes = await request(app).get(`/api/v1/runs/${startRes.body.runId}/status`);
  return { startRes, body: { ...statusRes.body, runId: startRes.body.runId } };
}


describe("POST /api/v1/runs/start", () => {
  let env: TestEnvironment;
  let app: Application;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, enqueueRunJob: inProcessEnqueue(env) });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  /**
   * These three drive WHOLE agent workflows over HTTP — model calls, tool calls,
   * gates, checkpoints, a resume — against vitest's 5s default timeout. They
   * passed for as long as the machine was quiet and flaked the moment the full
   * sweep ran alongside anything else, which is the worst possible failure shape:
   * green in isolation, red under load, and the red arrives as
   * `ENOTEMPTY: rmdir clients/acme/topics` from afterEach racing a workflow that
   * was aborted mid-write, which points at cleanup rather than at the timeout
   * that caused it.
   *
   * AU66 tipped them over by adding a /status round-trip per product to
   * `startAndRead`. The tests were always near the edge; that made it visible.
   *
   * An explicit timeout rather than a global one: these are legitimately
   * long-running and should say so at the call site, while a genuinely hung
   * 5s unit test elsewhere still fails fast.
   */
  it("runs the X agent end to end: pauses for human batch review, then resumes to a delivered report", async () => {
    const { startRes, body: started } = await startAndRead(app, { clientSlug: "acme", productId: "x-agent", runKind: "recurring", inputParams: {} });

    expect(startRes.status).toBe(202);
    expect(typeof started.runId).toBe("string");
    expect(started.status).toBe("awaiting_gate");
    // X's own workflow grew to 21 steps in Phase 2.5 Batch 2.3 (lane selection,
    // engagement-cap check, and link-placement verification) -- its batch-review
    // gate now lands at step 15, not 13.
    expect(started.pendingGateId).toContain("15-batch-review-r0");
    const { runId } = started;

    const resumeRes = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({ gateId: "15-batch-review-r0", resolution: { decision: "approve", actor: "jane@karoslabs.com" } });

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.status).toBe("completed");
    expect(resumeRes.body.report.domainOutcome).toBe("delivered");
    expect(resumeRes.body.report.steps).toHaveLength(22);
    // Phase 2.5 fix-batch regression check: a genuinely completed/delivered
    // run's own review-gate step must report as done/approved, never as
    // "failed: step did not run" (the report-serializer gate-status bug).
    const gateStep = resumeRes.body.report.steps.find((s: { stepId: string }) => s.stepId === "15-batch-review-r0");
    expect(gateStep?.status).toBe("done");
    expect(gateStep?.error).toBeUndefined();
  }, 60_000);

  it("runs each of the five channel agents end to end: pauses for human batch review, then resumes to delivered", async () => {
    for (const productId of ["linkedin-agent", "reddit-agent", "blog-agent", "newsletter-agent"] as const) {
      const { startRes, body: started } = await startAndRead(app, { clientSlug: "acme", productId, runKind: "recurring" });
      expect(startRes.status, `${productId} should return 202`).toBe(202);
      expect(started.status, `${productId} should pause for review`).toBe("awaiting_gate");
      const { runId } = started;
      // Reddit's own gate lands one step later ("14-batch-review") than the other
      // four channels' shared "13-batch-review" — its own pre-draft subreddit-
      // eligibility check (step 09) shifts everything after it by one.
      const gateId: string = started.pendingGateId.slice(`${runId}__`.length);

      const resumeRes = await request(app)
        .post(`/api/v1/runs/${runId}/resume`)
        .send({ gateId, resolution: { decision: "approve", actor: "jane@karoslabs.com" } });
      expect(resumeRes.status, `${productId} should resume cleanly`).toBe(200);
      expect(resumeRes.body.status, `${productId} should complete`).toBe("completed");
      expect(resumeRes.body.report.domainOutcome, `${productId} should be delivered`).toBe("delivered");

      // Phase 2.5 fix-batch regression check, across every channel: the resolved
      // review-gate step must report as done, never "failed: step did not run".
      const gateStep = resumeRes.body.report.steps.find((s: { stepId: string }) => s.stepId === gateId);
      expect(gateStep?.status, `${productId}'s ${gateId} step should report done`).toBe("done");
      expect(gateStep?.error, `${productId}'s ${gateId} step should have no error`).toBeUndefined();
    }
  }, 60_000);

  it("rejects a request missing required fields", async () => {
    const res = await request(app).post("/api/v1/runs/start").send({ clientSlug: "acme" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects a request with an unrecognized productId", async () => {
    const res = await request(app).post("/api/v1/runs/start").send({ clientSlug: "acme", productId: "carrier-pigeon-agent", runKind: "recurring" });
    expect(res.status).toBe(400);
  });

  it("returns blocked_intake when the client hasn't been onboarded for the requested channel", async () => {
    // Deliberately bypasses setupTestEnvironment(), which always seeds a complete
    // client.config — this test needs a tenant with genuinely no config doc at all.
    const bareRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-server-bare-test-"));
    const bareStore = new WorkspaceStore(bareRootDir);
    // `createOfflineScraper()` passed explicitly: `research.pull` reports
    // not_available without a real scraper rather than returning a placeholder
    // (see karos-research/src/pull.ts). Tests still need deterministic offline
    // data, so they opt in; nothing in `apps/src` does.
    const bareTools = createAllKarosTools(bareStore, undefined, { scraper: createOfflineScraper() });
    await bareStore.writeJson("bare-client", ["client", "profile"], { name: "Bare Co", industry: "Unknown" });
    // Deliberately no ["client", "config"] doc written for "bare-client".

    const bareDurableStore = new MemoryDurableStepStore();
    const bareRuntimeDeps = { tools: bareTools, promptStore: env.runtimeDeps.promptStore, router: env.runtimeDeps.router, workspaceStore: bareStore };
    const bareApp = createApp({
      durableStore: bareDurableStore,
      runtimeDeps: bareRuntimeDeps,
      enqueueRunJob: async (request) => {
        const runId = `bare-${Math.random().toString(36).slice(2)}`;
        await startRunJob(request, runId, { durableStore: bareDurableStore, runtimeDeps: bareRuntimeDeps });
        return { runId };
      },
    });
    try {
      const { startRes, body: started } = await startAndRead(bareApp, { clientSlug: "bare-client", productId: "x-agent", runKind: "recurring" });
      expect(startRes.status).toBe(202);
      // The intake block is a property of the RUN, not of the handoff — the
      // route cannot know it without executing, which is exactly what it no
      // longer does. So it surfaces where a run's state belongs: /status.
      expect(started.status).toBe("blocked_intake");
    } finally {
      await fs.rm(bareRootDir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/v1/runs/:runId/status", () => {
  let env: TestEnvironment;
  let app: Application;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, enqueueRunJob: inProcessEnqueue(env) });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("returns the same status/report for a run that was already started", async () => {
    const { startRes, body: started } = await startAndRead(app, { clientSlug: "acme", productId: "blog-agent", runKind: "recurring" });
    const { runId } = started;
    expect(startRes.status).toBe(202);
    expect(started.status).toBe("awaiting_gate");

    // Re-reading /status must give the same answer. That is the real property
    // here now: /runs/start no longer reports a run's state at all, so /status
    // is the ONLY source for it and has to be stable.
    const statusRes = await request(app).get(`/api/v1/runs/${runId}/status`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe("awaiting_gate");
    expect(statusRes.body.pendingGateId).toBe(started.pendingGateId);

    // Blog's own batch-review gate lands at step 15 (Phase 2.5 Batch 2.4 grew its
    // workflow by two steps for the newly-wired noPlaceholder/leakCheck gates).
    const resumeRes = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({ gateId: "15-batch-review-r0", resolution: { decision: "approve", actor: "jane@karoslabs.com" } });
    expect(resumeRes.body.status).toBe("completed");

    const statusAfterResumeRes = await request(app).get(`/api/v1/runs/${runId}/status`);
    expect(statusAfterResumeRes.status).toBe(200);
    expect(statusAfterResumeRes.body.status).toBe("completed");
    expect(statusAfterResumeRes.body.report.domainOutcome).toBe("delivered");

    // Phase 2.5 fix-batch regression check: fetched independently via GET
    // /status (not just the resume response), the gate step must still report done.
    const gateStep = statusAfterResumeRes.body.report.steps.find((s: { stepId: string }) => s.stepId === "15-batch-review-r0");
    expect(gateStep?.status).toBe("done");
    expect(gateStep?.error).toBeUndefined();
  });

  it("returns 404 for an unknown runId", async () => {
    const res = await request(app).get("/api/v1/runs/does-not-exist/status");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/runs/:runId/resume — campaign orchestrator gate", () => {
  let env: TestEnvironment;
  let app: Application;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, enqueueRunJob: inProcessEnqueue(env) });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("pauses at the campaign review gate, then resumes to completed on approval", async () => {
    const { startRes, body: started } = await startAndRead(app, { clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" });

    expect(startRes.status).toBe(202);
    expect(started.status).toBe("awaiting_gate");
    expect(started.pendingGateId).toContain("13-campaign-review");
    const { runId } = started;

    const resumeRes = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({ gateId: "13-campaign-review", resolution: { decision: "approve", actor: "jane@karoslabs.com" } });

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.status).toBe("completed");
    expect(resumeRes.body.report.domainOutcome).toBe("delivered");
    // The dynamically-discovered fan-out slots (5 channels) all show up as their own report entries.
    const slotSteps = resumeRes.body.report.steps.filter((s: { stepId: string }) => s.stepId.startsWith("channel-fanout__slot_"));
    expect(slotSteps.length).toBeGreaterThan(0);

    // Phase 2.5 fix-batch regression check: the top-level campaign-review gate
    // must report as done on a genuinely completed/delivered run, never
    // "failed: step did not run".
    const gateStep = resumeRes.body.report.steps.find((s: { stepId: string }) => s.stepId === "13-campaign-review");
    expect(gateStep?.status).toBe("done");
    expect(gateStep?.error).toBeUndefined();
  }, 60_000);

  it("rejects a reject-decision resume with no notes (reason is mandatory on reject, RFC-01 §8.3)", async () => {
    const startRes = await request(app)
      .post("/api/v1/runs/start")
      .send({ clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" });
    const { runId } = startRes.body;

    const res = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({ gateId: "13-campaign-review", resolution: { decision: "reject", actor: "jane@karoslabs.com" } });

    expect(res.status).toBe(400);
  });

  it("resolves to held when the gate is rejected with a reason", async () => {
    const startRes = await request(app)
      .post("/api/v1/runs/start")
      .send({ clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" });
    const { runId } = startRes.body;

    const res = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({ gateId: "13-campaign-review", resolution: { decision: "reject", actor: "jane@karoslabs.com", notes: "needs a different theme" } });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("held");
  });

  it("returns 404 when resuming a run that doesn't exist", async () => {
    const res = await request(app)
      .post("/api/v1/runs/does-not-exist/resume")
      .send({ gateId: "13-campaign-review", resolution: { decision: "approve", actor: "jane@karoslabs.com" } });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/runs/:runId/resume — concurrency and gate-lifecycle guards (a reliability audit finding)", () => {
  let env: TestEnvironment;
  let app: Application;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, enqueueRunJob: inProcessEnqueue(env) });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("returns 409, not 500, when resuming a run that already completed", async () => {
    const startRes = await request(app)
      .post("/api/v1/runs/start")
      .send({ clientSlug: "acme", productId: "blog-agent", runKind: "recurring" });
    const { runId } = startRes.body;

    const firstResume = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({ gateId: "15-batch-review-r0", resolution: { decision: "approve", actor: "jane@karoslabs.com" } });
    expect(firstResume.status).toBe(200);
    expect(firstResume.body.status).toBe("completed");

    // The run is now "completed" — a second resume of the same run is not a valid
    // in-flight-gate resume, and must not be reported as an unexpected 500.
    const secondResume = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({ gateId: "15-batch-review-r0", resolution: { decision: "approve", actor: "jane@karoslabs.com" } });
    expect(secondResume.status).toBe(409);
    expect(secondResume.body.error).toMatch(/not awaiting a gate/i);
  });

  it("returns 409, not 404 or 500, when the gate was already resolved by someone else (a concurrent approval)", async () => {
    const startRes = await request(app)
      .post("/api/v1/runs/start")
      .send({ clientSlug: "acme", productId: "blog-agent", runKind: "recurring" });
    const { runId } = startRes.body;

    // Simulates a second, concurrent approval channel resolving the same gate directly
    // against the shared store — the run record is still "awaiting_gate" (only
    // WorkflowEngine.run() flips that), so this HTTP request's own pre-check passes, and
    // it reaches engine.resolveGate() to find the gate itself already answered.
    const rivalEngine = new WorkflowEngine(env.durableStore);
    await rivalEngine.resolveGate(runId, "15-batch-review-r0", { decision: "approve", actor: "mallory@example.com", at: "2026-08-15T00:00:00Z" });

    const res = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({ gateId: "15-batch-review-r0", resolution: { decision: "approve", actor: "jane@karoslabs.com" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already resolved/i);
  });
});
