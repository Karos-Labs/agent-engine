import type { RedditChannelPlanOutput } from "../agent/reddit-channel-planner-agent.js";
import type { RedditThreadScoutOutput } from "../agent/reddit-thread-scout-agent.js";
import type { DiscoverThreadsResult, FetchThreadResult } from "../tools/reddit-threads.js";

/**
 * The Reddit charter as the workflow reads it: the resolved allowlist plus
 * whatever the charter (recorded from a form, or auto-derived) said about
 * what to look for and how to sound. `source` says which of the three places
 * the allowlist came from, so a trace can tell "the client configured this"
 * from "the engine decided this for them".
 */
export interface RedditCharter {
  /** Bare names, e.g. `marketing`. */
  targetSubreddits: string[];
  /** Words a thread worth replying to would contain. Empty when nothing recorded any. */
  searchKeywords: string[];
  offLimitsTopics: string[];
  voiceNotes?: string;
  disclosureLine?: string;
  source: "client-config" | "charter" | "auto-derived";
  /** True when this run's own auto-setup produced the charter. */
  autoDerived: boolean;
}

export interface RedditIntakeConfig {
  /** Subjects this client does not engage with, carried from the intake read so the terminal guardrail needs no second one. */
  forbiddenTopics: string[];
  charter: RedditCharter;
  requestedTopic?: string;
  requestedSubreddit?: string;
  /**
   * An explicit thread to reply to, supplied by the person dispatching the
   * run (or by client intake config). When present, discovery and the scout
   * are skipped: a person who named a thread has already done the finding.
   */
  requestedThreadUrl?: string;
  /** The requested thread's title, when the caller supplied one. Otherwise read live from the thread itself. */
  requestedThreadTitle?: string;
}

export interface RedditClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
}

/** What the auto-setup step recorded, for the trace. */
export interface RedditAutoSetupOutcome {
  status: "not-needed" | "recorded" | "not-recorded" | "planner-failed";
  plan?: RedditChannelPlanOutput;
  note: string;
}

/** Step 05's output: the live candidate list plus what the scan found per subreddit. */
export type RedditDiscovery = DiscoverThreadsResult & {
  /** How the candidate list was obtained. `requested` means a caller named the thread and no scan ran. */
  mode: "scanned" | "requested";
  /** The keywords the scan ranked against, for the trace. */
  keywords: string[];
};

/** The one thread this run replies to. Selected by the scout (or named by the caller), never by the draft agent itself. */
export interface RedditSelectedThread {
  targetThreadUrl: string;
  targetThreadTitle: string;
  /** Parsed mechanically from `targetThreadUrl`'s `/r/<name>/` segment — never guessed. */
  targetSubreddit: string;
  /** How the thread was chosen. */
  selectedBy: "scout" | "requested";
  /** The scout's reasoning when it chose; absent for a requested thread. */
  scoutBrief?: NonNullable<RedditThreadScoutOutput["selected"]>;
}

/** The thread as fetched live (post body + existing replies), or the title-only fallback when it could not be read. */
export type RedditThreadContext = FetchThreadResult | { url: string; title: string; subreddit: string; body: ""; comments: []; source: "unavailable"; note: string };

export interface RedditAgentWorkflowResult {
  targetThreadUrl: string;
  targetSubreddit: string;
  topic: string;
  angle: string;
  deliverableId: string;
  /**
   * The same reply text this run's own batch-review gate showed a human (or
   * would have, had `autoApprove` not skipped it) — i.e. `draft.text`.
   *
   * Added for SCRUM-302/AU18: campaign-orchestrator runs every channel with
   * `autoApprove: true` and needs something to put in front of its own single
   * campaign-review gate in place of the per-channel gates it bypassed.
   */
  preview: string;
}
