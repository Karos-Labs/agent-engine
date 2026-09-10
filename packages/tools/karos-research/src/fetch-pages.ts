import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, parseDurationMs, success, toolingError } from "@agent-engine/tool-common";
import { ScraperError, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { truncate } from "./payload.js";
import { latestRunForQuery, writeRunRecord, type RunRecord } from "./runs.js";

// 1.0.0 — new (2026-09, Instagram Phase 1 item H): read the pages a caller
// already knows the URLs of, rather than searching for them.
const TOOL_VERSION = "1.0.0";

/** How much of one page travels by default. See the schema field for why this is a token bill, not a completeness setting. */
export const DEFAULT_PAGE_CHARS = 8000;

/** Named cache job for this tool's records, alongside `research.pull`'s and `research.socialHistory`'s. */
const JOB = "page-fetch";

/**
 * At most four URLs per call. Each is one billed vendor execution, and every
 * caller of this tool so far names three or fewer (a client's home, about and
 * pricing pages; a report PDF and the article that cites it). A caller that
 * wants a whole site wants `research.crawlTechnicalSeo`, not this.
 */
const MAX_URLS = 4;

export const FetchPagesInputSchema = z.object({
  urls: z
    .array(z.string().url())
    .min(1)
    .max(MAX_URLS)
    .describe("The page URLs to read, at most four. Each is one billed scrape per cache window; duplicates in one call are read once."),
  maxChars: z
    .number()
    .int()
    .min(1000)
    .max(12_000)
    .default(DEFAULT_PAGE_CHARS)
    .describe(
      "Per-page content ceiling. The pages are injected whole into a prompt, so this is a token bill as much as a completeness setting; a page longer than this is truncated with a marker saying so.",
    ),
  window: z
    .string()
    .min(1)
    .default("7d")
    .describe(
      "Freshness window — a page read inside it is served from the cache instead of re-scraped. A company's own about page does not change weekly, and the brief that reads it refreshes monthly.",
    ),
});
export type FetchPagesInput = z.input<typeof FetchPagesInputSchema>;

export interface FetchedPage {
  url: string;
  title?: string;
  /** The page's main text, truncated to `maxChars`. */
  text: string;
  fetchedAt: string;
  fromCache: boolean;
}

export interface FetchPagesResult {
  pages: FetchedPage[];
  /** URLs that could not be read, named — one dead link must not hide behind "the site was unavailable". */
  problems: string[];
}

/** What one cached page read stores. `maxChars` is part of the record because the text is already truncated to it — see `servableFromCache`. */
interface CachedPage {
  url: string;
  title?: string;
  text: string;
  fetchedAt: string;
  maxChars: number;
}

/**
 * Two URLs are the same page when they differ only in a trailing slash or in
 * surrounding whitespace. Nothing cleverer: query strings, fragments and
 * `www.` prefixes genuinely address different content often enough that
 * normalising them away would serve the wrong page from the cache, which is a
 * worse failure than one extra scrape.
 */
function cacheKey(url: string): string {
  return url.trim().replace(/\/+$/u, "");
}

/**
 * One record per URL, forever: the run id is a hash of the cache key rather
 * than a timestamp or a UUID, so re-reading a page after its window replaces
 * its own record instead of adding one. A URL is not a path segment (it
 * carries `/` and `:`, which `sanitizeSegment` refuses), and a timestamped id
 * would both grow the store without bound and, for two calls landing in the
 * same millisecond, let one URL's record overwrite another's.
 */
function recordId(key: string): string {
  return `${JOB}-${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * A cached page is servable only when it was fetched with AT LEAST as much
 * content as this caller asked for. The stored `text` is already truncated,
 * so a record taken at 4000 characters cannot answer an 8000-character
 * request — it would look like a complete page that simply ends early, and
 * the caller has no way to tell. The reverse is fine: a larger record is
 * re-truncated on the way out.
 */
function servableFromCache(cached: CachedPage, maxChars: number): boolean {
  return cached.maxChars >= maxChars;
}

/**
 * `research.fetchPages` — read the pages whose URLs are already known.
 *
 * ## Why this is not `research.pull`
 *
 * `research.pull` asks a question and gets back whatever a keyword index
 * returns. Several callers do not have a question; they have addresses. The
 * Instagram Client Brief agent needs the client's OWN site (home, about,
 * pricing) to write what the client sells, and the deep-research step needs
 * the report a secondary article is citing rather than the article. Searching
 * for a URL you already hold is both a worse read (the index may not carry
 * that page at all) and a billed one.
 *
 * So this is the fourth `ScraperProvider` capability — `extractUrl` — given a
 * tool of its own. No new vendor, no new credential: the same ScrappyCoco
 * seam every other research read goes through, and `not_available` (never a
 * placeholder) when none is configured.
 *
 * ## Cache and failure posture
 *
 * Cached PER URL, not per call, in the same `research/<job>/runs` store as
 * every other research read — so the brief agent's read of `acme.test/about`
 * costs nothing when the deep-research step wants the same page an hour
 * later, and a three-URL call where one page is already warm scrapes one page
 * rather than three.
 *
 * A single unreadable URL is a named `problem` and the other pages still come
 * back, exactly like `research.socialHistory`'s per-account rule: a typo in
 * one URL must not cost a caller the two pages that worked. Every URL failing
 * is different — that is an outage or a blocked domain, not "this site has no
 * about page" — and reports `tooling_error` so the caller can tell the two
 * apart.
 */
export function createFetchPages(store: WorkspaceStoreLike, scraper?: ScraperProvider) {
  return defineTool<FetchPagesInput, FetchPagesResult>({
    name: "research.fetchPages",
    description:
      "Read the text of up to four pages whose URLs are already known (a client's own site, a report a source cites), via the configured scraper's page extraction. Cached per URL inside `window`, so repeated reads of the same page across steps and runs cost one scrape. Reports not_available when no scraper is configured; a single unreadable URL is a named problem, never a failed call.",
    version: TOOL_VERSION,
    inputSchema: FetchPagesInputSchema,
    async execute(rawInput, { ctx }) {
      // `defineTool` already parsed this against the schema above (defaults
      // applied) — same note as `research.pull`'s own cast.
      const input = rawInput as z.output<typeof FetchPagesInputSchema>;
      const { maxChars } = input;
      const windowMs = parseDurationMs(input.window);

      // Deduped in call order: a caller assembling URLs from a profile field
      // and a document can legitimately hand us the same page twice, and
      // paying for it twice is the kind of waste this cache exists to stop.
      const urls: string[] = [];
      for (const url of input.urls) {
        const key = cacheKey(url);
        if (!urls.some((u) => cacheKey(u) === key)) urls.push(url.trim());
      }

      const pages: FetchedPage[] = [];
      const problems: string[] = [];
      let attemptedScrapes = 0;

      for (const url of urls) {
        const key = cacheKey(url);
        const cached = await latestRunForQuery(store, ctx.clientSlug, JOB, key);
        if (cached && Date.now() - cached.at <= windowMs) {
          const record = cached.result as CachedPage;
          if (servableFromCache(record, maxChars)) {
            pages.push({
              url: record.url,
              ...(record.title ? { title: record.title } : {}),
              text: truncate(record.text, maxChars),
              fetchedAt: record.fetchedAt,
              fromCache: true,
            });
            continue;
          }
        }

        if (scraper === undefined) {
          // Reported once for the whole call, not per URL: the missing
          // credential is one fact about the deployment, and four copies of
          // it in `problems` would read like four broken pages.
          return notAvailable<FetchPagesResult>(
            "research.fetchPages: no scraper is configured — set SCRAPPYCOCO_API_KEY so pages can be read (see packages/tools/karos-research/README.md). " +
              "Refusing to return a placeholder page: a brief written from one describes the missing data instead of the client.",
          );
        }

        attemptedScrapes += 1;
        try {
          const record = await scraper.extractUrl(url);
          const text = (record?.text ?? "").trim();
          if (record === undefined || text.length === 0) {
            // A 200 with no extractable body: the URL resolved and there is
            // still nothing to read from it (a JS-only page, a login wall, an
            // image-only PDF). Named as such rather than stored as an empty
            // page, which would cache "this client has no about page".
            problems.push(`${url} returned no readable text (the page resolved but carried no extractable body)`);
            continue;
          }
          const fetchedAt = new Date().toISOString();
          const stored: CachedPage = {
            url: record.url || url,
            ...(record.title ? { title: record.title } : {}),
            // Stored at the size actually fetched, and `servableFromCache`
            // decides whether a later, larger request may reuse it.
            text: truncate(text, maxChars),
            fetchedAt,
            maxChars,
          };
          await writeRunRecord(store, ctx.clientSlug, {
            job: JOB,
            runId: recordId(key),
            query: key,
            result: stored,
            at: Date.now(),
          } satisfies RunRecord);
          pages.push({
            url: stored.url,
            ...(stored.title ? { title: stored.title } : {}),
            text: stored.text,
            fetchedAt,
            fromCache: false,
          });
        } catch (error) {
          if (error instanceof ScraperError) {
            problems.push(`could not read ${url}: ${error.message}`);
            continue;
          }
          throw error;
        }
      }

      // Every page we actually tried to scrape failed: an outage or a blocked
      // domain, not a set of pages that happen to be empty. Same rule as
      // `research.socialHistory`'s all-accounts-failed case — and gated on
      // `attemptedScrapes` so a call served entirely from a cache of one
      // earlier failure can never report it as an outage.
      if (pages.length === 0 && attemptedScrapes > 0 && problems.length === attemptedScrapes) {
        return toolingError<FetchPagesResult>(`research.fetchPages: no page could be read — ${problems.join("; ")}`);
      }

      return success<FetchPagesResult>({ pages, problems });
    },
  });
}
