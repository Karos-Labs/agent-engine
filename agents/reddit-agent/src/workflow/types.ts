export interface RedditIntakeConfig {
  /** Subjects this client does not engage with, carried from the intake read so the terminal guardrail needs no second one. */
  forbiddenTopics: string[];
  targetSubreddits: string[];
  requestedTopic?: string;
  requestedSubreddit?: string;
  /**
   * An explicit candidate thread to reply to, supplied through the client's
   * intake config (`client.getConfig`). Phase 1 has no live thread-discovery
   * backend — finding a real candidate thread means scanning subreddit
   * RSS feeds / the Reddit API for live threads worth replying to
   * (`reddit-agent-v2/SKILL.md` step 05, "the only expensive step"), which
   * is out of scope here exactly the way a real external search backend is
   * out of scope for `research.pull` (see workflow step 04's comment). So
   * this is the *only* honest source of a target thread today: never a
   * fabricated reddit.com URL synthesized from a query string.
   */
  requestedThreadUrl?: string;
  /** The candidate thread's own title — required alongside `requestedThreadUrl` so the draft step never has to guess what the thread is about. */
  requestedThreadTitle?: string;
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

/** The recurring-question-pattern / angle context this run is steering toward — legacy's "recurring question pool" (subreddit-sourcing.md §3), distinct from *which thread* gets replied to. */
export interface RedditSelectedCandidate {
  topic: string;
  source: RedditCandidateSource;
}

/** The one thread this run replies to, selected at workflow step 08 — never chosen by the draft agent itself. */
export interface RedditSelectedThread {
  targetThreadUrl: string;
  targetThreadTitle: string;
  /** Parsed mechanically from `targetThreadUrl`'s `/r/<name>/` segment — never guessed or reused from `targetSubreddits` when the URL says otherwise. */
  targetSubreddit: string;
}

export interface RedditAgentWorkflowResult {
  targetThreadUrl: string;
  targetSubreddit: string;
  topic: string;
  angle: string;
  deliverableId: string;
  /**
   * The same reply text this run's own `15-batch-review` gate showed a human
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
