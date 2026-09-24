import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success, toolingError } from "@agent-engine/tool-common";
import { fetchHtmlViaFetch, ScraperError, type ScrapedRecord, type ScraperProvider } from "@agent-engine/tool-karos-scraper";

// 1.0.0 — new (2026-09-24, RFC-26 Phase 1): the client's, its competitors'
// and its reference accounts' Instagram posts, hundreds at a time, ranked by
// how each performed inside its own account.
// 1.0.1: every input property carries a description (the registry test); no behaviour change.
const TOOL_VERSION = "1.0.1";

/** What one `instagram.account_posts` call bills (ScrappyCoco usage, 2026-09-24, 12 posts per call). */
export const HARVEST_CALL_COST_USD = 0.0019;
/** Posts one page returns. The vendor ignores a larger `limit`. */
const PAGE_SIZE = 12;
/** A first line longer than this is not a hook, it is a paragraph. */
const HOOK_CHARS = 140;

export type HarvestRole = "client" | "competitor" | "reference";
export type HarvestFormat = "carousel" | "reel" | "single";

export interface HarvestedPost {
  handle: string;
  role: HarvestRole;
  url: string;
  format: HarvestFormat;
  /** One full-size image per frame, in the order a reader swipes them (a reel's cover for a reel). */
  frames: string[];
  frameCount: number;
  likes: number;
  comments: number;
  /** Plays, for a reel. Absent for a still. */
  views?: number;
  postedAt?: string;
  caption: string;
  /** The caption's first line: what a reader sees before "more". */
  hook: string;
  /**
   * The account hid its like count. The vendor then reports a placeholder (3,
   * on every such post in the 2026-09-24 live harvest), so the post cannot be
   * ranked honestly and is never an exemplar.
   */
  likesHidden?: true;
  /** A giveaway or "comment X and I'll DM you" post: its comments were bought, so it ranks on likes alone. */
  commentBait?: true;
}

export interface RankedPost extends HarvestedPost {
  /** The raw performance number the percentile is taken over (see `performanceScore`). */
  score: number;
  /** 0..1, this post's rank inside its own account AND format group. */
  percentile: number;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function largestCandidateUrl(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const versions = (node as Record<string, unknown>)["image_versions2"];
  const candidates = typeof versions === "object" && versions !== null ? (versions as Record<string, unknown>)["candidates"] : undefined;
  if (!Array.isArray(candidates)) return undefined;
  // The vendor lists the largest first; sorted anyway so a reordering cannot
  // hand the judge a 150px thumbnail.
  const best = candidates
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && typeof (c as Record<string, unknown>)["url"] === "string")
    .sort((a, b) => (asNumber(b["width"]) ?? 0) - (asNumber(a["width"]) ?? 0))[0];
  return best?.["url"] as string | undefined;
}

/**
 * One vendor record as a harvested post, or `undefined` when it is not an
 * Instagram post this harvest can use.
 *
 * Reads the provider's own JSON (`outputs.json`), because the normalised
 * record's `imageUrls` is a regex over the whole payload: every resolution of
 * every frame plus the author's avatar, in no order. A judge shown that sees
 * the same slide six times and a profile picture.
 */
