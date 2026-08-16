export interface BlogIntakeConfig {
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
}
