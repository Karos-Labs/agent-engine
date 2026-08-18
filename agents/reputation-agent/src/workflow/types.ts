import { z } from "zod";
import type { CaptureLegRequest, TriageConfig } from "@agent-engine/tool-karos-reputation";

/**
 * The closed 7-value department-tag enum (`references/scoring.md` §4):
 * "exactly one tag per review, from this closed list, and nothing else."
 *
 * Tie-break when two tags both fit: the tag naming the highest consequence
 * wins, and this array is in ASCENDING consequence order — so the candidate
 * appearing LATER wins (Fraud beats Billing; Press beats Legal). `Service` is
 * outside the ordering: the residual, never a tie-break winner and never a
 * shrug. The rule lives in `prompts/reputation-tag/*.md`; the enum itself is
 * what is mechanically enforced (the workflow rejects any tag outside it).
 */
export const DEPARTMENT_TAGS = ["Billing", "Safety", "Legal", "Fraud", "Discrimination", "Press", "Service"] as const;
export type DepartmentTag = (typeof DEPARTMENT_TAGS)[number];

/** Step 01: the pulse-number claim (run-protocol.md §5's first of the "two claims"). */
export interface ReputationRunClaim {
  pulseNumber: number;
  /** False when this pulse number was already claimed by a prior run of the same slot — see `claims.ts`'s doc comment on why this never blocks the run (the number itself is cosmetic/best-effort, unlike the review claim). */
  claimedNew: boolean;
  /** The client's one-off steer for this pulse, read from `client.getConfig` at step 01 (e.g. a specific listing to prioritize). Free-form and optional — no schema exists for it yet. */
  steer: Record<string, unknown>;
}

/** Step 02: everything about what the client IS, frozen for the lifetime of this pulse (run-protocol.md §6). */
export interface ReputationFrozenInputs {
  /** `01-facts.md`'s lines — the closed universe `facts_grounded` claims must trace to, and the only source a drafted reply may cite a fact from. */
  facts: string[];
  brand: Record<string, unknown>;
  voiceRules: Record<string, unknown>;
  /** The client-lock gate's inputs (step 07): a never-say phrase list plus, for a regulated client, phrases at least one of which must appear (e.g. "operates under license"). Both default to empty — most clients have no locks configured yet. */
  locks: {
    neverSay: string[];
    requiredFramingAnyOf: string[];
  };
  /**
   * The raw config value — read as a free-form string, never trusted as
   * already-validated. Step 10 is where this is actually asserted against
   * `"approve-all"` (RFC-08 §6: no reply-publish credential exists for any
   * other state today); a fast-fail check also runs at freeze time (step 02)
   * so an illegal value blocks intake before any capture/draft spend, not
   * after.
   */
  autonomy: string;
  captureLegs: CaptureLegRequest[];
  /** Present only when `reputationRoster` existed but failed its own schema — carried through so step 03's `WorkflowBlockedIntake` reason can name the real problem instead of just "empty." */
  rosterConfigError?: string;
  baselineRatingAvg: Record<string, number>;
  /** A client's frozen per-pulse override of `DEFAULT_TRIAGE_CONFIG` (`references/scoring.md`: "the client's frozen `02-config.json` is the runtime authority"). Absent means the tool's own default rubric applies. */
  triageConfigOverride?: TriageConfig;
}

/** Step 04a's extraction output — the 5 evidenced yes/no questions `references/scoring.md` §2 describes, one model pass per NEW review, cached forever after. */
export const ReputationExtractionAnswerSchema = z.object({
  value: z.boolean(),
  /** The exact substring of the review text that justifies `value`. Empty/missing is treated as false by the workflow, never trusted at face value (scoring.md §2: "a boolean with no span is treated as false"). */
  evidenceSpan: z.string(),
});
export type ReputationExtractionAnswer = z.infer<typeof ReputationExtractionAnswerSchema>;