export function instagramPostFromRecord(record: ScrapedRecord, handle: string, role: HarvestRole): HarvestedPost | undefined {
  const raw = record.raw as Record<string, unknown> | undefined;
  const outputs = raw !== undefined && typeof raw["outputs"] === "object" && raw["outputs"] !== null ? (raw["outputs"] as Record<string, unknown>) : undefined;
  const json = outputs !== undefined && typeof outputs["json"] === "object" && outputs["json"] !== null ? (outputs["json"] as Record<string, unknown>) : undefined;
  if (json === undefined) return undefined;

  const productType = typeof json["product_type"] === "string" ? json["product_type"] : undefined;
  const carousel = Array.isArray(json["carousel_media"]) ? (json["carousel_media"] as unknown[]) : [];
  const format: HarvestFormat = productType === "clips" ? "reel" : carousel.length > 0 || productType === "carousel_container" ? "carousel" : "single";
  const frames = (format === "carousel" ? carousel.map(largestCandidateUrl) : [largestCandidateUrl(json)]).filter((u): u is string => u !== undefined);
  if (frames.length === 0) return undefined;

  const caption = (() => {
    const c = json["caption"];
    const text = typeof c === "object" && c !== null ? (c as Record<string, unknown>)["text"] : undefined;
    return typeof text === "string" ? text : (record.text ?? "");
  })().trim();
  const firstLine = caption.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
  const takenAt = asNumber(json["taken_at"]);
  const likesHidden = json["like_and_view_counts_disabled"] === true;
  const commentBait = COMMENT_BAIT.test(caption);
  const views = format === "reel" ? (asNumber(json["play_count"]) ?? asNumber(json["ig_play_count"]) ?? asNumber(json["view_count"]) ?? record.engagement?.views) : undefined;

  return {
    handle: handle.replace(/^@+/u, "").toLowerCase(),
    role,
    url: record.url,
    format,
    frames,
    frameCount: format === "carousel" ? (asNumber(json["carousel_media_count"]) ?? frames.length) : 1,
    likes: asNumber(json["like_count"]) ?? record.engagement?.likes ?? 0,
    comments: asNumber(json["comment_count"]) ?? record.engagement?.comments ?? 0,
    ...(views !== undefined ? { views } : {}),
    ...(takenAt !== undefined ? { postedAt: new Date(takenAt * 1000).toISOString() } : record.publishedAt !== undefined ? { postedAt: record.publishedAt } : {}),
    caption,
    hook: firstLine.length > HOOK_CHARS ? `${firstLine.slice(0, HOOK_CHARS - 1).trimEnd()}…` : firstLine,
    ...(likesHidden ? { likesHidden: true as const } : {}),
    ...(commentBait ? { commentBait: true as const } : {}),
  };
}

/**
 * Captions that buy comments. From the live harvest: "Three winners will each
 * receive $500 … HOW TO ENTER" (2,831 comments on 740 likes), "Comment
 * \u201cOpus\u201d and I'll send you the link", "Comment OUTFIT below to receive a DM".
 */
const COMMENT_BAIT =
  /\b(giveaway|how to enter|to enter|winners? (?:will|gets?)|tag (?:a|your|\d+) friends?|comment\s+["\u201c\u2018']?[\p{L}\p{N}]+["\u201d\u2019']?\s+(?:and|to|below|for)|comment below to|dm (?:me|us) ["\u201c]?\w+)/iu;

/**
 * The number a post is ranked on. A comment costs a reader more than a like,
 * so it counts three (the same weight `media.ingestVisualPatterns` uses). A
 * reel is ranked on plays, which is what a reel is for; likes break ties.
 */
export function performanceScore(post: HarvestedPost): number {
  if (post.format === "reel" && post.views !== undefined) return post.views + post.likes / 1000;
  return post.likes + (post.commentBait === true ? 0 : 3 * post.comments);
}

/**
 * Every post's percentile INSIDE ITS OWN ACCOUNT AND FORMAT GROUP (reels
 * apart from stills).
 *
 * Raw likes rank accounts by size, not posts by quality: a 900-like post on a
 * million-follower account is that account's median, and a 60-like post on a
 * 2,000-follower account can be the best thing it ever made. Percentiles
 * compare each post with its own account's other work, which is the only
 * comparison the harvest can make honestly (the vendor returns no reach).
 */
export function rankHarvest(posts: readonly HarvestedPost[]): RankedPost[] {
  const groups = new Map<string, HarvestedPost[]>();
  const unranked: RankedPost[] = [];
  for (const post of posts) {
    // A hidden like count leaves only a placeholder to rank on: kept in the
    // harvest (its frames are still reference material), never ranked.
    if (post.likesHidden === true && !(post.format === "reel" && post.views !== undefined)) {
      unranked.push({ ...post, score: 0, percentile: 0 });
      continue;
    }
    const key = `${post.handle}|${post.format === "reel" ? "reel" : "still"}`;
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }
  const ranked: RankedPost[] = [];
  for (const group of groups.values()) {
    const scored = group.map((post) => ({ post, score: performanceScore(post) })).sort((a, b) => a.score - b.score);
    scored.forEach(({ post, score }, index) => {
      ranked.push({ ...post, score, percentile: scored.length === 1 ? 0.5 : index / (scored.length - 1) });
    });
  }
  return [...ranked.sort((a, b) => b.percentile - a.percentile || b.score - a.score), ...unranked];
}

/**
 * The exemplar set: each account's top share, interleaved across roles so the
 * client's own winners are never crowded out by a competitor with more posts.
 */
export function selectExemplars(ranked: readonly RankedPost[], options: { topShare?: number; max?: number } = {}): RankedPost[] {
  const topShare = options.topShare ?? 0.25;
  const max = options.max ?? 60;
  const byAccount = new Map<string, RankedPost[]>();
  for (const post of ranked) {
    if (post.likesHidden === true && post.score === 0) continue;
    byAccount.set(post.handle, [...(byAccount.get(post.handle) ?? []), post]);
  }
  const queues = [...byAccount.values()].map((posts) => {
    const sorted = [...posts].sort((a, b) => b.percentile - a.percentile || b.score - a.score);
    return sorted.slice(0, Math.max(1, Math.ceil(sorted.length * topShare)));
  });
  const roleOrder: HarvestRole[] = ["client", "competitor", "reference"];
  queues.sort((a, b) => roleOrder.indexOf(a[0]!.role) - roleOrder.indexOf(b[0]!.role));
  const picked: RankedPost[] = [];
  while (picked.length < max && queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next !== undefined && picked.length < max) picked.push(next);
    }
  }
  return picked;
}

