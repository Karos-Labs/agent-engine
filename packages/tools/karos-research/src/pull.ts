import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success, toolingError, notAvailable } from "@agent-engine/tool-common";
import { readOutputHistory } from "@agent-engine/tool-karos-ledger";
// SCRUM-321 (AU37) — the visual-pattern read path below folds in the client's
// own learned house style. Imported from the package that OWNS that document
// (`karos-media`) rather than re-deriving its store path here, for exactly the
// reason `readOutputHistory` above is imported from `karos-ledger`: two
// definitions of where a record lives is one definition too many, and the copy
// that drifts is the one that silently reads nothing.
import {
  readVisualPatternConsent,
  readVisualPatternProfile,
  renderVisualPatternReference,
} from "@agent-engine/tool-karos-media";
import { ScraperError, type ScrapedRecord, type ScraperProvider, type SocialPlatform } from "@agent-engine/tool-karos-scraper";
import { latestRunForQuery, listRuns, writeRunRecord, type RunRecord } from "./runs.js";
import {
  DEFAULT_CONTENT_CHARS,
  HISTORY_EXCERPT_CHARS,
  truncate,
  type ResearchDocument,
  type ResearchHistory,
  type ResearchHistoryPost,
  type ResearchPayload,
  type ResearchVisualPatterns,
} from "./payload.js";

// 1.3.0 (RFC-13 §J): per-call breadth and depth — `maxResults` up to 16,
// `contentChars` (was the hard-wired `DEFAULT_CONTENT_CHARS`) and
// `includeDomains` — plus a size-aware cache, so a deep pull is never served
// a record fetched shallow. Every existing caller's payload is byte-identical.
// 1.2.0 (SCRUM-321/AU37): additive `includeVisualPatterns` read path on the
// account-history half of the payload.
// 1.1.1 (SCRUM-296/AU11): removed the redundant re-parse of already-validated input.
const TOOL_VERSION = "1.3.0";

const SOCIAL_PLATFORMS = ["x", "instagram", "reddit", "tiktok"] as const;

export const PullInputSchema = z.object({
  // job/query have no existing TSDoc to transcribe (SCRUM-293 flag) — synthesized from latestRunForQuery's usage.
  job: z.string().min(1).describe("The research job's name — namespaces the cache alongside query."),
  query: z.string().min(1).describe("The research question — cached runs are keyed on (job, query), not job alone, so a differently-worded run never reuses stale results."),
  /** Freshness window — a cached run inside this window is returned instead of re-fetching. */
  window: z.string().min(1).describe("Freshness window — a cached run inside this window is returned instead of re-fetching."),
  /**
   * How many live sources to retrieve. The payload is injected whole into the
   * extraction agent's prompt, so this is a token bill as much as a breadth
   * setting: a handful of real sources beats a pile of them.
   */
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4)
    .describe(
      "How many live sources to retrieve. The payload is injected whole into the extraction agent's prompt, so this is a token bill as much as a breadth setting.",
    ),
  /**
   * RFC-13 §J. Per-document content ceiling for THIS call.
   *
   * It used to be the module-level `DEFAULT_CONTENT_CHARS` for every caller,
   * which made one number serve two genuinely different jobs: a trend scout
   * skimming twelve headlines wants 4000 characters, and a fact-card
   * extraction reading a study wants the paragraph the figure is actually in.
   * The default is unchanged, so no existing caller's payload moves a byte.
   */
  contentChars: z
    .number()
    .int()
    .min(500)
    .max(8000)
    .default(DEFAULT_CONTENT_CHARS)
    .describe(
      "Per-document content ceiling for this call. Higher costs prompt tokens downstream; the default matches what every caller got before this option existed.",
    ),
  /**
   * RFC-13 §J. Restrict the search to these domains — the client's own site,
   * a reference publication, the community sites an audience-question query
   * is actually looking for. Reaches `SearchOptions.includeDomains`, which
   * the ScrappyCoco adapter has always supported and no tool exposed.
   *
   * Part of this call's cache identity (see `servesRequest`): a
   * domain-restricted search and an open one are different questions, not the
   * same question with a parameter.
   */
  includeDomains: z
    .array(z.string().min(1))
    .max(8)
    .optional()
    .describe("Restrict results to these domains (e.g. the client's own site, a reference publication, community sites). Omitted means the open web."),
  /**
   * Whose prior deliverables to fold in as anti-repetition context, e.g.
   * `"instagram-agent"`. Omitted means no history section at all — a caller
   * that has not decided gets no half-answer.
   */
  historyAgentId: z
    .string()
    .min(1)
    .optional()
    .describe("Whose prior deliverables to fold in as anti-repetition context, e.g. \"instagram-agent\". Omitted means no history section at all."),
  /**
   * The client's own accounts, for pulling what they actually published
   * recently. Each entry costs a billed scrape, so callers name only the
   * accounts they want read.
   */
  socialAccounts: z
    .array(
      z.object({
        platform: z.enum(SOCIAL_PLATFORMS).describe("Which social platform this account is on."),
        username: z.string().min(1).describe("The account's username/handle on that platform."),
      }),
    )
    .max(4)
    .optional()
    .describe("The client's own accounts, for pulling what they actually published recently. Each entry costs a billed scrape."),
  /**
   * SCRUM-321 (AU37). Opt in to folding this client's learned visual-pattern
   * profile into the payload, so a copy-drafting or template-selection prompt
   * gets the client's own house style instead of the one static generic
   * template.
   *
   * Costs nothing and reaches no network: the profile is read from the
   * client's own workspace, written earlier by
   * `media.ingestVisualPatterns`. Defaults to false so no existing caller's
   * payload changes shape.
   */
  includeVisualPatterns: z
    .boolean()
    .default(false)
    .describe(
      "Fold this client's learned visual-pattern profile (written earlier by media.ingestVisualPatterns) into the payload as an aesthetic reference. Reads the client's own workspace, not the network. Omitted from the payload entirely when consent is not currently granted or no profile has been ingested.",
    ),
});
export type PullInput = z.input<typeof PullInputSchema>;

