import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createPull } from "./pull.js";
import { createGetRuns } from "./get-runs.js";
import { createWriteRun } from "./write-run.js";
import { createCheckFreshness } from "./check-freshness.js";
import { createCaptureVisibility } from "./capture-visibility.js";
import { createApifyResearchBackend, type ResearchSearchBackend } from "./backends.js";

export * from "./runs.js";
export * from "./pull.js";
export * from "./get-runs.js";
export * from "./write-run.js";
export * from "./check-freshness.js";
export * from "./capture-visibility.js";
export * from "./backends.js";

export interface KarosResearchToolsOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the env-derived backend. Tests pass a fake; `null` forces the unconfigured path. */
  backend?: ResearchSearchBackend | null;
  fetchImpl?: typeof fetch;
}

/**
 * Builds the external-search backend from configuration, or undefined when
 * none is available — in which case `research.pull` reports `not_available`
 * rather than returning a placeholder. Same rule as every other credentialed
 * capability here (`media.*`, `video.*`, `landing.*`): registered
 * unconditionally, honest per call.
 */
function backendFromEnv(options: KarosResearchToolsOptions): ResearchSearchBackend | undefined {
  if (options.backend !== undefined) return options.backend ?? undefined;
  const token = (options.env ?? process.env)["APIFY_TOKEN"]?.trim();
  if (!token) return undefined;
  const actor = (options.env ?? process.env)["APIFY_RESEARCH_ACTOR"]?.trim();
  return createApifyResearchBackend({
    token,
    ...(actor ? { actor } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

/** The `karos-research` MCP server's tool registry (RFC-01 §9.2) — egress-bound, cached, freshness-enforced. */
export function createKarosResearchTools(
  store: WorkspaceStoreLike = createWorkspaceStore(),
  options: KarosResearchToolsOptions = {},
): AgentToolRegistry {
  const backend = backendFromEnv(options);
  return {
    "research.pull": createPull(store, backend),
    "research.getRuns": createGetRuns(store),
    "research.writeRun": createWriteRun(store),
    "research.checkFreshness": createCheckFreshness(store),
    "research.captureVisibility": createCaptureVisibility(store),
  };
}
