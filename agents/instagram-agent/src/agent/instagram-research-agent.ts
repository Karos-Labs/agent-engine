import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { ResearchOutputSchema, type ResearchOutput } from "../workflow/types.js";

/**
 * RFC-03 §3 step 04: "research the subject with verbatim raw payload
 * capture." The verbatim-capture half of that requirement is already
 * satisfied by `research.pull` itself (it persists the raw payload to the
 * workspace store before this agent ever runs, `packages/tools/karos-research/
 * src/pull.ts`) — this agent's own job is the *judgment* half: read that raw
 * payload and extract the facts worth carrying into slide copy, each traced
 * to a source and a date (RFC-03 §1: "every fact that will reach a slide
 * needs a source + date — no drafting step may search afterward").
 *
 * `allowedTools: []` — same reasoning as `IntelReportDraftAgent`
 * (`agents/intel-report-agent/src/agent/intel-report-draft-agent.ts`):
 * everything this step needs (the topic, the already-fetched raw payload)
 * is hand-assembled into its input by the workflow ahead of time, so this
 * agent's single turn goes straight to a `final` output rather than running
 * its own tool-calling loop. This also keeps step 04 bounded and cheap
 * context-wise — the "context bloat" legacy defect (RFC-03 §1) this whole
 * migration exists to avoid — since the agent only ever sees one already-
 * fetched payload, never a growing pile of prior runs' raw research.
 *
 * ## Fact cards (`instagram-research@2`, RFC-13 §J, Phase 1)
 *
 * The payload this reads is no longer one 4-document pull: `04a2-research-
 * pull-deep` merges three lanes (news 7d, insight 90d, primary-domains 90d)
 * into 14-20 documents ordered primary-first, plus the client's own material
 * as `clientDocuments`. The output grew with it — `kind`, `url`, `quote` and
 * `primary` per card, 12-24 cards instead of 4-8 facts — because the
 * downstream steps that were starved were starved of STRUCTURE as much as of
 * volume: the angle step needs to know which card is a statistic, the copy
 * prompt maps `kind` to an archetype, and `04b2-dedupe-fact-cards` needs
 * `primary`/`url` to decide which of two cards saying the same thing to keep.
 *
 * ## Model (2026-09)
 *
 * Gemini 2.5 Flash on Vertex, `pinned` (never silently substituted). This is
 * an EXTRACTION step: it reads a research payload and returns sourced, dated
 * cards as structured output. It is not client-facing copy, so voice is not
 * what it needs; a large window and cheap tokens are. Sonnet cost roughly ten
 * times as much per run here for no measured quality gain on a read-and-list
 * task.
 *
 * The `@2` payload is bigger — ~20k input / ~3k output tokens against the
 * ~5k/1.5k of `@1` — so this step's cost per run goes from ≈ $0.005 to
 * **≈ $0.014 on Flash** against ≈ $0.11 on Sonnet. It stays on Flash, and the
 * decision is not a judgment call kept in a comment: `research-extraction-
 * quality.test.ts` pins the floor this step has to clear (≥ 10 cards, ≥ 3
 * kinds, no duplicates, a URL on every card whose document had one). If
 * Flash stops clearing that floor on prep samples, THAT is what moves this
 * step to Sonnet — at +$0.10 per run against a $1.00 target, which the run
 * budget can absorb once, not per attempt.
 *
 * Retargetable per deployment
 * (`MODEL_STEP_INSTAGRAM_RESEARCH_VENDOR/_MODEL`) and per run in Studio
 * (`stageModels["instagram-research"]`).
 *
 * ## The output ceiling (Phase 5.5, 2026-09-16)
 *
 * This step declared none and inherited `GEMINI_DEFAULT_MAX_TOKENS` (16,384).
 * On geektime (prep run `pubsub-21868533047825082`) it hit that ceiling and
 * resolved `tooling_error`, so the post was written from **zero fact cards** —
 * the single most expensive failure in the run, and it reported $0 because a
 * truncated turn booked nothing (`OutputLimitExceededError` now carries the
 * usage, and `BaseAgent` raises the ceiling once before giving up).
 *
 * 24,000 is measured, not padded. The three extractions that completed that
 * day returned 3,059 / 3,127 / 3,263 *visible* output tokens on 65,137 /
 * 71,686 / 75,804 input. The gap between that and a 16,384-token cut-off is
 * thinking: Gemini 2.5 counts `thoughtsTokenCount` against `maxOutputTokens`
 * while excluding it from `candidatesTokenCount`, so the visible payload is
 * only ever part of the budget and the headroom this step needs is the part
 * nobody could see. 24,000 leaves ~7.5x the largest measured visible payload
 * for thoughts plus payload together.
 *
 * Cost: nothing until it is used, and bounded at +7,616 output tokens ×
 * $2.50/1M = **+$0.019** in the worst case — against a run that otherwise
 * ships with no sourced facts at all. Per the 2026-09-16 cost ruling, a
 * quality-affecting ceiling is not optional spend.
 */
export class InstagramResearchAgent extends BaseAgent<ResearchOutput> {
  protected readonly config: AgentStepConfig<ResearchOutput> = {
    id: "instagram-research",
    description: "Extract sourced, dated fact cards worth carrying into carousel slide copy from one already-fetched multi-lane research payload.",
    allowedTools: [],
    outputSchema: ResearchOutputSchema,
    modelPolicy: resolveModelPolicy("instagram-research", { policy: "pinned", model: "gemini-3.8-flash", vendor: "gemini" }),
    skillRef: "instagram-research@2",
    /** See "The output ceiling" above — 16,384 truncated this step on geektime and cost that post every one of its fact cards. */
    maxTokens: 24_000,
  };
}
