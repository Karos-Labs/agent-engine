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
   * These drive WHOLE agent workflows over HTTP — model calls, tool calls,
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

  /**
   * AU53 / SCRUM-345 — this used to be one test named "five channel agents"
   * that actually iterated four (`x-agent` was silently absent — the only
   * reason anyone noticed was AU13 changing x-agent's gate ordering and going
   * looking for coverage that turned out not to exist). It is now `it.each`
   * over all five, x-agent included, as five independent cases.
   *
   * That split is also the fix for the load-dependent flake, not a second,
   * unrelated change. The old test awaited four full agent workflows
   * SEQUENTIALLY inside one `it(..., 60_000)` — a single fixed wall-clock
   * budget shared across four round trips. Every other whole-workflow test
   * in this file does ONE agent (this file's `x-agent` test, `blog-agent` in
   * the status describe below) or a single real CONCURRENT fan-out bounded
   * by its slowest member (the campaign-orchestrator describe below, which
   * runs five channels via `Promise.all` inside the engine, not sequential
   * HTTP round trips) — so only this loop's total wall-clock scaled with
   * agent count under one timeout. Under `full-workspace parallel load` every
   * router/tool call gets slower (CPU and disk contention, not a code bug),
   * and that per-call latency inflation is exactly what the loop's shared
   * budget could not absorb: agent N's slack is agent (N-1)'s overrun. A
   * single agent under the same inflated per-call latency stayed comfortably
   * inside its own 60s.
   *
   * That was verified directly, not inferred: with a temporary fixed
   * per-router-call delay standing in for contention and the timeout
   * shrunk to make the effect fast to observe, the OLD four-in-one-loop
   * test timed out while the single-agent test passed at the same
   * injected latency; after this split, all five independent cases pass
   * at that same latency because each now gets its own dedicated budget
   * instead of a 4-way-shared one (see the SCRUM-345 report for the
   * verbatim before/after run). Nothing here raises any timeout, adds a
   * retry, or forces serial execution — each case already runs with the
   * exact 60_000 the single-agent tests always used; it's just no longer
   * split five ways.
   *
   * This is also a real isolation improvement, not just a rename: each case
   * gets its own `beforeEach`-provisioned `TestEnvironment` (a fresh
   * `mkdtemp` root, a fresh `MemoryDurableStepStore`), where before, all
   * four shared one `TestEnvironment` for the whole test.
   *
   * Per (4): the other whole-workflow tests in this file already don't share
   * this pattern — each awaits one agent (or one true concurrent fan-out)
   * inside its own budget, so this loop was the only occurrence of it here.
   */
  it.each(["x-agent", "linkedin-agent", "reddit-agent", "blog-agent", "newsletter-agent"] as const)(
    "runs the %s end to end: pauses for human batch review, then resumes to delivered",
    async (productId) => {
      const { startRes, body: started } = await startAndRead(app, { clientSlug: "acme", productId, runKind: "recurring" });
      expect(startRes.status, `${productId} should return 202`).toBe(202);
      expect(started.status, `${productId} should pause for review`).toBe("awaiting_gate");
      const { runId } = started;
      // Each product's batch-review gate lands at its own step number (x-agent
      // and blog-agent at 15, reddit-agent at 14, linkedin-agent/newsletter-agent
      // at 13 — see the per-product comments on the dedicated tests elsewhere in
      // this file), so the gate id is read back from the run's own response
      // rather than hard-coded here.
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
    },
    60_000,
  );

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

describe("POST /api/v1/runs/:runId/resume — edits.style (IGSTYLE-1)", () => {
  let env: TestEnvironment;
  let app: Application;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, enqueueRunJob: inProcessEnqueue(env) });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // The malformed-hex 400 happens at `ResumeRunRequestSchema.safeParse`, the
  // very first line of the resume handler — BEFORE the run record is even
  // looked up (see runs.ts:237). So this needs no real run at all: any
  // runId reaches the same validation failure the same way.
  it.each([
    ["orange", "a named color, not a hex value"],
    ["#12345", "5 hex digits — not a legal 3/4/6/8-digit CSS color"],
    ["rgb(0,0,0)", "not hex syntax at all"],
    ["", "empty string"],
  ])("400s a resume whose edits.style has an invalid hex (%s: %s)", async (badHex) => {
    const res = await request(app)
      .post("/api/v1/runs/does-not-matter/resume")
      .send({
        gateId: "09a-batch-review-r0",
        resolution: { decision: "approve", actor: "jane@karoslabs.com", edits: { style: { ground: badHex } } },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid request body");
  });

  it.each(["#111", "#1a1a1a", "#1a1a1aff"])("accepts a resume whose edits.style has a legal hex (%s)", async (goodHex) => {
    const res = await request(app)
      .post("/api/v1/runs/does-not-matter/resume")
      .send({
        gateId: "09a-batch-review-r0",
        resolution: { decision: "approve", actor: "jane@karoslabs.com", edits: { style: { ground: goodHex } } },
      });
    // 404 ("no run found"), not 400 — proves the body cleared schema
    // validation and the request got as far as the run lookup.
    expect(res.status).toBe(404);
  });

  it("carries edits.style through a real gate resume on approve, unmangled end to end", async () => {
    const { startRes, body: started } = await startAndRead(app, { clientSlug: "acme", productId: "x-agent", runKind: "recurring", inputParams: {} });
    expect(startRes.status).toBe(202);
    expect(started.pendingGateId).toContain("15-batch-review-r0");
    const { runId } = started;

    const resumeRes = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({
        gateId: "15-batch-review-r0",
        resolution: { decision: "approve", actor: "jane@karoslabs.com", edits: { style: { ground: "#111111", accent: "#ff7a1a" } } },
      });
    // x-agent doesn't read `edits.style` (only instagram-agent does, from
    // IGSTYLE-3 on) — this asserts the ROUTE and the shared GateResponseSchema
    // accept and pass it through cleanly for ANY agent, not that x-agent acts
    // on it.
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.status).toBe("completed");
  }, 60_000);

  it("accepts edits.style on decision:'revise' too, not just 'approve' (§2.5's split of the approve-only rule)", async () => {
    const { startRes, body: started } = await startAndRead(app, { clientSlug: "acme", productId: "x-agent", runKind: "recurring", inputParams: {} });
    expect(startRes.status).toBe(202);
    const { runId } = started;

    const resumeRes = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({
        gateId: "15-batch-review-r0",
        resolution: {
          decision: "revise",
          actor: "jane@karoslabs.com",
          feedback: "make the background darker",
          edits: { style: { ground: "#111111" } },
        },
      });
    // Not a 400: the schema accepts `style` on `revise` exactly as it does on
    // `approve` — whatever x-agent (which implements no revision loop) does
    // with the decision itself is a separate question from whether the
    // ROUTE let the payload through.
    expect(resumeRes.status).toBe(200);
  }, 60_000);
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
