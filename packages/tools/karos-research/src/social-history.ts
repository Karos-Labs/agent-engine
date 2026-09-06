import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success, toolingError, notAvailable } from "@agent-engine/tool-common";
import { ScraperError, type ScraperProvider, type SocialPlatform } from "@agent-engine/tool-karos-scraper";
import { latestRunForQuery, writeRunRecord, type RunRecord } from "./runs.js";

// 1.0.0 — new (2026-09): the client's own recent posts, on their own, for
// cross-channel anti-repetition.
const TOOL_VERSION = "1.0.0";

const SOCIAL_PLATFORMS = ["x", "instagram", "reddit", "tiktok"] as const;

/** How far back per account. A month of a busy account is well inside this; the point is "what did they say lately", not an archive. */
const POSTS_PER_ACCOUNT = 12;
/** How much of a post travels. Enough to recognise a repeat of the subject, not enough to re-read the post. */
const POST_EXCERPT_CHARS = 600;

export const SocialHistoryInputSchema = z.object({
  accounts: z
    .array(
      z.object({
        platform: z.enum(SOCIAL_PLATFORMS).describe("Which social platform this account is on."),
        username: z.string().min(1).describe("The account's handle, with or without a leading @."),
      }),
    )
    .min(1)
    .max(6)
    .describe("The client's own accounts to read. Each is one billed scrape per cache window."),
  window: z
    .string()
    .min(1)
    .default("6h")
    .describe("Freshness window — a read of the same accounts inside it is served from the cache, so several agents running the same afternoon share one scrape."),
});
export type SocialHistoryInput = z.input<typeof SocialHistoryInputSchema>;

export interface SocialHistoryPost {
  platform: SocialPlatform;
  username: string;
  url: string;
  excerpt: string;
  publishedAt?: string;
  engagement?: { likes?: number; comments?: number; views?: number };
}

export interface SocialHistoryResult {
  posts: SocialHistoryPost[];
  /** Accounts that could not be read, named — one wrong handle must not hide behind "history unavailable". */
  problems: string[];
  fromCache: boolean;
  fetchedAt: string;
}

const JOB = "social-history";

function cacheKey(accounts: ReadonlyArray<{ platform: string; username: string }>): string {
  return accounts
    .map((a) => `${a.platform}/@${a.username.replace(/^@/, "").toLowerCase()}`)
    .sort()
    .join(" ");
}

/**
 * `research.socialHistory` — what the client actually published lately, on
 * their own accounts.
 *
 * ## Why a tool of its own
 *
 * `research.pull` can already fold a client's accounts into its payload, but
 * only alongside a web search it bills for anyway. The cross-channel
 * anti-repetition read wants the accounts and nothing else, on every run of
 * every content agent — so it gets its own cached call rather than a web search
 * it would throw away. The cache is the same `research/<job>/runs` store every
 * other research read uses, keyed on the account set, so an X run and a
 * LinkedIn run the same afternoon share one scrape.
 *
 * What it does NOT do is analyse anything: the posts come back as excerpts for
 * a dedupe corpus and a do-not-repeat directive. The visual-pattern ingestion,
 * which reads the same accounts to LEARN a house style, keeps its own consent
 * gate; this read is the same anti-repetition context `research.pull` has
 * always offered through `socialAccounts`, on the same footing.
 *
 * Unconfigured (no scraper) it reports `not_available`, like every other
 * credentialed capability; a per-account failure is a named `problem`, never a
 * failed run.
 */
export function createSocialHistory(store: WorkspaceStoreLike, scraper?: ScraperProvider) {
  return defineTool<SocialHistoryInput, SocialHistoryResult>({
    name: "research.socialHistory",
    description:
      "The client's own recent posts on their own social accounts (x, instagram, reddit, tiktok), as excerpts for cross-channel anti-repetition. Cached per account set inside `window` so agents running the same afternoon share one scrape. Reports not_available when no scraper is configured; a single unreadable account is a named problem, never a failure.",
    version: TOOL_VERSION,
    inputSchema: SocialHistoryInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof SocialHistoryInputSchema>;
      const query = cacheKey(input.accounts);
      const windowMs = parseDurationMs(input.window);

      const cached = await latestRunForQuery(store, ctx.clientSlug, JOB, query);
      if (cached && Date.now() - cached.at <= windowMs) {
        const result = cached.result as Omit<SocialHistoryResult, "fromCache">;
        return success<SocialHistoryResult>({ ...result, fromCache: true });
      }

      if (scraper === undefined) {
        return notAvailable("research.socialHistory: no scraper is configured — set SCRAPPYCOCO_API_KEY so the client's own recent posts can be read");
      }

      const posts: SocialHistoryPost[] = [];
      const problems: string[] = [];
      for (const account of input.accounts) {
        const username = account.username.replace(/^@/, "");
        try {
          const records = await scraper.socialHistory({ platform: account.platform, username, limit: POSTS_PER_ACCOUNT });
          for (const record of records) {
            const text = (record.text ?? record.title ?? "").trim();
            if (text.length === 0) continue;
            posts.push({
              platform: account.platform,
              username,
              url: record.url,
              excerpt: text.length > POST_EXCERPT_CHARS ? `${text.slice(0, POST_EXCERPT_CHARS)}…` : text,
              ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
              ...(record.engagement ? { engagement: record.engagement } : {}),
            });
          }
        } catch (error) {
          if (error instanceof ScraperError) {
            problems.push(`could not read ${account.platform}/@${username}: ${error.message}`);
            continue;
          }
          throw error;
        }
      }

      if (posts.length === 0 && problems.length === input.accounts.length) {
        // Every account failed: an outage, not "this client never posts".
        return toolingError(`research.socialHistory: no account could be read — ${problems.join("; ")}`);
      }

      const fetchedAt = new Date().toISOString();
      const record: RunRecord = { job: JOB, runId: `${JOB}-${Date.now()}`, query, result: { posts, problems, fetchedAt }, at: Date.now() };
      await writeRunRecord(store, ctx.clientSlug, record);
      return success<SocialHistoryResult>({ posts, problems, fromCache: false, fetchedAt });
    },
  });
}
