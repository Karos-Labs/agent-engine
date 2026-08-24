/**
 * The shape `research.pull` persists verbatim and hands to every extraction
 * agent.
 *
 * Two halves, deliberately kept apart in the payload rather than blended:
 * `documents` is what the open web says right now, `history` is what this
 * client has already published. An extraction agent needs the first to have
 * anything to say and the second to avoid saying it again, and a model given
 * one merged list cannot tell which is which.
 */

/** One live source, in the shape a claim can be traced back to. */
export interface ResearchDocument {
  readonly title: string;
  readonly url: string;
  readonly description?: string;
  /** Page text, truncated. The substance a claim is drawn from. */
  readonly content?: string;
  /** ISO 8601 where the source reports it. Feeds a claim's `date`. */
  readonly publishedAt?: string;
  readonly author?: string;
}

/** One thing this client already published, for anti-repetition. */
export interface ResearchHistoryPost {
  /** Where it came from: `output-history` for our own ledger, or a platform name when scraped. */
  readonly origin: string;
  readonly excerpt: string;
  readonly recordedAt?: string;
  readonly url?: string;
  /** Present for scraped posts, so a model can tell what actually landed. */
  readonly engagement?: { readonly likes?: number; readonly comments?: number; readonly views?: number };
}

export interface ResearchHistory {
  /** Prior deliverables from this agent's own excerpt ledger. */
  readonly priorPosts: ResearchHistoryPost[];
  /** Topics already covered, for a topic picker to steer around. */
  readonly priorTopics: string[];
  /** Set when history was requested but could not be read, so an empty list is never mistaken for a clean slate. */
  readonly note?: string;
}

export interface ResearchPayload {
  /** Which scraper answered. Recorded so a stale run is attributable. */
  readonly provider: string;
  readonly query: string;
  /** ISO 8601. The extraction agent needs a real date to attach to claims. */
  readonly fetchedAt: string;
  readonly documents: ResearchDocument[];
  /** Omitted entirely when the caller asked for no history, rather than present-and-empty. */
  readonly history?: ResearchHistory;
  /** Set when the scraper answered but found nothing, so empty is never mistaken for broken. */
  readonly note?: string;
}

/**
 * Per-document content ceiling.
 *
 * This payload is injected whole into an extraction agent's prompt, so its size
 * is a token bill on every research-backed run. A few thousand characters is
 * plenty to pull a sourced claim from; a full article is mostly navigation
 * chrome and footer.
 */
export const DEFAULT_CONTENT_CHARS = 4000;

/** How much of a past deliverable to carry. Enough to recognise a repeat, not enough to re-read the post. */
export const HISTORY_EXCERPT_CHARS = 600;

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n\n[truncated at ${max} characters]` : value;
}
