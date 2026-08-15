import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStore } from "@agent-engine/tool-common";
import { createDraft } from "./draft.js";
import { createSchedule } from "./schedule.js";
import { createStatus } from "./status.js";

export * from "./types.js";
export * from "./draft.js";
export * from "./schedule.js";
export * from "./status.js";

export function createKarosPublishTools(store: WorkspaceStore = createWorkspaceStore()): AgentToolRegistry {
  return {
    "publish.draft": createDraft(store),
    "publish.schedule": createSchedule(store),
    "publish.status": createStatus(store),
  };
}
