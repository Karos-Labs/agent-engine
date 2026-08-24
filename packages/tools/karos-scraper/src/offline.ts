import type { RawPage, ScrapedRecord, ScraperProvider, SocialHistoryRequest, SocialPlatform } from "./provider.js";

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
  };
}
