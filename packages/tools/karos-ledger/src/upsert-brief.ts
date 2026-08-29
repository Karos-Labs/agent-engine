import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const UpsertBriefInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and the tool's own doc comment.
  briefId: z.string().min(1).describe("The brief's id — the same id always overwrites, never duplicates."),
  content: z.unknown().describe("The brief's content, as arbitrary JSON."),
});
export type UpsertBriefInput = z.infer<typeof UpsertBriefInputSchema>;

/** Idempotent on `briefId` — an upsert by definition: the same id always overwrites, never duplicates. */
export function createUpsertBrief(store: WorkspaceStoreLike) {
  return defineTool<UpsertBriefInput, IdempotentWriteResult>({
    name: "ledger.upsertBrief",
    description: "Idempotent on briefId — an upsert by definition: the same id always overwrites, never duplicates.",
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
