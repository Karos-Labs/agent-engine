import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { ReputationDraftOutputSchema, type ReputationDraftOutput } from "../workflow/types.js";

/**
 * Step 06 (RFC-08 §5 / `references/response-craft.md`): drafts one reply for
 * one review the deterministic engine already routed to a lane carrying
 * `draft_attached: true` (RESPOND, or a FLAG row drafted for after human
 * review — response-craft.md's Example 2). One bounded call per item, never
 * a batch — each review's facts and tone need are distinct enough that
 * batching would either bloat context or flatten the response into a
 * template, exactly the "automation smell" response-craft.md's own
 * anti-patterns warn about.
 *
 * The four non-negotiable constraints (no fault concession, no blame, no
 * financial promise, no fact outside `factsBase`) are enforced downstream by
 * steps 07-09, never trusted from this step alone — this agent's system
 * prompt states them, but the workflow never skips the gates on the
 * assumption a "good" draft agent got it right on the first try.
 */
export class ReputationDraftAgent extends BaseAgent<ReputationDraftOutput> {
  protected readonly config: AgentStepConfig<ReputationDraftOutput> = {
    id: "reputation-draft",
    description: "Draft one public reply to one review, grounded only in the supplied facts, under the four non-negotiable doctrine constraints.",
    allowedTools: [],
    outputSchema: ReputationDraftOutputSchema,
    modelPolicy: resolveModelPolicy("reputation-draft", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "reputation-draft@1",
  };
}
