import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createWriteDeliverable } from "./write-deliverable.js";
import { createAppendEvent } from "./append-event.js";
import { createUpsertBrief } from "./upsert-brief.js";
import { createDashboardSnapshot } from "./dashboard-snapshot.js";
import { createListUsedImages, createRecordUsedImages } from "./used-images.js";
import { createListOutputExcerpts, createRecordOutputExcerpt } from "./output-history.js";

export * from "./write-deliverable.js";
export * from "./append-event.js";
export * from "./upsert-brief.js";
export * from "./dashboard-snapshot.js";
export * from "./used-images.js";
export * from "./output-history.js";

/**
 * The `karos-ledger` MCP server's tool registry (RFC-01 §9.2) — the one place all deliverables, events, and briefs are written.
 *
 * `ledger.feedbackAppend` retired (AU22 audit finding): it wrote every review
 * decision to `["ledger","feedback",runId,feedbackId]`, but nothing in this
 * repo ever read that path — no `ledger.readFeedback`/`ledger.listFeedback`
 * tool was ever registered, and no other reader existed. It was a write-only
 * log, called from six workflows purely as un-consumed record-keeping. The
 * one real feedback pipeline is `memory.appendFeedback`/`memory.readFeedback`
 * (`packages/workflow/src/primitives/review-cycle.ts`'s
 * `persistReviewFeedbackToMemory`/`readPastFeedback`): every review decision
 * is written there instead, and the next drafting prompt reads it back. Five
 * of the six former callers (blog/reddit/x/linkedin/newsletter-agent) were
 * already also writing to that real pipeline in the same step, so removing
 * the dead call changed nothing they actually relied on; the sixth
 * (intel-report-agent) now writes through the real pipeline too instead of
 * losing its feedback into the void.
 */
export function createKarosLedgerTools(store: WorkspaceStoreLike = createWorkspaceStore()): AgentToolRegistry {
  return {
    "ledger.writeDeliverable": createWriteDeliverable(store),
    "ledger.appendEvent": createAppendEvent(store),
    "ledger.upsertBrief": createUpsertBrief(store),
    "ledger.dashboardSnapshot": createDashboardSnapshot(store),
    "ledger.recordUsedImages": createRecordUsedImages(store),
    "ledger.listUsedImages": createListUsedImages(store),
    "ledger.recordOutputExcerpt": createRecordOutputExcerpt(store),
    "ledger.listOutputExcerpts": createListOutputExcerpts(store),
  };
}