export const ReputationExtractionOutputSchema = z.object({
  sentiment: z.enum(["pos", "neg", "neutral", "mixed"]),
  /**
   * Answered for completeness/audit (the source doc lists it among the "5
   * evidenced yes/no questions"), but never fed into `Annotations` or
   * `reputation.triage`: `has_question` is derived deterministically by
   * `triage.py`'s own port from `text.includes("?")` (scoring.md §1's Value
   * table), so a model opinion on it can never override arithmetic — the
   * anti-vibe invariant applies even to a signal this cheap to compute
   * without a model at all.
   */
  hasQuestion: ReputationExtractionAnswerSchema,
  factualError: ReputationExtractionAnswerSchema,
  fixableComplaint: ReputationExtractionAnswerSchema,
  detailedPositive: ReputationExtractionAnswerSchema,
  serviceRecoveryOpportunity: ReputationExtractionAnswerSchema,
});
export type ReputationExtractionOutput = z.infer<typeof ReputationExtractionOutputSchema>;

/** Step 04b: exactly one department tag per FLAG-lane review. */
export const ReputationTagOutputSchema = z.object({
  tags: z.array(
    z.object({
      reviewId: z.string().min(1),
      tag: z.enum(DEPARTMENT_TAGS),
    }),
  ),
});
export type ReputationTagOutput = z.infer<typeof ReputationTagOutputSchema>;

/** Step 06: one drafted reply. */
export const ReputationDraftOutputSchema = z.object({
  draftText: z.string().min(1),
});
export type ReputationDraftOutput = z.infer<typeof ReputationDraftOutputSchema>;

/** Step 08a: the batch voice-consistency pass — one verdict per drafted item, evaluated together so cross-item repetition (response-craft.md's "same opener twice" anti-pattern) is actually visible. */
export const ReputationVoiceOutputSchema = z.object({
  verdicts: z.array(
    z.object({
      reviewId: z.string().min(1),
      pass: z.boolean(),
      reason: z.string(),
    }),
  ),
});
export type ReputationVoiceOutput = z.infer<typeof ReputationVoiceOutputSchema>;

/** run-protocol.md §2b: "a multi-item step writes a sibling completion file, last" — the N-row manifest step 06-09's drafting loop and step 11's payload both produce. */
export interface ReputationCompletionManifestRow {
  reviewId: string;
  outcome: "written" | "held" | "dropped";
  reason?: string;
}

/**
 * One row per capture leg this pulse ran (`ADAPTERS.md` rule 1 /
 * `run-protocol.md` §7). A dead leg also emits an `UNAVAILABLE` tombstone
 * review into the triage envelope — that is what makes the engine count it in
 * `summary.unavailable` rather than reading zero reviews as "nothing to
 * answer" — but a tombstone buried inside a review row is not something a
 * human skimming the pulse will see. This is the first-class version of the
 * same fact: "Google: capture failed, reason X."
 */
export interface ReputationCaptureLegStatus {
  leg: string;
  status: "ok" | "UNAVAILABLE" | "not_in_roster";
  /** Real reviews captured, excluding any UNAVAILABLE tombstone row. */
  reviewCount: number;
  reason?: string;
}

export interface ReputationPulseWorkflowResult {
  pulseNumber: number;
  counts: { respond: number; flag: number; noAction: number; unavailable: number };
  crisisFired: boolean;
  crisisTriggerCount: number;
  deliverableId: string;
  draftManifest: ReputationCompletionManifestRow[];
  approvedDraftCount: number;
  flaggedCount: number;
  captureLegs: ReputationCaptureLegStatus[];
  /** The subset of `captureLegs` a human must act on — empty on a clean pulse. */
  unavailableLegs: ReputationCaptureLegStatus[];
}

/** Layer 0-only capture summary the analysis workflow scaffold hands to its (stubbed) Layer 1-5 phases. */
export interface ReputationAnalysisWorkflowResult {
  layer0Capture: { legCount: number; reviewCount: number };
  layer1ResponseBehavior: { status: "not_yet_ported"; note: string };
  layer2ReputationState: { status: "not_yet_ported"; note: string };
  layer3ThemeMining: { status: "not_yet_implemented"; note: string };
  layer4Benchmark: { status: "not_yet_implemented"; note: string; competitorTrackingRead: boolean };
  layer5Synthesis: { status: "not_yet_implemented"; note: string };
}
