import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createWriteDeliverable } from "./write-deliverable.js";
import { createAppendEvent } from "./append-event.js";
import { createUpsertBrief } from "./upsert-brief.js";
import { createDashboardSnapshot } from "./dashboard-snapshot.js";
import { createFeedbackAppend } from "./feedback-append.js";
import { createListUsedImages, createRecordUsedImages } from "./used-images.js";

export * from "./write-deliverable.js";
export * from "./append-event.js";
export * from "./upsert-brief.js";
export * from "./dashboard-snapshot.js";
export * from "./feedback-append.js";
export * from "./used-images.js";

/** The `karos-ledger` MCP server's tool registry (RFC-01 §9.2) — the one place all deliverables, events, and briefs are written. */
export function createKarosLedgerTools(store: WorkspaceStoreLike = createWorkspaceStore()): AgentToolRegistry {
  return {
    "ledger.writeDeliverable": createWriteDeliverable(store),
    "ledger.appendEvent": createAppendEvent(store),
    "ledger.upsertBrief": createUpsertBrief(store),
    "ledger.dashboardSnapshot": createDashboardSnapshot(store),
    "ledger.feedbackAppend": createFeedbackAppend(store),
    "ledger.recordUsedImages": createRecordUsedImages(store),
    "ledger.listUsedImages": createListUsedImages(store),
  };
}
