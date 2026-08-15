import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStore } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const AppendDecisionInputSchema = z.object({
  /** Caller-minted idempotency key for this one decision. */
  decisionId: z.string().min(1),
  summary: z.string().min(1),
  rationale: z.string().min(1).optional(),
});
export type AppendDecisionInput = z.infer<typeof AppendDecisionInputSchema>;

/** Idempotent on `decisionId` — an append-only decision log with no duplicate rows on replay. */
export function createAppendDecision(store: WorkspaceStore) {
  return defineTool<AppendDecisionInput, IdempotentWriteResult>({
    name: "memory.appendDecision",
    version: TOOL_VERSION,
    inputSchema: AppendDecisionInputSchema,
    async execute({ decisionId, summary, rationale }, { ctx }) {
      const segments = ["memory", "decisions", decisionId];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        decisionId,
        summary,
        ...(rationale !== undefined ? { rationale } : {}),
        at: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: decisionId, created });
    },
  });
}
