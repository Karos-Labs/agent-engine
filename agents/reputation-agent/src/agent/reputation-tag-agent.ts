import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { ReputationTagOutputSchema, type ReputationTagOutput } from "../workflow/types.js";

/**
 * Step 04b (RFC-08 §5 / `references/scoring.md` §4): for FLAG-lane reviews
 * only, assign exactly one department tag from the closed 7-value enum. A
 * SEPARATE bounded agent from `ReputationExtractionAgent` — tagging is a
 * genuine judgment call (which of several plausible tags names the highest
 * consequence, per the tie-break rule), unlike extraction's mechanical
 * evidenced-boolean pass, so this is pinned rather than commodity tier.
 *
 * This agent never sees a review the arithmetic engine did not already route
 * to FLAG — the workflow only ever calls it with the FLAG-lane subset, so
 * "deciding whether to flag" is never a question this step can even be asked.
 */
export class ReputationTagAgent extends BaseAgent<ReputationTagOutput> {
  protected readonly config: AgentStepConfig<ReputationTagOutput> = {
    id: "reputation-tag",
    description:
      "For each already-flagged review, assign exactly one department tag from the closed 7-value enum (Billing/Safety/Legal/Fraud/Discrimination/Press/Service), using the highest-consequence tie-break rule.",
    allowedTools: [],
    outputSchema: ReputationTagOutputSchema,
    modelPolicy: resolveModelPolicy("reputation-tag", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "reputation-tag@1",
  };
}
