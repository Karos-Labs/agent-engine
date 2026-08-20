import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Application } from "express";
import type { ModelRouter } from "@agent-engine/core";
import type { VerifyPushIdToken } from "../src/routes/queue.js";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const PUSH_PATH = "/api/v1/queue/pubsub-push";

/**
 * Wraps a real `ModelRouter` with a call counter on `complete`, preserving
 * `complete`'s own generic signature (a `vi.fn()` wrapper loses it, since
 * vitest's mock type can't express a generic method).
 */
function withCallCounter(router: ModelRouter): { router: ModelRouter; callCount: () => number } {
  let count = 0;
  const wrapped: ModelRouter = {
    ...router,
    async complete(prompt, schema, policy, opts) {
      count += 1;
      return router.complete(prompt, schema, policy, opts);
    },
  };
  return { router: wrapped, callCount: () => count };
}

function envelope(payload: unknown, messageId = "test-msg-1") {
  return { message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), messageId } };
}

const validPayload = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" };

describe("POST /api/v1/queue/pubsub-push", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe("permissive local-dev config (no pushToken / pushAudienceUrl)", () => {
    let app: Application;

    beforeEach(() => {
      app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
    });

    it("triggers a real run and returns 200 with the run's status", async () => {
      const res = await request(app).post(PUSH_PATH).send(envelope(validPayload));

      expect(res.status).toBe(200);
      expect(res.body.runId).toBe("pubsub-test-msg-1");
      expect(res.body.status).toBe("awaiting_gate");
    });

    it("returns 400 for a malformed envelope (missing message.data)", async () => {
      const res = await request(app)
        .post(PUSH_PATH)
        .send({ message: { messageId: "test-msg-2" } });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid base64/non-JSON message.data", async () => {
      // Node's base64 decoder is lenient (it silently ignores non-alphabet
      // characters rather than throwing), so this has to actually decode to
      // garbage that fails JSON.parse, not merely contain "invalid" base64
      // characters.
      const garbage = Buffer.from("this decodes fine but is not json at all {{{", "utf8").toString("base64");
      const res = await request(app)
        .post(PUSH_PATH)
        .send({ message: { data: garbage, messageId: "test-msg-3" } });
      expect(res.status).toBe(400);
    });

    it("returns 400 for valid base64 JSON that doesn't match RunJobRequestSchema", async () => {
      const res = await request(app).post(PUSH_PATH).send(envelope({ clientSlug: "acme", runKind: "recurring" }, "test-msg-4"));
      expect(res.status).toBe(400);
    });

    it("idempotency: posting the identical envelope twice returns the same runId both times and does not re-invoke the model router", async () => {
      const { router: countingRouter, callCount } = withCallCounter(env.runtimeDeps.router);
      const instrumentedRuntimeDeps = { ...env.runtimeDeps, router: countingRouter };
      const idempotentApp = createApp({ durableStore: env.durableStore, runtimeDeps: instrumentedRuntimeDeps });

      const body = envelope(validPayload, "redelivered-msg");
      const first = await request(idempotentApp).post(PUSH_PATH).send(body);
      expect(first.status).toBe(200);
      const callCountAfterFirst = callCount();
      expect(callCountAfterFirst).toBeGreaterThan(0);

      const second = await request(idempotentApp).post(PUSH_PATH).send(body);
      expect(second.status).toBe(200);
      expect(second.body.runId).toBe(first.body.runId);
      expect(callCount()).toBe(callCountAfterFirst);
    });
  });

  describe("pushToken configured", () => {
    let app: Application;

    beforeEach(() => {
      app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, queuePushToken: "shared-secret-123" });
    });

    it("rejects a request with no ?token= with 401", async () => {
      const res = await request(app).post(PUSH_PATH).send(envelope(validPayload, "token-test-1"));
      expect(res.status).toBe(401);
    });

    it("rejects a request with the wrong ?token= with 401", async () => {
      const res = await request(app).post(`${PUSH_PATH}?token=wrong-secret`).send(envelope(validPayload, "token-test-2"));
      expect(res.status).toBe(401);
    });

    it("succeeds with the correct ?token=", async () => {
      const res = await request(app).post(`${PUSH_PATH}?token=shared-secret-123`).send(envelope(validPayload, "token-test-3"));
      expect(res.status).toBe(200);
    });
  });

  describe("pushAudienceUrl configured but no verifyPushIdToken injected (misconfiguration)", () => {
    it("returns 500 rather than silently accepting the unauthenticated push", async () => {
      const app = createApp({
        durableStore: env.durableStore,
        runtimeDeps: env.runtimeDeps,
        queuePushAudienceUrl: "https://example.run.app/api/v1/queue/pubsub-push",
      });
      const res = await request(app)
        .post(PUSH_PATH)
        .set("Authorization", "Bearer some-id-token")
        .send(envelope(validPayload, "misconfig-test-1"));
      expect(res.status).toBe(500);
    });
  });

  describe("pushAudienceUrl + a fake verifyPushIdToken injected", () => {
    const audienceUrl = "https://example.run.app/api/v1/queue/pubsub-push";
    let app: Application;
    let verifyPushIdToken: ReturnType<typeof vi.fn<VerifyPushIdToken>>;

    function buildApp() {
      app = createApp({
        durableStore: env.durableStore,
        runtimeDeps: env.runtimeDeps,
        queuePushAudienceUrl: audienceUrl,
        verifyPushIdToken,
      });
    }

    it("returns 401 when there is no Authorization header", async () => {
      verifyPushIdToken = vi.fn().mockResolvedValue(undefined);
      buildApp();
      const res = await request(app).post(PUSH_PATH).send(envelope(validPayload, "oidc-test-1"));
      expect(res.status).toBe(401);
      expect(verifyPushIdToken).not.toHaveBeenCalled();
    });

    it("returns 401 when the fake verifier rejects", async () => {
      verifyPushIdToken = vi.fn().mockRejectedValue(new Error("invalid token"));
      buildApp();
      const res = await request(app)
        .post(PUSH_PATH)
        .set("Authorization", "Bearer bad-id-token")
        .send(envelope(validPayload, "oidc-test-2"));
      expect(res.status).toBe(401);
      expect(verifyPushIdToken).toHaveBeenCalledWith("bad-id-token", audienceUrl);
    });

    it("proceeds normally when the fake verifier resolves, and is called with the exact bearer token and audience", async () => {
      verifyPushIdToken = vi.fn().mockResolvedValue(undefined);
      buildApp();
      const res = await request(app)
        .post(PUSH_PATH)
        .set("Authorization", "Bearer good-id-token")
        .send(envelope(validPayload, "oidc-test-3"));
      expect(res.status).toBe(200);
      expect(verifyPushIdToken).toHaveBeenCalledWith("good-id-token", audienceUrl);
    });
  });
});
