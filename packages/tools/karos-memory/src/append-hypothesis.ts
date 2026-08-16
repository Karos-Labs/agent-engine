import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const AppendHypothesisInputSchema = z.object({
  /** Caller-minted idempotency key for this one hypothesis. */
  hypothesisId: z.string().min(1),
  statement: z.string().min(1),
});
export type AppendHypothesisInput = z.infer<typeof AppendHypothesisInputSchema>;

/** Idempotent on `hypothesisId`. New records start `status: "open"` until `resolveHypothesis` closes them out. */
export function createAppendHypothesis(store: WorkspaceStoreLike) {
  return defineTool<AppendHypothesisInput, IdempotentWriteResult>({
    name: "memory.appendHypothesis",
    version: TOOL_VERSION,
    inputSchema: AppendHypothesisInputSchema,
    async execute({ hypothesisId, statement }, { ctx }) {
      const segments = ["memory", "hypotheses", hypothesisId];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        hypothesisId,
        statement,
        status: "open" as const,
        at: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: hypothesisId, created });
    },
  });
}
