import { normalizeForSimilarity, shingles, type AgentContext, type AgentToolRegistry } from "@agent-engine/core";
import type { TopicSignalsForScout } from "@agent-engine/workflow";
import type { ClientBrief, SocialHistoryPost } from "@agent-engine/tools";

/**
 * The five topic engines (RFC-13 §I, 2026-09) — where an Instagram subject
 * can come from, beyond this week's niche news.
 *
 * ## What was wrong
 *
 * Prep audit 2026-09-08: with one source of candidates (the news pull behind
 * `03b`), five consecutive auto runs landed on the same subject. Even after
 * Phase 0 made the scout run on every run, a week with quiet news has nothing
 * to offer a client whose feed still has to publish — while the engine was
 * already holding four other kinds of evidence and reading none of them for
 * topic selection: what the accounts the client's audience actually follows
 * posted and how it landed, what that audience is asking in public, the
 * client's own case studies and data, and the evergreen angles their brief
 * names.
 *
 * ## What this does
 *
 * Pure helpers plus ONE orchestrating function (`gatherTopicSignals`, called
 * inside the workflow's `03e-topic-signals` code step) that assembles those
 * four engines into the `signals` object the scout reads alongside the news
 * digest. Engine 1 (niche news) is `03b`'s merged pull and is not repeated
 * here.
 *
 * Three properties are load-bearing:
 *
 * - **Every source is best-effort.** A missing reference account, an
 *   unconfigured scraper or a search that answers with nothing produces a
 *   NOTE naming the gap, never a thrown error and never a hold: the run still
 *   has the news digest, the request or the catalog row.
 * - **The ranking is deterministic.** Only the scout (one Flash call,
 *   unchanged in count) uses a model; per-account engagement normalisation,
 *   question filtering and the final ranking (`rankTopicCandidates` in
 *   `topic-selection.ts`) are code, so the same evidence always produces the
 *   same subject and a reviewer can be told why.
 * - **The cost is bounded.** ≤ 6 `socialHistory` accounts on a 24 h cache
 *   (shared with `04e`) and 2 community queries on a 7 d cache: ≈ $0.056 cold,
 *   ≈ $0 warm, against a $1.00 per-run target.
 */

// ─────────────────────────────────────────────────────────────────────────
// Bounds. Every one of these is a token or vendor bill, not a preference.
// ─────────────────────────────────────────────────────────────────────────

/** Reference accounts read per run. The brief allows 7; `research.socialHistory` bills one scrape per account and caps at 6. */
export const MAX_REFERENCE_ACCOUNTS = 6;
/** A post older than this says nothing about what lands NOW, and its engagement has finished accruing while a fresh post's has not. */
export const REFERENCE_POST_MAX_AGE_DAYS = 30;
/** How many peer posts reach the prompt. Eight is enough to show a pattern across three or four accounts without crowding out the news digest. */
export const MAX_REFERENCE_POSTS = 8;
/** Community questions carried forward. */
export const MAX_AUDIENCE_QUESTIONS = 8;
/** Own-asset rows carried forward (the brief's own list plus document headings). */
export const MAX_OWN_ASSET_SIGNALS = 8;
/** Evergreen angles carried forward — the brief's schema caps its own list at 8. */
export const MAX_EVERGREEN_SIGNALS = 8;
/** Documents per community query. Six answers is a sample of what is being asked, not an archive. */
export const COMMUNITY_QUERY_MAX_RESULTS = 6;
/** How much of a peer post or an asset summary travels into the prompt. */
const EXCERPT_CHARS = 320;
const SUMMARY_CHARS = 240;
/** Search engines degrade on long natural-language input; the grounded-query ceiling applies here too. */
const MAX_QUERY_CHARS = 200;

/**
 * Where public questions actually get asked. Passed to `research.pull` as
 * `includeDomains` (added in RFC-13 §J): a plain web search for a question
 * phrase returns SEO articles shaped like questions, which is the opposite of
 * evidence that a human asked one.
 */
export const COMMUNITY_DOMAINS = ["reddit.com", "quora.com", "news.ycombinator.com", "stackexchange.com"] as const;

/** The research job name — namespaces the 7 d cache away from `03b`'s trend scan and `04a`'s subject research. */
export const AUDIENCE_QUESTIONS_JOB = "instagram-audience-questions";

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────
// Small text helpers (Unicode-aware: Hebrew is a first-class target).
// ─────────────────────────────────────────────────────────────────────────

