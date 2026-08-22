/** The subset of `client.getConfig()`'s free-form config this workflow actually depends on. */
export interface XIntakeConfig {
  xHandle: string;
  /**
   * Which setup document under `strategy/x-agent/` this account posts from.
   *
   * Config rather than convention because nothing derives one from the other:
   * karoslabs runs `@getkaros` off `karos-labs.md` and `@alberree` off
   * `albert-kattan.md`. Slugifying a handle would silently pick up the wrong
   * charter, or none, and "none" is the dangerous one — the run would proceed
   * without the never-post list.
   *
   * Omitted falls back to the account-level `strategy/x-agent` document.
   */
  xStrategyKey?: string;
  requestedTopic?: string;
  /** An explicit lane request for this run (lanes.md: "the customer's run request wins"). Any of `LANE_VALUES`; anything else is ignored and the rotation fallback decides instead. */
  requestedLane?: string;
  [key: string]: unknown;
}

export interface XClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
  /**
   * The client's filled-in account intake for this handle — what the account
   * is chartered to be known for, and what it must never post.
   *
   * Distinct from `voiceRules`, which says how the client SOUNDS. This says
   * what this particular account is FOR, and the two are not
   * interchangeable: a brand page and a founder's seat share one voice and
   * have opposite charters, which is exactly why the lab repo keeps a
   * separate intake per account.
   *
   * `null` when the client has no setup document — a real state, not an error.
   */
  strategy: string | null;
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