/** Paths under instagram.com that are not an account. */
const NOT_A_HANDLE = new Set(["p", "reel", "reels", "explore", "stories", "accounts", "tv", "direct", "about", "legal", "developer", "web", "share", "sharer", "static", "images"]);

/** The Instagram handles a web page links to, in order of appearance. Never guessed: a site with no link yields none. */
export function instagramHandlesFromHtml(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/instagram\.com\/([A-Za-z0-9_.]{1,30})(?=[/"'?#\s<]|$)/giu)) {
    const handle = match[1]!.toLowerCase().replace(/\.+$/u, "");
    if (handle.length === 0 || NOT_A_HANDLE.has(handle) || found.includes(handle)) continue;
    found.push(handle);
  }
  return found;
}

/** Pages one account until `maxPosts`, the `since` date, or the end of its history. */
export async function harvestAccount(
  scraper: ScraperProvider,
  account: { handle: string; role: HarvestRole },
  options: { maxPosts: number; since: Date },
): Promise<{ posts: HarvestedPost[]; calls: number }> {
  if (scraper.socialHistoryPage === undefined) throw new ScraperError(`${scraper.name} cannot page an account's history`);
  const posts: HarvestedPost[] = [];
  let cursor: string | undefined;
  let calls = 0;
  const maxCalls = Math.ceil(options.maxPosts / PAGE_SIZE) + 2;
  while (posts.length < options.maxPosts && calls < maxCalls) {
    const page = await scraper.socialHistoryPage({ platform: "instagram", username: account.handle, limit: PAGE_SIZE, ...(cursor !== undefined ? { cursor } : {}) });
    calls += 1;
    let reachedSince = false;
    for (const record of page.records) {
      const post = instagramPostFromRecord(record, account.handle, account.role);
      if (post === undefined) continue;
      if (post.postedAt !== undefined && new Date(post.postedAt) < options.since) {
        // Pinned posts come first and can be old: only stop when a page's
        // UNPINNED tail is past the window, approximated by the last record.
        reachedSince = record === page.records[page.records.length - 1];
        continue;
      }
      if (posts.length < options.maxPosts) posts.push(post);
    }
    if (reachedSince || page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return { posts, calls };
}

export interface HarvestAccountSummary {
  handle: string;
  role: HarvestRole;
  posts: number;
  formatShare: Record<HarvestFormat, number>;
  /** Median frames per carousel, the length this account's readers actually swipe. */
  medianCarouselFrames?: number;
  /** Median `performanceScore` per format, so "what this audience rewards" is a number. */
  medianScoreByFormat: Partial<Record<HarvestFormat, number>>;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeAccounts(posts: readonly HarvestedPost[]): HarvestAccountSummary[] {
  const byAccount = new Map<string, HarvestedPost[]>();
  for (const post of posts) byAccount.set(post.handle, [...(byAccount.get(post.handle) ?? []), post]);
  return [...byAccount.entries()].map(([handle, list]) => {
    const formats: HarvestFormat[] = ["carousel", "reel", "single"];
    const share = Object.fromEntries(formats.map((f) => [f, Math.round((list.filter((p) => p.format === f).length / list.length) * 100) / 100])) as Record<HarvestFormat, number>;
    const medianScoreByFormat: Partial<Record<HarvestFormat, number>> = {};
    for (const f of formats) {
      const m = median(list.filter((p) => p.format === f).map(performanceScore));
      if (m !== undefined) medianScoreByFormat[f] = m;
    }
    const frames = median(list.filter((p) => p.format === "carousel").map((p) => p.frameCount));
    return { handle, role: list[0]!.role, posts: list.length, formatShare: share, ...(frames !== undefined ? { medianCarouselFrames: frames } : {}), medianScoreByFormat };
  });
}

const HandleSchema = z.string().min(1).max(31).regex(/^@?[A-Za-z0-9_.]+$/u, "an Instagram handle: letters, digits, _ and .");

export const HarvestInstagramExemplarsInputSchema = z.object({
  accounts: z
    .array(z.object({ handle: HandleSchema, role: z.enum(["client", "competitor", "reference"]) }))
    .max(15)
    .default([])
    .describe("Instagram accounts to harvest, each labelled with its role."),
  competitorSites: z
    .array(z.object({ name: z.string().min(1), website: z.string().url() }))
    .max(10)
    .default([])
    .describe("Competitors known only by website: each home page is fetched (free) and its instagram.com link, if any, becomes a competitor account. Never guessed."),
  maxPostsPerAccount: z.number().int().min(12).max(300).default(120).describe("Posts to read per account (12 per billed call, ~$0.0019 each)."),
  sinceDays: z.number().int().min(30).max(1095).default(365).describe("How far back to read; older posts are not harvested."),
  exemplarsMax: z.number().int().min(10).max(120).default(60).describe("How many exemplars to return across all accounts (each account's top quarter, interleaved)."),
});
export type HarvestInstagramExemplarsInput = z.input<typeof HarvestInstagramExemplarsInputSchema>;

export interface HarvestInstagramExemplarsResult {
  accounts: HarvestAccountSummary[];
  exemplars: RankedPost[];
  postCount: number;
  problems: string[];
  calls: number;
  estimatedCostUsd: number;
  /** Workspace segments of the stored harvest (every ranked post), under the client. */
  storedAt: string[];
  /** Which Instagram handles each competitor's own site linked, so a wrong resolution is visible. */
  resolvedFromSites: Array<{ name: string; website: string; handles: string[] }>;
}

/**
 * `research.harvestInstagramExemplars` — RFC-26 Phase 1.
 *
 * Reads hundreds of posts across the client's, its competitors' and its
 * reference accounts, ranks each inside its own account and format, and keeps
 * the top of each as exemplars. The whole ranked harvest is stored under
 * `exemplars/harvest-<date>` for the Phase 2 judge and the Phase 3 setup
 * consumers; the tool returns the summary and the exemplars.
 *
 * Harvested images are REFERENCE material. Nothing here offers them to the
 * picture cascade, and nothing downstream may republish them.
 */
export function createInstagramExemplarHarvest(store: WorkspaceStoreLike, scraper?: ScraperProvider, fetchImpl: typeof fetch = fetch) {
  return defineTool<HarvestInstagramExemplarsInput, HarvestInstagramExemplarsResult>({
    name: "research.harvestInstagramExemplars",
    description:
      "Harvests up to hundreds of Instagram posts from the client's, its competitors' and its reference accounts, ranks every post by percentile inside its own account and format (likes + 3·comments; reels by plays), and returns the top of each account as exemplars with every frame's image URL. Competitors known only by website are resolved to a handle from the site's own instagram.com link. Reference material only: never republished.",
    version: TOOL_VERSION,
    inputSchema: HarvestInstagramExemplarsInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof HarvestInstagramExemplarsInputSchema>;
      if (scraper === undefined || scraper.socialHistoryPage === undefined) {
        return notAvailable("research.harvestInstagramExemplars: no paging scraper is configured — set SCRAPPYCOCO_API_KEY");
      }
      const problems: string[] = [];
      /** Each account and, for one resolved from a site, the other handles that site linked (tried in order when one is empty). */
      const accounts = new Map<string, { role: HarvestRole; alternates: string[]; site?: string }>();
      for (const account of input.accounts) accounts.set(account.handle.replace(/^@+/u, "").toLowerCase(), { role: account.role, alternates: [] });
      const resolvedFromSites: Array<{ name: string; website: string; handles: string[] }> = [];
      for (const site of input.competitorSites) {
        const page = await fetchHtmlViaFetch(site.website, fetchImpl, 15_000).catch(() => undefined);
        const handles = page !== undefined ? instagramHandlesFromHtml(page.html) : [];
        resolvedFromSites.push({ name: site.name, website: site.website, handles });
        if (handles.length === 0) {
          problems.push(`${site.name}: no instagram.com link on ${site.website}, so no account was harvested`);
          continue;
        }
        if (!accounts.has(handles[0]!)) accounts.set(handles[0]!, { role: "competitor", alternates: handles.slice(1, 3), site: site.name });
      }
      if (accounts.size === 0) return toolingError("research.harvestInstagramExemplars: no account to harvest — pass accounts or competitor sites with an Instagram link");

      const since = new Date(Date.now() - input.sinceDays * 86_400_000);
      const harvested: HarvestedPost[] = [];
      let calls = 0;
      for (const [first, { role, alternates, site }] of accounts) {
        // Negative Underwear's site links `instagram.com/negative` (silent)
        // before `instagram.com/negativeunderwear` (live): the first handle
        // with posts is the account.
        for (const handle of [first, ...alternates]) {
          try {
            const result = await harvestAccount(scraper, { handle, role }, { maxPosts: input.maxPostsPerAccount, since });
            calls += result.calls;
            harvested.push(...result.posts);
            if (result.posts.length > 0) break;
            problems.push(`@${handle}${site !== undefined ? ` (linked from ${site}'s site)` : ""}: no posts inside the last ${input.sinceDays} days`);
          } catch (error) {
            if (error instanceof ScraperError) {
              problems.push(`could not read @${handle}: ${error.message}`);
              continue;
            }
            throw error;
          }
        }
      }
      if (harvested.length === 0) return toolingError(`research.harvestInstagramExemplars: nothing could be harvested — ${problems.join("; ")}`);

      const ranked = rankHarvest(harvested);
      const exemplars = selectExemplars(ranked, { max: input.exemplarsMax });
      const summary = summarizeAccounts(harvested);
      const storedAt = ["exemplars", `harvest-${new Date().toISOString().slice(0, 10)}`];
      await store.writeJson(ctx.clientSlug, storedAt, {
        version: 1,
        harvestedAt: new Date().toISOString(),
        accounts: summary,
        exemplars,
        posts: ranked,
        problems,
        calls,
        resolvedFromSites,
      });
      return success<HarvestInstagramExemplarsResult>({
        accounts: summary,
        exemplars,
        postCount: harvested.length,
        problems,
        calls,
        estimatedCostUsd: Math.round(calls * HARVEST_CALL_COST_USD * 10_000) / 10_000,
        storedAt,
        resolvedFromSites,
      });
    },
  });
}
