import express, { type Application } from "express";
import { MemoryAgentDefinitionStore } from "@agent-engine/core";
import type { DurableStepStore } from "@agent-engine/workflow";
import { createAgentsRouter } from "./routes/agents.js";
import { createDeliverablesRouter } from "./routes/deliverables.js";
import { createDiagnosticsRouter } from "./routes/diagnostics.js";
import { createDocsRouter } from "./routes/docs.js";
import { createHealthRouter } from "./routes/health.js";
import { createQueueRouter, type VerifyPushIdToken } from "./routes/queue.js";
import { createRunsRouter, type RunsRouterDeps } from "./routes/runs.js";
import { createServiceIdentityMiddleware, type ServiceIdentityConfig } from "./auth/service-identity.js";
import { httpTracingMiddleware } from "./telemetry/http-tracing-middleware.js";
import { createTenantAssertionMiddleware, type TenantAssertionConfig } from "./auth/tenant-assertion.js";

export interface CreateAppDeps extends RunsRouterDeps {
  durableStore: DurableStepStore;
  /** See `routes/queue.ts`'s `QueueRouterDeps` — all optional, so an app built with none of this still boots (the push route just 500s if ever hit, same as any other unconfigured-dependency mistake). */
  queuePushAudienceUrl?: string;
  verifyPushIdToken?: VerifyPushIdToken;
  /**
   * Service-to-service authentication (AU1). Omitted means disabled — the
   * local-development and test default, and the behaviour every caller of this
   * function had before authentication existed. `server.ts` supplies the real,
   * env-built config.
   */
  auth?: ServiceIdentityConfig;
  /**
   * Tenant entitlement at the edge (AU46 / SCRUM-329). Omitted means
   * disabled — no `req.tenantAssertion` is attached, and every route's
   * `enforceTenantEntitlement` call becomes a no-op, i.e. today's
   * caller-asserted-clientSlug behaviour. `server.ts` supplies the real,
   * env-built config; see `wiring/tenant-assertion.ts` for why it stays
   * off by default.
   */
  tenantAssertion?: TenantAssertionConfig;
}

/**
 * Builds the Express application without binding a port — every real
 * dependency (durable store, tools/promptStore/router, id/clock generators)
 * is injected, so `__tests__/` can exercise the real HTTP routes against
 * fully in-memory/fake dependencies (no real GCP or Anthropic call), and
 * `src/server.ts` supplies the real, env-constructed ones for Cloud Run.
 */
export function createApp(deps: CreateAppDeps): Application {
  // Task 2: falls back to a fresh in-process store when the caller didn't configure one
  // (existing tests that predate dynamic agents, or a deployment that never uses them) —
  // the SAME instance is threaded into both /api/agents and startRunJob's own resolution
  // (via RunsRouterDeps below), so an agent created through the CRUD routes is immediately
  // visible to a run naming it, never a second, unrelated store.
  const agentDefinitionStore = deps.agentDefinitionStore ?? new MemoryAgentDefinitionStore();
  const runsDeps: RunsRouterDeps = { ...deps, agentDefinitionStore };

  const app = express();
  app.use(express.json());

  // AU42/SCRUM-326: the top-of-trace HTTP request span, mounted before
  // EVERYTHING else — including the two exemptions below — so a request that
  // never reaches an authenticated route (a bad push token, a liveness probe)
  // still gets a span, matching what the caller actually saw.
  app.use(httpTracingMiddleware());

  // Mount order is load-bearing (AU1). Two routes sit deliberately BEFORE the
  // authentication middleware:
  //
  //  * `/healthz` — a liveness probe carries no credentials, and a health
  //    endpoint that can 401 reports the wrong thing when auth is the very
  //    thing misconfigured.
  //  * the Pub/Sub push route — it authenticates against a DIFFERENT audience
  //    (its own endpoint URL, which is what Pub/Sub mints push tokens for) via
  //    its own verifier, so a valid push token would fail the service-wide
  //    audience check. Its auth is configured separately; see `routes/queue.ts`.
  //
  // Express falls through to the next `use` when a router matches no path, so
  // mounting these first exempts exactly those paths and nothing else.
  app.use(createHealthRouter());
  app.use(
    createQueueRouter({
      durableStore: deps.durableStore,
      runtimeDeps: deps.runtimeDeps,
      agentDefinitionStore,
      ...(deps.queuePushAudienceUrl !== undefined ? { pushAudienceUrl: deps.queuePushAudienceUrl } : {}),
      ...(deps.verifyPushIdToken !== undefined ? { verifyPushIdToken: deps.verifyPushIdToken } : {}),
    }),
  );

  if (deps.auth) {
    app.use(createServiceIdentityMiddleware(deps.auth));
  }

  // Layered on top of "who is the caller" (AU1, immediately above): "which
  // tenant is this specific request for" (AU46 / SCRUM-329). Mounted after
  // service identity and before every router that reads or resolves a
  // clientSlug, so `req.tenantAssertion` is available by the time any of
  // them runs `enforceTenantEntitlement`. Docs/diagnostics carry no
  // clientSlug and don't need it, but mounting here rather than per-router
  // costs nothing and matches AU1's own mount-order comment below.
  if (deps.tenantAssertion) {
    app.use(createTenantAssertionMiddleware(deps.tenantAssertion));
  }

  // Everything below is authenticated whenever `deps.auth.enabled` is set.
  app.use(createDocsRouter());
  app.use(createDiagnosticsRouter());
  app.use(createRunsRouter(runsDeps));
  app.use(createAgentsRouter({ agentDefinitionStore }));
  app.use(createDeliverablesRouter({ durableStore: deps.durableStore, workspaceStore: deps.runtimeDeps.workspaceStore }));
  return app;
}
