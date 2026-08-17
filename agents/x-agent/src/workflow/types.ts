/** The subset of `client.getConfig()`'s free-form config this workflow actually depends on. */
export interface XIntakeConfig {
  xHandle: string;
  requestedTopic?: string;
  /** An explicit lane request for this run (lanes.md: "the customer's run request wins"). Any of `LANE_VALUES`; anything else is ignored and the rotation fallback decides instead. */
  requestedLane?: string;
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

/**
 * A single `memory.read({scope:"decisions"})` row, widened past
 * `DecisionRecord`'s own shape to explicitly surface `at` — the append
 * timestamp `memory.appendDecision` always writes but `AppendDecisionInputSchema`
 * doesn't name as a field — since the lane rotation and the engagement daily
 * cap both need real recency, not just insertion order (`listJson` sorts by
 * filename, which is a decision id, not a timestamp).
 */
export interface XRecentDecision {
  decisionId: string;
  summary: string;
  at?: number;
  [key: string]: unknown;
}

export type XCandidateSource = "requested" | "reserved" | "research";

export interface XSelectedCandidate {
  topic: string;
  source: XCandidateSource;
}

export interface XAgentWorkflowResult {
  topic: string;
  angle: string;
  lane: string;
  targetHandle: string;
  deliverableId: string;
}
