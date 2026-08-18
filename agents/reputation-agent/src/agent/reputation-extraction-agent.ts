import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";
import { ReputationExtractionOutputSchema, type ReputationExtractionOutput } from "../workflow/types.js";

/**
 * Step 04a (RFC-08 §5 / `references/scoring.md` §2): one commodity-tier model
 * pass per NEW review (never re-run on a review already carrying cached
 * `annotations` — that caching lives in the workflow, not here), answering
 * the 5 evidenced yes/no questions plus sentiment. This agent's output is
 * pure extraction — it never sees, and is never asked for, a route/lane.
 * `references/scoring.md`'s whole point: "The model extracts. It does not
 * route." Routing is `reputation.triage`'s job alone, several steps away
 * from this one.
 *
 * `allowedTools: []` — same reasoning as every other single-turn extraction
 * agent in this repo (`InstagramResearchAgent`, `IntelReportDraftAgent`):
 * the one review this agent needs is already handed to it as input, so it
 * goes straight to a `final` turn.
 */
/**
 * The pinned classifier `review-schema.md` names for the annotation pass
 * (`claude-haiku-4-5-20251001`). Exported because it is half of the
 * annotation cache's key: `review-schema.md` specifies the cache is keyed
 * `(review_id, classifier_model_id)` precisely so that swapping this constant
 * is a logged config change that triggers a fresh classification, rather than
 * a silent no-op that keeps serving the retired model's booleans.
 */
export const REPUTATION_CLASSIFIER_MODEL_ID = "claude-haiku-4-5-20251001";

export class ReputationExtractionAgent extends BaseAgent<ReputationExtractionOutput> {
  protected readonly config: AgentStepConfig<ReputationExtractionOutput> = {
    id: "reputation-extraction",
    description: "Answer 5 evidenced yes/no questions plus sentiment for one review. Never decide a lane — arithmetic routes, not this step.",
    allowedTools: [],
    outputSchema: ReputationExtractionOutputSchema,
    // Commodity — cheap, cacheable, swappable (RFC-08 §2's three-tier model
    // policy table: "the extraction pass is squarely 'commodity' tier").
    modelPolicy: { policy: "commodity", model: REPUTATION_CLASSIFIER_MODEL_ID },
    skillRef: "reputation-extraction@1",
  };
}
