import { similarity } from "@agent-engine/core";
import type { ClientBrief } from "@agent-engine/tools";
import {
  MIN_BRAND_FIT,
  candidateEngine,
  extractResearchCandidate,
  parseContentModeFromSummary,
  selectTrendCandidate,
  type ContentMode,
  type ResearchPullResult,
  type TopicEngine,
  type TopicSignalsForScout,
  type TrendCandidate,
  type TrendScoutOutput,
} from "@agent-engine/workflow";
import { INSTAGRAM_FORMATS, type InstagramFormat, type InstagramTopicClaim, type TopicAlternative, type TopicAlternativeReason, type TopicScoutStatus, type TopicWeighting } from "./types.js";

/**
 * Topic selection for the Instagram agent (RFC-13 §E, 2026-09).
 *
 * ## What was wrong
 *
 * The trend scout (`03a-03c`) ran only when step 03 had fallen through to the
 * literal `${industry} trends this week`, so a client with a healthy catalog
 * or a `requestedSubject` never saw this week's stories at all — and a client
 * without either got a QUERY as a subject, which the research step then
 * researched. Five auto runs in prep landed on the same topic. The content
 * mode rotated on `ownShippedCount % 3`, a counter that every failed or held
 * run left untouched, so the "rotation" could sit on one mode for weeks.
 *
 * ## What this does
 *
 * Pure functions the workflow's `03d-select-content-mode` and
 * `03g-select-topic` code steps call; nothing here touches a tool, a store or
 * a model, so every precedence rule below is unit-testable in isolation:
 *
 * - `recentModesFromDecisions` turns the decision log (`memory.read`,
 *   `scope: "decisions"`) into the oldest-first mode list the shared
 *   `selectContentMode` wants — the same rotation x-agent and linkedin-agent
 *   use, in place of the shipped-count modulo.
 * - `resolveTopicClaim` takes step 03's seed claim (a catalog row, a typed
 *   request, or the bare industry) and the scout's candidates and decides the
 *   subject under ONE precedence order: a person's request > a planned row
 *   (unless the client opted into trend-jacking and a story clearly beats
 *   it, or the row is outclassed by more than `1 / CATALOG_MIN_FIT_RATIO` —
 *   the mis-seeded-catalog case) > the strongest on-brand trend > a real fetched headline > the
 *   client's own declared industry. Everything not chosen is recorded as an
 *   alternative with the rule that outranked it, so the reviewer at the gate
 *   sees the road not taken.
 * - `topicDecisionSummary` is the one line `09b` appends to the decision log,
 *   shaped so `parseContentModeFromSummary` reads the mode back next run and
 *   so the archetypes used are recorded at zero cost (audit finding 8).
 *
 * ## Phase 6 (RFC-19 §4 item 16)
 *
 * The last rung used to be `{ hold }` — "no on-brand subject this week" — and
 * it fired whenever `MIN_BRAND_FIT` refused every scouted story. A floor
 * refusing every candidate is a QUALITY verdict about STORIES, and under the
 * owner's rule a quality verdict may not end a run. Branch 6 leads with the
 * industry the client themselves declared and records what the floor refused
 * in `weighting.belowFloor`. The floor does not move; what happens after it
 * refuses does.
 *
 * ## Phase 1 (RFC-13 §I)
 *
 * `rankTopicCandidates` ranks candidates from all FIVE topic engines
 * (`topic-engines.ts` gathers the other four's evidence) with the mode and
 * engine bonuses applied, and `resolveTopicClaim` takes its `chosen` /
 * `alternatives` through the optional `ranked` option instead of calling
 * `selectTrendCandidate` itself. The precedence order above does not change:
 * ranking decides which STORY leads, never whether a story outranks a person's
 * request or a planned row.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a catalog row is worth when a trend competes with it: brand fit 4 ×
 * interest 3. A human planned the row, so it is on-brand by definition (4,
 * not 5 — a plan made weeks ago is not the client's core-domain story of THIS
 * week), and its interest is the mid-scale default a scout gives an
 * unremarkable-but-real story. A trend has to beat this product outright,
 * with distance already applied, to displace the plan.
 */
export const PLANNED_ROW_SCORE = 12;

/** A trend may displace a planned row only when it is unmistakably on-brand AND stops a reader — both 4+, never one carrying the other. */
export const TREND_JACK_MIN_BRAND_FIT = 4;
export const TREND_JACK_MIN_INTEREST = 4;

