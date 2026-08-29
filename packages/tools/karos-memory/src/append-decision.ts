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

/**
 * Idempotent on `decisionId` — an append-only decision log with no duplicate
 * rows on replay.
 *
 * Scoped to `(clientSlug, productId)`, not `clientSlug` alone (AU24 / audit
 * §4.2-§4.3-3). Every channel agent's own "load recent decisions" step reads
 * this log back expecting *its own* history — linkedin-agent's archetype
 * rotation, x-agent's lane rotation and engagement daily cap, blog/reddit/
 * newsletter's topic-repeat check all assume the rows they get back are
 * theirs. Keying by `clientSlug` alone put every product for a client in one
 * shared bucket, so a multi-channel client's rules silently degraded: the
 * "never repeat the last archetype" rule could be defeated by a same- or
 * later-timestamped decision from a completely different channel (a
 * `x-agent` lane post landing between two LinkedIn posts), and the rotation
 * index itself (`recentDecisions.summaries.length % order.length` in
 * linkedin-agent) drifted with every OTHER product's post count, not just
 * LinkedIn's own. `ctx.productId` is already threaded through every step
 * (`AgentContextSchema`, required, never model-supplied) — this was always
 * the correct scope, just not the one implemented.
 */
export function createAppendDecision(store: WorkspaceStoreLike) {
  return defineTool<AppendDecisionInput, IdempotentWriteResult>({
    name: "memory.appendDecision",
    description: "Idempotent on decisionId — appends to an append-only decision log an agent uses to stay consistent with its own past conclusions, with no duplicate rows on replay.",
    version: TOOL_VERSION,
    inputSchema: AppendDecisionInputSchema,
    async execute({ decisionId, summary, rationale }, { ctx }) {
      const segments = ["memory", "products", ctx.productId, "decisions", decisionId];
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
