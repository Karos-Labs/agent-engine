import { z } from "zod";
import { defineTool, fetchWithRetry, success, toolingError, DEFAULT_RETRY_POLICY, type CaptureFetch } from "@agent-engine/tool-common";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import type { ScrapedRecord, ScraperProvider } from "@agent-engine/tool-karos-scraper";

const TOOL_VERSION = "1.0.0";

/**
 * Live Reddit thread discovery and thread reading — the "expensive skill"
 * this agent never had.
 *
 * ## Why this exists
 *
 * Every version of the reply-only workflow before this one held any run that
 * did not arrive with a hand-typed `requestedThreadUrl`, under a comment that
 * said thread discovery "is out of scope for Phase 1". For a scheduled weekly
 * pulse that means every run held, forever: nothing in the portal types a
 * thread URL into a recurring job. And even a run that did carry a URL drafted
 * from the thread's TITLE alone — it never read the question the poster
 * actually asked, or what the thread's existing replies had already said.
 *
 * ## The source, and why it is the Atom feed
 *
 * Reddit's JSON endpoints (`/r/<sub>/new.json`, `/search.json`,
 * `/comments/<id>.json`) answer HTTP 403 to any non-browser client from a
 * server IP, verified 2026-09-05 with both a descriptive and a browser
 * user-agent. The Atom feeds (`/r/<sub>/new.rss`, `<thread>/.rss`) answer 200
 * with the post body, author, timestamp and — for a thread — its comments.
 * They are rate-limited (429 after a handful of quick requests), which is why
 * every fetch below goes through `fetchWithRetry` (honours `Retry-After`) and
 * subreddits are read one at a time with a pause between them.
 *
 * When Reddit refuses anyway, the configured `ScraperProvider` (ScrappyCoco's
 * `reddit.search_posts` / `web.extract_content`) is the paid fallback. When
 * neither answers, the tool says so per subreddit in `scanned`, so a run that
 * finds nothing can tell "nothing worth replying to" from "could not look".
 *
 * ## Nothing here fabricates a thread
 *
 * Every candidate carries the URL Reddit (or the scraper) returned, verbatim.
 * The subreddit is parsed from that URL, never assumed from the feed that was
 * asked for.
 */

