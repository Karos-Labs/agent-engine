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

/**
 * One HTTP response's status line plus normalised headers — the "is this URL
 * alive, and what did the server actually say" signal a crawl needs before a
 * billed extraction is worth spending on it.
 */
export interface PageStatus {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  /** Final URL after redirects, when it differs from the one requested. */
  readonly redirectedTo?: string;
  /** Header names lower-cased. `x-robots-tag` lives here, not modelled separately. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * One robots.txt rule block, already resolved to a single user-agent.
 *
 * A robots.txt group that lists several `User-agent:` lines above one shared
 * rule set is expanded into one `RobotsRuleGroup` per agent named, so a
 * caller checking "is Googlebot disallowed" never has to re-parse a
 * comma-free multi-agent block itself.
 */
export interface RobotsRuleGroup {
  readonly userAgent: string;
  readonly disallow: readonly string[];
  readonly allow: readonly string[];
}

/** robots.txt for one origin, parsed. */
export interface RobotsInfo {
  /** The robots.txt URL actually fetched. */
  readonly url: string;
  readonly status: number;
  readonly groups: readonly RobotsRuleGroup[];
  /** `Sitemap:` lines, in file order. */
  readonly sitemaps: readonly string[];
}

export interface SitemapEntry {
  readonly url: string;
  /** ISO 8601 `<lastmod>`, when the sitemap carries one. */
  readonly lastModified?: string;
}

/** One `sitemap.xml` (or one leaf of a sitemap index), parsed. */
export interface SitemapResult {
  /** The sitemap URL actually fetched. */
  readonly url: string;
  readonly status: number;
  readonly entries: readonly SitemapEntry[];
  /** Present when `url` was a `<sitemapindex>`: the child sitemap URLs it names, not yet fetched. */
  readonly childSitemaps?: readonly string[];
}

export interface CrawlOptions extends ScrapeOptions {
  /** How many link-hops to follow from the seed when no sitemap is found. 0 = seed page only. Default 1. */
  readonly maxDepth?: number;
  /** Restrict discovered URLs to the seed's origin. Default true. */
  readonly sameOriginOnly?: boolean;
}

export interface CrawlPage {
  readonly url: string;
  /** 0 when the page could not be reached at all (network failure, not an HTTP status). */
  readonly status: number;
}

/** The map of a site: what pages exist and whether each answered. */
export interface SiteCrawlResult {
  readonly seedUrl: string;
  readonly pages: readonly CrawlPage[];
  /** Present when a sitemap was found and used as the page source. */
  readonly sitemap?: SitemapResult;
  /** Present when the seed origin's robots.txt was reachable. */
  readonly robots?: RobotsInfo;
  /** True when `pages` stops short of the full site — hit `limit`, `maxDepth`, or a truncated sitemap. */
  readonly truncated: boolean;
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

  /**
   * Crawl capabilities (T-A1): map a site, and expose the status/headers/
   * robots/sitemap signals SEO and GEO-Readiness measurement (T-A2/T-A3)
   * derive `crawl_snapshot` from. Optional, unlike the five capabilities
   * above: several existing callers construct a `ScraperProvider` literal
   * (`karos-research`'s and `karos-media`'s test fakes among them) without
   * these, and a required method would break every one of them for a
   * capability they never use. `createScrappyCocoScraper` and
   * `createOfflineScraper` both implement all four.
   */

  /** HTTP status + headers for one URL, via HEAD (falling back to GET when a server rejects HEAD). No vendor billing: this is a plain fetch, not a ScrappyCoco execution. */
  fetchStatus?(url: string, options?: ScrapeOptions): Promise<PageStatus | undefined>;

  /** robots.txt for the URL's origin, parsed into per-agent rule groups plus any `Sitemap:` lines. */
  fetchRobots?(url: string, options?: ScrapeOptions): Promise<RobotsInfo | undefined>;

  /** `sitemap.xml` for the URL's origin (or `url` itself, when it already names a sitemap). `undefined` when none is found. */
  fetchSitemap?(url: string, options?: ScrapeOptions): Promise<SitemapResult | undefined>;

  /**
   * Discover the reachable pages of a site from a seed URL. Prefers the
   * site's own sitemap when one resolves (cheaper and more complete than
   * following links); falls back to breadth-first link-following bounded by
   * `options.maxDepth` and `options.limit`.
   */
  crawlSite?(seedUrl: string, options?: CrawlOptions): Promise<SiteCrawlResult>;
}
