import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success, toolingError, notAvailable } from "@agent-engine/tool-common";
import { readOutputHistory } from "@agent-engine/tool-karos-ledger";
import { ScraperError, type ScrapedRecord, type ScraperProvider, type SocialPlatform } from "@agent-engine/tool-karos-scraper";
import { latestRunForQuery, runSegments, type RunRecord } from "./runs.js";
import {
  DEFAULT_CONTENT_CHARS,
  HISTORY_EXCERPT_CHARS,
  truncate,
  type ResearchDocument,
  type ResearchHistory,
  type ResearchHistoryPost,
  type ResearchPayload,
} from "./payload.js";

const TOOL_VERSION = "1.1.0";

const SOCIAL_PLATFORMS = ["x", "instagram", "reddit", "tiktok"] as const;

export const PullInputSchema = z.object({
  job: z.string().min(1),
  query: z.string().min(1),
  /** Freshness window — a cached run inside this window is returned instead of re-fetching. */
  window: z.string().min(1),
  /**
   * How many live sources to retrieve. The payload is injected whole into the
   * extraction agent's prompt, so this is a token bill as much as a breadth
   * setting: a handful of real sources beats a pile of them.
   */
  maxResults: z.number().int().min(1).max(10).default(4),
  /**
   * Whose prior deliverables to fold in as anti-repetition context, e.g.
   * `"instagram-agent"`. Omitted means no history section at all — a caller
   * that has not decided gets no half-answer.
   */
  historyAgentId: z.string().min(1).optional(),
  /**
   * The client's own accounts, for pulling what they actually published
   * recently. Each entry costs a billed scrape, so callers name only the
   * accounts they want read.
   */
  socialAccounts: z
    .array(z.object({ platform: z.enum(SOCIAL_PLATFORMS), username: z.string().min(1) }))
    .max(4)
    .optional(),
});
export type PullInput = z.input<typeof PullInputSchema>;

export interface PullResult {
  runId: string;
  query: string;
  result: unknown;
  fromCache: boolean;
  ageMs: number;
}

function toDocument(record: ScrapedRecord, contentChars: number): ResearchDocument {
  return {
    title: record.title ?? record.url,
    url: record.url,
    ...(record.text ? { content: truncate(record.text, contentChars) } : {}),
    ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
    ...(record.author ? { author: record.author } : {}),
  };
}

/**
 * Egress-bound, cached, freshness-enforced (RFC-01 §9.2): a cached run inside
 * `window` is returned as-is; otherwise a new run is fetched and recorded.
 *
 * ## The stand-in, and why it had to go
 *
 * This shipped with no egress. The "fetch" returned
 * `{note: "Phase 1 stand-in...", query}`, so the caching and freshness
 * contract was real while the search was not, and nothing downstream could
 * tell a placeholder from a topic with nothing to say about it. prep run
 * pubsub-21066191524607951 is the receipt: the extraction agent reported the
 * only fact it could see ("the research payload for this run is a Phase 1
 * stand-in with no real external data fetched") and the copy agent then wrote
 * a client-facing carousel about our own plumbing. Nothing errored. Every
 * content agent in the engine drafted from nothing, for months, silently.
 *
 * So an unconfigured deployment reports `not_available` naming the missing
 * credential. That is a deliberate behaviour change: a run that cannot
 * research now stops with a reason instead of drafting from a placeholder. A
 * held run costs a retry; a published carousel about our own plumbing costs a
 * client's trust.
 *
 * ## Two halves of the payload
 *
 * `documents` is live external research. `history` is what this client already
 * published, read from the same excerpt ledger `ledger.recordOutputExcerpt`
 * writes, plus optionally their own recent social posts. Kept as separate keys
 * so an extraction agent can use the first for substance and the second to
 * avoid repeating itself, which it cannot do if both arrive as one list.
 */
