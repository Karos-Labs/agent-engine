import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStore } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const DashboardSnapshotInputSchema = z.object({
  runId: z.string().min(1),
  snapshot: z.unknown(),
});
export type DashboardSnapshotInput = z.infer<typeof DashboardSnapshotInputSchema>;

/** Idempotent on `runId` — one dashboard snapshot per run, overwritten on retry. */
export function createDashboardSnapshot(store: WorkspaceStore) {
  return defineTool<DashboardSnapshotInput, IdempotentWriteResult>({
    name: "ledger.dashboardSnapshot",
    version: TOOL_VERSION,
    inputSchema: DashboardSnapshotInputSchema,
    async execute({ runId, snapshot }, { ctx }) {
      const segments = ["ledger", "dashboard-snapshots", runId];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        runId,
        snapshot,
        capturedAt: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: runId, created });
    },
  });
}
