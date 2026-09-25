import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { BrandedShortsCopySchema, type BrandedShortsCopy } from "../workflow/types.js";

/**
 * The words the short is posted with (step 09c).
 *
 * The one genuinely free-text thing this product writes. Everything else it
 * produces quotes the client's own footage — captions, graphics labels, the
 * endcard — which is why this agent is handed the kept transcript rather than
 * a summary: the caption has to be about what the speaker actually said, and
 * the only way to hold it to that is to give it their words and forbid it
 * anything else.
 *
 * Wired with `gate.lintPost` as a `selfCritique` gate, the same shared post
 * lint every other channel's copy passes through. It is the right gate for
 * exactly one reason: this is a social caption, which is what that lint was
 * written for — the tells, the em dashes, the engagement bait, and since
 * 2026-09-25 the same bank in Hebrew for the third of the roster that posts
 * in it. One revision, not more: a caption is three lines, and a second
 * rewrite of three lines has never been the difference between shipping and
 * not.
 */
export class BrandedShortsCaptionAgent extends BaseAgent<BrandedShortsCopy> {
  protected readonly config: AgentStepConfig<BrandedShortsCopy> = {
    id: "branded-shorts-caption",
    description:
      "Write the post caption for a finished branded short, in the client's own voice and language, using only what the speaker actually says in the transcript — plus 1-3 plain sentences about the short for the client's own team.",
    allowedTools: [],
    outputSchema: BrandedShortsCopySchema,
    // `contentLanguageSensitive`, unlike this agent's other two steps: those
    // return timestamps and archetype names, and this one returns the only
    // sentences on this product a client's audience ever reads. A Hebrew
    // brand kit re-points it at the same vendor's strongest RTL model, the
    // way every other drafting step in the fleet is.
    modelPolicy: resolveModelPolicy("branded-shorts-caption", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    skillRef: "branded-shorts-caption@2",
    selfCritique: {
      gateTool: "gate.lintPost",
      maxRevisions: 1,
      gateArgs: { platform: "generic" },
      gateInput: (draft) => ({
        text: [draft.caption, draft.about].filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n\n"),
      }),
    },
  };
}
