import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

describe("GET /openapi.json", () => {
  it("returns a valid-looking OpenAPI 3.0 document covering every route", async () => {
    const env: TestEnvironment = await setupTestEnvironment();
    try {
      const app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
      const res = await request(app).get("/openapi.json");

      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe("3.0.3");
      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining(["/healthz", "/api/v1/runs/start", "/api/v1/runs/{runId}/resume", "/api/v1/runs/{runId}/status"]),
      );

      const startExamples = res.body.paths["/api/v1/runs/start"].post.requestBody.content["application/json"].examples;
      for (const productId of ["x-agent", "linkedin-agent", "reddit-agent", "blog-agent", "newsletter-agent", "campaign-orchestrator"]) {
        expect(startExamples[productId].value.productId).toBe(productId);
      }
    } finally {
      await env.cleanup();
    }
  });
});

describe("GET /docs", () => {
  it("serves the Swagger UI page", async () => {
    const env: TestEnvironment = await setupTestEnvironment();
    try {
      const app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
      const res = await request(app).get("/docs/");

      expect(res.status).toBe(200);
      expect(res.type).toBe("text/html");
      expect(res.text).toContain("Swagger UI");
    } finally {
      await env.cleanup();
    }
  });

  it("redirects the no-trailing-slash path to /docs/", async () => {
    const env: TestEnvironment = await setupTestEnvironment();
    try {
      const app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
      const res = await request(app).get("/docs");

      expect(res.status).toBe(301);
    } finally {
      await env.cleanup();
    }
  });
});
