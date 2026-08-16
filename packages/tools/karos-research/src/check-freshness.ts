import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, parseDurationMs, success } from "@agent-engine/tool-common";
import { latestRun } from "./runs.js";

const TOOL_VERSION = "1.0.0";

export const CheckFreshnessInputSchema = z.object({
  job: z.string().min(1),
  /** e.g. "24h", "7d". */
  window: z.string().min(1),
});
export type CheckFreshnessInput = z.infer<typeof CheckFreshnessInputSchema>;

export interface CheckFreshnessResult {
  fresh: boolean;
  lastRunId: string;
  lastRunAt: number;
  ageMs: number;
  windowMs: number;
}

/** `not_available` when the job has never run — RFC-01 §6's own example of the outcome. */
export function createCheckFreshness(store: WorkspaceStoreLike) {
  return defineTool<CheckFreshnessInput, CheckFreshnessResult>({
    name: "research.checkFreshness",
    version: TOOL_VERSION,
    inputSchema: CheckFreshnessInputSchema,
    async execute({ job, window }, { ctx }) {
      const last = await latestRun(store, ctx.clientSlug, job);
      if (!last) {
        return notAvailable<CheckFreshnessResult>(`job "${job}" has not been run yet`);
      }

      const windowMs = parseDurationMs(window);
      const ageMs = Date.now() - last.at;

      return success<CheckFreshnessResult>({
        fresh: ageMs <= windowMs,
        lastRunId: last.runId,
        lastRunAt: last.at,
        ageMs,
        windowMs,
      });
    },
  });
}
