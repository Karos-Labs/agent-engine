import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const AppendDecisionInputSchema = z.object({
  decisionId: z.string().min(1).describe("Caller-minted idempotency key for this one decision."),
  // No existing TSDoc on these two fields to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  summary: z.string().min(1).describe("A short statement of the decision made."),
  rationale: z.string().min(1).optional().describe("Why the decision was made, if worth recording."),
});
export type AppendDecisionInput = z.infer<typeof AppendDecisionInputSchema>;

/** Idempotent on `decisionId` — an append-only decision log with no duplicate rows on replay. */
export function createAppendDecision(store: WorkspaceStoreLike) {
  return defineTool<AppendDecisionInput, IdempotentWriteResult>({
    name: "memory.appendDecision",
    description: "Idempotent on decisionId — appends to an append-only decision log an agent uses to stay consistent with its own past conclusions, with no duplicate rows on replay.",
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
