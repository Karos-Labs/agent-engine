import { similarity } from "@agent-engine/core";
import {
  MIN_BRAND_FIT,
  extractResearchCandidate,
  parseContentModeFromSummary,
  selectTrendCandidate,
  type ContentMode,
  type ResearchPullResult,
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

function alternativeFromCandidate(candidate: TrendCandidate, reason: TopicAlternativeReason, recentExcerpts: readonly string[]): TopicAlternative {
  return {
    topic: candidate.topic,
    headline: candidate.headline,
    brandFit: candidate.brandFit,
    interest: candidate.interest,
    mode: candidate.mode,
    score: round3(scoreCandidate(candidate, recentExcerpts)),
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
  const scored = candidates.map((c) => ({ candidate: c, score: scoreCandidate(c, recent) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const common = { mode, scoutStatus: options.scoutStatus };

  // 1. A person's request stands. The scout ran anyway, so the reviewer sees
  //    what this week's stories were — as alternatives, never as the subject.
  if (seed.source === "requested") {
    return {
      claim: {
        ...seed,
        ...common,
        alternatives: rankAlternatives(candidates.map((c) => alternativeFromCandidate(c, "outranked-by-request", recent))),
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
      const others = scored.filter((s) => s.candidate !== candidate).map((s) => alternativeFromCandidate(s.candidate, "lower-rank", recent));
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
        alternatives: rankAlternatives(candidates.map((c) => alternativeFromCandidate(c, "outranked-by-catalog", recent))),
        weighting,
      },
      releaseReservation: false,
    };
  }

  // 3. Nothing planned. The strongest on-brand candidate for this run's mode
  //    (mode-first, then any mode — the rotation is a steer, not a wall).
  const trend = selectTrendCandidate(candidates, mode, { avoidTopics: options.avoidTopics });
  if (trend !== undefined) {
    const others = candidates.filter((c) => c !== trend).map((c) => alternativeFromCandidate(c, c.mode === trend.mode ? "lower-rank" : "off-mode", recent));
    return {
      claim: {
        ...seed,
        ...common,
        topic: trend.topic,
        source: "trend",
        trend,
        alternatives: rankAlternatives(others),
        weighting: {
          bestCandidateScore: round3(scoreCandidate(trend, recent)),
          rule:
            trend.mode === mode
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