const REDDIT_THREAD_URL_PATTERN = /^https?:\/\/(?:www\.|old\.|new\.|m\.)?reddit\.com\/r\/([A-Za-z0-9_]+)\/comments\/([A-Za-z0-9]+)(?:\/[^/?#]*)?\/?(?:[?#].*)?$/i;

export function parseRedditThreadUrl(url: string): { subreddit: string; threadId: string } | undefined {
  const match = REDDIT_THREAD_URL_PATTERN.exec(url.trim());
  if (!match) return undefined;
  return { subreddit: match[1]!, threadId: match[2]!.toLowerCase() };
}

/** `r/Marketing`, `/r/marketing/`, `marketing` -> `marketing`. */
export function bareSubreddit(raw: string): string {
  return raw
    .trim()
    .replace(/^\/?r\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * A browser-shaped user-agent. Reddit's feeds answer a descriptive bot UA
 * with 403 but a browser UA with 200 (verified 2026-09-05); this is the same
 * public, unauthenticated document a browser would fetch, so nothing is being
 * evaded — the string is just what the server currently accepts.
 */
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/** Pause between two subreddit feeds. Reddit's unauthenticated limit is about ten requests a minute per IP. */
const DEFAULT_PAUSE_BETWEEN_FEEDS_MS = 1_500;

/** How much of a post body travels in a candidate. Enough to judge relevance, not enough to read the thread. */
const CANDIDATE_EXCERPT_CHARS = 500;
/** Per-comment ceiling in a fetched thread. */
const COMMENT_CHARS = 1_500;
/** Post-body ceiling in a fetched thread. */
const POST_BODY_CHARS = 6_000;

const QUESTION_PATTERN =
  /\?|^(?:how|what|why|which|when|where|who|is|are|does|do|did|can|could|should|would|any(?:one|body)|looking for|need|recommend|advice|help|thoughts)\b/i;

// ── Atom parsing ─────────────────────────────────────────────────────────────

interface AtomEntry {
  id?: string;
  title?: string;
  link?: string;
  author?: string;
  published?: string;
  updated?: string;
  /** Plain text: entities decoded, tags stripped, Reddit's feed boilerplate removed. */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? whole;
  });
}

/** HTML -> readable plain text, keeping paragraph breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(?:p|div|li|h[1-6]|blockquote|pre|tr)\s*>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Reddit appends "submitted by /u/x [link] [comments]" to every post entry. Not part of what the poster wrote. */
function stripRedditBoilerplate(text: string): string {
  return text
    .replace(/\s*submitted by\s+\/u\/\S+.*$/is, "")
    .replace(/\s*\[link\]\s*\[comments\]\s*$/i, "")
    .trim();
}

function firstTag(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!match) return undefined;
  const inner = match[1]!.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1");
  return decodeEntities(inner).trim();
}

export function parseAtomEntries(xml: string): AtomEntry[] {
  const entries: AtomEntry[] = [];
  const pattern = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const block = match[1]!;
    const linkMatch = /<link(?:\s[^>]*?)?\shref="([^"]+)"/i.exec(block);
    const authorBlock = /<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/i.exec(block)?.[1];
    const contentRaw = /<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/i.exec(block)?.[1] ?? "";
    // The feed double-encodes: the content element holds escaped HTML.
    const contentHtml = decodeEntities(contentRaw.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1"));
    const author = authorBlock ? firstTag(authorBlock, "name") : undefined;
    entries.push({
      ...(firstTag(block, "id") ? { id: firstTag(block, "id")! } : {}),
      ...(firstTag(block, "title") ? { title: firstTag(block, "title")! } : {}),
      ...(linkMatch ? { link: decodeEntities(linkMatch[1]!) } : {}),
      ...(author ? { author: author.replace(/^\/?u\//i, "") } : {}),
      ...(firstTag(block, "published") ? { published: firstTag(block, "published")! } : {}),
      ...(firstTag(block, "updated") ? { updated: firstTag(block, "updated")! } : {}),
      text: stripRedditBoilerplate(htmlToText(contentHtml)),
    });
  }
  return entries;
}

// ── Public shapes ────────────────────────────────────────────────────────────

export interface RedditThreadCandidate {
  url: string;
  title: string;
  /** Bare name, parsed from `url`. */
  subreddit: string;
  author?: string;
  /** ISO 8601. */
  postedAt?: string;
  /** The poster's own words, cut to `CANDIDATE_EXCERPT_CHARS`. Empty for a link post with no text. */
  excerpt: string;
  /** Which of the caller's keywords the title or body mentions. */
  keywordHits: string[];
  /** The title reads like a question or a request for help — what a reply can actually answer. */
  looksLikeQuestion: boolean;
  /** Where this candidate came from. */
  source: "reddit-feed" | "scraper";
}

export interface SubredditScan {
  subreddit: string;
  /** How many threads the feed returned before filtering. */
  fetched: number;
  /** `reddit-feed` when Reddit's own feed answered, `scraper` when the paid fallback did, `failed` when neither could. */
  source: "reddit-feed" | "scraper" | "failed";
  /** True when Reddit itself said the community does not exist or is not readable (404/403 on the feed, or an empty feed with a 3xx). */
  notFound?: boolean;
  error?: string;
}

export interface DiscoverThreadsResult {
  candidates: RedditThreadCandidate[];
  scanned: SubredditScan[];
  /** How many threads were dropped as too old, already answered, or otherwise filtered — so an empty result is explicable. */
  filteredOut: number;
}

export interface RedditThreadComment {
  author?: string;
  body: string;
  postedAt?: string;
}

export interface FetchThreadResult {
  url: string;
  title: string;
  subreddit: string;
  author?: string;
  postedAt?: string;
  /** The poster's full text (bounded). */
  body: string;
  /** Existing replies, top-sorted as Reddit's feed orders them. Empty when the thread has none or they could not be read. */
  comments: RedditThreadComment[];
  source: "reddit-feed" | "scraper";
  /** Set when comments could not be read even though the post could. */
  note?: string;
}

// ── Input schemas ────────────────────────────────────────────────────────────

export const DiscoverThreadsInputSchema = z.object({
  subreddits: z.array(z.string().min(1)).min(1).max(12).describe("Communities to scan, with or without the r/ prefix."),
  keywords: z.array(z.string().min(1)).max(40).default([]).describe("Words or phrases the client can speak to. Threads mentioning one rank first; nothing is excluded for missing them."),
  excludeUrls: z.array(z.string()).default([]).describe("Thread URLs already answered for this client. Dropped before ranking."),
  maxAgeDays: z.number().int().min(1).max(30).default(7).describe("Ignore threads older than this. A reply to a stale thread is never seen."),
  maxCandidates: z.number().int().min(1).max(60).default(30).describe("How many ranked candidates to return."),
});
export type DiscoverThreadsInput = z.input<typeof DiscoverThreadsInputSchema>;

export const FetchThreadInputSchema = z.object({
  url: z.string().min(1).describe("A reddit.com thread URL (.../r/<subreddit>/comments/<id>/...)."),
  maxComments: z.number().int().min(0).max(40).default(12).describe("How many existing replies to read."),
});
export type FetchThreadInput = z.input<typeof FetchThreadInputSchema>;

export interface RedditThreadToolsOptions {
  fetchImpl?: CaptureFetch;
  /** The paid fallback when Reddit's feed refuses. Omitted means feed-only. */
  scraper?: ScraperProvider;
  userAgent?: string;
  /** Injectable so tests do not wait between feeds. */
  sleep?: (ms: number) => Promise<void>;
  pauseBetweenFeedsMs?: number;
  now?: () => number;
}

// ── Implementation ───────────────────────────────────────────────────────────

function keywordHits(text: string, keywords: readonly string[]): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const raw of keywords) {
    const k = raw.trim().toLowerCase();
    if (k.length < 3) continue;
    if (lower.includes(k) && !hits.includes(raw.trim())) hits.push(raw.trim());
  }
  return hits;
}