export interface PullResult {
  runId: string;
  query: string;
  result: unknown;
  fromCache: boolean;
  ageMs: number;
}

/**
 * RFC-13 §J. A run record plus the SIZE OF THE PULL that produced it.
 *
 * Declared here rather than widened into `RunRecord` itself because these
 * three fields are `research.pull`'s own business: `research.writeRun` and
 * `research.captureVisibility` write the same record type and have no notion
 * of a result's breadth. Every field is optional, so a record written before
 * this version still reads — `servesRequest` treats a missing annotation as
 * the pre-1.3.0 defaults, which is exactly what it was.
 */
interface PullRunRecord extends RunRecord {
  readonly maxResults?: number;
  readonly contentChars?: number;
  readonly includeDomains?: readonly string[];
}

/** Domain lists compare as sets: order and case are not part of the question. */
function sameDomains(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const norm = (list: readonly string[] | undefined): string =>
    [...(list ?? [])].map((d) => d.trim().toLowerCase()).sort().join(",");
  return norm(a) === norm(b);
}

/**
 * Whether a cached record can honestly answer THIS request.
 *
 * The cache was keyed on `(job, query)` alone, which was right until a call
 * could ask for more than the last one did: a 4-document / 4000-character
 * record served to a 6-document / 6000-character request looks like a cache
 * hit and is silently a thinner answer — the deep-research lanes would have
 * been handed the trend scout's skim. So a record serves only when it is at
 * least as broad and at least as deep as what was asked for, and was fetched
 * under the same domain restriction. Anything less refetches; the new record
 * supersedes the old one for later cache checks (`latestRunForQuery` reads
 * the newest matching run).
 */
function servesRequest(
  cached: PullRunRecord,
  request: { maxResults: number; contentChars: number; includeDomains?: readonly string[] },
): boolean {
  const cachedMax = cached.maxResults ?? 4;
  const cachedChars = cached.contentChars ?? DEFAULT_CONTENT_CHARS;
  return cachedMax >= request.maxResults && cachedChars >= request.contentChars && sameDomains(cached.includeDomains, request.includeDomains);
}

/**
 * Two queries are the same question when they differ only in case or spacing.
 *
 * The same rule `runs.ts`'s own `sameQuestion` applies on the `latest.json`
 * fast path — repeated here because that one is private to the module that
 * owns the pointer, and the size-aware lookup below needs it for the
 * historical scan the pointer cannot answer (see `findServingRun`). If the
 * two ever disagree the symptom is a redundant refetch, never a wrong answer.
 */
function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The newest recorded run that asked this question AND is fresh enough AND
 * was fetched at least as broad/deep as this request, or `undefined`.
 *
 * The pointer read comes first, because that is the common case and it is one
 * store read whatever the history's size. The scan happens only when the
 * pointer's record exists but cannot serve THIS request — a `latest.json`
 * keyed on the query alone cannot distinguish "the last pull of this question"
 * from "the last DEEP pull of this question", and without the scan an
 * interleaved shallow/deep (or open/domain-restricted) pair of callers would
 * refetch each other's answer forever.
 */
