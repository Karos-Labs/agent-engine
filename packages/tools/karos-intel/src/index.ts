import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createWriteReport } from "./write-report.js";
import { createGetReport } from "./get-report.js";

export * from "./types.js";
export * from "./scoring.js";
export * from "./competitor-keys.js";
export * from "./competitor-merge.js";
export * from "./write-report.js";
export * from "./get-report.js";

/** The `karos-intel` tool registry (RFC-05 §5) — structured Intel Report persistence, deterministic overall-score arithmetic. */
export function createKarosIntelTools(store: WorkspaceStoreLike = createWorkspaceStore()): AgentToolRegistry {
  return {
    "intel.writeReport": createWriteReport(store),
    "intel.getReport": createGetReport(store),
  };
}
