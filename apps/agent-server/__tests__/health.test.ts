import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

describe("GET /healthz", () => {
  it("returns status ok and a non-negative uptime", async () => {
    const env: TestEnvironment = await setupTestEnvironment();
    try {
      const app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
      const res = await request(app).get("/healthz");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(typeof res.body.uptime).toBe("number");
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      await env.cleanup();
    }
  });
});
