import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createWriteReport } from "./write-report.js";
import { createGetReport } from "./get-report.js";
import type { ClientReportStore } from "./client-report-store.js";

export * from "./types.js";
export * from "./scoring.js";
export * from "./competitor-keys.js";
export * from "./competitor-merge.js";
export * from "./write-report.js";
export * from "./get-report.js";
export * from "./build-client-report.js";
export * from "./client-report-store.js";

/**
 * The `karos-intel` tool registry (RFC-05 §5) — structured Intel Report
 * persistence, deterministic overall-score arithmetic.
 *
 * `clientReportStore` is the portal-facing half added by SCRUM-267 (T-A18):
 * the `clientReports/{clientId}` document the portal's `getClientReport()`
 * reads. It has NO default, on purpose. Defaulting it to a memory or workspace
 * store would restore the exact bug the ticket exists to fix — a run that
 * completes, reports success at every step, and leaves the portal's read path
 * returning null — and would do it silently, in every deployment that forgot to
 * wire it. Unwired, `intel.writeReport` reports `not_available` and the run
 * fails where somebody can see it.
 */
export function createKarosIntelTools(
  store: WorkspaceStoreLike = createWorkspaceStore(),
  clientReportStore?: ClientReportStore,
): AgentToolRegistry {
  return {
    "intel.writeReport": createWriteReport(store, clientReportStore),
    "intel.getReport": createGetReport(store),
  };
}
