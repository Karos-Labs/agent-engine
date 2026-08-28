import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";
import { writeRunRecord, type RunRecord } from "./runs.js";

const TOOL_VERSION = "1.0.0";

export const WriteRunInputSchema = z.object({
  job: z.string().min(1),
  runId: z.string().min(1),
  query: z.string().min(1),
  result: z.unknown(),
});
export type WriteRunInput = z.infer<typeof WriteRunInputSchema>;

/** Idempotent on `(job, runId)` — records one research leg's result. */
export function createWriteRun(store: WorkspaceStoreLike) {
  return defineTool<WriteRunInput, IdempotentWriteResult>({
    name: "research.writeRun",
    version: TOOL_VERSION,
    inputSchema: WriteRunInputSchema,
    async execute({ job, runId, query, result }, { ctx }) {
      const record: RunRecord = { job, runId, query, result, at: Date.now() };
      const { created } = await writeRunRecord(store, ctx.clientSlug, record);
      return success<IdempotentWriteResult>({ id: `${job}__${runId}`, created });
    },
  });
}
