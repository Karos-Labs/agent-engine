import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { IntelReportOutputSchema, type IntelReportOutput } from "@agent-engine/tool-karos-intel";

/**
 * The RFC-05 migration's single generation step (§3 step 3): one bounded
 * `BaseAgent` producing the entire structured `IntelReportOutput` directly
 * (`outputSchema: IntelReportOutputSchema`, imported straight from
 * `@agent-engine/tool-karos-intel` — the same schema `intel.writeReport`
 * validates against, so there is no drift possible between what this agent
 * promises and what persistence accepts). This replaces the legacy
 * markdown-write / regex-parse round trip (RFC-05 §4) with a single typed
 * turn: no intermediate markdown-heading contract to keep in sync between
 * the prompt and a parser.
 *
 * `overallScore`/`overallGrade` are deliberately NOT part of what this
 * agent produces — see `IntelReportOutputSchema`'s own doc comment and
 * `karos-intel/src/scoring.ts`: the model supplies every real judgment call
 * (each of the 8 fixed dimensions' 0-100 score, every analysis section's
 * prose, the SWOT, the recommendations, the competitor rows), and the
 * workflow's own persistence step computes the weighted overall score in
 * code afterward, never trusting the model's own arithmetic.
 *
 * No `allowedTools`/tool-calling loop is needed here — everything this step
 * needs (client profile, brand kit, competitor list, the research pull's
 * result) is hand-assembled into its input by the workflow ahead of time
 * (RFC-05 §3 steps 1-2), so this agent's single turn goes straight to a
 * `final` output. `selfCritique` is intentionally omitted too: the
 * numbers-sourced check runs as its own explicit workflow step afterward
 * (RFC-05 §3 step 4, `gate.numbersSourced` against the concatenated
 * analysis prose), not folded into this agent's own loop, because that gate
 * needs a single `text` + `sources` shape that doesn't map cleanly onto this
 * agent's multi-field structured draft.
 */
export class IntelReportDraftAgent extends BaseAgent<IntelReportOutput> {
  protected readonly config: AgentStepConfig<IntelReportOutput> = {
    id: "intel-report-draft",
    description: "Generate one client's full competitive intelligence report: 8 dimension scores, 7 analysis sections, SWOT, recommendations, and competitor rows.",
    allowedTools: [],
    outputSchema: IntelReportOutputSchema,
    // SCRUM-291 (AU14) — the highest truncation risk in the fleet (AUDIT-2026-08-25
    // §3.2). `IntelReportOutputSchema` (karos-intel/src/types.ts) has no per-field
    // max length, so its realistic ceiling has to be sized from the fields it
    // actually asks the model to fill on every run:
    //   - 7 required prose sections (contentAnalysis..growthAnalysis), each a real
    //     analysis paragraph — ~500 words / ~2.8k chars apiece is a conservative
    //     floor for a paid deliverable, not a summary: ~19k chars.
    //   - brandSynchronizationUpdate, another required prose section: ~2.4k chars.
    //   - swot (14+ bullets at the schema's own minimums) + recommendations
    //     (unbounded array) + competitorRankings + competitors (unbounded arrays,
    //     Wide Scan targets >=8 rows each, and `competitors[].positioning` is its
    //     own free-text deep-dive per row) + brandVoiceRows/Archetypes +
    //     customerSentiment + whitespaceOpportunities: another ~15k chars once the
    //     Wide Scan target is met, most of it inside repeated array-of-object
    //     structures whose field names (keyStrengths, keyWeaknesses, ratingLabel,
    //     …) are themselves non-trivial token cost at 8-15 rows.
    //   ~37k content chars, at a conservative ~3.5 chars/token for JSON-escaped
    //   English prose, plus ~30% for the repeated-key-name overhead the
    //   array-heavy fields above add, is ~13.7k tokens of *floor* content — before
    //   any headroom for the schema growing (the point of sizing this from the
    //   schema at all — SCRUM-267 already grew it once) or a model that runs long.
    //   32000 leaves >2x margin over that floor and is the fleet's largest
    //   explicit ceiling, matching this agent's ranking as the #1 truncation risk
    //   (messages-api-adapter.ts:111-116 — a truncated turn is not a partial
    //   report, it's an unparseable one and the whole step fails).
    maxTokens: 32_000,
    // Pinned — same rationale as every other draft agent's craft step (RFC-02
    // §5): drafting/analysis is never a fallback-eligible step.
    modelPolicy: resolveModelPolicy("intel-report-draft", { policy: "pinned", model: "claude-sonnet-4-6" }),
    // v2 (parity-audit remediation): restores the Brand Synchronization Protocol,
    // the Output Quality Rules (conservative scoring, anti-sycophancy client-rank
    // floor, Wide Scan minimum, pricing/regulatory high-risk-field guidance,
    // conditional Customer Sentiment), 4-form Evidence Specificity, and the
    // SWOT minimum-bullet floors — ported from `karosCMO/src/lib/intel/brain.ts`'s
    // `DEFAULT_INTEL_PROMPT`, adapted honestly for this run's lack of live
    // web-search/web-fetch tools (no "web-observed" claims — see the prompt's
    // own research note). Same version-bump discipline as `linkedin-craft@2`.
    skillRef: "intel-report-craft@2",
  };
}