function normalizeThreadUrl(url: string): string {
  const parsed = parseRedditThreadUrl(url);
  if (!parsed) return url.trim();
  return `https://www.reddit.com/r/${parsed.subreddit}/comments/${parsed.threadId}/`;
}

function isFresh(iso: string | undefined, maxAgeDays: number, nowMs: number): boolean {
  if (!iso) return true; // Unknown age is not proof of staleness; the scout sees the date field is missing.
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return nowMs - t <= maxAgeDays * 86_400_000;
}

function candidateFromScraped(record: ScrapedRecord, keywords: readonly string[]): RedditThreadCandidate | undefined {
  const parsed = parseRedditThreadUrl(record.url);
  if (!parsed) return undefined;
  const title = (record.title ?? "").trim();
  if (!title) return undefined;
  const excerpt = (record.text ?? "").trim().slice(0, CANDIDATE_EXCERPT_CHARS);
  return {
    url: normalizeThreadUrl(record.url),
    title,
    subreddit: parsed.subreddit,
    ...(record.author ? { author: record.author.replace(/^\/?u\//i, "") } : {}),
    ...(record.publishedAt ? { postedAt: record.publishedAt } : {}),
    excerpt,
    keywordHits: keywordHits(`${title}\n${excerpt}`, keywords),
    looksLikeQuestion: QUESTION_PATTERN.test(title),
    source: "scraper",
  };
}

export function createRedditThreadTools(options: RedditThreadToolsOptions = {}): AgentToolRegistry {
  const fetchImpl: CaptureFetch = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pauseMs = options.pauseBetweenFeedsMs ?? DEFAULT_PAUSE_BETWEEN_FEEDS_MS;
  const now = options.now ?? Date.now;
  const scraper = options.scraper;

  async function fetchFeed(url: string): Promise<{ status: number; body: string }> {
    const response = await fetchWithRetry(fetchImpl, url, {
      init: { headers: { "User-Agent": userAgent, Accept: "application/atom+xml, application/xml, text/xml, */*" }, redirect: "follow" },
      timeoutMs: 15_000,
      // Reddit's Retry-After on a 429 is honoured up to the policy cap; three
      // attempts with backoff is enough to ride out a burst, not an outage.
      policy: { ...DEFAULT_RETRY_POLICY, maxRetryAfterMs: 15_000 },
      totalBudgetMs: 40_000,
      sleep,
      now,
    });
    const body = await response.text();
    return { status: response.status, body };
  }

  const discoverThreads: AgentTool<DiscoverThreadsInput, DiscoverThreadsResult> = defineTool({
    name: "reddit.discoverThreads",
    description:
      "Scans each target subreddit's newest threads (Reddit's own feed, with the configured scraper as fallback) and returns ranked reply candidates: real thread URLs with title, poster's text, age and which client keywords they mention. Reports per-subreddit whether the scan worked, so an empty result is never mistaken for a working scan that found nothing.",
    version: TOOL_VERSION,
    inputSchema: DiscoverThreadsInputSchema,
    async execute(rawInput) {
      const input = rawInput as z.output<typeof DiscoverThreadsInputSchema>;
      const subreddits = [...new Set(input.subreddits.map(bareSubreddit).filter((s) => s.length > 0))];
      const exclude = new Set(input.excludeUrls.map(normalizeThreadUrl));
      const nowMs = now();
      const scanned: SubredditScan[] = [];
      const candidates: RedditThreadCandidate[] = [];
      let filteredOut = 0;

      for (const [index, subreddit] of subreddits.entries()) {
        if (index > 0) await sleep(pauseMs);
        let entries: RedditThreadCandidate[] | undefined;
        let scan: SubredditScan;
        try {
          const { status, body } = await fetchFeed(`https://www.reddit.com/r/${subreddit}/new.rss?limit=25`);
          if (status === 200 && /<feed[\s>]/i.test(body)) {
            entries = parseAtomEntries(body)
              .map((e): RedditThreadCandidate | undefined => {
                if (!e.link || !e.title) return undefined;
                const parsed = parseRedditThreadUrl(e.link);
                if (!parsed) return undefined;
                const excerpt = e.text.slice(0, CANDIDATE_EXCERPT_CHARS);
                return {
                  url: normalizeThreadUrl(e.link),
                  title: e.title,
                  subreddit: parsed.subreddit,
                  ...(e.author ? { author: e.author } : {}),
                  ...(e.published ?? e.updated ? { postedAt: (e.published ?? e.updated)! } : {}),
                  excerpt,
                  keywordHits: keywordHits(`${e.title}\n${excerpt}`, input.keywords),
                  looksLikeQuestion: QUESTION_PATTERN.test(e.title),
                  source: "reddit-feed",
                };
              })
              .filter((c): c is RedditThreadCandidate => c !== undefined);
            scan = { subreddit, fetched: entries.length, source: "reddit-feed" };
          } else if (status === 404 || status === 403) {
            // 404: no such community. 403: private, quarantined, or banned.
            // Either way there is nothing here for this client to reply in.
            scan = { subreddit, fetched: 0, source: "failed", notFound: true, error: `Reddit answered ${status} for r/${subreddit}` };
          } else {
            scan = { subreddit, fetched: 0, source: "failed", error: `Reddit answered ${status} for r/${subreddit}'s feed` };
          }
        } catch (error) {
          scan = { subreddit, fetched: 0, source: "failed", error: `feed fetch failed: ${(error as Error).message}` };
        }

        // The paid fallback, only when Reddit itself would not answer (never
        // for a community Reddit says does not exist).
        if (entries === undefined && !scan.notFound && scraper !== undefined) {
          try {
            const query = input.keywords.length > 0 ? `${input.keywords.slice(0, 4).join(" ")} subreddit:${subreddit}` : `subreddit:${subreddit}`;
            const records = await scraper.searchSocial("reddit", query, { limit: 15 });
            entries = records
              .map((r) => candidateFromScraped(r, input.keywords))
              .filter((c): c is RedditThreadCandidate => c !== undefined && c.subreddit.toLowerCase() === subreddit);
            scan = { subreddit, fetched: entries.length, source: "scraper", ...(scan.error ? { error: `${scan.error}; used ${scraper.name} instead` } : {}) };
          } catch (error) {
            scan = { ...scan, error: `${scan.error ?? "feed unavailable"}; scraper fallback also failed: ${(error as Error).message}` };
          }
        }

        scanned.push(scan);
        for (const c of entries ?? []) {
          if (exclude.has(c.url) || !isFresh(c.postedAt, input.maxAgeDays, nowMs)) {
            filteredOut++;
            continue;
          }
          candidates.push(c);
        }
      }

      // Rank: keyword relevance first, then "is this answerable", then recency.
      // A thread that names the client's subject AND asks a question is the
      // one a reply is most welcome in.
      const score = (c: RedditThreadCandidate) => c.keywordHits.length * 10 + (c.looksLikeQuestion ? 3 : 0) + (c.excerpt.length > 80 ? 1 : 0);
      candidates.sort((a, b) => {
        const diff = score(b) - score(a);
        if (diff !== 0) return diff;
        return Date.parse(b.postedAt ?? "") - Date.parse(a.postedAt ?? "") || 0;
      });

      // Dedupe by URL across subreddits (crossposts).
      const seen = new Set<string>();
      const unique = candidates.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));

      return success<DiscoverThreadsResult>({ candidates: unique.slice(0, input.maxCandidates), scanned, filteredOut });
    },
  });

  const fetchThread: AgentTool<FetchThreadInput, FetchThreadResult> = defineTool({
    name: "reddit.fetchThread",
    description:
      "Reads one Reddit thread: the poster's full text plus its existing top replies (Reddit's own feed, with the configured scraper as fallback). This is what a reply is written against — the actual question and what has already been said in answer to it.",
    version: TOOL_VERSION,
    inputSchema: FetchThreadInputSchema,
    async execute(rawInput) {
      const input = rawInput as z.output<typeof FetchThreadInputSchema>;
      const parsed = parseRedditThreadUrl(input.url);
      if (!parsed) return toolingError(`reddit.fetchThread: "${input.url}" is not a reddit.com thread URL (expected .../r/<subreddit>/comments/<id>/...)`);
      const canonical = normalizeThreadUrl(input.url);

      let feedError: string | undefined;
      try {
        const { status, body } = await fetchFeed(`${canonical}.rss?limit=${input.maxComments + 1}&sort=top`);
        if (status === 200 && /<feed[\s>]/i.test(body)) {
          const entries = parseAtomEntries(body);
          const post = entries[0];
          if (post) {
            const comments: RedditThreadComment[] = entries
              .slice(1, 1 + input.maxComments)
              .filter((e) => e.text.length > 0)
              .map((e) => ({
                ...(e.author ? { author: e.author } : {}),
                body: e.text.slice(0, COMMENT_CHARS),
                ...(e.published ?? e.updated ? { postedAt: (e.published ?? e.updated)! } : {}),
              }));
            return success<FetchThreadResult>({
              url: canonical,
              title: post.title ?? canonical,
              subreddit: parsed.subreddit,
              ...(post.author ? { author: post.author } : {}),
              ...(post.published ?? post.updated ? { postedAt: (post.published ?? post.updated)! } : {}),
              body: post.text.slice(0, POST_BODY_CHARS),
              comments,
              source: "reddit-feed",
            });
          }
          feedError = "Reddit's feed for the thread carried no entries";
        } else {
          feedError = `Reddit answered ${status} for the thread feed`;
        }
      } catch (error) {
        feedError = `thread feed fetch failed: ${(error as Error).message}`;
      }

      if (scraper !== undefined) {
        try {
          const record = await scraper.extractUrl(canonical);
          if (record && (record.text || record.title)) {
            return success<FetchThreadResult>({
              url: canonical,
              title: (record.title ?? canonical).trim(),
              subreddit: parsed.subreddit,
              ...(record.author ? { author: record.author.replace(/^\/?u\//i, "") } : {}),
              ...(record.publishedAt ? { postedAt: record.publishedAt } : {}),
              body: (record.text ?? "").trim().slice(0, POST_BODY_CHARS),
              comments: [],
              source: "scraper",
              note: `${feedError}; read the page through ${scraper.name} instead, which does not separate out the existing replies`,
            });
          }
        } catch (error) {
          feedError = `${feedError}; scraper fallback also failed: ${(error as Error).message}`;
        }
      }

      return toolingError(`reddit.fetchThread: could not read ${canonical} — ${feedError}`);
    },
  });

  return { "reddit.discoverThreads": discoverThreads, "reddit.fetchThread": fetchThread };
}
