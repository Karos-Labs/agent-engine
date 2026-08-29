import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";
import { writeRunRecord, type RunRecord } from "./runs.js";

const TOOL_VERSION = "1.0.0";

export const WriteRunInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment and execute()'s usage.
  job: z.string().min(1).describe("The research job's name — namespaces the record alongside runId."),
  runId: z.string().min(1).describe("This run's id. Idempotent alongside job — the same (job, runId) always overwrites, never duplicates."),
  query: z.string().min(1).describe("The research question this run answered."),
  result: z.unknown().describe("The research result to record, as arbitrary JSON."),
});
export type WriteRunInput = z.infer<typeof WriteRunInputSchema>;

/** Idempotent on `(job, runId)` — records one research leg's result. */
export function createWriteRun(store: WorkspaceStoreLike) {
  return defineTool<WriteRunInput, IdempotentWriteResult>({
    name: "research.writeRun",
    description: "Idempotent on (job, runId) — records one research leg's result.",
    version: TOOL_VERSION,
    inputSchema: WriteRunInputSchema,
    async execute({ job, runId, query, result }, { ctx }) {
      const record: RunRecord = { job, runId, query, result, at: Date.now() };
      const { created } = await writeRunRecord(store, ctx.clientSlug, record);
      return success<IdempotentWriteResult>({ id: `${job}__${runId}`, created });
    },
  });
}
