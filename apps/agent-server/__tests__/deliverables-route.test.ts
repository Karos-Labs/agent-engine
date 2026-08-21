import { describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

describe("GET /api/v1/runs/:runId/deliverables/:kind (Task 1 plumbing)", () => {
  let env: TestEnvironment;
  let app: Application;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    // The deliverables route reads via runtimeDeps.workspaceStore — must be the SAME instance
    // env.tools["ledger.writeDeliverable"] itself writes through (env.store), not a fresh
    // default one, or a read would target an unrelated location.
    app = createApp({ durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, workspaceStore: env.store } });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("404s for a run that doesn't exist", async () => {
    const res = await request(app).get("/api/v1/runs/no-such-run/deliverables/seo-geo-report");
    expect(res.status).toBe(404);
  });

  it("404s for a real run with no deliverable of that kind written yet", async () => {
    await env.durableStore.createRunIfNotExists({
      runId: "run-1",
      clientSlug: "acme",
      productId: "seo-geo-agent",
      runKind: "recurring",
      status: "running",
      createdAt: 1000,
      updatedAt: 1000,
    });
    const res = await request(app).get("/api/v1/runs/run-1/deliverables/seo-geo-report");
    expect(res.status).toBe(404);
  });

  it("returns exactly what ledger.writeDeliverable wrote for that run/kind", async () => {
    await env.durableStore.createRunIfNotExists({
      runId: "run-2",
      clientSlug: "acme",
      productId: "seo-geo-agent",
      runKind: "recurring",
      status: "completed",
      createdAt: 1000,
      updatedAt: 1000,
    });
    const outcome = await env.runtimeDeps.tools["ledger.writeDeliverable"]!.execute(
      { runId: "run-2", kind: "seo-geo-report", deliverable: { seoScore: 82, narrative: "solid coverage" } },
      { ctx: { runId: "run-2", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring", metadata: {} } },
    );
    expect(outcome.status).toBe("success");

    const res = await request(app).get("/api/v1/runs/run-2/deliverables/seo-geo-report");
    expect(res.status).toBe(200);
    expect(res.body.deliverable).toEqual({ seoScore: 82, narrative: "solid coverage" });
    expect(res.body.kind).toBe("seo-geo-report");
  });
});