/**
 * How far a planned catalog row may be outclassed and still keep its slot
 * (Phase 5.5, spec §6 G5.1).
 *
 * ## The run this exists because of
 *
 * thepitchbydeel, 2026-09-16. `03g` recorded `source: "reserved",
 * plannedScore: 12, bestCandidateScore: 37.5` and marked FIVE candidates
 * scoring 18.4 to 37.5 `outranked-by-catalog`. The row that beat them was
 * *"a workflow we would rebuild from scratch"* — Karos Labs' subject matter,
 * seeded on deel's catalog — and the post it produced argued about running one
 * LLM call for every task and about specialised agents, for a pitch
 * competition's audience of founders. `07g` scored it 3 and named the missing
 * bridge, and the gate dropped the bridge on the floor (see
 * `relevance-gate.ts`).
 *
 * ## Why a ratio and not a threshold
 *
 * `PLANNED_ROW_SCORE` is a CONSTANT: every row is worth 12 because a human
 * planned it, and nothing in the catalog says whether a particular row still
 * fits this client. There is therefore no absolute number that separates a good
 * row from a mis-seeded one. What there is, is the field it is standing in: a
 * row the week's best on-brand story beats by more than two to one is a row
 * whose planner is not in the room, and the plan is not evidence about THIS
 * week.
 *
 * ## WHY 0.4 AND NOT THE 0.5 THE SPEC WROTE
 *
 * The spec's 0.5 was written against a variable planned score ("a row at 30 vs
 * 37.5 keeps it"), and `PLANNED_ROW_SCORE` is not variable. With the constant
 * 12, a ratio of 0.5 means the row loses to any candidate scoring above 24 —
 * and a plain 5/5 story with no overlap scores `5 × 5 × 1.0 = 25` on the Phase 0
 * path. So 0.5 would take a catalog row away from EVERY client whose scout found
 * one strong story, which is the `trendJacking: "always"` behaviour arriving
 * without the client's opt-in. `topic-selection.test.ts` pins that invariant by
 * name ("stays regardless of the story when the client has not opted into
 * trend-jacking") and it is a promise about a client SETTING, not a tuning
 * choice for this phase to reverse.
 *
 * Two measured numbers bracket the answer:
 *
 * - **25 is the CEILING of the scout's own two judgments**: `scoreCandidate` is
 *   `brandFit × interest × distance` with both scores capped at 5 and distance
 *   at 1. 28.75 is that ceiling with the mode bonus. A story at the top of the
 *   raw scale must NOT take a human's row — `topic-selection.test.ts` pins that
 *   as a promise about the `trendJacking` SETTING.
 * - deel's mis-seeded row was outclassed **12 against 37.5** and must lose.
 *
 * The rule fires when `best > PLANNED_ROW_SCORE / ratio`, so the threshold has
 * to land between 28.75 and 37.5. 0.4 puts it at **30**, which has a meaning and
 * not just a value: a row is taken only when the candidate scores ABOVE
 * ANYTHING THE SCOUT ALONE CAN AWARD — that is, only when the five-engine
 * ranking's own evidence (the client's own case study with an offer to lead to,
 * a peer post that measurably outperformed) has pushed it past a perfect
 * scouted story. It is deliberately a rule that fires rarely: the human's plan
 * is still the default, and this only removes the case where the plan is being
 * outvoted by a factor.
 *
 * The spec wrote 0.5, whose threshold is 24 — below the raw ceiling, so every
 * client with one strong story would lose their planned row and `trendJacking`
 * would only decide the 12-to-24 band. That is a bigger change to a client
 * SETTING than G5.1 asked for, and 0.4 is the value that fixes deel without
 * making it.
 *
 * A row that loses its slot is RELEASED back to the catalog, not consumed, so
 * the planner's row is still there to be posted on a week when nothing outclasses
 * it.
 */
export const CATALOG_MIN_FIT_RATIO = 0.4;

/** How many not-chosen stories the claim carries forward to the gate. Enough to show the field; not the scout's whole `skipped` list. */
export const MAX_ALTERNATIVES = 5;

/** The text a candidate is compared against the client's recent posts on: its subject and the source's own phrasing of it. */
function candidateText(candidate: Pick<TrendCandidate, "topic" | "headline">): string {
  return `${candidate.topic} ${candidate.headline}`;
}

/**
 * 1 − the closest trigram-Jaccard match between the candidate and anything
 * the client recently published (`similarity` from `@agent-engine/core`, the
 * same measure `07d-dedupe-check` scores the finished draft with). 1 when
 * there is no history: a first post has nothing to be a repeat of.
 */
export function candidateDistance(candidate: Pick<TrendCandidate, "topic" | "headline">, recentExcerpts: readonly string[]): number {
  const text = candidateText(candidate);
  let closest = 0;
  for (const excerpt of recentExcerpts) {
    const score = similarity(text, excerpt);
    if (score > closest) closest = score;
  }
  return 1 - closest;
}

/**
 * `brandFit × interest × distance`. Multiplicative on purpose: a 5/5 story
 * the client posted about last week scores near zero, and a distant story
 * nobody would stop for cannot be rescued by novelty alone.
 */
export function scoreCandidate(candidate: TrendCandidate, recentExcerpts: readonly string[]): number {
  return candidate.brandFit * candidate.interest * candidateDistance(candidate, recentExcerpts);
}

/** Cheap containment check, both sides normalised — mirrors `selectTrendCandidate`'s own (unexported) eligibility test so the two never disagree. */
function overlaps(text: string, avoid: readonly string[]): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return false;
  return avoid.some((a) => {
    const v = a.trim().toLowerCase();
    return v.length > 0 && (t.includes(v) || v.includes(t));
  });
}

/**
 * `score` is the candidate's rank score: `scoreCandidate` on the Phase 0 path,
 * and the pre-computed `rankTopicCandidates` score (which folds in the mode and
 * engine bonuses) when the caller ranked first — passed in rather than
 * recomputed so the number the reviewer sees is the number that decided.
 */
