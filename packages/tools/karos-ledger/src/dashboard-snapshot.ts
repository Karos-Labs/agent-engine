import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const DashboardSnapshotInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and the tool's own doc comment.
  runId: z.string().min(1).describe("The run this snapshot belongs to. One snapshot per runId — a retry overwrites, never duplicates."),
  snapshot: z.unknown().describe("The dashboard state to persist for this run, as arbitrary JSON."),
});
export type DashboardSnapshotInput = z.infer<typeof DashboardSnapshotInputSchema>;

/** Idempotent on `runId` — one dashboard snapshot per run, overwritten on retry. */
export function createDashboardSnapshot(store: WorkspaceStoreLike) {
  return defineTool<DashboardSnapshotInput, IdempotentWriteResult>({
    name: "ledger.dashboardSnapshot",
    description: "Idempotent on runId — writes one dashboard snapshot per run, overwritten on retry.",
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
