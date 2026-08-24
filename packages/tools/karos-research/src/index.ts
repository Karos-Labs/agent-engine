import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createPull } from "./pull.js";
import { createGetRuns } from "./get-runs.js";
import { createWriteRun } from "./write-run.js";
import { createCheckFreshness } from "./check-freshness.js";
import { createCaptureVisibility } from "./capture-visibility.js";
import { createScraperProvider, type ScraperProvider } from "@agent-engine/tool-karos-scraper";

export * from "./runs.js";
export * from "./pull.js";
export * from "./get-runs.js";
export * from "./write-run.js";
export * from "./check-freshness.js";
export * from "./capture-visibility.js";
export * from "./payload.js";

export interface KarosResearchToolsOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the env-derived scraper. Tests pass a fake; `null` forces the unconfigured path. */
  scraper?: ScraperProvider | null;
  fetchImpl?: typeof fetch;
}

/**
 * Resolves the scraper backing `research.pull`, or undefined when none is
 * configured — in which case the tool reports `not_available` rather than
 * returning a placeholder. Same rule as every other credentialed capability
 * here (`media.*`, `video.*`, `landing.*`): registered unconditionally, honest
 * per call.
 */
/** The `karos-research` MCP server's tool registry (RFC-01 §9.2) — egress-bound, cached, freshness-enforced. */
export function createKarosResearchTools(
  store: WorkspaceStoreLike = createWorkspaceStore(),
  options: KarosResearchToolsOptions = {},
): AgentToolRegistry {
  const scraper = createScraperProvider({
    ...(options.env ? { env: options.env } : {}),
    ...(options.scraper !== undefined ? { provider: options.scraper } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return {
    "research.pull": createPull(store, scraper),
    "research.getRuns": createGetRuns(store),
    "research.writeRun": createWriteRun(store),
    "research.checkFreshness": createCheckFreshness(store),
    "research.captureVisibility": createCaptureVisibility(store),
  };
}
