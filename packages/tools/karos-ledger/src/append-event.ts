import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const AppendEventInputSchema = z.object({
  runId: z.string().min(1),
  /** Caller-minted idempotency key for this one event. */
  eventId: z.string().min(1),
  level: z.enum(["info", "error", "success"]),
  message: z.string().min(1),
});
export type AppendEventInput = z.infer<typeof AppendEventInputSchema>;

/** Idempotent on `(runId, eventId)` — an append-only run event log with no duplicate rows on replay. */
export function createAppendEvent(store: WorkspaceStoreLike) {
  return defineTool<AppendEventInput, IdempotentWriteResult>({
    name: "ledger.appendEvent",
    version: TOOL_VERSION,
    inputSchema: AppendEventInputSchema,
    async execute({ runId, eventId, level, message }, { ctx }) {
      const segments = ["ledger", "events", runId, eventId];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        runId,
        eventId,
        level,
        message,
        at: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: `${runId}__${eventId}`, created });
    },
  });
}
