import type {
  CrawlOptions,
  PageStatus,
  RawHtmlPage,
  RawPage,
  RobotsInfo,
  ScrapedRecord,
  ScraperProvider,
  SiteCrawlResult,
  SitemapResult,
  SocialHistoryRequest,
  SocialPlatform,
} from "./provider.js";

/**
 * A deterministic, network-free `ScraperProvider` for tests and local
 * development.
 *
 * ## Read this before using it anywhere near production
 *
 * This is NOT a fallback. `createScraperProvider` will never return it, from
 * any environment, and nothing in `apps/` constructs it. It exists only to be
 * passed explicitly, by a caller that has decided it wants synthetic data.
 *
 * That restriction is the whole point. `research.pull` previously shipped with
 * exactly this sort of object wired in as its default, and the result was that
 * every content agent in the engine drafted from synthetic data for months
 * while nothing errored — prep run pubsub-21066191524607951 ended with a
 * client-facing carousel titled "This carousel couldn't be written yet",
 * because the extraction agent correctly reported the only fact it had. A
 * convenience default is how that happened. So this one is opt-in only, and
 * every record it emits says out loud that it is synthetic, so that if it ever
 * does leak into a real run the output accuses itself immediately rather than
 * looking like thin research.
 */
export function createOfflineScraper(options: { documentsPerQuery?: number } = {}): ScraperProvider {
  const perQuery = options.documentsPerQuery ?? 2;

  const record = (query: string, index: number, kind: string): ScrapedRecord => ({
    id: `offline:${kind}:${query}:${index}`,
    url: `https://offline.test/${encodeURIComponent(query)}/${index}`,
    title: `Offline ${kind} result ${index + 1} for "${query}"`,
    // Stated in the body, not only the URL: this is the field an extraction
    // agent reads, so this is where the warning has to live.
    text:
      `SYNTHETIC TEST DATA - not a real source. Generated offline for the query "${query}". ` +
      `Any figure below is fabricated and must never reach a client deliverable.`,
    publishedAt: "2026-01-01T00:00:00.000Z",
    author: "offline-fixture",
    capability: kind,
  });

  return {
    name: "offline-fixture",

    async searchKeyword(query: string, opts = {}): Promise<ScrapedRecord[]> {
      const limit = opts.limit ?? perQuery;
      return Array.from({ length: Math.min(limit, perQuery) }, (_, i) => record(query, i, "search_web"));
    },

    async extractUrl(url: string): Promise<ScrapedRecord | undefined> {
      return { ...record(url, 0, "extract_content"), url };
    },

    async socialHistory(request: SocialHistoryRequest): Promise<ScrapedRecord[]> {
      const limit = request.limit ?? perQuery;
      return Array.from({ length: Math.min(limit, perQuery) }, (_, i) => ({
        ...record(`${request.platform}/${request.username}`, i, "account_posts"),
        engagement: { likes: 10 + i, comments: i },
      }));
    },

    async searchSocial(platform: SocialPlatform, query: string, opts = {}): Promise<ScrapedRecord[]> {
      const limit = opts.limit ?? perQuery;
      return Array.from({ length: Math.min(limit, perQuery) }, (_, i) => ({
        ...record(query, i, `${platform}.search_posts`),
        // No imageUrls: a fixture must not hand the visual pipeline a URL it
        // would then try to download over a network the test does not have.
      }));
    },

    async fetchRaw(url: string): Promise<RawPage | undefined> {
      return { url, title: `Offline page for ${url}`, text: "SYNTHETIC TEST DATA - not a real page." };
    },

    // Crawl capabilities (T-A1). Deterministic and network-free, same as
    // every other method here: a fixed, self-labelled shape rather than a
    // real crawl, so a run using this provider by mistake is obvious from the
    // data itself.

    async fetchStatus(url: string): Promise<PageStatus | undefined> {
      return { url, status: 200, ok: true, headers: { "content-type": "text/html; charset=offline-fixture" } };
    },

    async fetchHtml(url: string): Promise<RawHtmlPage | undefined> {
      // A well-formed, self-labelled page so an on-page audit run against this
      // fixture measures real structure (title, description, one H1, sectioned
      // H2s, JSON-LD, links) without pretending to be a real site.
      const origin = new URL(url).origin;
      const jsonLd = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": `${origin}/#org`,
        name: "Acme Corp",
        url: origin,
        sameAs: [],
        dateModified: "2026-01-01T00:00:00.000Z",
      });
      const filler = (sentence: string, times: number) => Array.from({ length: times }, () => sentence).join(" ");
      const html = [
        '<!doctype html><html lang="en"><head>',
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>Offline fixture page for SEO audits - Acme</title>",
        '<meta name="description" content="SYNTHETIC TEST DATA: a deterministic fixture page used by the offline scraper so on-page audits have real structure to measure, never a real site.">',
        `<link rel="canonical" href="${url}">`,
        '<meta property="article:modified_time" content="2026-01-01T00:00:00.000Z">',
        '<meta name="author" content="Offline Fixture">',
        `<script type="application/ld+json">${jsonLd}</script>`,
        "</head><body><main>",
        "<h1>Offline fixture page</h1>",
        "<p>Acme Corp is a synthetic test company used by the offline scraper fixture. This opening paragraph gives the page a short self-contained answer so extractability checks have something real to measure, and it is deliberately kept between forty and sixty words long for exactly that reason.</p>",
        "<h2>What does this fixture measure?</h2>",
        `<p>${filler("It measures headings, word counts, internal links and structured data in a deterministic way, with 3 sample figures like 42% to count.", 9)}</p>`,
        "<h2>Why is it synthetic?</h2>",
        `<p>${filler("Because a test must never depend on the network, we generate this body offline every time.", 11)} According to the fixture author, "this page is synthetic". <a href="${origin}/offline-page-0">internal</a> <a href="${origin}/offline-page-1">another</a> <a href="${origin}/about">about</a> <a href="https://example.org/source">source</a> <a href="https://example.com/study">study</a> <a href="https://example.net/report">report</a></p>`,
        `<img src="${origin}/fixture.png" alt="fixture image">`,
        "</main></body></html>",
      ].join("");
      return { url, finalUrl: url, status: 200, headers: { "content-type": "text/html; charset=offline-fixture" }, html };
    },

    async fetchRobots(url: string): Promise<RobotsInfo | undefined> {
      const origin = new URL(url).origin;
      return {
        url: `${origin}/robots.txt`,
        status: 200,
        groups: [{ userAgent: "*", disallow: [], allow: [] }],
        sitemaps: [`${origin}/sitemap.xml`],
      };
    },

    async fetchSitemap(url: string, opts = {}): Promise<SitemapResult | undefined> {
      const origin = new URL(url).origin;
      const count = Math.min(opts.limit ?? perQuery, perQuery);
      return {
        url: `${origin}/sitemap.xml`,
        status: 200,
        entries: Array.from({ length: count }, (_, i) => ({
          url: `${origin}/offline-page-${i}`,
          lastModified: "2026-01-01T00:00:00.000Z",
        })),
      };
    },

    async crawlSite(seedUrl: string, options: CrawlOptions = {}): Promise<SiteCrawlResult> {
      const origin = new URL(seedUrl).origin;
      const count = Math.min(options.limit ?? perQuery, perQuery);
      const sitemap = await this.fetchSitemap!(seedUrl, { limit: count });
      const robots = await this.fetchRobots!(seedUrl);
      return {
        seedUrl,
        pages: [
          { url: seedUrl, status: 200 },
          ...(sitemap?.entries ?? []).map((entry) => ({ url: entry.url, status: 200 })),
        ],
        ...(sitemap ? { sitemap } : {}),
        ...(robots ? { robots } : {}),
        truncated: false,
      };
    },
  };
}
