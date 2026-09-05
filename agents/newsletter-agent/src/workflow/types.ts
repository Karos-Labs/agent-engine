export interface NewsletterIntakeConfig {
  /** Subjects this client does not engage with, carried from the intake read so the terminal guardrail needs no second one. */
  forbiddenTopics: string[];
  targetAudience: string;
  frequency: string;
  requestedTopic?: string;
}

export interface NewsletterClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
}

export interface NewsletterCandidateSummary {
  candidateTopic?: string;
  hasNumericInsight: boolean;
  sourceLabel: string;
}

export interface NewsletterTopicReservation {
  reservationKey?: string;
  topics: string[];
}

export type NewsletterCandidateSource = "requested" | "reserved" | "research";

export interface NewsletterSelectedCandidates {
  mainStory: string;
  source: NewsletterCandidateSource;
  secondaryTopics: string[];
}

/**
 * The editor's last word on the edition that shipped from one revision round
 * (`15c-editor-verdict`), carried onto the review gate's payload, the
 * persisted manifest and the workflow result so a reviewer sees what the
 * editor thought rather than only what the writer wrote.
 */
export interface NewsletterEditorialOutcome {
  verdict: "approve" | "revise";
  scores: { specificity: number; voice: number; structure: number; humanity: number };
  /** The editor's notes on the shipped draft: polish suggestions on `approve`, the unresolved problems on a flagged `revise`. */
  notes: readonly string[];
  /** How many drafting rounds this revision took before it shipped (1 = first draft cleared everything). */
  rounds: number;
  /** True when the edition shipped on the last round with the editor still asking for changes: the reviewer should read `notes` before approving. */
  flagged: boolean;
}

export interface NewsletterAgentWorkflowResult {
  mainStory: string;
  theme: string;
  targetAudience: string;
  deliverableId: string;
  /** The editor's verdict on the shipped draft; absent only when the run completed without reaching the editor (never, in practice). */
  editorial?: NewsletterEditorialOutcome;
  /**
   * The same edition text this run's own `15-batch-review` gate showed a
   * human (or would have, had `autoApprove` not skipped it) — i.e.
   * `draft.text`.
   *
   * Added for SCRUM-302/AU18: campaign-orchestrator runs every channel with
   * `autoApprove: true` and needs something to put in front of its own single
   * campaign-review gate in place of the five per-channel gates it bypassed.
   * A standalone caller that already got a real per-channel gate can ignore
   * this field.
   */
  preview: string;
}
