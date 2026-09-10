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
import type { InstagramTopicClaim, TopicAlternative, TopicAlternativeReason, TopicScoutStatus, TopicWeighting } from "./types.js";

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
 *   it) > the strongest on-brand trend > a real fetched headline > an honest
 *   hold. Everything not chosen is recorded as an alternative with the rule
 *   that outranked it, so the reviewer at the gate sees the road not taken.
 * - `topicDecisionSummary` is the one line `09b` appends to the decision log,
 *   shaped so `parseContentModeFromSummary` reads the mode back next run and
 *   so the archetypes used are recorded at zero cost (audit finding 8).
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
    ranked.push({
      candidate,
      score: round3(candidate.brandFit * candidate.interest * distance * modeBonus * bonus),
      components: {
        brandFit: candidate.brandFit,
        interest: candidate.interest,
        distance: round3(distance),
        modeBonus,
        engineBonus: round3(bonus),
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
  const at = (d: { at?: unknown }): number => (typeof d.at === "number" ? d.at : 0);
  return [...decisions]
    .sort((a, b) => at(a) - at(b))
    .map((d) => parseContentModeFromSummary(d.summary))
    .filter((mode): mode is ContentMode => mode !== undefined);
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

export type ResolvedTopic =
  | {
      claim: InstagramTopicClaim;
      /** True when a trend displaced a reserved catalog row: the workflow must `topics.release` the reservation so the row is reservable again. */
      releaseReservation: boolean;
    }
  | { hold: string };

/**
 * Decides this run's subject. See the module comment for the precedence
 * order; each branch below states which rule fired in `weighting.rule`.
 *
 * `seed` is step 03's claim: `requested` (a typed direction or the client's
 * standing `requestedSubject`), `reserved` (a catalog row, with its
 * `reservationKey`), or `research` (nothing planned — the bare industry, a
 * seed this function MUST replace or hold on; it is never a subject).
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
  //    and beats the row's planned score with distance applied.
  if (seed.source === "reserved") {
    const jackable = scored.filter(
      ({ candidate }) =>
        candidate.brandFit >= TREND_JACK_MIN_BRAND_FIT &&
        candidate.interest >= TREND_JACK_MIN_INTEREST &&
        !overlaps(candidate.topic, options.avoidTopics) &&
        !overlaps(candidate.headline, options.avoidTopics),
    );
    const winner = options.trendJacking === "always" ? jackable.find(({ score }) => score > PLANNED_ROW_SCORE) : undefined;
    if (winner !== undefined) {
      const { candidate } = winner;
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
            rule: `trendJacking is "always" and a story with brand fit ${candidate.brandFit}/5 and interest ${candidate.interest}/5 scored ${round3(winner.score)} > the planned row's ${PLANNED_ROW_SCORE}`,
          },
        },
        releaseReservation: true,
      };
    }
    const weighting: TopicWeighting = {
      plannedScore: PLANNED_ROW_SCORE,
      ...(best !== undefined ? { bestCandidateScore: round3(best.score) } : {}),
      rule:
        options.trendJacking === "always"
          ? `trendJacking is "always" but no story cleared brand fit ${TREND_JACK_MIN_BRAND_FIT}+, interest ${TREND_JACK_MIN_INTEREST}+ and a score above the planned row's ${PLANNED_ROW_SCORE}`
          : "a planned catalog row keeps its slot; trends compete with it only when the client sets trendJacking to \"always\"",
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

  // 5. Genuinely nothing: no row, no request, and the scout either saw nothing
  //    or found nothing on-brand. Holding with the counts is the honest
  //    answer — a query dressed as a subject is what this replaces.
  const considered = candidates.length + (scout?.skipped.length ?? 0);
  const bestFit = candidates.reduce((max, c) => Math.max(max, c.brandFit), 0);
  return {
    hold:
      `no on-brand subject this week: catalog empty, nothing requested, scout considered ${considered} stories ` +
      `(best brand fit ${considered > 0 ? `${bestFit}/5` : "n/a"}${options.scoutStatus !== "ran" ? `; scout ${options.scoutStatus}` : ""}) — add a catalog row or a requestedSubject`,
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
export function topicDecisionSummary(input: { topic: string; mode: ContentMode; source: InstagramTopicClaim["source"]; archetypes: readonly string[] }): string {
  const archetypes = input.archetypes.length > 0 ? [...new Set(input.archetypes)].join(",") : "none";
  return `instagram post: "${input.topic}" (mode: ${input.mode}; source: ${input.source}; archetypes: ${archetypes})`;
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
