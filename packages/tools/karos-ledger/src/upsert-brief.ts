import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStore } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const UpsertBriefInputSchema = z.object({
  briefId: z.string().min(1),
  content: z.unknown(),
});
export type UpsertBriefInput = z.infer<typeof UpsertBriefInputSchema>;

/** Idempotent on `briefId` — an upsert by definition: the same id always overwrites, never duplicates. */
export function createUpsertBrief(store: WorkspaceStore) {
  return defineTool<UpsertBriefInput, IdempotentWriteResult>({
    name: "ledger.upsertBrief",
    version: TOOL_VERSION,
    inputSchema: UpsertBriefInputSchema,
    async execute({ briefId, content }, { ctx }) {
      const segments = ["ledger", "briefs", briefId];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        briefId,
        content,
        updatedAt: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: briefId, created });
    },
  });
}