async function findServingRun(
  store: WorkspaceStoreLike,
  clientSlug: string,
  job: string,
  query: string,
  request: { windowMs: number; maxResults: number; contentChars: number; includeDomains?: readonly string[] },
): Promise<{ record: PullRunRecord; ageMs: number } | undefined> {
  const usable = (record: PullRunRecord | undefined): { record: PullRunRecord; ageMs: number } | undefined => {
    if (record === undefined) return undefined;
    const ageMs = Date.now() - record.at;
    if (ageMs > request.windowMs) return undefined;
    return servesRequest(record, request) ? { record, ageMs } : undefined;
  };

  const pointed = (await latestRunForQuery(store, clientSlug, job, query)) as PullRunRecord | undefined;
  const fromPointer = usable(pointed);
  if (fromPointer) return fromPointer;
  if (pointed === undefined) return undefined;

  for (const record of (await listRuns(store, clientSlug, job)) as PullRunRecord[]) {
    if (!sameQuestion(record.query, query)) continue;
    const hit = usable(record);
    if (hit) return hit;
  }
  return undefined;
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
    description:
      "Egress-bound, cached, freshness-enforced research fetch: a cached run inside window is returned as-is; otherwise real external sources are fetched via the configured scraper. Reports not_available naming the missing credential when no scraper is configured, rather than drafting from a placeholder payload.",
    version: TOOL_VERSION,
    inputSchema: PullInputSchema,
    async execute(rawInput, { ctx }) {
      // See karos-media/src/find-images.ts's identical comment: `defineTool` already
      // parsed `rawInput` against `PullInputSchema` (defaults applied) before calling
      // this — this cast reflects that instead of a second, actually-redundant `.parse()`.
      const input = rawInput as z.output<typeof PullInputSchema>;
      const { job, query, window, maxResults, contentChars, includeDomains } = input;
      const windowMs = parseDurationMs(window);
      // Keyed on the QUESTION, not just the job. Keyed on the job alone, a
      // second instagram run the same day reused the first one's research
      // whatever its own subject was — see `latestRunForQuery`.
      const cached = await findServingRun(store, ctx.clientSlug, job, query, {
        windowMs,
        maxResults,
        contentChars,
        ...(includeDomains ? { includeDomains } : {}),
      });

      if (cached) {
        const { record, ageMs } = cached;
        return success<PullResult>({ runId: record.runId, query: record.query, result: record.result, fromCache: true, ageMs });
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
        const records = await scraper.searchKeyword(query, { limit: maxResults, ...(includeDomains && includeDomains.length > 0 ? { includeDomains } : {}) });
        documents = records.map((r) => toDocument(r, contentChars));
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
      // SCRUM-321 (AU37) — additive, and deliberately a separate call rather
      // than a new branch inside `buildHistory`: this reads a stored document,
      // never the network, and folding it into the scraper-driven history
      // builder would entangle a free local read with billed egress.
      const visualPatterns = await buildVisualPatterns(store, ctx.clientSlug, input);

      const result: ResearchPayload = {
        provider: scraper.name,
        query,
        fetchedAt: new Date().toISOString(),
        documents,
        ...(history ? { history } : {}),
        ...(visualPatterns ? { visualPatterns } : {}),
        ...(documents.length === 0
          ? { note: `${scraper.name} returned no results for this query; no external facts are available for this run.` }
          : {}),
      };

      const runId = randomUUID();
      // The size annotations ride along with the record so the NEXT call can
      // tell whether this answer is deep enough for it (`servesRequest`).
      const record: PullRunRecord = {
        job,
        runId,
        query,
        result,
        at: Date.now(),
        maxResults,
        contentChars,
        ...(includeDomains ? { includeDomains } : {}),
      };
      await writeRunRecord(store, ctx.clientSlug, record);

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

/**
 * SCRUM-321 (AU37) — the visual half of the account-history read path.
 *
 * Assembles the client's own learned house style, or returns `undefined` and
 * leaves the key off the payload entirely. Four things make it `undefined`,
 * and only one of them is a problem:
 *
 * - the caller did not opt in (`includeVisualPatterns` defaults to false, so
 *   no existing caller's payload changes shape);
 * - the client's consent is not currently `granted`. Consent gates
 *   `media.ingestVisualPatterns`' scrape at ingestion time; re-checking it
 *   here means a client who withdraws consent stops having their own history
 *   steer their copy on the very next run, not on the next re-ingestion that
 *   may never come. `media.getVisualPatterns` stays ungated so a human can
 *   always still read and correct what was stored;
 * - no profile has been ingested yet;
 * - the store read failed, which is logged as a payload `note` nowhere and
 *   simply degrades — same posture as `buildHistory`: losing the aesthetic
 *   reference is a quality regression, not a reason to publish nothing.
 *
 * Written as a standalone function taking `(store, clientSlug, input)` rather
 * than as a branch inside `buildHistory` so it is trivially separable: nothing
 * above it changed except one `await` and one spread in the payload literal.
 */
async function buildVisualPatterns(
  store: WorkspaceStoreLike,
  clientSlug: string,
  input: z.infer<typeof PullInputSchema>,
): Promise<ResearchVisualPatterns | undefined> {
  if (input.includeVisualPatterns !== true) return undefined;

  try {
    const consent = await readVisualPatternConsent(store, clientSlug);
    if (!consent.granted) return undefined;

    const profile = await readVisualPatternProfile(store, clientSlug);
    if (profile === undefined) return undefined;

    return {
      versionId: profile.versionId,
      generatedAt: profile.generatedAt,
      reviewStatus: profile.review.status,
      reference: renderVisualPatternReference(profile),
      templateHints: profile.templateHints,
    };
  } catch {
    return undefined;
  }
}