function alternativeFromCandidate(candidate: TrendCandidate, reason: TopicAlternativeReason, recentExcerpts: readonly string[], score?: number): TopicAlternative {
  return {
    topic: candidate.topic,
    headline: candidate.headline,
    brandFit: candidate.brandFit,
    interest: candidate.interest,
    mode: candidate.mode,
    engine: candidateEngine(candidate),
    score: round3(score ?? scoreCandidate(candidate, recentExcerpts)),
    reason,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Strongest first, capped — the shape every branch below records its alternatives in. */
function rankAlternatives(alternatives: readonly TopicAlternative[]): TopicAlternative[] {
  return [...alternatives].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, MAX_ALTERNATIVES);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking across the five topic engines (RFC-13 §I, Phase 1)
// ─────────────────────────────────────────────────────────────────────────────

/** A candidate in this run's content mode is worth 15% more — the rotation is a steer with a price, not a wall (`selectTrendCandidate` keeps the same posture). */
export const MODE_BONUS = 1.15;

/**
 * How much a candidate's age moves its score.
 *
 * ## Why this exists at all
 *
 * `publishedAt` used to appear exactly once in this module: in the
 * comparator, as the last tie-break after the score and `hasNumbers`. Two
 * candidates with different scores never reached it, so recency had no effect
 * on any real ranking. The three prep carousels of 2026-09-18 all opened on
 * evergreen abstractions, and the owner read the result as topics that were
 * boring.
 *
 * ## The shape, and why undated is neutral rather than punished
 *
 * A candidate with no date is the ordinary state of a good evergreen idea, and
 * an absent date is not evidence of age. Punishing it would be guessing. It
 * sits at 1.0 and anything genuinely fresh passes it, which is the direction
 * that was missing.
 *
 * Over a month old is the one penalty, and it is small. A news peg that is
 * five weeks old is not news; it is an evergreen topic with a date on it, and
 * it should compete as one rather than be dropped.
 */
export const FRESHNESS_STEPS: ReadonlyArray<{ readonly withinDays: number; readonly factor: number }> = [
  { withinDays: 3, factor: 1.35 },
  { withinDays: 7, factor: 1.25 },
  { withinDays: 14, factor: 1.12 },
  { withinDays: 30, factor: 1.0 },
];

/** The factor for an undated candidate, and for anything inside thirty days. */
export const FRESHNESS_NEUTRAL = 1.0;
/** Older than the last step. A month-old peg competes as the evergreen idea it has become. */
export const FRESHNESS_STALE = 0.9;

export function freshnessBonus(publishedAt: string | undefined, now: Date = new Date()): number {
  if (publishedAt === undefined || publishedAt.trim().length === 0) return FRESHNESS_NEUTRAL;
  const at = Date.parse(publishedAt);
  // An unparseable date is an absent one. It is never read as "very old",
  // because a malformed field is a fact about the harvester, not the story.
  if (Number.isNaN(at)) return FRESHNESS_NEUTRAL;
  const days = (now.getTime() - at) / 86_400_000;
  // A date in the FUTURE is a clock skew or a scheduled post, not a scoop.
  // Treated as today rather than rewarded for being ahead of the calendar.
  const age = Math.max(0, days);
  for (const step of FRESHNESS_STEPS) if (age <= step.withinDays) return step.factor;
  return FRESHNESS_STALE;
}
/** How much a peer post's own engagement can lift a candidate the reference-accounts engine produced: at most +25%, and only with a measured score. */
export const REFERENCE_ENGAGEMENT_BONUS = 0.25;
/** The client's own case study or data point is worth 50% more WHEN there is an offer for it to lead to; without one it is just another story. */
export const OWN_ASSET_WITH_OFFER_BONUS = 1.5;
/** An evergreen angle is worth 20% less than a dated story — except on a deep-value week, which is exactly what evergreen is for. */
export const EVERGREEN_OFF_MODE_MULTIPLIER = 0.8;

/** Why each factor moved the score. Checkpointed with the ranking so a reviewer can disagree with a weight rather than with a total. */
export interface RankComponents {
  brandFit: number;
  interest: number;
  distance: number;
  modeBonus: number;
  engineBonus: number;
  /** How much the candidate's age moved it. 1 for an undated one, which is neutral by design. */
  freshness: number;
  engine: TopicEngine;
}

export interface RankedCandidate {
  candidate: TrendCandidate;
  score: number;
  components: RankComponents;
}

export interface RankedTopics {
  /** Every eligible candidate, strongest first. */
  ranked: RankedCandidate[];
  /** The strongest one, when anything was eligible. */
  chosen?: TrendCandidate;
  /** The next `MAX_ALTERNATIVES`, already shaped for the claim and the gate. */
  alternatives: TopicAlternative[];
  /** Candidates dropped before scoring, with the reason — the honest counterpart to `chosen`. */
  dropped: Array<{ topic: string; reason: string }>;
}

export interface RankTopicOptions {
  /** This run's content mode (`03d`). */
  mode: ContentMode;
  /** The client brief: `offers` decides whether an own-asset candidate gets its bonus. */
  brief: Pick<ClientBrief, "offers">;
  /** Recent post excerpts across channels — what `candidateDistance` measures against. */
  recentExcerpts: readonly string[];
  /** Subjects already covered anywhere; an overlapping candidate is dropped before scoring. */
  avoidTopics: readonly string[];
  /**
   * `03e`'s signals, so a reference-accounts candidate can be matched back to
   * the peer post it rests on (`evidenceRefs`) and carry that post's measured
   * engagement into its bonus. Absent, the bonus is neutral rather than
   * guessed.
   */
  signals?: TopicSignalsForScout | undefined;
  /** Overridable only for tests; production uses the shared `MIN_BRAND_FIT`. */
  minBrandFit?: number;
  /** Overridable only for tests, so a freshness assertion is not a function of the day it runs. */
  now?: Date;
}

/** The strongest measured engagement among the peer posts this candidate cites, in [0,1]; 0 when it cites none. */
function citedEngagement(candidate: TrendCandidate, signals: TopicSignalsForScout | undefined): number {
  const refs = candidate.evidenceRefs ?? [];
  if (signals === undefined || refs.length === 0) return 0;
  let best = 0;
  for (const post of signals.referencePosts) {
    const url = post.url.trim().toLowerCase();
    if (url.length === 0) continue;
    const cited = refs.some((raw) => {
      const ref = raw.trim().toLowerCase();
      return ref.length > 0 && (ref === url || ref.includes(url) || url.includes(ref));
    });
    if (cited && post.engagementScore > best) best = post.engagementScore;
  }
  return Math.min(1, Math.max(0, best));
}

/**
 * What the candidate's ORIGIN is worth, on top of the scout's own judgment.
 *
 * The scout scores brand fit and interest; it cannot know that the client has
 * an offer this case study leads to, or that a peer's post on this subject
 * measurably outperformed their own median. That is what these multipliers
 * carry — and they are multipliers, not additions, so no engine can rescue a
 * candidate the scout scored as uninteresting.
 */
export function engineBonus(candidate: TrendCandidate, options: Pick<RankTopicOptions, "mode" | "brief" | "signals">): number {
  switch (candidateEngine(candidate)) {
    case "reference-accounts":
      return 1 + REFERENCE_ENGAGEMENT_BONUS * citedEngagement(candidate, options.signals);
    case "own-assets":
      return options.brief.offers.length > 0 ? OWN_ASSET_WITH_OFFER_BONUS : 1;
    case "evergreen":
      return options.mode === "deep-value" ? 1 : EVERGREEN_OFF_MODE_MULTIPLIER;
    case "audience-questions":
    case "niche-news":
    default:
      return 1;
  }
}

/**
 * Ranks every candidate the scout produced, whatever engine it came from, and
 * says which one wins.
 *
 * `interest × brandFit × distance × modeBonus × engineBonus`. The first three
 * are Phase 0's `scoreCandidate` (a story the client already covered scores
 * near zero however good it is); the two bonuses are what makes five engines
 * comparable — see `engineBonus`. Multiplicative throughout, so every factor
 * can veto and none can carry a candidate alone.
 *
 * Dropped before scoring: anything below the brand-fit floor (`MIN_BRAND_FIT`
 * — not on-brand enough to post about at all) and anything overlapping a
 * subject another channel already covered. Both are recorded in `dropped`.
 */
export function rankTopicCandidates(candidates: readonly TrendCandidate[], options: RankTopicOptions): RankedTopics {
  const minFit = options.minBrandFit ?? MIN_BRAND_FIT;
  const dropped: RankedTopics["dropped"] = [];
  const ranked: RankedCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.brandFit < minFit) {
      dropped.push({ topic: candidate.topic, reason: `brand fit ${candidate.brandFit}/5 is below the floor of ${minFit}` });
      continue;
    }
    if (overlaps(candidate.topic, options.avoidTopics) || overlaps(candidate.headline, options.avoidTopics)) {
      dropped.push({ topic: candidate.topic, reason: "a subject this client already covered on some channel" });
      continue;
    }
    const distance = candidateDistance(candidate, options.recentExcerpts);
    const modeBonus = candidate.mode === options.mode ? MODE_BONUS : 1;
    const bonus = engineBonus(candidate, options);
    // Recency, as a term in the score rather than as the last tie-break after
    // it. See `freshnessBonus`: two candidates with different scores never
    // reached the comparator, so this factor is the whole of what "sometimes
    // trendy or about something new" needed.
    const freshness = freshnessBonus(candidate.publishedAt, options.now);
    ranked.push({
      candidate,
      score: round3(candidate.brandFit * candidate.interest * distance * modeBonus * bonus * freshness),
      components: {
        brandFit: candidate.brandFit,
        interest: candidate.interest,
        distance: round3(distance),
        modeBonus,
        engineBonus: round3(bonus),
        freshness,
        engine: candidateEngine(candidate),
      },
    });
  }

  // Ties broken the way `selectTrendCandidate` breaks them — a citable figure,
  // then the more recent date — so two candidates the formula cannot separate
  // are separated by the same rule everywhere in the codebase.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.candidate.hasNumbers !== b.candidate.hasNumbers) return a.candidate.hasNumbers ? -1 : 1;
    return (b.candidate.publishedAt ?? "").localeCompare(a.candidate.publishedAt ?? "");
  });

  const chosen = ranked[0]?.candidate;
  const alternatives = ranked
    .slice(1, 1 + MAX_ALTERNATIVES)
    .map((row) =>
      alternativeFromCandidate(row.candidate, chosen !== undefined && row.candidate.mode === chosen.mode ? "lower-rank" : "off-mode", options.recentExcerpts, row.score),
    );

  return { ranked, ...(chosen !== undefined ? { chosen } : {}), alternatives, dropped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content mode
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The oldest-first mode list `selectContentMode` wants, out of the decision
 * log as `memory.read` returns it. `memory.read` with a `limit` hands rows
 * back NEWEST-first (`boundHistory`), and `selectContentMode` reads
 * `recentModes.at(-1)` as "the immediately prior mode" — feeding it the raw
 * list would make the rotation avoid the OLDEST post's mode instead of the
 * last one's. Rows without a parseable `(mode: …)` (other decision kinds,
 * older rows) are skipped, not defaulted.
 */
