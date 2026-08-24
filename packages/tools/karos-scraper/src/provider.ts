/**
 * The generic scraping seam.
 *
 * One interface, four jobs the engine actually needs done: pull one URL, search
 * the open web, read an account's posting history, and get raw bytes/text back
 * from a page. Everything above this line (research, image sourcing, intake)
 * talks to `ScraperProvider`; nothing above it names a vendor.
 *
 * ## Why a seam rather than calling ScrappyCoco directly
 *
 * This engine has already paid for the alternative twice. `karos-media`
 * shipped with one hardcoded image provider and prep held every Instagram run
 * when its key went unprovisioned; `research.pull` shipped with a stand-in and
 * every content agent quietly drafted from nothing. Both were one-line
 * decisions that became architecture. A provider interface with a factory is
 * the cheapest available insurance against the third repetition.
 */

/** Which social network an account-history request targets. Mirrors the capability sources the provider exposes. */
export type SocialPlatform = "x" | "instagram" | "reddit" | "tiktok";

/**
 * One scraped item, normalised across every capability.
 *
 * The field set is deliberately the intersection of what the engine consumes,
 * not the union of what a vendor returns: a research claim needs `url` +
 * `publishedAt` to be citable, image sourcing needs `imageUrls`, and
 * anti-repetition needs `text` + `publishedAt`. Vendor-specific extras stay in
 * `raw` rather than widening this shape.
 */
export interface ScrapedRecord {
  /** Stable identity for dedupe. The canonical URL when there is one. */
  readonly id: string;
  readonly url: string;
  readonly title?: string;
  /** Main text content. What a fact is actually drawn from. */
  readonly text?: string;
  /** ISO 8601 when the provider reports it. A claim's date depends on this. */
  readonly publishedAt?: string;
  readonly author?: string;
  /** Direct image URLs carried by the item. Feeds the visual pipeline's scrape tier. */
  readonly imageUrls?: readonly string[];
  /** Likes/comments/views where the source has them. Signals which past posts landed. */
  readonly engagement?: { readonly likes?: number; readonly comments?: number; readonly views?: number };
  /** Which capability produced this, e.g. `web.search_web`. Recorded for audit. */
  readonly capability?: string;
  /** The untouched provider payload, for anything this interface deliberately does not model. */
  readonly raw?: unknown;
}

export interface ScrapeOptions {
  /** Max records to return. Providers are billed per call, so callers state a real bound. */
  readonly limit?: number;
  /** Per-request ceiling. Below the caller's own step budget. */
  readonly timeoutMs?: number;
}

export interface SearchOptions extends ScrapeOptions {
  /** ISO country code, when the provider supports geo-scoping a search. */
  readonly country?: string;
  /** Restrict results to these domains. */
  readonly includeDomains?: readonly string[];
}

export interface SocialHistoryRequest extends ScrapeOptions {
  readonly platform: SocialPlatform;
  /** Handle without a leading `@`. */
  readonly username: string;
}

/** Raw page bytes/markup, for callers that want to parse it themselves. */
export interface RawPage {
  readonly url: string;
  /** Markdown or plain text rendering of the page. */
  readonly text?: string;
  /** Original HTML when the provider returns it. */
  readonly html?: string;
  readonly title?: string;
}

/**
 * Thrown for a provider-side failure the caller should surface as
 * `tooling_error`.
 *
 * The distinction this type exists to protect: a provider that *broke* is not
 * a query that legitimately found nothing. Collapsing the two is what let a
 * dead research pipeline read as a topic with nothing to say about it.
 */
export class ScraperError extends Error {
  constructor(
    message: string,
    /** Set when the failure came back as an HTTP status, so callers can distinguish auth from quota from outage. */
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ScraperProvider {
  readonly name: string;

  /** Pull one URL and return its content as a record. */
  extractUrl(url: string, options?: ScrapeOptions): Promise<ScrapedRecord | undefined>;

  /** Search the open web by keyword. An empty array is a valid answer, not an error. */
  searchKeyword(query: string, options?: SearchOptions): Promise<ScrapedRecord[]>;

  /** Recent posts for one social account, newest first where the provider orders them. */
  socialHistory(request: SocialHistoryRequest): Promise<ScrapedRecord[]>;

  /** Raw HTML/text for a URL, for callers doing their own parsing. */
  fetchRaw(url: string, options?: ScrapeOptions): Promise<RawPage | undefined>;

  /**
   * Search a social platform by keyword. Not part of the four core methods,
   * but the visual pipeline's scrape tier needs it and every implementation of
   * this interface can already do it, so it is declared rather than
   * back-doored through `raw`.
   */
  searchSocial(platform: SocialPlatform, query: string, options?: ScrapeOptions): Promise<ScrapedRecord[]>;
}