export function createPull(store: WorkspaceStoreLike, scraper?: ScraperProvider) {
  return defineTool<PullInput, PullResult>({
    name: "research.pull",
    version: TOOL_VERSION,
    inputSchema: PullInputSchema,
    async execute(rawInput, { ctx }) {
      const input = PullInputSchema.parse(rawInput);
      const { job, query, window, maxResults } = input;
      const windowMs = parseDurationMs(window);
      // Keyed on the QUESTION, not just the job. Keyed on the job alone, a
      // second instagram run the same day reused the first one's research
      // whatever its own subject was — see `latestRunForQuery`.
      const cached = await latestRunForQuery(store, ctx.clientSlug, job, query);

      if (cached) {
        const ageMs = Date.now() - cached.at;
        if (ageMs <= windowMs) {
          return success<PullResult>({ runId: cached.runId, query: cached.query, result: cached.result, fromCache: true, ageMs });
        }
      }

      if (scraper === undefined) {
        return notAvailable(
          "research.pull: no scraper is configured — set SCRAPPYCOCO_API_KEY so real sources can be fetched " +
            "(see packages/tools/karos-research/README.md). Refusing to return a placeholder payload: an agent that " +
            "drafts from one writes about the missing data instead of the topic.",
        );
      }

      let documents: ResearchDocument[];
      try {
        const records = await scraper.searchKeyword(query, { limit: maxResults });
        documents = records.map((r) => toDocument(r, DEFAULT_CONTENT_CHARS));
      } catch (error) {
        if (error instanceof ScraperError) {
          // A search outage is tooling, never content. Reporting it as an
          // empty-but-successful payload is what let a broken pipeline read as
          // a topic with nothing to say about it.
          return toolingError(error.message);
        }
        throw error;
      }

      const history = await buildHistory(store, ctx.clientSlug, input, scraper);

      const result: ResearchPayload = {
        provider: scraper.name,
        query,
        fetchedAt: new Date().toISOString(),
        documents,
        ...(history ? { history } : {}),
        ...(documents.length === 0
          ? { note: `${scraper.name} returned no results for this query; no external facts are available for this run.` }
          : {}),
      };

      const runId = randomUUID();
      const record: RunRecord = { job, runId, query, result, at: Date.now() };
      await store.writeJson(ctx.clientSlug, runSegments(job, runId), record);

      return success<PullResult>({ runId, query, result, fromCache: false, ageMs: 0 });
    },
  });
}

/**
 * Assembles the anti-repetition half of the payload.
 *
 * Returns undefined when the caller asked for neither history source, so the
 * payload omits the key rather than carrying an empty shell that reads like
 * "this client has never posted".
 *
 * Every failure here degrades to a `note` rather than failing the pull: the
 * live research is the part a run cannot proceed without, and losing the
 * anti-repetition context is a quality regression, not a reason to publish
 * nothing.
 */
async function buildHistory(
  store: WorkspaceStoreLike,
  clientSlug: string,
  input: z.infer<typeof PullInputSchema>,
  scraper: ScraperProvider,
): Promise<ResearchHistory | undefined> {
  const { historyAgentId, socialAccounts } = input;
  if (historyAgentId === undefined && (socialAccounts === undefined || socialAccounts.length === 0)) {
    return undefined;
  }

  const priorPosts: ResearchHistoryPost[] = [];
  const priorTopics: string[] = [];
  const problems: string[] = [];

  if (historyAgentId !== undefined) {
    try {
      for (const entry of await readOutputHistory(store, clientSlug, historyAgentId)) {
        priorPosts.push({
          origin: "output-history",
          excerpt: truncate(entry.excerpt, HISTORY_EXCERPT_CHARS),
          recordedAt: new Date(entry.recordedAt).toISOString(),
        });
      }
    } catch (error) {
      problems.push(`could not read ${historyAgentId} output history: ${(error as Error).message}`);
    }
  }

  for (const account of socialAccounts ?? []) {
    try {
      const posts = await scraper.socialHistory({
        platform: account.platform as SocialPlatform,
        username: account.username,
        limit: 8,
      });
      for (const post of posts) {
        priorPosts.push({
          origin: account.platform,
          excerpt: truncate(post.text ?? post.title ?? post.url, HISTORY_EXCERPT_CHARS),
          ...(post.publishedAt ? { recordedAt: post.publishedAt } : {}),
          url: post.url,
          ...(post.engagement ? { engagement: post.engagement } : {}),
        });
      }
    } catch (error) {
      // Named per account: "history unavailable" is useless when one of three
      // handles is wrong and the other two worked.
      problems.push(`could not read ${account.platform}/@${account.username}: ${(error as Error).message}`);
    }
  }

  // The topic list is derived from the posts rather than stored separately:
  // a first line is what a topic picker actually needs to steer around, and
  // deriving it means there is no second store to keep in sync.
  for (const post of priorPosts) {
    const firstLine = post.excerpt.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    if (firstLine && !priorTopics.includes(firstLine)) priorTopics.push(firstLine);
  }

  return {
    priorPosts,
    priorTopics,
    ...(problems.length > 0 ? { note: problems.join("; ") } : {}),
  };
}
