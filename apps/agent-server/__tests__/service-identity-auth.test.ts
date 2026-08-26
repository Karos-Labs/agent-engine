import { describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { createApp } from "../src/app.js";
import type { ServiceIdentityConfig, VerifyIdToken } from "../src/auth/service-identity.js";
import { createServiceIdentityConfigFromEnv } from "../src/wiring/auth.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const AUDIENCE = "https://agent-engine-prep.example.run.app";
const PORTAL_SA = "portal@karoscmo.iam.gserviceaccount.com";

/** Accepts exactly one token, for exactly the expected audience. Never touches the network. */
function fakeVerifier(validToken: string, email: string | undefined = PORTAL_SA): VerifyIdToken {
  return async (idToken, audience) => {
    if (audience !== AUDIENCE) throw new Error(`wrong audience: ${audience}`);
    if (idToken !== validToken) throw new Error("token signature verification failed against Google certs");
    return { sub: "1234567890", email };
  };
}

describe("AU1: service-identity authentication (SCRUM-287)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  function appWith(auth: Partial<ServiceIdentityConfig>): Application {
    return createApp({
      durableStore: env.durableStore,
      runtimeDeps: { ...env.runtimeDeps, workspaceStore: env.store },
      auth: {
        enabled: true,
        audience: AUDIENCE,
        allowedServiceAccounts: [],
        isProduction: true,
        verifyIdToken: fakeVerifier("good-token"),
        ...auth,
      },
    });
  }

  describe("an authorised caller", () => {
    it("passes a valid token through to the route", async () => {
      const res = await request(appWith({})).get("/api/v1/runs/no-such-run/status").set("authorization", "Bearer good-token");
      // 404 from the route itself — not 401/403 — proves the middleware let it through.
      expect(res.status).toBe(404);
    });

    it("accepts a caller whose email is on a populated allowlist", async () => {
      const app = appWith({ allowedServiceAccounts: [PORTAL_SA] });
      const res = await request(app).get("/api/v1/runs/no-such-run/status").set("authorization", "Bearer good-token");
      expect(res.status).toBe(404);
    });
  });

  describe("an unauthorised caller", () => {
    it("401s a request with no Authorization header, and advertises Bearer", async () => {
      const res = await request(appWith({})).get("/api/v1/runs/any/status");
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    });

    it("401s an invalid token WITHOUT echoing the verification failure", async () => {
      const res = await request(appWith({})).get("/api/v1/runs/any/status").set("authorization", "Bearer forged");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "invalid identity token" });
      expect(JSON.stringify(res.body)).not.toContain("Google certs");
    });

    it("403s a verified caller who is not on a populated allowlist", async () => {
      const app = appWith({ allowedServiceAccounts: ["someone-else@example.iam.gserviceaccount.com"] });
      const res = await request(app).get("/api/v1/runs/any/status").set("authorization", "Bearer good-token");
      expect(res.status).toBe(403);
    });

    it("blocks the write routes too, not just reads", async () => {
      const app = appWith({});
      const start = await request(app).post("/api/v1/runs/start").send({ clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" });
      expect(start.status).toBe(401);
      const createAgent = await request(app).post("/api/agents").send({ agentId: "x", definition: {} });
      expect(createAgent.status).toBe(401);
      const deliverable = await request(app).get("/api/v1/runs/r1/deliverables/seo-geo-report");
      expect(deliverable.status).toBe(401);
    });
  });

  describe("fail-closed configuration guards", () => {
    it("500s rather than verifying without an audience — a token minted for any other service must not be replayable here", async () => {
      const app = appWith({ audience: undefined });
      const res = await request(app).get("/api/v1/runs/any/status").set("authorization", "Bearer good-token");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("service authentication is misconfigured");
    });

    it("500s when enabled but no verifier was wired at the composition root", async () => {
      const app = appWith({ verifyIdToken: undefined });
      const res = await request(app).get("/api/v1/runs/any/status").set("authorization", "Bearer good-token");
      expect(res.status).toBe(500);
    });

    it("refuses the dev token in production, even when one is configured", async () => {
      const app = appWith({ devToken: "dev-secret", isProduction: true });
      const res = await request(app).get("/api/v1/runs/any/status").set("authorization", "Bearer dev-secret");
      // Falls through to OIDC verification, which rejects it.
      expect(res.status).toBe(401);
    });

    it("accepts the dev token outside production", async () => {
      const app = appWith({ devToken: "dev-secret", isProduction: false });
      const res = await request(app).get("/api/v1/runs/no-such-run/status").set("authorization", "Bearer dev-secret");
      expect(res.status).toBe(404);
    });
  });

  describe("deliberate exemptions", () => {
    it("leaves /healthz reachable without credentials", async () => {
      const res = await request(appWith({})).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });

    it("does not apply the service audience to the Pub/Sub push route, which authenticates against its own", async () => {
      // No Authorization header at all. The push route has its own auth (AU2);
      // reaching its envelope validation (400) rather than the service-wide 401
      // is what proves it sits outside this middleware.
      const res = await request(appWith({})).post("/api/v1/queue/pubsub-push").send({ not: "an envelope" });
      expect(res.status).toBe(400);
    });
  });

  describe("disabled by default", () => {
    it("lets every request through when no auth config is supplied — the pre-AU1 behaviour tests rely on", async () => {
      const app = createApp({ durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, workspaceStore: env.store } });
      const res = await request(app).get("/api/v1/runs/no-such-run/status");
      expect(res.status).toBe(404);
    });
  });

  describe("createServiceIdentityConfigFromEnv", () => {
    it("is off unless AUTH_ENABLED is explicitly true", () => {
      expect(createServiceIdentityConfigFromEnv({}).enabled).toBe(false);
      expect(createServiceIdentityConfigFromEnv({ AUTH_ENABLED: "false" }).enabled).toBe(false);
      expect(createServiceIdentityConfigFromEnv({ AUTH_ENABLED: "true" }, async () => ({})).enabled).toBe(true);
    });

    it("parses a comma-separated service-account allowlist", () => {
      const config = createServiceIdentityConfigFromEnv({ AUTH_ALLOWED_SERVICE_ACCOUNTS: ` ${PORTAL_SA} , other@x.iam.gserviceaccount.com ,` });
      expect(config.allowedServiceAccounts).toEqual([PORTAL_SA, "other@x.iam.gserviceaccount.com"]);
    });

    it("derives production from the same FIRESTORE_DATABASE_ID signal the tracer uses", () => {
      expect(createServiceIdentityConfigFromEnv({ FIRESTORE_DATABASE_ID: "prep" }).isProduction).toBe(false);
      expect(createServiceIdentityConfigFromEnv({ FIRESTORE_DATABASE_ID: "(default)" }).isProduction).toBe(true);
      // Unset must NOT read as prep — an unconfigured deploy is treated as production.
      expect(createServiceIdentityConfigFromEnv({}).isProduction).toBe(true);
    });
  });
});
