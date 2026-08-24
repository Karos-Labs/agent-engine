import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createRead } from "./read.js";
import { createAppendDecision } from "./append-decision.js";
import { createAppendHypothesis } from "./append-hypothesis.js";
import { createResolveHypothesis } from "./resolve-hypothesis.js";
import { createUpdateBeliefs } from "./update-beliefs.js";
import { createAppendFeedback, createReadFeedback } from "./append-feedback.js";

export * from "./read.js";
export * from "./append-decision.js";
export * from "./append-hypothesis.js";
export * from "./resolve-hypothesis.js";
export * from "./update-beliefs.js";
export * from "./append-feedback.js";

/** The `karos-memory` MCP server's tool registry (RFC-01 §9.2) — structured, retrieved-not-loaded-whole instance memory. */
export function createKarosMemoryTools(store: WorkspaceStoreLike = createWorkspaceStore()): AgentToolRegistry {
  return {
    "memory.read": createRead(store),
    "memory.appendDecision": createAppendDecision(store),
    "memory.appendHypothesis": createAppendHypothesis(store),
    "memory.resolveHypothesis": createResolveHypothesis(store),
    "memory.updateBeliefs": createUpdateBeliefs(store),
    // The human-feedback loop: what reviewers asked for, and what a later run
    // reads back so the same correction is not made every week.
    "memory.appendFeedback": createAppendFeedback(store),
    "memory.readFeedback": createReadFeedback(store),
  };
}
