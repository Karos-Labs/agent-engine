import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { draftSegments, type DraftRecord } from "./types.js";

const TOOL_VERSION = "1.0.0";

export const ScheduleInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  draftId: z.string().min(1).describe("The existing draft to schedule. Reports not_available if no draft exists for this id."),
  publishAt: z.string().min(1).describe("Treated as an opaque ISO-8601 timestamp string — no date-format validation beyond non-empty."),
});
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

export interface ScheduleResult {
  draftId: string;
  status: DraftRecord["status"];
  publishAt: string;
  /** False when this call is a replay of an already-identical schedule (same `publishAt`) — the idempotent no-op case. */
  alreadyScheduled: boolean;
}

/**
 * Transitions a draft to `status: "scheduled"`. Requires the draft to
 * already exist (RFC-01 §6: a missing draft "legitimately doesn't exist
 * yet" — `not_available`, not a tooling error). Idempotent: calling again
 * with the exact same `publishAt` on an already-scheduled draft is a no-op.
 */
export function createSchedule(store: WorkspaceStoreLike) {
  return defineTool<ScheduleInput, ScheduleResult>({
    name: "publish.schedule",
    description:
      "Transitions an existing draft to status: \"scheduled\" at publishAt. Requires the draft to already exist (not_available if it doesn't). Idempotent: calling again with the exact same publishAt on an already-scheduled draft is a no-op.",
    version: TOOL_VERSION,
    inputSchema: ScheduleInputSchema,
    async execute({ draftId, publishAt }, { ctx }) {
      const segments = draftSegments(draftId);
      const record = await store.readJson<DraftRecord>(ctx.clientSlug, segments);
      if (!record) {
        return notAvailable<ScheduleResult>(`no draft found for id "${draftId}"`);
      }

      if (record.status === "scheduled" && record.publishAt === publishAt) {
        return success<ScheduleResult>({ draftId, status: record.status, publishAt, alreadyScheduled: true });
      }

      const updated: DraftRecord = {
        ...record,
        status: "scheduled",
        publishAt,
        updatedAt: Date.now(),
      };
      await store.writeJson(ctx.clientSlug, segments, updated);
      return success<ScheduleResult>({ draftId, status: updated.status, publishAt, alreadyScheduled: false });
    },
  });
}
