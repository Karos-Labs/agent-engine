import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";
import { listRuns } from "./runs.js";

const TOOL_VERSION = "1.0.0";

export const GetRunsInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and the tool's own doc comment.
  job: z.string().min(1).describe("Which job's run history to list."),
  limit: z.number().int().positive().max(100).default(20).describe("Newest-first cap on how many run summaries to return."),
});
export type GetRunsInput = z.infer<typeof GetRunsInputSchema>;

export interface RunSummary {
  runId: string;
  query: string;
  at: number;
}

export interface GetRunsResult {
  runs: RunSummary[];
}

/** Newest-first run history for a job — summaries with handles, not the full cached payload (RFC-01 §9.1 rule 4). */
export function createGetRuns(store: WorkspaceStoreLike) {
  return defineTool<GetRunsInput, GetRunsResult>({
    name: "research.getRuns",
    description: "Newest-first run history for a job — summaries with handles, not the full cached payload.",
    version: TOOL_VERSION,
    inputSchema: GetRunsInputSchema,
    async execute({ job, limit }, { ctx }) {
      const runs = await listRuns(store, ctx.clientSlug, job);
      return success<GetRunsResult>({
        runs: runs.slice(0, limit).map((r) => ({ runId: r.runId, query: r.query, at: r.at })),
      });
    },
  });
}
