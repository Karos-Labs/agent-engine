import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createSaveStrategy } from "./save-strategy.js";

export * from "./save-strategy.js";

/**
 * `intake.*` — the write side of a client's setup documents.
 *
 * Its own package rather than a tool inside `karos-client` because that
 * package is a read-only view of a tenant's onboarding data and says so. The
 * separation is the permission: a setup agent is handed this registry, a
 * drafting agent is not, so nothing that merely writes posts can rewrite the
 * charter it is judged against.
 */
export function createKarosIntakeTools(store: WorkspaceStoreLike = createWorkspaceStore()): AgentToolRegistry {
  return {
    "intake.saveStrategy": createSaveStrategy(store),
  };
}
