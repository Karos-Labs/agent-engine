import express, { type Application } from "express";
import { MemoryAgentDefinitionStore } from "@agent-engine/core";
import { createWorkspaceStore } from "@agent-engine/tools";
import type { DurableStepStore } from "@agent-engine/workflow";
import { createAgentsRouter } from "./routes/agents.js";
import { createDeliverablesRouter } from "./routes/deliverables.js";
import { createDocsRouter } from "./routes/docs.js";
import { createHealthRouter } from "./routes/health.js";
import { createQueueRouter, type VerifyPushIdToken } from "./routes/queue.js";
import { createRunsRouter, type RunsRouterDeps } from "./routes/runs.js";

export interface CreateAppDeps extends RunsRouterDeps {
  durableStore: DurableStepStore;
  /** See `routes/queue.ts`'s `QueueRouterDeps` — all optional, so an app built with none of this still boots (the push route just 500s if ever hit, same as any other unconfigured-dependency mistake). */
  queuePushToken?: string;
  queuePushAudienceUrl?: string;
  verifyPushIdToken?: VerifyPushIdToken;
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
  app.use(createHealthRouter());
  app.use(createDocsRouter());
  app.use(createRunsRouter(runsDeps));
  app.use(createAgentsRouter({ agentDefinitionStore }));
  app.use(createDeliverablesRouter({ durableStore: deps.durableStore, workspaceStore: deps.runtimeDeps.workspaceStore ?? createWorkspaceStore() }));
  app.use(
    createQueueRouter({
      durableStore: deps.durableStore,
      runtimeDeps: deps.runtimeDeps,
      agentDefinitionStore,
      ...(deps.queuePushToken !== undefined ? { pushToken: deps.queuePushToken } : {}),
      ...(deps.queuePushAudienceUrl !== undefined ? { pushAudienceUrl: deps.queuePushAudienceUrl } : {}),
      ...(deps.verifyPushIdToken !== undefined ? { verifyPushIdToken: deps.verifyPushIdToken } : {}),
    }),
  );
  return app;
}
