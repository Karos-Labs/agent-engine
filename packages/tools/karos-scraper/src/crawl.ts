import { ScraperError } from "./provider.js";
import type {
  CrawlOptions,
  CrawlPage,
  PageStatus,
  RobotsInfo,
  RobotsRuleGroup,
  SiteCrawlResult,
  SitemapEntry,
  SitemapResult,
} from "./provider.js";

/**
 * Plain-fetch crawl mechanics (T-A1), shared by every `ScraperProvider`
 * implementation that wants them.
 *
 * ## Why plain `fetch` rather than a ScrappyCoco execution
 *
 * A status check, a `robots.txt`, and a `sitemap.xml` are public,
 * unauthenticated documents — there is no vendor capability to buy here, and
 * routing them through `POST /scrapers/execute` would bill per call for data
 * a bare `fetch` already returns. `createScrappyCocoScraper` wires these
 * functions in directly against its own injected `fetchImpl`, so a test still
 * controls every network call the same way it controls `execute()`.
 */

function originOf(url: string): string {
  return new URL(url).origin;
}

async function getText(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ status: number; body: string } | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ScraperError(`crawl fetch of ${url} failed: ${(error as Error).message}`);
  }
  const body = await response.text();
  return { status: response.status, body };
}

/** HEAD, falling back to GET when a server 405/501s a HEAD it will happily answer as GET. */
export async function fetchPageStatus(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<PageStatus> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 405 || response.status === 501) {
      response = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    }
  } catch (error) {
    throw new ScraperError(`crawl status check for ${url} failed: ${(error as Error).message}`);
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    url,
    status: response.status,
    ok: response.ok,
    ...(response.url && response.url !== url ? { redirectedTo: response.url } : {}),
    headers,
  };
}

/**
 * Parses a `robots.txt` body into per-agent rule groups.
 *
 * A block naming several agents above one shared rule set (`User-agent: a` /
 * `User-agent: b` / `Disallow: /x`) is expanded into one `RobotsRuleGroup`
 * per agent, each carrying the same rules — the de-facto grouping semantics
 * (RFC 9309 §2.1): consecutive `User-agent` lines with no rule line between
 * them belong to the same block; a `User-agent` line seen after a rule line
 * starts a new block.
 */
export function parseRobotsTxt(url: string, status: number, body: string): RobotsInfo {
  const groups: RobotsRuleGroup[] = [];
  const sitemaps: string[] = [];

  let pendingAgents: string[] = [];
  let disallow: string[] = [];
  let allow: string[] = [];
  let blockHasRules = false;

  const flush = () => {
    for (const userAgent of pendingAgents) {
      groups.push({ userAgent, disallow: [...disallow], allow: [...allow] });
    }
    pendingAgents = [];
    disallow = [];
    allow = [];
    blockHasRules = false;
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (blockHasRules) flush();
      pendingAgents.push(value);
    } else if (key === "disallow") {
      if (pendingAgents.length === 0) continue;
      blockHasRules = true;
      // An empty value means "disallow nothing" and contributes no rule.
      if (value) disallow.push(value);
    } else if (key === "allow") {
      if (pendingAgents.length === 0) continue;
      blockHasRules = true;
      if (value) allow.push(value);
    } else if (key === "sitemap") {
      sitemaps.push(value);
    }
  }
  flush();

  return { url, status, groups, sitemaps };
}

/**
 * Whether `path` is disallowed for `userAgent` (default `*`), by the
 * longest-matching-rule-wins rule most crawlers apply.
 *
 * Deliberately does NOT implement `*`/`$` wildcard patterns — every rule this
 * repo's own scoring config checks (`Disallow: /admin`, `Sitemap:` presence)
 * is a plain path prefix. A caller that needs wildcard matching has the raw
 * `groups` to build it from.
 */
export function isPathDisallowed(info: RobotsInfo, path: string, userAgent = "*"): boolean {
  const named = info.groups.filter((g) => g.userAgent.toLowerCase() === userAgent.toLowerCase());
  const applicable = named.length > 0 ? named : info.groups.filter((g) => g.userAgent === "*");
  if (applicable.length === 0) return false;

  let best: { length: number; allowed: boolean } = { length: -1, allowed: true };
  for (const group of applicable) {
    for (const rule of group.disallow) {
      if (rule.length > best.length && path.startsWith(rule)) best = { length: rule.length, allowed: false };
    }
    for (const rule of group.allow) {
      if (rule.length > best.length && path.startsWith(rule)) best = { length: rule.length, allowed: true };
    }
  }
  return !best.allowed;
}

const LOC_GLOBAL_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const URL_ENTRY_RE = /<url>([\s\S]*?)<\/url>/gi;

/** Parses a `sitemap.xml` body, handling both a `<urlset>` and a `<sitemapindex>`. */
export function parseSitemapXml(url: string, status: number, xml: string): SitemapResult {
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const childSitemaps = [...xml.matchAll(LOC_GLOBAL_RE)].map((m) => m[1]!.trim());
    return { url, status, entries: [], childSitemaps };
  }

  const urlBlocks = [...xml.matchAll(URL_ENTRY_RE)];
  const entries: SitemapEntry[] =
    urlBlocks.length > 0
      ? urlBlocks
          .map((block): SitemapEntry | undefined => {
            // Non-global matches: no `lastIndex` state to reset between calls.
            const loc = block[1]!.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i);
            if (!loc) return undefined;
            const lastmod = block[1]!.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i);
            return { url: loc[1]!.trim(), ...(lastmod ? { lastModified: lastmod[1]!.trim() } : {}) };
          })
          .filter((e): e is SitemapEntry => e !== undefined)
      : // No <url> wrapper found (a non-conformant but not uncommon sitemap): fall back to every <loc> in the document.
        [...xml.matchAll(LOC_GLOBAL_RE)].map((m) => ({ url: m[1]!.trim() }));

  return { url, status, entries };
}