export function recentModesFromDecisions(decisions: ReadonlyArray<{ at?: unknown; summary: string }>): ContentMode[] {
  return sortedOldestFirst(decisions)
    .map((d) => parseContentModeFromSummary(d.summary))
    .filter((mode): mode is ContentMode => mode !== undefined);
}

/** Oldest-first, shared by both readers of the decision log. `memory.read` with a `limit` hands rows back NEWEST-first (`boundHistory`). */
function sortedOldestFirst<T extends { at?: unknown }>(rows: readonly T[]): T[] {
  const at = (d: { at?: unknown }): number => (typeof d.at === "number" ? d.at : 0);
  return [...rows].sort((a, b) => at(a) - at(b));
}

// ─────────────────────────────────────────────────────────────────────────────
// Post format (Phase 5.5, spec §5 D3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many DELIVERED posts back the format rotation looks.
 *
 * ## What it replaces
 *
 * `04h-select-format` rotated on `ownShippedCount % 3`, where `ownShippedCount`
 * is the number of this agent's rows in the cross-channel history read at `04e`.
 * That is the same counter shape `03d` was already fixed for and which this
 * module's header has documented as wrong since Phase 0: it counts a window of
 * entries rather than a rotation position, so a client whose ledger window
 * slides, or whose runs fail, or who posts twice in a day, sits on one format
 * for weeks — and the `single` format the rotation exists to produce may never
 * arrive at all.
 *
 * ## Why two and not three
 *
 * There are exactly two formats. "Pick the format not used in the last two
 * delivered posts" therefore selects `single` only when the last two delivered
 * posts were BOTH carousels, which reproduces the one-in-three cadence the
 * modulo was written for — `C, C, S, C, C, S` — while advancing only on posts
 * that actually shipped. Set it to 1 and every other post is a single; set it
 * to 3 and a single appears once every four. Two is the value that keeps the
 * behaviour the old rule intended and fixes only the counter behind it.
 */
