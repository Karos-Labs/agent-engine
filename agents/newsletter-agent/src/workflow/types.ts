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

export interface NewsletterAgentWorkflowResult {
  mainStory: string;
  theme: string;
  targetAudience: string;
  deliverableId: string;
}
