import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import request from "supertest";
import type { Application } from "express";
import { createApp } from "../src/app.js";
import {
  createTenantAssertionMiddleware,
  enforceTenantEntitlement,
  signTenantAssertion,
  verifyTenantAssertion,
  TenantAssertionError,
  type RequestWithTenantAssertion,
} from "../src/auth/tenant-assertion.js";
import { createTenantAssertionConfigFromEnv } from "../src/wiring/tenant-assertion.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const SECRET = "shared-hmac-secret-for-tests";
const HEADER = "x-tenant-assertion";

describe("AU46: tenant entitlement at the engine edge (SCRUM-329, decision 9)", () => {
  describe("signTenantAssertion / verifyTenantAssertion (the wire format)", () => {
    it("round-trips a valid assertion", () => {
      const token = signTenantAssertion("acme", SECRET);
      expect(verifyTenantAssertion(token, SECRET)).toEqual({ clientSlug: "acme" });
    });

    it("rejects a tampered clientSlug even though the signature was valid for the original payload", () => {
      const token = signTenantAssertion("acme", SECRET);
      const [payloadB64, sigB64] = token.split(".");
      const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
      payload.clientSlug = "evil-corp";
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const tampered = `${tamperedPayloadB64}.${sigB64}`;
      expect(() => verifyTenantAssertion(tampered, SECRET)).toThrow(TenantAssertionError);
    });

    it("rejects a token signed with a different secret", () => {
      const token = signTenantAssertion("acme", "wrong-secret");
      expect(() => verifyTenantAssertion(token, SECRET)).toThrow(/signature verification failed/);
    });

    it("rejects an expired assertion", () => {
      let clock = 1_000_000;
      const token = signTenantAssertion("acme", SECRET, () => clock, 60);
      clock += 61; // past exp
      expect(() => verifyTenantAssertion(token, SECRET, () => clock)).toThrow(/expired/);
    });

    it("accepts an assertion at the boundary before it expires", () => {
      let clock = 1_000_000;
      const token = signTenantAssertion("acme", SECRET, () => clock, 60);
      clock += 60; // exactly at exp — now() > exp is the failure condition, not >=
      expect(verifyTenantAssertion(token, SECRET, () => clock)).toEqual({ clientSlug: "acme" });
    });

    it("rejects a malformed token (no separator)", () => {
      expect(() => verifyTenantAssertion("not-a-valid-token", SECRET)).toThrow(/malformed/);
    });

    it("rejects an assertion with no clientSlug in the payload", () => {
      const payloadB64 = Buffer.from(JSON.stringify({ iat: 1, exp: 999_999_999_999 }), "utf8").toString("base64url");
      const sig = createHmac("sha256", SECRET).update(payloadB64).digest();
      const token = `${payloadB64}.${sig.toString("base64url")}`;
      expect(() => verifyTenantAssertion(token, SECRET)).toThrow(/clientSlug/);
    });
  });

  describe("createTenantAssertionMiddleware", () => {
    function req(headerValue?: string): RequestWithTenantAssertion {
      return { header: (name: string) => (name.toLowerCase() === HEADER ? headerValue : undefined) } as unknown as RequestWithTenantAssertion;
    }
    function res() {
      const calls: { status?: number; body?: unknown } = {};
      return {
        status(code: number) {
          calls.status = code;
          return this;
        },
        json(body: unknown) {
          calls.body = body;
          return this;
        },
        calls,
      } as unknown as { status: (n: number) => unknown; json: (b: unknown) => unknown; calls: typeof calls };
    }

    it("passes through with no tenantAssertion attached when disabled — the structural no-op this ticket is allowed to leave in place", () => {
      const middleware = createTenantAssertionMiddleware({ enabled: false });
      const r = req(undefined);
      let called = false;
      middleware(r, res() as never, () => {
        called = true;
      });
      expect(called).toBe(true);
      expect(r.tenantAssertion).toBeUndefined();
    });

    it("500s when enabled with no secret configured — fails closed rather than trusting an unverifiable header", () => {
      const middleware = createTenantAssertionMiddleware({ enabled: true });
      const r = req(signTenantAssertion("acme", SECRET));
      const response = res();
      let called = false;
      middleware(r, response as never, () => {
        called = true;
      });
      expect(called).toBe(false);
      expect(response.calls.status).toBe(500);
    });

    it("401s a request with no header when enabled", () => {
      const middleware = createTenantAssertionMiddleware({ enabled: true, secret: SECRET });
      const response = res();
      let called = false;
      middleware(req(undefined), response as never, () => {
        called = true;
      });
      expect(called).toBe(false);
      expect(response.calls.status).toBe(401);
    });

    it("401s a forged/invalid assertion", () => {
      const middleware = createTenantAssertionMiddleware({ enabled: true, secret: SECRET });
      const response = res();
      let called = false;
      middleware(req("garbage"), response as never, () => {
        called = true;
      });
      expect(called).toBe(false);
      expect(response.calls.status).toBe(401);
    });

    it("attaches the verified clientSlug and calls next() on a valid assertion", () => {
      const middleware = createTenantAssertionMiddleware({ enabled: true, secret: SECRET });
      const r = req(signTenantAssertion("acme", SECRET));
      let called = false;
      middleware(r, res() as never, () => {
        called = true;
      });
      expect(called).toBe(true);
      expect(r.tenantAssertion).toEqual({ clientSlug: "acme" });
    });
  });

  describe("enforceTenantEntitlement", () => {
    function res() {
      const calls: { status?: number; body?: unknown } = {};
      return {
        status(code: number) {
          calls.status = code;
          return this;
        },
        json(body: unknown) {
          calls.body = body;
          return this;
        },
        calls,
      } as unknown as { status: (n: number) => unknown; json: (b: unknown) => unknown; calls: typeof calls };
    }

    it("is a no-op (returns false, writes nothing) when no assertion is attached", () => {
      const response = res();
      const rejected = enforceTenantEntitlement({} as RequestWithTenantAssertion, response as never, "acme");
      expect(rejected).toBe(false);
      expect(response.calls.status).toBeUndefined();
    });

    it("403s when the asserted tenant does not match the target clientSlug — the actual entitlement check", () => {
      const response = res();
      const r = { tenantAssertion: { clientSlug: "acme" } } as RequestWithTenantAssertion;
      const rejected = enforceTenantEntitlement(r, response as never, "some-other-client");
      expect(rejected).toBe(true);
      expect(response.calls.status).toBe(403);
    });

    it("passes (returns false) when the asserted tenant matches", () => {
      const response = res();
      const r = { tenantAssertion: { clientSlug: "acme" } } as RequestWithTenantAssertion;
      const rejected = enforceTenantEntitlement(r, response as never, "acme");
      expect(rejected).toBe(false);
      expect(response.calls.status).toBeUndefined();
    });
  });

  describe("createTenantAssertionConfigFromEnv", () => {
    it("is off unless TENANT_ASSERTION_ENABLED is explicitly true", () => {
      expect(createTenantAssertionConfigFromEnv({}).enabled).toBe(false);
      expect(createTenantAssertionConfigFromEnv({ TENANT_ASSERTION_ENABLED: "false" }).enabled).toBe(false);
      expect(createTenantAssertionConfigFromEnv({ TENANT_ASSERTION_ENABLED: "true" }).enabled).toBe(true);
    });

    it("reads the shared secret from TENANT_ASSERTION_SECRET", () => {
      expect(createTenantAssertionConfigFromEnv({ TENANT_ASSERTION_SECRET: "abc" }).secret).toBe("abc");
    });
  });

  // ---------------------------------------------------------------------
  // Full-app integration: the actual cross-tenant gap this ticket closes.
  // ---------------------------------------------------------------------
  describe("wired end-to-end: enforcement at the edge on the routes that carry clientSlug", () => {
    let env: TestEnvironment;
    let app: Application;

    beforeEach(async () => {
      env = await setupTestEnvironment("acme");
      app = createApp({
        durableStore: env.durableStore,
        runtimeDeps: { ...env.runtimeDeps, workspaceStore: env.store },
        tenantAssertion: { enabled: true, secret: SECRET },
      });
    });

    afterEach(async () => {
      await env.cleanup();
    });

    function assertionFor(clientSlug: string): string {
      return signTenantAssertion(clientSlug, SECRET);
    }

    it("401s every clientSlug-bearing route when the assertion header is missing entirely", async () => {
      const status = await request(app).get("/api/v1/runs/any/status");
      expect(status.status).toBe(401);

      const start = await request(app).post("/api/v1/runs/start").send({ clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" });
      expect(start.status).toBe(401);

      const deliverable = await request(app).get("/api/v1/runs/r1/deliverables/seo-geo-report");
      expect(deliverable.status).toBe(401);
    });

    it("403s /runs/start when the asserted tenant does not match the body's clientSlug", async () => {
      const res = await request(app)
        .post("/api/v1/runs/start")
        .set(HEADER, assertionFor("acme"))
        .send({ clientSlug: "some-other-client", productId: "linkedin-agent", runKind: "recurring" });
      expect(res.status).toBe(403);
    });

    it("lets /runs/start through when the asserted tenant matches the body's clientSlug", async () => {
      const res = await request(app)
        .post("/api/v1/runs/start")
        .set(HEADER, assertionFor("acme"))
        .send({ clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" });
      // No queue is configured in this test app — the *tenant* check passing is
      // what's under test, proven by getting PAST it to the (expected) 500 for
      // the unconfigured queue, rather than being stopped at 403/401.
      expect(res.status).toBe(500);
    });

    it("THE GAP THIS TICKET CLOSES: 403s a cross-tenant deliverable-content read via runId guessing, instead of serving another tenant's data", async () => {
      await env.durableStore.createRunIfNotExists({
        runId: "victim-run",
        clientSlug: "acme",
        productId: "seo-geo-agent",
        runKind: "recurring",
        status: "completed",
        createdAt: 1000,
        updatedAt: 1000,
      });
      await env.runtimeDeps.tools["ledger.writeDeliverable"]!.execute(
        { runId: "victim-run", kind: "seo-geo-report", deliverable: { secret: "acme's private report" } },
        { ctx: { runId: "victim-run", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring", metadata: {} } },
      );

      // An attacker authenticated as a DIFFERENT tenant guesses the runId and kind.
      const attack = await request(app).get("/api/v1/runs/victim-run/deliverables/seo-geo-report").set(HEADER, assertionFor("attacker-client"));
      expect(attack.status).toBe(403);
      expect(JSON.stringify(attack.body)).not.toContain("acme's private report");

      // The legitimate tenant can still read its own deliverable.
      const legit = await request(app).get("/api/v1/runs/victim-run/deliverables/seo-geo-report").set(HEADER, assertionFor("acme"));
      expect(legit.status).toBe(200);
      expect(legit.body.deliverable).toEqual({ secret: "acme's private report" });
    });

    it("also closes the same runId-guessing gap on /runs/:runId/status", async () => {
      await env.durableStore.createRunIfNotExists({
        runId: "victim-run-2",
        clientSlug: "acme",
        productId: "seo-geo-agent",
        runKind: "recurring",
        status: "completed",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const attack = await request(app).get("/api/v1/runs/victim-run-2/status").set(HEADER, assertionFor("attacker-client"));
      expect(attack.status).toBe(403);

      const legit = await request(app).get("/api/v1/runs/victim-run-2/status").set(HEADER, assertionFor("acme"));
      expect(legit.status).toBe(200);
    });

    it("also closes the same runId-guessing gap on /runs/:runId/resume", async () => {
      await env.durableStore.createRunIfNotExists({
        runId: "victim-run-3",
        clientSlug: "acme",
        productId: "seo-geo-agent",
        runKind: "recurring",
        status: "awaiting_gate",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const attack = await request(app)
        .post("/api/v1/runs/victim-run-3/resume")
        .set(HEADER, assertionFor("attacker-client"))
        .send({ gateId: "g1", resolution: { decision: "approve", actor: "attacker" } });
      expect(attack.status).toBe(403);
    });

    it("disabled tenant assertion (the default) leaves today's caller-asserted-clientSlug behaviour unchanged", async () => {
      const looseApp = createApp({
        durableStore: env.durableStore,
        runtimeDeps: { ...env.runtimeDeps, workspaceStore: env.store },
        // tenantAssertion omitted entirely
      });
      const res = await request(looseApp).get("/api/v1/runs/no-such-run/status");
      // 404, not 401/403: with the middleware unmounted, the route runs exactly
      // as it did before this ticket.
      expect(res.status).toBe(404);
    });
  });
});