export const POST_FORMAT_WINDOW = 2;

/** The default when the window is not yet full: a client's first two posts are carousels, exactly as `ownShippedCount % 3` gave them. */
export const DEFAULT_POST_FORMAT: InstagramFormat = "carousel";

/**
 * The format out of one decision-log row, or `undefined` for a row that does
 * not carry one.
 *
 * Deliberately shaped like `parseContentModeFromSummary`: matched wherever it
 * appears inside the parenthesis rather than at a fixed position, and a row
 * without it is SKIPPED rather than defaulted. Every row written before this
 * phase has no `format:` key, so an existing client's log degrades to an empty
 * window and their next two posts are carousels — the same thing a new client
 * gets, and never a wrong answer dressed as a read.
 */
export function parsePostFormatFromSummary(summary: string): InstagramFormat | undefined {
  const match = /format: ([a-z]+)/.exec(summary);
  const candidate = match?.[1];
  return (INSTAGRAM_FORMATS as readonly string[]).includes(candidate ?? "") ? (candidate as InstagramFormat) : undefined;
}

/** The oldest-first delivered-format list `selectPostFormat` wants, out of the decision log as `memory.read` returns it. */
export function recentFormatsFromDecisions(decisions: ReadonlyArray<{ at?: unknown; summary: string }>): InstagramFormat[] {
  return sortedOldestFirst(decisions)
    .map((d) => parsePostFormatFromSummary(d.summary))
    .filter((format): format is InstagramFormat => format !== undefined);
}

/** Which format this run takes, and the sentence the gate payload shows for why. */
export interface PostFormatSelection {
  format: InstagramFormat;
  source: "requested" | "rotation" | "default";
  rule: string;
}

/**
 * Picks this run's format. Pure; `recentFormats` is oldest-first and comes from
 * the caller's own decision-log read, exactly as `selectContentMode`'s does.
 *
 * An explicit `single`/`carousel` request wins outright. `auto` rotates. Any
 * other value (unset, an unknown string) is the standing default.
 */
