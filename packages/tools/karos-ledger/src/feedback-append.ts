import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/** A reason is mandatory on rejection — this is what feeds the learning loop (RFC-01 §8.3's rule, applied here too). */
export const FeedbackAppendInputSchema = z
  .object({
    runId: z.string().min(1),
    feedbackId: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
    actor: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.decision === "reject" && !val.reason) {
      ctx.addIssue({ code: "custom", message: "reason is mandatory when decision is 'reject'", path: ["reason"] });
    }
  });
export type FeedbackAppendInput = z.infer<typeof FeedbackAppendInputSchema>;

/** Idempotent on `(runId, feedbackId)` — an append-only feedback log for the learning loop (RFC-01 §8.2's `learn` step). */
export function createFeedbackAppend(store: WorkspaceStoreLike) {
  return defineTool<FeedbackAppendInput, IdempotentWriteResult>({
    name: "ledger.feedbackAppend",
    version: TOOL_VERSION,
    inputSchema: FeedbackAppendInputSchema,
    async execute({ runId, feedbackId, decision, actor, reason }, { ctx }) {
      const segments = ["ledger", "feedback", runId, feedbackId];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        runId,
        feedbackId,
        decision,
        actor,
        reason,
        at: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: `${runId}__${feedbackId}`, created });
    },
  });
}
