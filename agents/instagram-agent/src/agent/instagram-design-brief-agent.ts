import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { StudioDesignBriefOutputSchema, type StudioDesignBriefOutput } from "../workflow/template-studio.js";

/**
 * Phase 2, item N, step `00c3-write-design-brief`: the Template Studio's
 * format thesis — which four to six routable archetypes THIS client should
 * run, each tied to a measured format, plus the rules that make the set read
 * as one system.
 *
 * ## What it is for
 *
 * The owner's complaint (2026-09-10) was two-sided: the templates are boring,
 * AND the repetition reads as machine-made. Six templates authored
 * independently would answer neither — they would be six unrelated layouts,
 * each individually defensible, with no shared type roles, no accent
 * discipline and no ground policy. This call exists so the six designer calls
 * that follow are variations inside one system rather than six separate
 * opinions, and so the SET is chosen from what actually performs in this
 * client's niche instead of from the archetype list's own order.
 *
 * Everything it reads is hand-assembled by `00c2-gather-format-evidence`
 * (`buildDesignBriefInput`): the client brief's positioning and ICP, the
 * brand kit's tokens, up to three pages of the client's own site, the
 * `media.inspectImages` DESCRIPTIONS of reference-post images (never the
 * competitors' pixels), and the code-computed format ranking with its
 * available and absent engagement signals stated in the same block.
 *
 * ## The honesty constraint is structural, not a prompt request
 *
 * `research.socialHistory` returns `engagement { likes?, comments?, views? }`
 * and only for four platforms, so the evidence this call reads frequently has
 * a hole in it. Two mechanisms make that hole visible rather than fillable:
 * `signalsAbsent` is a REQUIRED field of the output schema (a thesis cannot
 * be returned without saying what was missing), and every numeric claim in a
 * template's `why` is checked verbatim against the evidence block by
 * `assertNoInventedMetrics` before the row is stored. A model asked for a
 * performance rationale will otherwise write "carousels get 3.2x more saves",
 * because that is what this genre of copy sounds like.
 *
 * ## Model: Sonnet, and the cost that justifies it
 *
 * `claude-sonnet-4-6`, pinned, `contentLanguageSensitive` — the same two
 * arguments `InstagramBriefAgent` makes. This is the one document a QUARTER
 * of runs is rendered through (`STUDIO_TTL_DAYS = 120`), so a weak thesis is
 * not one bad post; and it reasons about a client's visual register in their
 * own language, Hebrew included, which is what `contentLanguageSensitive`
 * re-points per client at run time.
 *
 * The bill: ~8k in / 1.2k out ≈ **$0.042 per setup**, once per client per 120
 * days, on the SEPARATE setup budget (target $2.00, hard max $3.00 —
 * `planSetupBudget`). At a weekly cadence that is under half a cent per run
 * amortised. No Opus anywhere, per the owner's rule.
 *
 * ## Shape
 *
 * `allowedTools: []`, `maxSteps: 1` — every source is assembled into the
 * input by `00c2`, so this is a fixed one-call bill rather than an open-ended
 * research loop, exactly as every other agent in this package is built. A
 * malformed answer is a `content_fail`, which `00c3` records as a warn; the
 * whole studio block then falls through and the run renders on the bundled
 * archetypes. Setup never blocks a run.
 */
export class InstagramDesignBriefAgent extends BaseAgent<StudioDesignBriefOutput> {
  protected readonly config: AgentStepConfig<StudioDesignBriefOutput> = {
    id: "instagram-design-brief",
    description:
      "Write the format thesis for one client's Instagram template set: which 4-6 routable slide archetypes they should run, the measured format each derives from, and the set rules (type roles, accent discipline, ground policy) that make the templates read as one system — stating plainly which engagement signals the evidence had and which were absent, and inventing no metric.",
    allowedTools: [],
    outputSchema: StudioDesignBriefOutputSchema,
    maxSteps: 1,
    // The thesis plus up to eight template proposals with a rationale each,
    // the set rules and the signal accounting. A turn that runs out of room
    // does not come back short, it comes back unparseable — and this step
    // runs once per client per 120 days, so the headroom is free.
    maxTokens: 4_000,
    modelPolicy: resolveModelPolicy("instagram-design-brief", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    skillRef: "instagram-design-brief@1",
  };
}
