/** The subset of `client.getConfig()`'s free-form config this workflow actually depends on. */
export interface XIntakeConfig {
  xHandle: string;
  requestedTopic?: string;
  [key: string]: unknown;
}

export interface XClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
}

export interface XCandidateSummary {
  /** A candidate topic derived from the (Phase 1 stand-in) research payload — see step 05's own comment. */
  candidateTopic?: string;
  hasNumericInsight: boolean;
  sourceLabel: string;
}

export interface XTopicReservation {
  reservationKey?: string;
  topics: string[];
}

export type XCandidateSource = "requested" | "reserved" | "research";

export interface XSelectedCandidate {
  topic: string;
  source: XCandidateSource;
}

export interface XAgentWorkflowResult {
  topic: string;
  angle: string;
  targetHandle: string;
  deliverableId: string;
}
