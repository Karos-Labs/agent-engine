import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";
import { DOCTRINE_CONSTRAINTS, DoctrineVerdictSchema } from "@agent-engine/tool-karos-reputation";

export const ReputationDoctrineGateAgentOutputSchema = z.object({
  verdicts: z.array(DoctrineVerdictSchema).length(DOCTRINE_CONSTRAINTS.length),
});
export type ReputationDoctrineGateAgentOutput = z.infer<typeof ReputationDoctrineGateAgentOutputSchema>;

/**
 * Step 09 (RFC-08 §5/§9's core design): "the model that wrote a sentence is
 * the worst judge of whether it conceded fault." This agent produces the 4
 * quoted verdicts (`no_fault_concession`/`no_blame`/`no_financial_promises`/
 * `facts_grounded`) that `reputation.doctrineGate` then mechanically grades
 * — this agent itself makes no pass/fail decision, it only quotes evidence
 * for each constraint.
 *
 * Structurally separate from `ReputationDraftAgent`, deliberately:
 * - A different class, a different `skillRef`/system prompt, a different
 *   `BaseAgent` instance constructed fresh in the workflow for this step
 *   (never the same object the draft step used).
 * - Its `input` is only ever `{draftText, factsBase, reviewText}` — plain,
 *   already-finished data. It is never handed `ReputationDraftAgent`'s own
 *   transcript, thought, or reasoning trace from step 06 (each `BaseAgent.run()`
 *   call starts a brand-new transcript from its own `input` alone — there is
 *   no shared memory to accidentally leak even if the workflow tried to reuse
 *   an instance, which it deliberately does not).
 * - It is asked to review the draft as an opaque piece of text to check, not
 *   told "you wrote this" — matching RFC-08's framing that the model who
 *   drafted a sentence should never be the one asked whether it slipped.
 */
export class ReputationDoctrineGateAgent extends BaseAgent<ReputationDoctrineGateAgentOutput> {
  protected readonly config: AgentStepConfig<ReputationDoctrineGateAgentOutput> = {
    id: "reputation-doctrine-gate",
    description:
      "Independently review one drafted reply against the four non-negotiable doctrine constraints, quoting exact evidence for each verdict. Never told who drafted the text.",
    allowedTools: [],
    outputSchema: ReputationDoctrineGateAgentOutputSchema,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "reputation-doctrine-gate@1",
  };
}
