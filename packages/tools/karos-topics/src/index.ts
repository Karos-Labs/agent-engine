import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStore } from "@agent-engine/tool-common";
import { createReserve } from "./reserve.js";
import { createCommit } from "./commit.js";
import { createRelease } from "./release.js";
import { createTopUp } from "./top-up.js";

export * from "./catalog.js";
export * from "./reserve.js";
export * from "./commit.js";
export * from "./release.js";
export * from "./top-up.js";

/** The `karos-topics` MCP server's tool registry (RFC-01 §9.2) — the no-repeat / topic-catalog contract, as code. */
export function createKarosTopicsTools(store: WorkspaceStore = createWorkspaceStore()): AgentToolRegistry {
  return {
    "topics.reserve": createReserve(store),
    "topics.commit": createCommit(store),
    "topics.release": createRelease(store),
    "topics.topUp": createTopUp(store),
  };
}
