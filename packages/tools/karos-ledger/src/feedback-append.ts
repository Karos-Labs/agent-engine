import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/** A reason is mandatory on rejection — this is what feeds the learning loop (RFC-01 §8.3's rule, applied here too). */
export const FeedbackAppendInputSchema = z
  .object({
    // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and this schema's own doc comment.
    runId: z.string().min(1).describe("The run this feedback decision belongs to."),
    feedbackId: z.string().min(1).describe("Caller-minted idempotency key for this one feedback entry."),
    decision: z.enum(["approve", "reject"]).describe("Whether this feedback approves or rejects the reviewed work."),
    actor: z.string().min(1).describe("Who or what made this decision (a human reviewer, an agent, etc)."),
    reason: z.string().min(1).optional().describe("Why the decision was made. Mandatory when decision is \"reject\" — this is what feeds the learning loop."),
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
    description: "Idempotent on (runId, feedbackId) — appends one entry to the append-only feedback log for the learning loop (RFC-01 §8.2's learn step).",
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