/** Fetches and parses `robots.txt` for `url`'s origin. `undefined` only on a genuinely empty response (see `getText`'s callers for the network-failure path, which throws instead). */
export async function fetchRobotsViaFetch(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<RobotsInfo | undefined> {
  const robotsUrl = `${originOf(url)}/robots.txt`;
  const result = await getText(robotsUrl, fetchImpl, timeoutMs);
  if (!result) return undefined;
  return parseRobotsTxt(robotsUrl, result.status, result.body);
}

const MAX_SITEMAP_INDEX_CHILDREN = 5;

/**
 * Fetches `url` as a sitemap. When it is a `<sitemapindex>`, follows up to
 * `MAX_SITEMAP_INDEX_CHILDREN` child sitemaps and merges their entries — a
 * real sitemap index for a mid-size site is a handful of files, and this
 * bounds the fan-out rather than fetching an unbounded tree.
 *
 * Returns `undefined` for a 404 (no sitemap at this URL) rather than an empty
 * result, so a caller can tell "no sitemap" apart from "empty sitemap".
 */
export async function fetchSitemapViaFetch(url: string, fetchImpl: typeof fetch, timeoutMs: number, limit: number): Promise<SitemapResult | undefined> {
  const result = await getText(url, fetchImpl, timeoutMs);
  if (!result || result.status === 404) return undefined;

  const parsed = parseSitemapXml(url, result.status, result.body);
  if (!parsed.childSitemaps || parsed.childSitemaps.length === 0) {
    return { ...parsed, entries: parsed.entries.slice(0, limit) };
  }

  const children = parsed.childSitemaps.slice(0, MAX_SITEMAP_INDEX_CHILDREN);
  const merged: SitemapEntry[] = [];
  for (const childUrl of children) {
    if (merged.length >= limit) break;
    const child = await fetchSitemapViaFetch(childUrl, fetchImpl, timeoutMs, limit - merged.length).catch(() => undefined);
    if (child) merged.push(...child.entries);
  }
  return { url, status: parsed.status, entries: merged.slice(0, limit), childSitemaps: parsed.childSitemaps };
}

const HREF_RE = /<a\s[^>]*href=["']([^"'#]+)["']/gi;

/** Breadth-first link discovery from `seedUrl`, used only when no sitemap resolves. */
async function followLinks(
  seedUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  limit: number,
  maxDepth: number,
  restrictToOrigin: string | undefined,
): Promise<{ urls: string[]; truncated: boolean }> {
  const seen = new Set<string>([seedUrl]);
  const queue: Array<{ url: string; depth: number }> = [{ url: seedUrl, depth: 0 }];
  const ordered: string[] = [];
  let truncated = false;

  while (queue.length > 0 && ordered.length < limit) {
    const next = queue.shift()!;
    ordered.push(next.url);
    if (next.depth >= maxDepth) continue;

    let html: string;
    try {
      const fetched = await getText(next.url, fetchImpl, timeoutMs);
      html = fetched?.body ?? "";
    } catch {
      continue; // a page that fails to load simply contributes no further links
    }

    for (const match of html.matchAll(HREF_RE)) {
      let absolute: string;
      try {
        absolute = new URL(match[1]!, next.url).href;
      } catch {
        continue;
      }
      if (restrictToOrigin && originOf(absolute) !== restrictToOrigin) continue;
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      if (ordered.length + queue.length >= limit) {
        truncated = true;
        break;
      }
      queue.push({ url: absolute, depth: next.depth + 1 });
    }
  }
  if (queue.length > 0) truncated = true;
  return { urls: ordered, truncated };
}

export async function crawlSiteViaFetch(seedUrl: string, options: CrawlOptions, fetchImpl: typeof fetch, defaultTimeoutMs: number): Promise<SiteCrawlResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const limit = options.limit ?? 20;
  const maxDepth = options.maxDepth ?? 1;
  const seedOrigin = originOf(seedUrl);
  const restrictToOrigin = (options.sameOriginOnly ?? true) ? seedOrigin : undefined;

  const robots = await fetchRobotsViaFetch(seedUrl, fetchImpl, timeoutMs).catch(() => undefined);
  const sitemapUrl = robots?.sitemaps[0] ?? `${seedOrigin}/sitemap.xml`;
  const sitemap = await fetchSitemapViaFetch(sitemapUrl, fetchImpl, timeoutMs, limit).catch(() => undefined);

  let candidateUrls: string[];
  let truncated: boolean;

  if (sitemap && sitemap.entries.length > 0) {
    candidateUrls = sitemap.entries.map((e) => e.url).slice(0, limit);
    truncated = sitemap.entries.length > limit;
  } else {
    const discovered = await followLinks(seedUrl, fetchImpl, timeoutMs, limit, maxDepth, restrictToOrigin);
    candidateUrls = discovered.urls;
    truncated = discovered.truncated;
  }

  const pages: CrawlPage[] = [];
  for (const url of candidateUrls) {
    try {
      const status = await fetchPageStatus(url, fetchImpl, timeoutMs);
      pages.push({ url, status: status.status });
    } catch {
      // Unreachable is itself a crawl finding — recorded with status 0 rather than dropped silently.
      pages.push({ url, status: 0 });
    }
  }

  return { seedUrl, pages, ...(sitemap ? { sitemap } : {}), ...(robots ? { robots } : {}), truncated };
}
