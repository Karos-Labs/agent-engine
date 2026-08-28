export interface BlogIntakeConfig {
  /** Subjects this client does not engage with, carried from the intake read so the terminal guardrail needs no second one. */
  forbiddenTopics: string[];
  targetKeywords: string[];
  contentPillars: string[];
  requestedTopic?: string;
  requestedKeyword?: string;
}

export interface BlogClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
  audiencePersona: string;
}

export interface BlogCandidateSummary {
  candidateTopic?: string;
  hasNumericInsight: boolean;
  sourceLabel: string;
}

export interface BlogTopicReservation {
  reservationKey?: string;
  topics: string[];
}

export type BlogCandidateSource = "requested" | "reserved" | "research";

export interface BlogSelectedCandidate {
  topic: string;
  source: BlogCandidateSource;
  targetKeyword: string;
  contentPillar: string;
}

export interface BlogAgentWorkflowResult {
  topic: string;
  angle: string;
  targetKeyword: string;
  deliverableId: string;
  /**
   * The same post text this run's own `15-batch-review` gate showed a human
   * (or would have, had `autoApprove` not skipped it) — i.e. `draft.text`.
   *
   * Added for SCRUM-302/AU18: campaign-orchestrator runs every channel with
   * `autoApprove: true` and needs something to put in front of its own single
   * campaign-review gate in place of the five per-channel gates it bypassed.
   * A standalone caller that already got a real per-channel gate can ignore
   * this field.
   */
  preview: string;
}
