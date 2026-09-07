import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, parseDurationMs, success, toolingError } from "@agent-engine/tool-common";
import { ScraperError, type ScraperProvider, type SitemapEntry } from "@agent-engine/tool-karos-scraper";
import { extractPageSignals, type PageSignals } from "./html-signals.js";
import { latestRunForQuery, writeRunRecord, type RunRecord } from "./runs.js";

// 1.0.1: archive/listing pages (tag, category, author, pagination) sample last, so the audited eight are content pages.
const TOOL_VERSION = "1.0.1";

/** The one job name every on-page audit records under, so a later run can find the previous snapshot for the body-change comparison. */
export const ON_PAGE_AUDIT_JOB = "on-page-audit";

export const AuditOnPageInputSchema = z.object({
  seedUrl: z.string().min(1).describe("The site to audit — normally the client's own homepage. Always fetched first."),
  candidateUrls: z
    .array(z.string().min(1))
    .max(200)
    .default([])
    .describe("Pages discovered by a crawl (sitemap or link-following) to choose the audited set from. Entity/about, contact, pricing and service pages are preferred, then the rest in order."),
  limit: z.number().int().min(1).max(15).default(8).describe("How many pages to fetch and parse, seed included. Each is one plain GET."),
  sitemapLimit: z.number().int().min(10).max(2000).default(500).describe("How many sitemap entries to read for cluster volume and publishing cadence (freshness bucket)."),
  window: z
    .string()
    .min(1)
    .optional()
    .describe("Freshness window. When set and the latest audit of this seed is younger, that audit is returned instead of refetching. Omitted means always refetch."),
});
export type AuditOnPageInput = z.input<typeof AuditOnPageInputSchema>;

export interface SitemapFreshness {
  /** Entries read (capped by `sitemapLimit`). */
  entryCount: number;
  /** Whether the read stopped at the cap, so `entryCount` is a floor. */
  truncated: boolean;
  entriesWithLastmod: number;
  /** ISO date of the newest `<lastmod>`. */
  newestLastmod?: string;
  /** Longest gap, in days, between consecutive `<lastmod>` dates in the trailing six months. `undefined` with fewer than two dated entries in that window. */
  maxGapDaysTrailing6mo?: number;
  /** Entries whose `<lastmod>` falls in the trailing six months. */
  entriesTrailing6mo: number;
  /** `lastmod` by URL, for consistency checks against on-page `dateModified`. */
  lastmodByUrl: Record<string, string>;
}

export interface OnPageAuditSnapshot {
  seedUrl: string;
  fetchedAt: string;
  pages: PageSignals[];
  /** URLs chosen but not audited, with why (a non-HTML body, a fetch failure). */
  skipped: Array<{ url: string; reason: string }>;
  llmsTxt: { status: number | undefined; present: boolean };
  sitemap?: SitemapFreshness;
  /** Present when a previous audit of this seed exists: which audited pages' main text changed since. */
  changedSince?: { previousAt: string; pagesCompared: number; pagesChanged: number };
}

export interface AuditOnPageResult {
  runId: string;
  snapshot: OnPageAuditSnapshot;
  fromCache: boolean;
  ageMs: number;
}

const ENTITY_PAGE_RE = /\/(about|about-us|company|who-we-are|our-story|team|אודות|עלינו|quienes-somos|sobre|a-propos)(\/|$|\.)/i;
const PRIORITY_PAGE_RE = /\/(contact|pricing|prices|plans|services|products?|solutions|features|faq|צור-קשר|מחירים|שירותים)(\/|$|\.)/i;
/**
 * Archive/listing pages — tag, category, author and paginated indexes. Real
 * URLs, legitimately in a sitemap, but not the pages a reader lands on or an
 * answer engine quotes: a tag page has no byline, no capsule and a 12-character
 * title, and a sample of eight of them says nothing about the site's articles.
 * On a news site whose freshest sitemap entries are its tag pages, the first
 * newest-first audit sampled exactly those and every on-page input collapsed.
 * They stay eligible, at the back of the queue.
 */
