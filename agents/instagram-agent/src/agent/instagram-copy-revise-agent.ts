import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { CopyRevisionSchema, type CopyRevision } from "../workflow/copy-revision.js";

/**
 * `05r-revise-copy-attempt-N` — the retry that edits instead of rewriting.
 *
 * ## Why this is a separate step and not a flag on the copy step
 *
 * Because the two have opposite jobs and opposite output sizes. The copy step
 * writes a whole carousel: ~53k tokens in, ~17k out, about $0.40 an attempt on
 * Sonnet, where the output is the expensive half. A revision returns the
 * fields that change and nothing else: a handful of strings, a few hundred
 * tokens, and the draft it is editing is the only long thing it needs to read.
 *
 * That is the whole saving. $1.14 of a $2.39 prep run on 2026-09-18 went on
 * three copy attempts, and the second and third were bought to fix a dash, a
 * repeated opening word and six words quoted from a fact card.
 *
 * ## And the saving is not the main reason
 *
 * A rewrite is a new random draw. In two of those three runs the second draft
 * fixed the finding and broke something else, and the third fixed that and
 * broke a third thing, which is why every run reached its cap. The loop was
 * resampling, not converging.
 *
 * An edit cannot regress what it does not touch. `applyCopyEdits` copies the
 * draft and replaces only the paths the model named, so "everything that
 * passed still passes" is a property of the code rather than an instruction
 * the model is asked to honour.
 *
 * ## The model, and why it is not the drafting model
 *
 * Editing to a named finding is a smaller job than writing a carousel, and the
 * step is deliberately on the cheap tier. If a revision cannot answer a
 * finding, the workflow still has the full redraft behind it: this step is an
 * attempt to make the expensive path unnecessary, never a replacement for it.
 *
 * ## No tools
 *
 * `allowedTools: []`. Everything it needs is the draft and the findings, both
 * assembled by the workflow from work the run has already paid for. A reviser
 * with a web search is a reviser that can introduce a fact nothing checked.
 */
export class InstagramCopyReviseAgent extends BaseAgent<CopyRevision> {
  protected readonly config: AgentStepConfig<CopyRevision> = {
    id: "instagram-copy-revise",
    description:
      "Edit an existing Instagram carousel draft so that it answers the findings a gate raised, changing as few fields as possible and leaving everything the gates accepted exactly as written. Return the edits, each addressed by its path in the draft, and one line on what you deliberately kept.",
    allowedTools: [],
    outputSchema: CopyRevisionSchema,
    maxSteps: 1,
    // Twelve edits at their schema maxima are ~7,200 characters of text plus
    // paths and reasons: roughly 2,600 tokens of JSON. 6,000 is a bit over
    // twice the maximal output, the headroom `setup-ceilings.test.ts`
    // established after three setup agents came back `tooling_error` on a
    // ceiling set to the expected size rather than to the possible one.
    maxTokens: 6_000,
    skillRef: "instagram-copy-revise@1",
    modelPolicy: resolveModelPolicy("instagram-copy-revise", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
  };
}