export function selectPostFormat(requested: string | undefined, recentFormats: readonly InstagramFormat[]): PostFormatSelection {
  if (requested === "single" || requested === "carousel") {
    return { format: requested, source: "requested", rule: `the run or the client asked for a ${requested}` };
  }
  if (requested !== "auto") {
    return { format: DEFAULT_POST_FORMAT, source: "default", rule: `no format was requested, so this post is a ${DEFAULT_POST_FORMAT}` };
  }
  const window = recentFormats.slice(-POST_FORMAT_WINDOW);
  // The window must be FULL before it can say a format is unused: one delivered
  // carousel is not evidence that the client has had enough of carousels, and
  // treating it as such would make a new client's second post a single.
  const unused = window.length < POST_FORMAT_WINDOW ? undefined : INSTAGRAM_FORMATS.find((f) => !window.includes(f));
  if (unused !== undefined) {
    return {
      format: unused,
      source: "rotation",
      rule: `format is "auto" and the last ${POST_FORMAT_WINDOW} DELIVERED posts were both ${window[0]}, so this one is a ${unused}`,
    };
  }
  return {
    format: DEFAULT_POST_FORMAT,
    source: "rotation",
    rule:
      window.length < POST_FORMAT_WINDOW
        ? `format is "auto" and this client has ${window.length} delivered post(s) on record, fewer than the ${POST_FORMAT_WINDOW} the rotation reads, so this one is a ${DEFAULT_POST_FORMAT}`
        : `format is "auto" and the last ${POST_FORMAT_WINDOW} delivered posts already used both formats, so this one is a ${DEFAULT_POST_FORMAT}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveTopicOptions {
  /** Subjects already covered on any channel (`crossChannelAvoidTopics`); a candidate overlapping one is never eligible. */
  avoidTopics: readonly string[];
  /** The client's `trendJacking` config: only the literal `"always"` lets a trend displace a planned catalog row. Anything else (unset, `"fallback"`) keeps the row. */
  trendJacking?: string | undefined;
  /** Recent post excerpts across channels — what `candidateDistance` measures against. */
  recentExcerpts: readonly string[];
  /** `03b`'s merged research, for the real-headline fallback when no candidate clears the brand-fit floor. */
  trendResearchMerged?: ResearchPullResult | undefined;
  /** What the workflow observed of the scout: ran, saw no documents, or could not run. Recorded on the claim verbatim. */
  scoutStatus: TopicScoutStatus;
  /**
   * Phase 1 (RFC-13 §I): `03f-rank-topic-candidates`'s output. When present it
   * REPLACES the internal `selectTrendCandidate` / `scoreCandidate` ordering,
   * so the subject is chosen by the five-engine formula (mode and engine
   * bonuses included) and the alternatives carry the engine and the score that
   * actually decided. Every precedence rule below is unchanged: a request
   * still outranks the ranking, and a planned row still outranks it unless the
   * client opted into trend-jacking.
   *
   * Absent — every Phase 0 run — this function behaves exactly as it did.
   */
  ranked?: RankedTopics | undefined;
}

/** What the brand-fit floor refused, recorded on the claim rather than thrown as a hold (RFC-19 §4 item 16). */
export interface TopicBelowFloor {
  /** Stories the scout looked at, including the ones it skipped before scoring. */
  considered: number;
  /** The best brand fit any of them reached — 0 when there was nothing to score. */
  bestFit: number;
  /** The floor they were measured against. Unchanged by RFC-19: the gate still refuses exactly what it refused. */
  floor: number;
}

/**
 * Branch 6's weighting.
 *
 * A `TopicWeighting` plus the counts that explain WHY the industry seed is
 * leading. Declared here rather than on `TopicWeighting` itself because
 * `types.ts` belongs to another work package this phase (RFC-19 Part 3); the
 * value is assignable to `TopicWeighting` and travels to the gate and the
 * deliverable by reference through `topicDecisionForGate`, so nothing is lost
 * at runtime. **NEEDED FROM `types.ts`: fold `belowFloor?: TopicBelowFloor`
 * into `TopicWeighting`** so a reader can reach it without a cast.
 */
export interface BelowFloorWeighting extends TopicWeighting {
  belowFloor: TopicBelowFloor;
}

/**
 * `resolveTopicClaim`'s answer. There is no `{ hold }` member and there has
 * not been one since RFC-19 Phase 6: every path through this function returns
 * a subject.
 *
 * Deleting the member rather than leaving it unreachable is the point. A hold
 * this function could still express is a hold a later branch would eventually
 * reach for, and the one it used to throw — a brand-fit floor refusing every
 * scouted story — is a QUALITY verdict, which under the owner's rule may never
 * end a run. The holds that remain are the intake ones, and they belong to
 * step 03 (`WF:3286`), where the seed genuinely does not exist.
 */
export interface ResolvedTopic {
  claim: InstagramTopicClaim;
  /** True when a trend displaced a reserved catalog row: the workflow must `topics.release` the reservation so the row is reservable again. */
  releaseReservation: boolean;
}

/**
 * Decides this run's subject. See the module comment for the precedence
 * order; each branch below states which rule fired in `weighting.rule`.
 *
 * `seed` is step 03's claim: `requested` (a typed direction or the client's
 * standing `requestedSubject`), `reserved` (a catalog row, with its
 * `reservationKey`), or `research` (nothing planned — the bare industry, a
 * seed this function replaces with a story or a headline wherever it can, and
 * leads with only when nothing else was usable; branch 6).
 *
 * EVERY PATH RETURNS A SUBJECT. There is no hold here — see `ResolvedTopic`.
 */
export function resolveTopicClaim(seed: InstagramTopicClaim, scout: TrendScoutOutput | undefined, mode: ContentMode, options: ResolveTopicOptions): ResolvedTopic {
  const candidates = scout?.candidates ?? [];
  const recent = options.recentExcerpts;
  const pre = options.ranked;
  // One ordering for every branch below: the pre-computed five-engine ranking
  // when `03f` ran, else Phase 0's `brandFit × interest × distance`.
  const scored: Array<{ candidate: TrendCandidate; score: number }> =
    pre !== undefined ? pre.ranked : candidates.map((c) => ({ candidate: c, score: scoreCandidate(c, recent) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const common = { mode, scoutStatus: options.scoutStatus };
  /** Every considered story as an alternative under one reason, strongest first — pre-ranked scores when there are any. */
  const alternativesUnder = (reason: TopicAlternativeReason): TopicAlternative[] =>
    rankAlternatives(
      pre !== undefined
        ? pre.ranked.map((row) => alternativeFromCandidate(row.candidate, reason, recent, row.score))
        : candidates.map((c) => alternativeFromCandidate(c, reason, recent)),
    );

  // 1. A person's request stands. The scout ran anyway, so the reviewer sees
  //    what this week's stories were — as alternatives, never as the subject.
  if (seed.source === "requested") {
    return {
      claim: {
        ...seed,
        ...common,
        alternatives: alternativesUnder("outranked-by-request"),
        weighting: {
          ...(best !== undefined ? { bestCandidateScore: round3(best.score) } : {}),
          rule: "a subject someone typed or configured for this run outranks every scouted story",
        },
      },
      releaseReservation: false,
    };
  }

  // 2. A planned catalog row keeps its slot — unless the client opted into
  //    trend-jacking AND a story is unmistakably on-brand, stops a reader,
  //    and beats the row's planned score with distance applied; or unless the
  //    row is outclassed by more than `1 / CATALOG_MIN_FIT_RATIO`, which is the
  //    mis-seeded-catalog case and applies to every client.
  if (seed.source === "reserved") {
    const jackable = scored.filter(
      ({ candidate }) =>
        candidate.brandFit >= TREND_JACK_MIN_BRAND_FIT &&
        candidate.interest >= TREND_JACK_MIN_INTEREST &&
        !overlaps(candidate.topic, options.avoidTopics) &&
        !overlaps(candidate.headline, options.avoidTopics),
    );
    // Two ways a row can lose its slot, and they answer different questions.
    //
    // `trendJacking: "always"` is the CLIENT'S OPT-IN: this account wants the
    // week's story whenever one clears the bar, and the bar is the row's own
    // score. It is unchanged.
    //
    // The catalog-fit test below applies to EVERY client, opted in or not, and
    // asks a narrower question: is this row still about this client's business
    // at all? A plan that the week's best on-brand story beats by more than
    // `1 / CATALOG_MIN_FIT_RATIO` is a plan the evidence does not support, and
    // deel's 2026-09-16 post is what shipping one looks like.
    const jacked = options.trendJacking === "always" ? jackable.find(({ score }) => score > PLANNED_ROW_SCORE) : undefined;
    const outclassing = jackable.find(({ score }) => PLANNED_ROW_SCORE < CATALOG_MIN_FIT_RATIO * score);
    const winner = jacked ?? outclassing;
    if (winner !== undefined) {
      const { candidate } = winner;
      const ratio = winner.score > 0 ? round3(PLANNED_ROW_SCORE / winner.score) : 1;
      const rowAsAlternative: TopicAlternative = { topic: seed.topic, reason: "outranked-by-trend", score: PLANNED_ROW_SCORE };
      const others = scored.filter((s) => s.candidate !== candidate).map((s) => alternativeFromCandidate(s.candidate, "lower-rank", recent, s.score));
      // No `reservationKey` on the new claim: the row goes back to the
      // catalog (the caller releases it), and step 09 must not commit a
      // reservation for a subject the catalog did not supply.
      const { reservationKey: _released, ...seedWithoutReservation } = seed;
      void _released;
      return {
        claim: {
          ...seedWithoutReservation,
          ...common,
          topic: candidate.topic,
          source: "trend",
          trend: candidate,
          alternatives: [rowAsAlternative, ...rankAlternatives(others).slice(0, MAX_ALTERNATIVES - 1)],
          weighting: {
            plannedScore: PLANNED_ROW_SCORE,
            bestCandidateScore: round3(winner.score),
            // WHICH BRANCH FIRED, in the reviewer's own view of the decision.
            // The two rules take the row away for different reasons and a
            // reviewer who disagrees needs to know which one to argue with:
            // one is a setting this client chose, the other is a catalog row
            // that no longer fits.
            rule:
              jacked !== undefined
                ? `trendJacking is "always" and a story with brand fit ${candidate.brandFit}/5 and interest ${candidate.interest}/5 scored ${round3(winner.score)} > the planned row's ${PLANNED_ROW_SCORE}`
                : `the planned catalog row lost its slot on fit: it is worth ${PLANNED_ROW_SCORE} against this week's best on-brand story at ${round3(winner.score)} ` +
                  `(ratio ${ratio}, below the ${CATALOG_MIN_FIT_RATIO} a row must keep to hold its slot), so the row was released back to the catalog rather than posted`,
          },
        },
        releaseReservation: true,
      };
    }
    // The row kept its slot, and the reason says so WITH the fit arithmetic in
    // it. The old sentence ("a planned catalog row keeps its slot; trends
    // compete with it only when the client sets trendJacking to \"always\"")
    // was true of deel's run and told the reviewer nothing about the 12-against-
    // 37.5 that should have taken the slot away, which is why the reason string
    // now carries the ratio on the keeping path as well as the losing one.
    const bestJackableScore = jackable[0]?.score;
    const keptOnFit =
      bestJackableScore !== undefined
        ? `it is worth ${PLANNED_ROW_SCORE} against this week's best on-brand story at ${round3(bestJackableScore)} ` +
          `(ratio ${bestJackableScore > 0 ? round3(PLANNED_ROW_SCORE / bestJackableScore) : 1}, at or above the ${CATALOG_MIN_FIT_RATIO} floor)`
        : "no scouted story was on-brand enough to compete with it";
    const weighting: TopicWeighting = {
      plannedScore: PLANNED_ROW_SCORE,
      ...(best !== undefined ? { bestCandidateScore: round3(best.score) } : {}),
      rule:
        options.trendJacking === "always"
          ? `trendJacking is "always" but no story cleared brand fit ${TREND_JACK_MIN_BRAND_FIT}+, interest ${TREND_JACK_MIN_INTEREST}+ and a score above the planned row's ${PLANNED_ROW_SCORE}; the row also keeps its slot on fit — ${keptOnFit}`
          : `a planned catalog row keeps its slot on fit — ${keptOnFit}; trends displace it outright only when the client sets trendJacking to "always"`,
    };
    return {
      claim: {
        ...seed,
        ...common,
        alternatives: alternativesUnder("outranked-by-catalog"),
        weighting,
      },
      releaseReservation: false,
    };
  }

  // 3. Nothing planned. The strongest on-brand candidate: the five-engine
  //    ranking's winner when `03f` ran, else the strongest for this run's mode
  //    (mode-first, then any mode — the rotation is a steer, not a wall).
  const trend = pre !== undefined ? pre.chosen : selectTrendCandidate(candidates, mode, { avoidTopics: options.avoidTopics });
  if (trend !== undefined) {
    const chosenRow = pre?.ranked.find((row) => row.candidate === trend);
    const others =
      pre !== undefined
        ? pre.alternatives
        : rankAlternatives(candidates.filter((c) => c !== trend).map((c) => alternativeFromCandidate(c, c.mode === trend.mode ? "lower-rank" : "off-mode", recent)));
    return {
      claim: {
        ...seed,
        ...common,
        topic: trend.topic,
        source: "trend",
        trend,
        alternatives: others,
        weighting: {
          bestCandidateScore: chosenRow !== undefined ? chosenRow.score : round3(scoreCandidate(trend, recent)),
          rule:
            chosenRow !== undefined
              ? `strongest candidate across the five topic engines: ${chosenRow.components.engine} scored ${chosenRow.score} ` +
                `(brand fit ${chosenRow.components.brandFit}/5 × interest ${chosenRow.components.interest}/5 × distance ${chosenRow.components.distance} ` +
                `× mode ${chosenRow.components.modeBonus} × engine ${chosenRow.components.engineBonus})`
              : trend.mode === mode
                ? `strongest candidate in this run's mode (${mode}) with brand fit ≥ ${MIN_BRAND_FIT}`
                : `no candidate in this run's mode (${mode}); strongest on-brand candidate of any mode (${trend.mode}) taken instead`,
        },
      },
      releaseReservation: false,
    };
  }

  // 4. No candidate cleared the brand-fit floor, but the research fetched real
  //    stories: the same fallback every other channel agent uses, a headline a
  //    reader could open — never the query, never a literal.
  const merged = options.trendResearchMerged;
  const titled = (merged?.result?.documents ?? []).filter((d) => (d.title ?? "").trim().length > 0);
  if (merged !== undefined && titled.length > 0) {
    const extracted = extractResearchCandidate(merged, { avoidTopics: options.avoidTopics });
    if (extracted.candidateTopic !== undefined && extracted.candidateTopic.trim().length > 0) {
      return {
        claim: {
          ...seed,
          ...common,
          topic: extracted.candidateTopic.trim(),
          source: "research",
          alternatives: rankAlternatives(candidates.map((c) => alternativeFromCandidate(c, "lower-rank", recent))),
          weighting: {
            ...(best !== undefined ? { bestCandidateScore: round3(best.score) } : {}),
            rule: `no scouted story cleared brand fit ${MIN_BRAND_FIT}; the strongest fetched headline (${extracted.sourceLabel}) leads instead`,
          },
        },
        releaseReservation: false,
      };
    }
  }

  // 6. No row, no request, no on-brand story and no usable headline — and the
  //    client's DECLARED INDUSTRY in hand the whole time (RFC-19 §4 item 16).
  //
  //    This used to hold. It is the earliest quality-driven exit in the agent
  //    and the cheapest to fix: a brand-fit floor refusing every scouted story
  //    is a judgment about STORIES, not evidence that there is nobody to write
  //    for. The seed on this path is `source: "research"`, which step 03 only
  //    produces from `client.getProfile().industry` — so reaching here means
  //    the client told us what business they are in and three ranked sources
  //    came back thin. Posting about the client's own declared field, with the
  //    counts recorded, is strictly more honest than ending the run.
  //
  //    It costs nothing: no attempt has been paid for yet, no model call is
  //    added, and `MIN_BRAND_FIT` does not move — every story the floor
  //    refused is still refused, and `belowFloor` says so on the claim, at the
  //    gate and in the deliverable.
  //
  //    THE HOLD THIS DOES NOT TOUCH is `WF:3286`: no catalog row, no
  //    `requestedSubject` AND no declared industry. There the seed does not
  //    exist and there is genuinely nobody to write for — the owner's own
  //    carve-out, and `topic-floor-breach.test.ts` pins it from both sides.
  //    `seed.topic` is non-empty on every path that reaches here for exactly
  //    that reason, which is why this branch has no hold to fall back to.
  const considered = candidates.length + (scout?.skipped.length ?? 0);
  const bestFit = candidates.reduce((max, c) => Math.max(max, c.brandFit), 0);
  const belowFloorWeighting: BelowFloorWeighting = {
    ...(best !== undefined ? { bestCandidateScore: round3(best.score) } : {}),
    rule:
      `no scouted story cleared brand fit ${MIN_BRAND_FIT} and no fetched headline was usable — ` +
      `the client's declared industry leads`,
    belowFloor: { considered, bestFit, floor: MIN_BRAND_FIT },
  };
  return {
    claim: {
      ...seed,
      ...common,
      topic: seed.topic,
      source: "research",
      alternatives: alternativesUnder("lower-rank"),
      weighting: belowFloorWeighting,
    },
    releaseReservation: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision log row and the gate view
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one line `09b` appends to the decision log. `(mode: …)` sits inside the
 * parenthesis exactly where `parseContentModeFromSummary` looks for it, so
 * next run's `03d` reads the rotation back; `archetypes` records which slide
 * templates shipped (audit finding 8) at zero cost — the row Phase 1's angle
 * ledger extends.
 */
export function topicDecisionSummary(input: {
  topic: string;
  mode: ContentMode;
  source: InstagramTopicClaim["source"];
  archetypes: readonly string[];
  /**
   * The format this post DELIVERED in, so next run's `04h` rotates on posts
   * that shipped rather than on a sliding window of ledger entries
   * (`selectPostFormat`).
   *
   * Optional, and appended only when supplied, for two reasons: every row
   * already in every client's decision log was written without it, and a
   * caller that does not know the format must write a row that says nothing
   * rather than a row that guesses `carousel`.
   */
  format?: InstagramFormat;
}): string {
  const archetypes = input.archetypes.length > 0 ? [...new Set(input.archetypes)].join(",") : "none";
  const format = input.format !== undefined ? `; format: ${input.format}` : "";
  return `instagram post: "${input.topic}" (mode: ${input.mode}; source: ${input.source}${format}; archetypes: ${archetypes})`;
}

/** What the gate payload and the deliverable carry as `topicDecision` — the reviewer's view of the choice and the road not taken. */
export function topicDecisionForGate(claim: InstagramTopicClaim): {
  topic: string;
  source: InstagramTopicClaim["source"];
  mode?: ContentMode;
  alternatives: TopicAlternative[];
  weighting?: TopicWeighting;
  scoutStatus?: TopicScoutStatus;
} {
  return {
    topic: claim.topic,
    source: claim.source,
    ...(claim.mode !== undefined ? { mode: claim.mode } : {}),
    alternatives: claim.alternatives ?? [],
    ...(claim.weighting !== undefined ? { weighting: claim.weighting } : {}),
    ...(claim.scoutStatus !== undefined ? { scoutStatus: claim.scoutStatus } : {}),
  };
}
