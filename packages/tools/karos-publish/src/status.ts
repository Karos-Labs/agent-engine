import { z } from "zod";
import type { WorkspaceStore } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { draftSegments, type DraftRecord } from "./types.js";

const TOOL_VERSION = "1.0.0";

export const StatusInputSchema = z.object({
  draftId: z.string().min(1),
});
export type StatusInput = z.infer<typeof StatusInputSchema>;

export interface StatusResult {
  draftId: string;
  platform: string;
  status: DraftRecord["status"];
  publishAt?: string;
  /** Length of the serialized content, not the content itself — RFC-01 §9.1 rule 4's "smallest useful shape". */
  contentLength: number;
}

/** Read-only status lookup. Returns `not_available` when the draft id is unknown. */
export function createStatus(store: WorkspaceStore) {
  return defineTool<StatusInput, StatusResult>({
    name: "publish.status",
    version: TOOL_VERSION,
    inputSchema: StatusInputSchema,
    async execute({ draftId }, { ctx }) {
      const segments = draftSegments(draftId);
      const record = await store.readJson<DraftRecord>(ctx.clientSlug, segments);
      if (!record) {
        return notAvailable<StatusResult>(`no draft found for id "${draftId}"`);
      }

      const result: StatusResult = {
        draftId: record.draftId,
        platform: record.platform,
        status: record.status,
        contentLength: JSON.stringify(record.content ?? null).length,
      };
      if (record.publishAt !== undefined) {
        result.publishAt = record.publishAt;
      }
      return success<StatusResult>(result);
    },
  });
}
