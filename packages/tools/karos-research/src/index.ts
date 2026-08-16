import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createPull } from "./pull.js";
import { createGetRuns } from "./get-runs.js";
import { createWriteRun } from "./write-run.js";
import { createCheckFreshness } from "./check-freshness.js";

export * from "./runs.js";
export * from "./pull.js";
export * from "./get-runs.js";
export * from "./write-run.js";
export * from "./check-freshness.js";

/** The `karos-research` MCP server's tool registry (RFC-01 §9.2) — egress-bound, cached, freshness-enforced. */
export function createKarosResearchTools(store: WorkspaceStoreLike = createWorkspaceStore()): AgentToolRegistry {
  return {
    "research.pull": createPull(store),
    "research.getRuns": createGetRuns(store),
    "research.writeRun": createWriteRun(store),
    "research.checkFreshness": createCheckFreshness(store),
  };
}
