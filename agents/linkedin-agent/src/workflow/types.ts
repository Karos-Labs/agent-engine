export interface LinkedInIntakeConfig {
  profile: Record<string, unknown>;
  voiceRules: Record<string, unknown>;
}

export interface LinkedInClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
  requestedTopic?: string;
}

export interface LinkedInCandidateSummary {
  candidateTopic?: string;
  hasNumericInsight: boolean;
  sourceLabel: string;
}

export interface LinkedInTopicReservation {
  reservationKey?: string;
  topics: string[];
}

export type LinkedInCandidateSource = "requested" | "reserved" | "research";

export interface LinkedInSelectedCandidate {
  topic: string;
  source: LinkedInCandidateSource;
}

export interface LinkedInAgentWorkflowResult {
  topic: string;
  angle: string;
  targetAudience: string;
  deliverableId: string;
}
