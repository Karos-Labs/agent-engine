import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { AngleProposalSchema, type AngleProposal } from "../workflow/angle-selection.js";

/**
 * Instagram Phase 1, item K, step `04i-propose-angles`: three candidate
 * angles for this run's subject, one per angle kind, each with the ONE
 * sentence the reader should remember.
 *
 * ## Why this is its own step and not a section of the copy prompt
 *
 * Asking the copy step to "find the angle and then write eight slides in it"
 * makes the angle the first thing sacrificed when the slide count, the
 * archetype menu, the sourcing rules and the language gate all compete for
 * the same attention — which is what the 2026-09-08 prep audit found: five
 * correct, sourced, unmemorable runs. Splitting it out means the editorial
 * decision is made once per revision, in isolation, against the brief and
 * the fact cards; it is scored deterministically (`selectAngle`); and the
 * chosen line is recorded in the decision log so next week's proposal knows
 * what this account already argued.
 *
 * `allowedTools: []` — everything this step judges (the brief, the deduped
 * fact cards, the topic decision, the account's recent posts and past angles)
 * is hand-assembled by the workflow, same reasoning as the research and copy
 * agents. `maxSteps: 1`: one turn, one structured proposal, no tool loop.
 *
 * ## Model and cost (brief's per-run ceiling: target $1.00, hard max $1.50)
 *
 * Pinned `claude-sonnet-4-6`, `contentLanguageSensitive` — the same policy as
 * the copy step, for the same reason: `rememberLine` is a sentence that may
 * be quoted on the cover in the client's own language, so the model has to be
 * able to write that language, and `applyClientLanguagePolicy` re-points the
 * step per client at run time.
 *
 * The angle IS the editorial judgment, which is the one thing the brief's
 * cost rule keeps on the drafting tier: Flash proposals over prep samples
 * read as restated headlines ("Vendor adds AI triage to all support plans"
 * as a "surprising number"), which is exactly the defect this step exists to
 * fix, so the cheap tier here would buy a step that costs money and changes
 * nothing. ~8k in / 0.8k out ≈ $0.036 per REVISION (at most three per run =
 * $0.108 at the ceiling), never per attempt: `04i` sits at the top of
 * `draftOnce`, outside the self-check loop, so three redrafts share one
 * proposal. Priced in `run-budget.ts` as `STEP_COST_ESTIMATES_USD.angle` and
 * counted against `PER_REVISION_ESTIMATE_USD` before each revision. No Opus
 * anywhere in this run (owner's decision, 2026-09-09).
 */
export class InstagramAngleAgent extends BaseAgent<AngleProposal> {
  protected readonly config: AgentStepConfig<AngleProposal> = {
    id: "instagram-angle",
    description: "Propose three angles for one Instagram post (a wrong assumption in the niche, a surprising number, what it means for this client's ICP), each resting on named fact cards and carrying the one sentence the reader should remember.",
    allowedTools: [],
    outputSchema: AngleProposalSchema,
    // One turn. With no tools there is nothing to iterate over, and the step
    // fails open (`angleUnavailable`) rather than spending a second Sonnet
    // turn on a proposal the run can do without.
    maxSteps: 1,
    modelPolicy: resolveModelPolicy("instagram-angle", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    skillRef: "instagram-angle@1",
  };
}