const ARCHIVE_PAGE_RE = /\/(tag|tags|category|categories|topic|topics|author|authors|page\/\d+|feed|search|תגית|קטגוריה|נושא)(\/|$|\.)/i;

/** Is this a tag/category/author/paginated listing rather than a content page? Exported for tests. */
export function isArchivePageUrl(url: string): boolean {
  const path = decodedPath(url);
  return path !== undefined && ARCHIVE_PAGE_RE.test(path);
}

/** The URL's path with percent-encoding undone, so a Hebrew `/אודות` matches the same way `/about` does. */
function decodedPath(url: string): string | undefined {
  try {
    const { pathname } = new URL(url);
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  } catch {
    return undefined;
  }
}

/** Is this URL the kind a reader (or an answer engine) uses to learn who the company is? Exported for the measurement layer's GEO-10/GEO-37 legs. */
export function isEntityPageUrl(url: string): boolean {
  const path = decodedPath(url);
  return path !== undefined && ENTITY_PAGE_RE.test(path);
}

/**
 * Picks the audited set: the seed, then entity/about pages, then other
 * priority pages (contact/pricing/services/blog), then the remaining
 * candidates in crawl order — deduplicated on the URL without its fragment.
 */
export function chooseAuditUrls(seedUrl: string, candidateUrls: readonly string[], limit: number): string[] {
  const normalise = (u: string): string | undefined => {
    try {
      const parsed = new URL(u);
      parsed.hash = "";
      return parsed.href;
    } catch {
      return undefined;
    }
  };
  const seed = normalise(seedUrl) ?? seedUrl;
  const seen = new Set<string>([seed, seed.replace(/\/$/, ""), `${seed}/`]);
  const chosen: string[] = [seed];
  const unique: string[] = [];
  for (const candidate of candidateUrls) {
    const n = normalise(candidate);
    if (!n || seen.has(n) || seen.has(n.replace(/\/$/, ""))) continue;
    seen.add(n);
    unique.push(n);
  }
  const isPriority = (u: string): boolean => {
    const path = decodedPath(u);
    return path !== undefined && PRIORITY_PAGE_RE.test(path);
  };
  const rest = unique.filter((u) => !isEntityPageUrl(u) && !isPriority(u));
  const ordered = [
    ...unique.filter(isEntityPageUrl),
    ...unique.filter((u) => !isEntityPageUrl(u) && isPriority(u)),
    ...rest.filter((u) => !isArchivePageUrl(u)),
    ...rest.filter(isArchivePageUrl),
  ];
  for (const u of ordered) {
    if (chosen.length >= limit) break;
    chosen.push(u);
  }
  return chosen;
}

