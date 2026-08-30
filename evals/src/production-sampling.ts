import { z } from "zod";
import { EvalLanguageSchema, type EvalLanguage } from "./language.js";
import type { JudgeCase } from "./judge/types.js";

/**
 * One production draft and what a human did with it.
 *
 * The field names mirror `ReviewCycleResult` (`@agent-engine/workflow`'s
 * `runReviewCycle`) rather than inventing a vocabulary: `revision` is that
 * type's own counter, where 0 means "approved first time", and `notes` is its
 * `RevisionNote[]`. Structural rather than imported — `evals/` deliberately
 * does not depend on `@agent-engine/workflow`, and a shape this small does not
 * justify the edge — but the correspondence is the point: a workflow that
 * already produces a `ReviewCycleResult` is one adapter away from feeding this.
 */
export const ProductionDraftRecordSchema = z.object({
  runId: z.string().min(1),
  clientId: z.string().min(1),
  agentId: z.string().min(1),
  language: EvalLanguageSchema,
  platform: z.string().min(1),
  /** What the agent produced before any human touched it. */
  firstDraft: z.string().min(1),
  /** What was actually shipped. Identical to `firstDraft` for an untouched approval. */
  finalOutput: z.string().min(1),
  /** 0 means approved as drafted. */
  revision: z.number().int().nonnegative(),
  notes: z
    .array(z.object({ revision: z.number().int().nonnegative(), actor: z.string().min(1), at: z.string().min(1), feedback: z.string().min(1) }))
    .default([]),
  decidedAt: z.string().min(1),
  decidedBy: z.string().min(1),
});
export type ProductionDraftRecord = z.infer<typeof ProductionDraftRecordSchema>;

/**
 * The label the training signal is actually about: did a person ship what the
 * agent wrote, or did they have to change it?
 *
 * `revision > 0` and `firstDraft !== finalOutput` are checked separately
 * because they are different events. A reviewer can hand-edit before
 * approving (`GateResponse.edits`, applied verbatim by the workflow) without
 * ever clicking revise — revision count 0, text changed. Reading only the
 * counter would file that under "the agent got it right first time", which is
 * exactly backwards as a training signal.
 */
export type ProductionDraftLabel = "approved_as_drafted" | "revised";

export function labelProductionDraft(record: ProductionDraftRecord): ProductionDraftLabel {
  return record.revision > 0 || record.firstDraft !== record.finalOutput ? "revised" : "approved_as_drafted";
}

/** Words, Unicode-aware. `\p{L}`/`\p{N}` rather than `\w`, or every Hebrew draft tokenizes to nothing. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 0),
  );
}

/**
 * How much the shipped text diverges from the draft, 0 (identical) to 1
 * (no shared vocabulary), as Jaccard distance over word sets.
 *
 * A coarse proxy, named as one. It is NOT an edit distance and does not
 * notice reordering, so a reviewer who rearranged paragraphs without changing
 * a word scores 0 here while `labelProductionDraft` still reports `revised`
 * — which is why the label, not this number, is the signal, and this is the
 * magnitude beside it. Chosen over Levenshtein because it is linear rather
 * than quadratic in a 3,000-character post and because word sets survive
 * RTL text and punctuation differences that character alignment does not.
 */
export function revisionDivergence(record: ProductionDraftRecord): number {
  if (record.firstDraft === record.finalOutput) return 0;
  const before = words(record.firstDraft);
  const after = words(record.finalOutput);
  if (before.size === 0 && after.size === 0) return 0;
  let shared = 0;
  for (const word of before) if (after.has(word)) shared += 1;
  const union = before.size + after.size - shared;
  return union === 0 ? 0 : Math.round((1 - shared / union) * 10_000) / 10_000;
}

export interface SamplingPolicy {
  /** Share of `approved_as_drafted` records to score, 0–1. */
  rate: number;
  /**
   * Take every revised draft regardless of `rate`. On by default.
   *
   * Revisions are the scarce class and the informative one: an approval says
   * only that nothing was wrong enough to fix, while a revision carries a
   * person's own statement of what was wrong. Sampling both at the same low
   * rate would produce a corpus that is ~95% approvals and almost no
   * examples of the thing worth learning from.
   */
  alwaysSampleRevised?: boolean;
  /** Mixed into the bucket hash. Change it to draw a genuinely different sample without changing `rate`. */
  salt?: string;
}

export const DEFAULT_SAMPLING_POLICY: SamplingPolicy = { rate: 0.05, alwaysSampleRevised: true };

/** FNV-1a, 32-bit. Small, dependency-free, and stable across processes and machines — which is the property that matters here. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Which point in [0,1) this run occupies. Deterministic in `runId`.
 *
 * Deliberately not `Math.random()`. A run is either in the sample or it is
 * not, permanently and reproducibly: re-running the sampler over the same
 * week must select the same runs, or the "drift" RFC-01 §12 bullet 5 asks
 * for alerting on is partly just resampling noise. It also means no RNG has
 * to be threaded through the call site to make this testable.
 */
export function samplingBucket(runId: string, salt = ""): number {
  return fnv1a(`${salt}:${runId}`) / 0x1_0000_0000;
}

export function shouldSampleProductionDraft(record: ProductionDraftRecord, policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY): boolean {
  if ((policy.alwaysSampleRevised ?? true) && labelProductionDraft(record) === "revised") return true;
  if (policy.rate <= 0) return false;
  if (policy.rate >= 1) return true;
  return samplingBucket(record.runId, policy.salt ?? "") < policy.rate;
}

export interface ProductionSample {
  record: ProductionDraftRecord;
  label: ProductionDraftLabel;
  divergence: number;
  /** Ready for `runRubricJudge` — production sampling scores on the SAME rubric as the golden runs, per RFC-01 §12 bullet 5. */
  judgeCase: JudgeCase;
}

/**
 * Turns one production record into a judge case.
 *
 * The SHIPPED text is what gets scored, and the agent's own first draft rides
 * along as `reference` only when a person changed it. That direction is the
 * whole training signal: the human-approved text is the endorsed answer, and
 * the judge is being asked how far the machine's attempt was from it. Feeding
 * the draft as the thing under evaluation would score the wrong artifact.
 */
export function toJudgeCase(record: ProductionDraftRecord): JudgeCase {
  const label = labelProductionDraft(record);
  const feedback = record.notes.map((n) => `- ${n.feedback}`).join("\n");
  const notes = [
    `This is a production sample, not a golden run. A human reviewer ${label === "revised" ? "changed this draft before shipping it" : "shipped it as drafted"}.`,
    ...(feedback.length > 0 ? [`Revision requests the reviewer made:\n${feedback}`] : []),
  ].join("\n\n");

  return {
    caseId: `${record.runId}:production-sample`,
    agentId: record.agentId,
    clientId: record.clientId,
    language: record.language as EvalLanguage,
    platform: record.platform,
    output: record.finalOutput,
    ...(label === "revised" ? { reference: record.firstDraft } : {}),
    notes,
  };
}

/** Every record the policy selects, as ready-to-judge samples, in input order. */
export function sampleProductionDrafts(
  records: readonly ProductionDraftRecord[],
  policy: SamplingPolicy = DEFAULT_SAMPLING_POLICY,
): ProductionSample[] {
  return records
    .filter((record) => shouldSampleProductionDraft(record, policy))
    .map((record) => ({ record, label: labelProductionDraft(record), divergence: revisionDivergence(record), judgeCase: toJudgeCase(record) }));
}
