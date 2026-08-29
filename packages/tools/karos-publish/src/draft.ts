import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";
import { draftSegments, type DraftRecord } from "./types.js";

const TOOL_VERSION = "1.0.0";

export const DraftInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and the tool's own doc comment.
  draftId: z.string().min(1).describe("The draft's id — the same id called twice overwrites the same record, never a duplicate."),
  platform: z.string().min(1).describe("Which platform this draft targets, e.g. \"linkedin\", \"instagram\"."),
  content: z.unknown().describe("The draft's content, as arbitrary JSON."),
});
export type DraftInput = z.infer<typeof DraftInputSchema>;

/**
 * Idempotent on `draftId` — same pattern as `ledger.upsertBrief`: the same id
 * called twice overwrites the SAME record (never a duplicate), and always
 * lands the draft back in `status: "draft"` — a re-draft supersedes any
 * prior scheduling rather than merging with it.
 */
export function createDraft(store: WorkspaceStoreLike) {
  return defineTool<DraftInput, IdempotentWriteResult>({
    name: "publish.draft",
    description:
      "Idempotent on draftId — writes (or overwrites) a draft, always landing it back in status: \"draft\". A re-draft supersedes any prior scheduling rather than merging with it.",
    version: TOOL_VERSION,
    inputSchema: DraftInputSchema,
    async execute({ draftId, platform, content }, { ctx }) {
      const segments = draftSegments(draftId);
      const existing = await store.readJson<DraftRecord>(ctx.clientSlug, segments);
      const now = Date.now();
      const record: DraftRecord = {
        draftId,
        platform,
        content,
        status: "draft",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const { created } = await store.writeJson(ctx.clientSlug, segments, record);
      return success<IdempotentWriteResult>({ id: draftId, created });
    },
  });
}
