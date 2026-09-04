import { BaseAgent, resolveModelPolicy, type AgentStepConfig, type BaseAgentRuntime, type ModelPolicy } from "@agent-engine/core";
import { z } from "zod";

/** This step's own id — what `resolveModelPolicy` derives `MODEL_STEP_INTEL_REPORT_GROUNDING_*` from, and what telemetry records. */
export const INTEL_REPORT_GROUNDING_STEP_ID = "intel-report-grounding";

/**
 * Output ceiling for a rewrite of the seven analysis sections.
 *
 * A fraction of the drafting step's 32k because this step returns prose only —
 * no dimension scores, no competitor rows, no SWOT. Those are the bulk of the
 * draft's payload and this step must not touch them: it is correcting numeric
 * claims in the narrative, not re-deciding the report.
 */
export const INTEL_REPORT_GROUNDING_MAX_TOKENS = 12_000;

export const INTEL_REPORT_GROUNDING_MODEL_POLICY: ModelPolicy = resolveModelPolicy(INTEL_REPORT_GROUNDING_STEP_ID, {
  policy: "pinned",
  model: "claude-sonnet-4-6",
});

/**
 * The seven analysis sections, corrected. Every field required: a partial
 * response would leave the workflow guessing which sections were reviewed and
 * which were dropped, and silently losing a section is worse than the
 * unsourced figure this step exists to remove.
 */
export const IntelReportGroundingOutputSchema = z.object({
  contentAnalysis: z.string().min(1).describe("The corrected content & messaging analysis."),
  conversionAnalysis: z.string().min(1).describe("The corrected conversion analysis."),
  seoAnalysis: z.string().min(1).describe("The corrected SEO analysis."),
  geoAnalysis: z.string().min(1).describe("The corrected GEO analysis."),
  positioningAnalysis: z.string().min(1).describe("The corrected positioning analysis."),
  brandAnalysis: z.string().min(1).describe("The corrected brand analysis."),
  growthAnalysis: z.string().min(1).describe("The corrected growth analysis."),
  corrections: z
    .array(
      z.object({
        claim: z.string().min(1).describe("The unsourced figure as it appeared in the draft."),
        action: z.enum(["restated_as_range", "replaced_with_qualitative", "removed", "kept_and_sourced"]),
        note: z.string().min(1).describe("One line on what was done and why — the audit trail for a figure that changed."),
      }),
    )
    .default([])
    .describe("What was done to each flagged claim. Recorded so a reviewer can see which numbers moved and why, rather than diffing two versions of seven prose sections."),
});
export type IntelReportGroundingOutput = z.infer<typeof IntelReportGroundingOutputSchema>;

const INTEL_REPORT_GROUNDING_STEP_CONFIG: AgentStepConfig<IntelReportGroundingOutput> = {
  id: INTEL_REPORT_GROUNDING_STEP_ID,
  description:
    "Repair numeric claims in a drafted intel report that do not trace to its research sources: restate a range faithfully, or replace the figure with qualitative analysis.",
  allowedTools: [],
  outputSchema: IntelReportGroundingOutputSchema,
  maxTokens: INTEL_REPORT_GROUNDING_MAX_TOKENS,
  modelPolicy: INTEL_REPORT_GROUNDING_MODEL_POLICY,
  skillRef: "intel-report-grounding@1",
};

/**
 * The pre-gate self-correction pass.
 *
 * `gate.numbersSourced` holds the whole run when the report's prose asserts a
 * figure its sources do not support. That is the correct behaviour and is not
 * being softened — but a held run is a report nobody gets, and the usual cause
 * is one sentence out of seven sections. On 2026-09-04 a Karos Labs report was
 * held over seven figures; six were faithful quotations of sourced ranges that
 * the gate mis-read (fixed in `numbers-sourced.ts`), and exactly one was a real
 * over-assertion: the draft turned a source's `$500-$2,000/month` range into
 * "engagements at $2,000+/month". This step exists for that one.
 *
 * It runs ONLY when the gate would fail, and it is handed the specific claims
 * that failed rather than being asked to re-audit the report — a critic given
 * the answer is a much cheaper and more reliable critic than one given the
 * question. Its output then goes through the real gate unchanged, so this step
 * can improve a report's chances and can never wave one through: if it strips
 * a figure badly, or invents a new one, the gate still holds the run.
 *
 * Prose only, deliberately. The dimension scores, SWOT, recommendations and
 * competitor rows are the draft's real judgments and are not re-opened here —
 * `gate.numbersSourced` never checked them, and letting a correction pass
 * rewrite them would put a second, less-informed model in charge of the
 * report's actual conclusions.
 */
export class IntelReportGroundingAgent extends BaseAgent<IntelReportGroundingOutput> {
  protected readonly config: AgentStepConfig<IntelReportGroundingOutput> = INTEL_REPORT_GROUNDING_STEP_CONFIG;

  constructor(runtime: BaseAgentRuntime) {
    super(runtime);
  }
}
