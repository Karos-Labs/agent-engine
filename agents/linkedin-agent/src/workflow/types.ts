export interface LinkedInIntakeConfig {
  profile: Record<string, unknown>;
  voiceRules: Record<string, unknown>;
}

/** The two posting identities the legacy system supported (RFC-01 §9's "two-paths" design) — which voice a run drafts in. */
export type LinkedInIdentityScope = "company" | "executive";

/**
 * The restored archetype/lane menu (Phase 2.5 Batch 2.2), sourced from
 * `products/live/linkedin-agent/references/linkedin-voice-by-industry.md`'s
 * "11 founder archetypes" (SKILL.md's own index names that file as the
 * canonical source for exactly this list) — the founder-led rotation that
 * replaces the pre-restoration boolean `hasNumericInsight ? "data-point" :
 * "thought-leadership"` angle. Naming follows that file's eleven numbered
 * entries directly: build-in-public/progress update, lesson learned
 * (failure → insight), contrarian/POV, origin story, milestone/launch,
 * the "here's how we did X" teardown, hiring/culture, customer/win story,
 * industry react, personal vulnerability, and community question.
 */
export const LINKEDIN_ARCHETYPES = [
  "build-in-public",
  "lesson-learned",
  "contrarian-take",
  "origin-story",
  "milestone-launch",
  "teardown-framework",
  "hiring-culture",
  "customer-story",
  "industry-reaction",
  "vulnerability-admission",
  "community-question",
] as const;
export type LinkedInArchetype = (typeof LINKEDIN_ARCHETYPES)[number];

export interface LinkedInCompanyIdentity {
  scope: "company";
}

export interface LinkedInExecutiveIdentity {
  scope: "executive";
  executiveName: string;
  executiveTitle?: string;
  /**
   * The mined-CV "lens" narrative (`founder-persona-spec.md` §2) — what
   * prior companies actually did, this executive's role there, and the
   * earned point of view it gives them. Free text, not structured, since the
   * whole point is the throughline prose a model can draw credibility from.
   */
  careerHistory?: string;
  /** The 3-5 earned pillars (`founder-persona-spec.md` §3) this executive can post on with authority because of `careerHistory`. */
  corePillars?: string[];
  /** Topics that would read as borrowed credibility for this executive — the earned-claim gate's hard "do not post" list (`founder-persona-spec.md` §3). A draft that strays here is not earned, not just off-brand. */
  offLimitsTopics?: string[];
  /** This executive's own personal voice/tone (`founder-persona-spec.md` §4) — deliberately distinct from the company's own `voiceRules.tone`; a founder post is not a press release wearing a first-person disguise. */
  voiceTone?: string;
}

export type LinkedInIdentity = LinkedInCompanyIdentity | LinkedInExecutiveIdentity;

export interface LinkedInClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
  requestedTopic?: string;
  /** A run note / standing direction request naming the archetype directly (`lanes.md` §2's style-choice rule #1: "the customer's request wins"). Takes precedence over the rotation below, even over a repeat of the last post's archetype. */
  requestedArchetype?: LinkedInArchetype;
  identity: LinkedInIdentity;
  /**
   * The setup document for whoever this run posts as — the company page's
   * standing direction, or that seat's own intake.
   *
   * Per identity, not per client, because that is what the document
   * describes: the company page and each executive seat have their own
   * charter, and merging them would let a seat post the company's material in
   * the company's framing under a personal name.
   *
   * `null` when no document exists, which is an ordinary state.
   */
  strategy: string | null;
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

/** What step 03 hands forward: the raw decision summaries (unchanged, still used to exclude recently-covered topics) plus the most recent run's archetype, if one can be parsed back out of its summary. */
export interface LinkedInDecisionsShelf {
  summaries: string[];
  lastArchetype?: LinkedInArchetype;
}

export type LinkedInArchetypeSource = "requested" | "rotation";

/** Step 08's output: the archetype this run will draft in, how it was picked, and (for testability) what the immediately-prior run's archetype was, if any. */
export interface LinkedInArchetypeSelection {
  archetype: LinkedInArchetype;
  source: LinkedInArchetypeSource;
  priorArchetype?: LinkedInArchetype;
}

export interface LinkedInAgentWorkflowResult {
  topic: string;
  archetype: LinkedInArchetype;
  targetAudience: string;
  deliverableId: string;
}
