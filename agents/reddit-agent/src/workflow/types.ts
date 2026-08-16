export interface RedditIntakeConfig {
  targetSubreddits: string[];
  requestedTopic?: string;
  requestedSubreddit?: string;
}

export interface RedditClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
}

export interface RedditCandidateSummary {
  candidateTopic?: string;
  hasNumericInsight: boolean;
  sourceLabel: string;
}

export interface RedditTopicReservation {
  reservationKey?: string;
  topics: string[];
}

export type RedditCandidateSource = "requested" | "reserved" | "research";

export interface RedditSelectedCandidate {
  topic: string;
  source: RedditCandidateSource;
  targetSubreddit: string;
}

export interface RedditAgentWorkflowResult {
  topic: string;
  angle: string;
  targetSubreddit: string;
  deliverableId: string;
}
