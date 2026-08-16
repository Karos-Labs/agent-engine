import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import request from "supertest";
import type { Application } from "express";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { MemoryDurableStepStore } from "@agent-engine/workflow";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

describe("POST /api/v1/runs/start", () => {
  let env: TestEnvironment;
  let app: Application;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("runs the X agent end to end and returns a delivered report", async () => {
    const res = await request(app)
      .post("/api/v1/runs/start")
      .send({ clientSlug: "acme", productId: "x-agent", runKind: "recurring", inputParams: {} });

    expect(res.status).toBe(201);
    expect(typeof res.body.runId).toBe("string");
    expect(res.body.status).toBe("completed");
    expect(res.body.report.domainOutcome).toBe("delivered");
    expect(res.body.report.steps).toHaveLength(16);
  });

  it("runs each of the five channel agents end to end", async () => {
    for (const productId of ["linkedin-agent", "reddit-agent", "blog-agent", "newsletter-agent"] as const) {
      const res = await request(app).post("/api/v1/runs/start").send({ clientSlug: "acme", productId, runKind: "recurring" });
      expect(res.status, `${productId} should return 201`).toBe(201);
      expect(res.body.status, `${productId} should complete`).toBe("completed");
      expect(res.body.report.domainOutcome, `${productId} should be delivered`).toBe("delivered");
    }
  });

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
    const bareTools = createAllKarosTools(bareStore);
    await bareStore.writeJson("bare-client", ["client", "profile"], { name: "Bare Co", industry: "Unknown" });
    // Deliberately no ["client", "config"] doc written for "bare-client".

    const bareApp = createApp({
      durableStore: new MemoryDurableStepStore(),
      runtimeDeps: { tools: bareTools, promptStore: env.runtimeDeps.promptStore, router: env.runtimeDeps.router },
    });
    try {
      const res = await request(bareApp).post("/api/v1/runs/start").send({ clientSlug: "bare-client", productId: "x-agent", runKind: "recurring" });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("blocked_intake");
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
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("returns the same status/report for a run that was already started", async () => {
    const startRes = await request(app).post("/api/v1/runs/start").send({ clientSlug: "acme", productId: "blog-agent", runKind: "recurring" });
    const { runId } = startRes.body;

    const statusRes = await request(app).get(`/api/v1/runs/${runId}/status`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe("completed");
    expect(statusRes.body.report.domainOutcome).toBe("delivered");
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
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("pauses at the campaign review gate, then resumes to completed on approval", async () => {
    const startRes = await request(app)
      .post("/api/v1/runs/start")
      .send({ clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" });

    expect(startRes.status).toBe(201);
    expect(startRes.body.status).toBe("awaiting_gate");
    expect(startRes.body.pendingGateId).toContain("13-campaign-review");
    const { runId } = startRes.body;

    const resumeRes = await request(app)
      .post(`/api/v1/runs/${runId}/resume`)
      .send({ gateId: "13-campaign-review", resolution: { decision: "approve", actor: "jane@karoslabs.com" } });

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.status).toBe("completed");
    expect(resumeRes.body.report.domainOutcome).toBe("delivered");
    // The dynamically-discovered fan-out slots (5 channels) all show up as their own report entries.
    const slotSteps = resumeRes.body.report.steps.filter((s: { stepId: string }) => s.stepId.startsWith("channel-fanout__slot_"));
    expect(slotSteps.length).toBeGreaterThan(0);
  });

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