/** Cluster volume and cadence from a sitemap's own `<lastmod>` dates — a real site fetch, not an index estimate. */
export function summariseSitemapFreshness(entries: readonly SitemapEntry[], truncated: boolean, now = Date.now()): SitemapFreshness {
  const lastmodByUrl: Record<string, string> = {};
  const dated: number[] = [];
  for (const entry of entries) {
    if (!entry.lastModified) continue;
    const at = Date.parse(entry.lastModified);
    if (!Number.isFinite(at)) continue;
    lastmodByUrl[entry.url] = entry.lastModified;
    dated.push(at);
  }
  dated.sort((a, b) => a - b);
  const sixMonthsAgo = now - 183 * 86_400_000;
  const trailing = dated.filter((at) => at >= sixMonthsAgo && at <= now + 86_400_000);
  let maxGap: number | undefined;
  if (trailing.length >= 2) {
    maxGap = 0;
    for (let i = 1; i < trailing.length; i++) maxGap = Math.max(maxGap, Math.round((trailing[i]! - trailing[i - 1]!) / 86_400_000));
    // The gap between the newest entry and today counts too: a cluster that went quiet has a cadence problem the entries alone would hide.
    maxGap = Math.max(maxGap, Math.round((now - trailing[trailing.length - 1]!) / 86_400_000));
  }
  const newest = dated.length > 0 ? new Date(dated[dated.length - 1]!).toISOString() : undefined;
  return {
    entryCount: entries.length,
    truncated,
    entriesWithLastmod: dated.length,
    ...(newest ? { newestLastmod: newest } : {}),
    ...(maxGap !== undefined ? { maxGapDaysTrailing6mo: maxGap } : {}),
    entriesTrailing6mo: trailing.length,
    lastmodByUrl,
  };
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * `research.auditOnPage`: fetches a bounded set of a site's pages as plain
 * HTML and extracts the on-page facts the scoring config's `on_page`,
 * `structure`, `extractability`, `evidence`, `freshness`, `multimodal` and
 * `hygiene` buckets need — titles, descriptions, headings and their sections,
 * schema, dates, links, media — plus `/llms.txt` and the sitemap's own
 * `<lastmod>` cadence. Every field is a direct observation of the markup.
 *
 * Reports `not_available` when no scraper with `fetchHtml` is configured, the
 * same rule `research.crawlTechnicalSeo` follows: a placeholder snapshot would
 * let the scorer grade a site nobody fetched.
 *
 * Records every audit as a research run under one job name so the NEXT audit
 * of the same site can compare content hashes and report which pages' body
 * text changed — the `body_changed` leg of GEO-20 that no single fetch can
 * measure.
 */
export function createAuditOnPage(store: WorkspaceStoreLike, scraper?: ScraperProvider) {
  return defineTool<AuditOnPageInput, AuditOnPageResult>({
    name: "research.auditOnPage",
    description:
      "Fetches up to `limit` pages of a site as raw HTML (plain GET, no vendor billing) and extracts on-page SEO/GEO facts: title and meta lengths, robots meta, canonical, headings with per-section word counts and opening capsules, JSON-LD types and Organization sameAs, dateModified, author bylines, internal/external links, images with alt text, numeric stats and attributed quotes, keyword density, Flesch (Latin only), mixed content, plus /llms.txt and sitemap lastmod cadence. Reports not_available when no HTML-capable scraper is configured.",
    version: TOOL_VERSION,
    inputSchema: AuditOnPageInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof AuditOnPageInputSchema>;
      if (scraper === undefined || !scraper.fetchHtml) {
        return notAvailable(
          "research.auditOnPage: no scraper with an HTML fetch capability is configured — set SCRAPPYCOCO_API_KEY (the plain-fetch crawl " +
            "capabilities ride on that provider) so a real on-page audit can run. Refusing to return a placeholder snapshot.",
        );
      }

      // The previous audit of THIS seed — the intel agent audits competitor
      // homepages under the same job, so "latest run" alone could be someone
      // else's site.
      const previousForSeed = await latestRunForQuery(store, ctx.clientSlug, ON_PAGE_AUDIT_JOB, input.seedUrl);
      if (input.window && previousForSeed) {
        const ageMs = Date.now() - previousForSeed.at;
        if (ageMs <= parseDurationMs(input.window)) {
          return success<AuditOnPageResult>({ runId: previousForSeed.runId, snapshot: previousForSeed.result as OnPageAuditSnapshot, fromCache: true, ageMs });
        }
      }

      // With no candidates handed in, discover the site's pages the same way
      // the technical crawl does (sitemap first, then links) — so a caller
      // that runs this in parallel with that crawl needs nothing from it.
      let candidateUrls: readonly string[] = input.candidateUrls;
      if (candidateUrls.length === 0 && scraper.crawlSite) {
        try {
          const crawl = await scraper.crawlSite(input.seedUrl, { limit: 40, timeoutMs: 30_000 });
          candidateUrls = crawl.pages.filter((p) => p.status === 200 || p.status === 0).map((p) => p.url);
        } catch {
          candidateUrls = [];
        }
      }
      const urls = chooseAuditUrls(input.seedUrl, candidateUrls, input.limit);
      const skipped: OnPageAuditSnapshot["skipped"] = [];
      const fetched = await mapWithConcurrency(urls, 3, async (url): Promise<PageSignals | undefined> => {
        try {
          const page = await scraper.fetchHtml!(url, { timeoutMs: 30_000 });
          if (!page) {
            skipped.push({ url, reason: "no HTML body" });
            return undefined;
          }
          return extractPageSignals({ url, finalUrl: page.finalUrl, status: page.status, html: page.html });
        } catch (error) {
          skipped.push({ url, reason: error instanceof ScraperError ? error.message : String(error) });
          return undefined;
        }
      });
      const pages = fetched.filter((p): p is PageSignals => p !== undefined);
      if (pages.length === 0) {
        // The seed itself could not be fetched: that is a broken fetch, not a measured site.
        return toolingError(`research.auditOnPage: none of ${urls.length} page(s) could be fetched as HTML — ${skipped.map((s) => `${s.url}: ${s.reason}`).join("; ")}`);
      }

      let origin: string;
      try {
        origin = new URL(pages[0]!.finalUrl).origin;
      } catch {
        origin = new URL(input.seedUrl).origin;
      }

      let llmsTxt: OnPageAuditSnapshot["llmsTxt"] = { status: undefined, present: false };
      try {
        const llms = await scraper.fetchHtml(`${origin}/llms.txt`, { timeoutMs: 15_000 });
        // A soft-404 that answers 200 with an HTML error page is not an llms.txt.
        const looksLikeText = llms !== undefined && !/<html\b/i.test(llms.html.slice(0, 500)) && llms.html.trim().length > 0;
        llmsTxt = { status: llms?.status, present: llms !== undefined && llms.status === 200 && looksLikeText };
      } catch {
        llmsTxt = { status: undefined, present: false };
      }

      let sitemap: SitemapFreshness | undefined;
      if (scraper.fetchSitemap) {
        try {
          const robotsSitemap = scraper.fetchRobots ? (await scraper.fetchRobots(input.seedUrl, { timeoutMs: 15_000 }))?.sitemaps[0] : undefined;
          const result = await scraper.fetchSitemap(robotsSitemap ?? `${origin}/sitemap.xml`, { timeoutMs: 30_000, limit: input.sitemapLimit });
          if (result) sitemap = summariseSitemapFreshness(result.entries, result.entries.length >= input.sitemapLimit);
        } catch {
          sitemap = undefined;
        }
      }

      let changedSince: OnPageAuditSnapshot["changedSince"];
      if (previousForSeed) {
        const previousPages = (previousForSeed.result as OnPageAuditSnapshot).pages ?? [];
        const previousHashes = new Map(previousPages.map((p) => [p.finalUrl, p.contentHash] as const));
        const compared = pages.filter((p) => previousHashes.has(p.finalUrl));
        if (compared.length > 0) {
          changedSince = {
            previousAt: new Date(previousForSeed.at).toISOString(),
            pagesCompared: compared.length,
            pagesChanged: compared.filter((p) => previousHashes.get(p.finalUrl) !== p.contentHash).length,
          };
        }
      }

      const snapshot: OnPageAuditSnapshot = {
        seedUrl: input.seedUrl,
        fetchedAt: new Date().toISOString(),
        pages,
        skipped,
        llmsTxt,
        ...(sitemap ? { sitemap } : {}),
        ...(changedSince ? { changedSince } : {}),
      };
      const runId = randomUUID();
      const record: RunRecord = { job: ON_PAGE_AUDIT_JOB, runId, query: input.seedUrl, result: snapshot, at: Date.now() };
      await writeRunRecord(store, ctx.clientSlug, record);
      return success<AuditOnPageResult>({ runId, snapshot, fromCache: false, ageMs: 0 });
    },
  });
}
