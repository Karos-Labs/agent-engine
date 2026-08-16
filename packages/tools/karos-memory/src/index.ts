import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createRead } from "./read.js";
import { createAppendDecision } from "./append-decision.js";
import { createAppendHypothesis } from "./append-hypothesis.js";
import { createResolveHypothesis } from "./resolve-hypothesis.js";
import { createUpdateBeliefs } from "./update-beliefs.js";

export * from "./read.js";
export * from "./append-decision.js";
export * from "./append-hypothesis.js";
export * from "./resolve-hypothesis.js";
export * from "./update-beliefs.js";

/** The `karos-memory` MCP server's tool registry (RFC-01 §9.2) — structured, retrieved-not-loaded-whole instance memory. */
export function createKarosMemoryTools(store: WorkspaceStoreLike = createWorkspaceStore()): AgentToolRegistry {
  return {
    "memory.read": createRead(store),
    "memory.appendDecision": createAppendDecision(store),
    "memory.appendHypothesis": createAppendHypothesis(store),
    "memory.resolveHypothesis": createResolveHypothesis(store),
    "memory.updateBeliefs": createUpdateBeliefs(store),
  };
}
