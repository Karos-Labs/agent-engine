import express, { type Application } from "express";
import type { DurableStepStore } from "@agent-engine/workflow";
import { createHealthRouter } from "./routes/health.js";
import { createRunsRouter, type RunsRouterDeps } from "./routes/runs.js";

export interface CreateAppDeps extends RunsRouterDeps {
  durableStore: DurableStepStore;
}

/**
 * Builds the Express application without binding a port — every real
 * dependency (durable store, tools/promptStore/router, id/clock generators)
 * is injected, so `__tests__/` can exercise the real HTTP routes against
 * fully in-memory/fake dependencies (no real GCP or Anthropic call), and
 * `src/server.ts` supplies the real, env-constructed ones for Cloud Run.
 */
export function createApp(deps: CreateAppDeps): Application {
  const app = express();
  app.use(express.json());
  app.use(createHealthRouter());
  app.use(createRunsRouter(deps));
  return app;
}