function normalise(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function clamp(text: string, max: number): string {
  const t = normalise(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:(\-]+$/u, "");
}

/**
 * Share of `a`'s word trigrams that also appear in `b`, over the SMALLER set —
 * containment, not Jaccard. A four-word evergreen angle ("how pricing pages
 * lie") inside a 60-word excerpt of last week's post scores near 1 on
 * containment and near 0.05 on Jaccard, and it is the same subject either way.
 */
function trigramContainment(a: string, b: string): number {
  const setA = shingles(a);
  const setB = shingles(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let hits = 0;
  for (const shingle of setA) if (setB.has(shingle)) hits++;
  return hits / Math.min(setA.size, setB.size);
}

/** Above this share of shared trigrams, two subjects are the same subject. Calibrated on containment (see above), not on `DEDUPE_SIMILARITY_THRESHOLD`, which is a Jaccard number. */
const CONTAINMENT_OVERLAP = 0.6;

/** True when `text` repeats something already covered — plain containment first (cheap, catches "AI triage" inside a headline), then trigram containment. */
function overlapsCovered(text: string, covered: readonly string[]): boolean {
  const t = normalizeForSimilarity(text);
  if (t.length === 0) return false;
  return covered.some((raw) => {
    const c = normalizeForSimilarity(raw);
    if (c.length === 0) return false;
    if (t.includes(c) || c.includes(t)) return true;
    return trigramContainment(t, c) >= CONTAINMENT_OVERLAP;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 2 — reference accounts: what peers posted, and what landed
// ─────────────────────────────────────────────────────────────────────────

/**
 * Raw engagement on one post, as a single comparable number.
 *
 * `likes + 3·comments + views/50`, then `log1p`. The weights say what the
 * signal is worth: a comment is a reader who stopped and typed, worth several
 * likes; views are a reach number the platform inflates, worth a fiftieth.
 * `log1p` because engagement is multiplicative — the gap between 10 and 100 is
 * the interesting one, and without the log a single viral post would set the
 * scale for the whole account and flatten every other post to zero.
 *
 * Missing fields count as 0 (not "unknown"), because `research.socialHistory`
 * omits what the provider did not return, and a post nobody engaged with looks
 * exactly the same as one whose counts were not scraped. The recency
 * tie-breaker in `scoreReferencePosts` is what carries an account whose
 * provider reports no counts at all.
 */
function rawEngagement(post: Pick<SocialHistoryPost, "engagement">): number {
  const e = post.engagement ?? {};
  const likes = typeof e.likes === "number" && Number.isFinite(e.likes) ? Math.max(0, e.likes) : 0;
  const comments = typeof e.comments === "number" && Number.isFinite(e.comments) ? Math.max(0, e.comments) : 0;
  const views = typeof e.views === "number" && Number.isFinite(e.views) ? Math.max(0, e.views) : 0;
  return Math.log1p(likes + 3 * comments + views / 50);
}

/** An account needs at least this many posts before its own mean and spread mean anything. */
const MIN_POSTS_FOR_ZSCORE = 3;
/**
 * The absolute log scale a one-or-two-post account is measured on: `log1p` of
 * about a thousand interactions reads as 1.0. Only used when there is no
 * within-account distribution to compare against.
 */
const RAW_ENGAGEMENT_FULL_SCALE = Math.log1p(1000);
/** A z-score of +2 (two standard deviations above the account's own mean) reads as 1.0. */
const ZSCORE_FULL_SCALE = 4;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function accountKey(post: Pick<SocialHistoryPost, "platform" | "username">): string {
  return `${post.platform}/@${post.username.replace(/^@/u, "").toLowerCase()}`;
}

/**
 * The peer posts worth showing the scout, strongest first.
 *
 * Normalised WITHIN each account, which is the whole point: a 200k-follower
 * publication's median post out-engages a 2k-follower practitioner's best post
 * every time, and the practitioner's outlier is the one that tells us what
 * this audience actually stops for. So each account's posts are z-scored
 * against that account's own mean and spread, and only then compared across
 * accounts. An account with fewer than three posts has no distribution to
 * score against and falls back to the absolute log scale.
 *
 * Posts older than 30 days are dropped; a post with no usable date is KEPT
 * (a provider that omits dates must not silently empty the engine).
 */
export function scoreReferencePosts(posts: readonly SocialHistoryPost[], options: { now?: Date } = {}): TopicSignalsForScout["referencePosts"] {
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - REFERENCE_POST_MAX_AGE_DAYS * DAY_MS;

  const fresh = posts.filter((post) => {
    const text = (post.excerpt ?? "").trim();
    if (text.length === 0 || typeof post.url !== "string" || post.url.length === 0) return false;
    if (post.publishedAt === undefined) return true;
    const at = Date.parse(post.publishedAt);
    return Number.isNaN(at) ? true : at >= cutoff;
  });

  const byAccount = new Map<string, SocialHistoryPost[]>();
  for (const post of fresh) {
    const key = accountKey(post);
    const bucket = byAccount.get(key);
    if (bucket) bucket.push(post);
    else byAccount.set(key, [post]);
  }

  const scored: Array<{ post: SocialHistoryPost; engagementScore: number }> = [];
  for (const bucket of byAccount.values()) {
    const raws = bucket.map((post) => rawEngagement(post));
    if (bucket.length >= MIN_POSTS_FOR_ZSCORE) {
      const mean = raws.reduce((sum, r) => sum + r, 0) / raws.length;
      const variance = raws.reduce((sum, r) => sum + (r - mean) ** 2, 0) / raws.length;
      const sd = Math.sqrt(variance);
      bucket.forEach((post, i) => {
        // sd === 0: every post performed identically (commonly: the provider
        // returned no counts at all). Everything sits at the midpoint and the
        // recency tie-breaker below decides.
        const z = sd === 0 ? 0 : (raws[i]! - mean) / sd;
        scored.push({ post, engagementScore: clamp01(0.5 + z / ZSCORE_FULL_SCALE) });
      });
    } else {
      bucket.forEach((post, i) => {
        scored.push({ post, engagementScore: clamp01(raws[i]! / RAW_ENGAGEMENT_FULL_SCALE) });
      });
    }
  }

  const at = (post: SocialHistoryPost): number => {
    if (post.publishedAt === undefined) return 0;
    const parsed = Date.parse(post.publishedAt);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  return scored
    .sort((a, b) => b.engagementScore - a.engagementScore || at(b.post) - at(a.post) || a.post.url.localeCompare(b.post.url))
    .slice(0, MAX_REFERENCE_POSTS)
    .map(({ post, engagementScore }) => ({
      platform: post.platform,
      handle: post.username.replace(/^@/u, ""),
      url: post.url,
      excerpt: clamp(post.excerpt, EXCERPT_CHARS),
      ...(post.publishedAt !== undefined ? { publishedAt: post.publishedAt } : {}),
      engagementScore: round3(engagementScore),
    }));
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 3 — audience questions
// ─────────────────────────────────────────────────────────────────────────

/**
 * Two queries, from the brief rather than from the industry name.
 *
 * The first is the vocabulary question: the client's two core terms as a
 * phrase, plus the words a real question carries (`how OR why OR anyone`), so
 * the index returns threads rather than landing pages. The second is the
 * person question: who the ICP is and what hurts, which surfaces the threads a
 * practitioner opened about their own problem.
 *
 * Two and not four: each is a billed scrape on a 7 d cache, and the ceiling
 * for this whole engine is $0.014 per cold run.
 */
export function buildCommunityQueries(brief: ClientBrief): string[] {
  const terms = brief.coreTerms.map((t) => normalise(t)).filter((t) => t.length > 0);
  const queries: string[] = [];

  const phrase = terms.slice(0, 2).join(" ");
  if (phrase.length > 0) queries.push(`"${phrase}" how OR why OR anyone`);

  const who = normalise(brief.icp.roles[0] ?? brief.icp.summary);
  const pain = normalise(brief.icp.pains[0] ?? terms[2] ?? terms[0] ?? "");
  const person = [clamp(who, 90), clamp(pain, 90)].filter((p) => p.length > 0).join(" ");
  if (person.length > 0) queries.push(person);

  const seen = new Set<string>();
  return queries
    .map((q) => clamp(q, MAX_QUERY_CHARS))
    .filter((q) => {
      const key = q.toLowerCase();
      if (q.length === 0 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * A line that reads as a question a person asked. Either it carries a question
 * mark, or it OPENS with an interrogative — a thread title is often stripped of
 * its "?" by the platform.
 *
 * `(?=\s|$|[?!,.'’"])` and not `\b`: `\b` is ASCII-only in JavaScript and
 * never fires after a Hebrew letter, so an anchored `\b` would silently drop
 * every Hebrew question (the same trap `client-brief.ts`'s DIRECTION_OPENER
 * documents).
 */
const QUESTION_OPENER =
  /^\s*(?:how|why|what|should|is|can|does|anyone|איך|למה|מה|האם|כדאי|מישהו)(?=\s|$|[?!,.'’"])/iu;

/** A question shorter than this is a fragment ("why?"), and one longer is a paragraph — clamped, not dropped. */
const MIN_QUESTION_CHARS = 12;

function looksLikeQuestion(line: string): boolean {
  if (line.length < MIN_QUESTION_CHARS) return false;
  return line.includes("?") || QUESTION_OPENER.test(line);
}

/** The community a URL belongs to (`reddit.com`), for the prompt to say where the question was asked. */
function communityOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return undefined;
  }
}

/**
 * The questions out of a community search's documents: the title first, then
 * the first line of the body (a Reddit thread's title is the question; a Q&A
 * page's title is sometimes the site name).
 *
 * A document with no URL is skipped — a question the copy cannot cite back to
 * a real thread is exactly the unsourced "audiences are asking…" claim this
 * engine exists to replace.
 */
export function extractCommunityQuestions(
  docs: ReadonlyArray<{ title?: string | undefined; url?: string | undefined; content?: string | undefined }>,
): TopicSignalsForScout["audienceQuestions"] {
  const out: TopicSignalsForScout["audienceQuestions"] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const url = typeof doc.url === "string" ? doc.url.trim() : "";
    if (url.length === 0) continue;
    const firstBodyLine = (doc.content ?? "")
      .split(/\r?\n/u)
      .map((l) => normalise(l.replace(/^[\s#>*+•-]+/u, "")))
      .find((l) => l.length > 0);
    for (const raw of [doc.title, firstBodyLine]) {
      const line = normalise(raw ?? "");
      if (!looksLikeQuestion(line)) continue;
      const question = clamp(line, 200);
      const key = normalizeForSimilarity(question);
      if (key.length === 0 || seen.has(key)) break;
      seen.add(key);
      const community = communityOf(url);
      out.push({ question, url, ...(community !== undefined ? { community } : {}) });
      // One question per document: the title and its own first body line are
      // the same question phrased twice.
      break;
    }
    if (out.length >= MAX_AUDIENCE_QUESTIONS) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 4 — the client's own assets
// ─────────────────────────────────────────────────────────────────────────

/** A markdown heading, any level. */
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/u;
/** A heading worth a post carries a figure or a date … */
const HEADING_HAS_FIGURE = /\d/u;
/** … or names something specific: two consecutive capitalised words (a customer, a product, a place) or a quoted name. */
const HEADING_HAS_PROPER_NOUN = /(?:\p{Lu}\p{L}+\s+\p{Lu}\p{L}+)|["“”'’«][^"“”'’»]{3,}["“”'’»]/u;

/**
 * The client's own material a post could be built on: the brief's `ownAssets`
 * first (an agent-written brief lists case studies and events by name), then
 * headings from the product-information and market-strategy documents that
 * carry a NUMBER, a date or a proper noun.
 *
 * The heading filter is the whole trick. "Our approach" is a heading; "How
 * Northwind cut onboarding to 3 days" is an asset. Scripts without letter case
 * (Hebrew, Arabic) match on the figure rule only — which is the honest
 * behaviour: there is no case signal to read.
 */
export function ownAssetSignals(
  brief: Pick<ClientBrief, "ownAssets">,
  contextDocs: { productInformation?: string | undefined; marketStrategy?: string | undefined },
): TopicSignalsForScout["ownAssets"] {
  const out: TopicSignalsForScout["ownAssets"] = [];
  const seen = new Set<string>();
  const push = (title: string, summary: string, sourceRef: string): void => {
    const t = clamp(title, 120);
    const key = normalizeForSimilarity(t);
    if (t.length === 0 || key.length === 0 || seen.has(key) || out.length >= MAX_OWN_ASSET_SIGNALS) return;
    seen.add(key);
    out.push({ title: t, summary: clamp(summary, SUMMARY_CHARS), sourceRef });
  };

  for (const asset of brief.ownAssets) push(asset.title, asset.summary, asset.sourceRef);

  for (const [docType, markdown] of [
    ["product-information", contextDocs.productInformation],
    ["market-strategy", contextDocs.marketStrategy],
  ] as const) {
    if (typeof markdown !== "string" || markdown.trim().length === 0) continue;
    const lines = markdown.split(/\r?\n/u);
    for (let i = 0; i < lines.length; i++) {
      const heading = HEADING.exec(lines[i]!.trim())?.[2];
      if (heading === undefined) continue;
      const title = normalise(heading);
      if (!HEADING_HAS_FIGURE.test(title) && !HEADING_HAS_PROPER_NOUN.test(title)) continue;
      // The first real line under the heading is what the asset says; a
      // heading followed immediately by another heading stands on its own.
      let summary = title;
      for (let j = i + 1; j < lines.length; j++) {
        const line = normalise(lines[j]!.replace(/^[\s>*+•-]+/u, ""));
        if (line.length === 0) continue;
        if (HEADING.test(lines[j]!.trim())) break;
        summary = line;
        break;
      }
      push(title, summary, `${docType}#${title}`);
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 5 — evergreen angles
// ─────────────────────────────────────────────────────────────────────────

/**
 * The brief's evergreen angles, minus anything another channel just covered.
 *
 * Evergreen is the engine most likely to repeat itself: the angles are a fixed
 * list, so without this filter the same one would be offered every week until
 * it happened to win. `avoidTopics` is the cross-channel history
 * (`crossChannelAvoidTopics`), and the comparison is trigram containment
 * because an angle is 4-8 words inside a 60-word post excerpt.
 */
export function evergreenSignals(brief: Pick<ClientBrief, "evergreenAngles">, avoidTopics: readonly string[]): string[] {
  const out: string[] = [];
  for (const angle of brief.evergreenAngles) {
    const text = normalise(angle);
    if (text.length === 0 || overlapsCovered(text, avoidTopics)) continue;
    if (!out.some((existing) => existing.toLowerCase() === text.toLowerCase())) out.push(text);
    if (out.length >= MAX_EVERGREEN_SIGNALS) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// The one orchestrating call
// ─────────────────────────────────────────────────────────────────────────

export interface GatherTopicSignalsOptions {
  /** The client brief (persisted or derived) — the authority on reference accounts, ICP, offers, evergreen angles and own assets. */
  brief: ClientBrief;
  /** The context documents step 02i already read, reused rather than re-fetched. */
  contextDocs: { productInformation?: string | undefined; marketStrategy?: string | undefined };
  /** Subjects covered on any channel (`crossChannelAvoidTopics`) — filters the evergreen engine. */
  avoidTopics: readonly string[];
  /**
   * Whether `research.pull` accepts `includeDomains` yet (RFC-13 §J). False
   * omits the field: passing it to the older tool would be silently stripped
   * and the caller would believe the community filter applied.
   */
  includeDomainsSupported: boolean;
  /** Injectable clock, so the 30-day freshness window is testable. */
  now?: Date;
}

export interface TopicSignalsGathered {
  signals: TopicSignalsForScout;
  /** One line per source that could not be read or had nothing, in the order the engines ran. Carried to the gate payload. */
  notes: string[];
  /**
   * Billed scraper executions this call made (cache hits are free), so the
   * caller's spend meter can add `STEP_COST_ESTIMATES_USD.scraperExecution`
   * per unit rather than assuming the worst case.
   */
  scraperExecutions: number;
}

/**
 * Gathers engines 2-5. Never throws: every source is wrapped, and a failure
 * becomes a note. The caller wraps this in `wf.step.code("03e-topic-signals")`
 * so a resumed run reuses the whole result.
 */
export async function gatherTopicSignals(
  tools: AgentToolRegistry,
  ctx: AgentContext,
  options: GatherTopicSignalsOptions,
): Promise<TopicSignalsGathered> {
  const notes: string[] = [];
  const brief = options.brief;
  let scraperExecutions = 0;

  // ── engine 2: reference accounts ──
  let referencePosts: TopicSignalsForScout["referencePosts"] = [];
  const accounts = brief.referenceAccounts.slice(0, MAX_REFERENCE_ACCOUNTS).map((a) => ({ platform: a.platform, username: a.handle.replace(/^@/u, "") }));
  const socialHistory = tools["research.socialHistory"];
  if (accounts.length === 0) {
    notes.push(
      "the brief names no reference accounts, so nothing was read from peer accounts (engine reference-accounts contributed nothing) — 3-7 accounts in the brief make this engine work",
    );
  } else if (socialHistory === undefined) {
    notes.push("research.socialHistory is not registered, so the reference-accounts engine was skipped");
  } else {
    try {
      // 24 h window: the same read every channel of this client makes today,
      // so the first run of the day pays and the rest are cache hits.
      const outcome = await socialHistory.execute({ accounts, window: "24h" }, { ctx });
      if (outcome.status === "success") {
        const result = outcome.result as { posts: SocialHistoryPost[]; problems: string[]; fromCache: boolean };
        if (!result.fromCache) scraperExecutions += accounts.length;
        referencePosts = scoreReferencePosts(result.posts, { ...(options.now !== undefined ? { now: options.now } : {}) });
        for (const problem of result.problems) notes.push(`reference account: ${problem}`);
        if (referencePosts.length === 0 && result.posts.length > 0) {
          notes.push(`all ${result.posts.length} reference post(s) were older than ${REFERENCE_POST_MAX_AGE_DAYS} days, so the reference-accounts engine contributed nothing`);
        }
      } else {
        notes.push(
          `the reference accounts could not be read (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}), so the reference-accounts engine contributed nothing`,
        );
      }
    } catch (error) {
      notes.push(`the reference accounts could not be read: ${(error as Error).message}`);
    }
  }

  // ── engine 3: audience questions ──
  const audienceQuestions: TopicSignalsForScout["audienceQuestions"] = [];
  const pull = tools["research.pull"];
  const queries = buildCommunityQueries(brief);
  if (pull === undefined) {
    notes.push("research.pull is not registered, so the audience-questions engine was skipped");
  } else if (queries.length === 0) {
    notes.push("the brief has no core terms or ICP to build a community query from, so the audience-questions engine was skipped");
  } else {
    if (!options.includeDomainsSupported) {
      notes.push("community queries ran without a domain filter (research.pull has no includeDomains option in this build), so some answers may not come from community sites");
    }
    const seenQuestions = new Set<string>();
    for (const query of queries) {
      try {
        const outcome = await pull.execute(
          {
            job: AUDIENCE_QUESTIONS_JOB,
            query,
            window: "7d",
            maxResults: COMMUNITY_QUERY_MAX_RESULTS,
            ...(options.includeDomainsSupported ? { includeDomains: [...COMMUNITY_DOMAINS] } : {}),
          },
          { ctx },
        );
        if (outcome.status !== "success") {
          notes.push(`community query "${query}" reported ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}`);
          continue;
        }
        const result = outcome.result as { fromCache?: boolean; result?: { documents?: ReadonlyArray<{ title?: string; url?: string; content?: string }> } };
        if (result.fromCache !== true) scraperExecutions += 1;
        const found = extractCommunityQuestions(result.result?.documents ?? []);
        if (found.length === 0) notes.push(`community query "${query}" returned nothing that reads as a question`);
        for (const question of found) {
          const key = normalizeForSimilarity(question.question);
          if (seenQuestions.has(key) || audienceQuestions.length >= MAX_AUDIENCE_QUESTIONS) continue;
          seenQuestions.add(key);
          audienceQuestions.push(question);
        }
      } catch (error) {
        notes.push(`community query "${query}" could not be run: ${(error as Error).message}`);
      }
    }
  }

  // ── engines 4 and 5: the client's own material (no network, no bill) ──
  const ownAssets = ownAssetSignals(brief, options.contextDocs);
  if (ownAssets.length === 0) {
    notes.push("no own assets: the brief lists none and no product-information or market-strategy heading carries a figure, date or name");
  }
  const evergreen = evergreenSignals(brief, options.avoidTopics);
  if (evergreen.length === 0 && brief.evergreenAngles.length > 0) {
    notes.push(`all ${brief.evergreenAngles.length} evergreen angle(s) in the brief overlap a subject another channel already covered`);
  }

  return { signals: { referencePosts, audienceQuestions, ownAssets, evergreen }, notes, scraperExecutions };
}
