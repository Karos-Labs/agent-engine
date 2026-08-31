import { z } from "zod";
import { defineTool, notAvailable, success, toolingError } from "@agent-engine/tool-common";
import { ScraperError, type RobotsInfo, type ScraperProvider, type SitemapResult } from "@agent-engine/tool-karos-scraper";

const TOOL_VERSION = "1.0.0";

export const CrawlTechnicalSeoInputSchema = z.object({
  seedUrl: z.string().min(1).describe("The site to crawl for technical SEO signals — normally the client's own domain."),
  /** How many discovered pages to individually status-check for headers (noindex/auth). Each costs one extra request beyond the crawl/robots/sitemap fetch, so bounded. */
  limit: z.number().int().min(1).max(50).default(10).describe("How many discovered pages to individually status-check for headers (noindex/auth)."),
});
export type CrawlTechnicalSeoInput = z.input<typeof CrawlTechnicalSeoInputSchema>;

/** One crawled page's real, HTTP-derived facts — never a fabricated pass/fail. */
export interface CrawledPageFacts {
  url: string;
  status: number;
  /** `x-robots-tag` response header contains "noindex" (case-insensitive). `undefined` when headers could not be read for this page at all (never guessed as false). */
  noindex: boolean | undefined;
}

/**
 * The real, HTTP-derived facts a technical-SEO measurement can honestly be
 * built from (T-A1's crawl mechanics — `@agent-engine/tool-karos-scraper`'s
 * `ScraperProvider.crawlSite`/`fetchRobots`/`fetchStatus` — wired up here as
 * a tool for the first time; T-A1 built the mechanics, not the wiring).
 * Every field is either a directly-observed HTTP fact or `undefined`/absent
 * when it genuinely could not be observed — never a fabricated pass.
 */
export interface TechnicalSeoSnapshot {
  seedUrl: string;
  robots?: RobotsInfo;
  sitemap?: SitemapResult;
  pages: CrawledPageFacts[];
  /** True when the discovered-page list stops short of the full site (T-A1's `SiteCrawlResult.truncated`, or this tool's own `limit` on top of it). */
  truncated: boolean;
}

export interface CrawlTechnicalSeoResult {
  runId: string;
  snapshot: TechnicalSeoSnapshot;
}

function noindexFromHeaders(headers: Readonly<Record<string, string>> | undefined): boolean | undefined {
  if (!headers) return undefined;
  const value = headers["x-robots-tag"];
  if (value === undefined) return false; // header absent is a real, observed fact: no noindex directive was sent.
  return value.toLowerCase().includes("noindex");
}

/**
 * `research.crawlTechnicalSeo` (T-A2/SCRUM-236): the tool `measurements.ts`
 * was missing — T-A1 built the crawl CAPABILITY (`ScraperProvider`'s
 * `crawlSite`/`fetchRobots`/`fetchSitemap`/`fetchStatus`) but nothing wired
 * it up as a callable tool yet. This is that wiring, not a second crawler:
 * every fact below comes from one of those four T-A1 methods, never
 * re-implemented here.
 *
 * Reports `not_available` (never a placeholder snapshot) when no scraper is
 * configured, or when the configured scraper doesn't implement the crawl
 * capabilities at all (both optional on `ScraperProvider` — see that
 * interface's own doc comment) — same rule `research.pull` already
 * established: an agent that would otherwise draft/score from nothing must
 * be told why, not handed a payload that quietly means nothing.
 */
export function createCrawlTechnicalSeo(scraper?: ScraperProvider) {
  return defineTool<CrawlTechnicalSeoInput, CrawlTechnicalSeoResult>({
    name: "research.crawlTechnicalSeo",
    description:
      "Crawls a site for real technical-SEO signals (robots.txt, sitemap.xml, per-page HTTP status + x-robots-tag) via the configured scraper's T-A1 crawl capabilities. Reports not_available naming the missing credential/capability when no scraper (or a scraper without crawl support) is configured, rather than a placeholder snapshot.",
    version: TOOL_VERSION,
    inputSchema: CrawlTechnicalSeoInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof CrawlTechnicalSeoInputSchema>;
      const { seedUrl, limit } = input;

      if (scraper === undefined) {
        return notAvailable(
          "research.crawlTechnicalSeo: no scraper is configured — set SCRAPPYCOCO_API_KEY so a real technical-SEO crawl can run " +
            "(see packages/tools/karos-research/README.md). Refusing to return a placeholder snapshot.",
        );
      }
      if (!scraper.crawlSite || !scraper.fetchRobots) {
        return notAvailable(
          `research.crawlTechnicalSeo: the configured scraper ("${scraper.name}") does not implement the T-A1 crawl capabilities ` +
            "(crawlSite/fetchRobots) — refusing to return a placeholder snapshot.",
        );
      }

      let crawl: Awaited<ReturnType<NonNullable<ScraperProvider["crawlSite"]>>>;
      let robots: RobotsInfo | undefined;
      try {
        [crawl, robots] = await Promise.all([scraper.crawlSite(seedUrl, { limit }), scraper.fetchRobots(seedUrl)]);
      } catch (error) {
        if (error instanceof ScraperError) return toolingError(error.message);
        throw error;
      }

      const candidatePages = crawl.pages.slice(0, limit);
      const pages: CrawledPageFacts[] = [];
      for (const page of candidatePages) {
        if (scraper.fetchStatus) {
          try {
            const withHeaders = await scraper.fetchStatus(page.url);
            pages.push({ url: page.url, status: withHeaders?.status ?? page.status, noindex: noindexFromHeaders(withHeaders?.headers) });
            continue;
          } catch {
            // A single page's status re-check failing is not a crawl failure — fall through to the crawl's own status, headers unknown.
          }
        }
        pages.push({ url: page.url, status: page.status, noindex: undefined });
      }

      const snapshot: TechnicalSeoSnapshot = {
        seedUrl,
        ...(robots ? { robots } : {}),
        ...(crawl.sitemap ? { sitemap: crawl.sitemap } : {}),
        pages,
        truncated: crawl.truncated || crawl.pages.length > limit,
      };

      return success<CrawlTechnicalSeoResult>({ runId: `crawl-${ctx.clientSlug}-${Date.now()}`, snapshot });
    },
  });
}
