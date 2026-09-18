import { describe, expect, it } from "vitest";
import { parseContentModeFromSummary, type ContentMode, type TrendCandidate } from "@agent-engine/workflow";
import {
  CATALOG_MIN_FIT_RATIO,
  DEFAULT_POST_FORMAT,
  PLANNED_ROW_SCORE,
  POST_FORMAT_WINDOW,
  parsePostFormatFromSummary,
  recentFormatsFromDecisions,
  resolveTopicClaim,
  selectPostFormat,
  topicDecisionSummary,
  type RankedTopics,
} from "../src/workflow/topic-selection.js";
import type { InstagramFormat, InstagramTopicClaim } from "../src/workflow/types.js";

/**
 * Phase 5.5 (spec §5 D3 and §6 G5.1) — the two `topic-selection.ts` defects the
 * 2026-09-16 prep runs made visible.
 *
 * 1. **A mis-seeded catalog row outranked five better candidates.** deel's
 *    `03g` recorded `plannedScore: 12` against `bestCandidateScore: 37.5` and
 *    marked all five `outranked-by-catalog`. The row was Karos Labs' subject
 *    matter, seeded on deel's catalog, and the post argued it to an audience of
 *    founders.
 * 2. **The format rotation counted the wrong thing.** `04h` rotated on
 *    `ownShippedCount % 3` — the size of a sliding window of ledger entries —
 *    which is the same defect `03d` was fixed for in Phase 0 and which this
 *    module's own header has documented as wrong since.
 *
 * Everything here is pure, so no workflow, no model and no store is involved.
 * The candidates are built locally rather than from `test-helpers.ts` so this
 * file depends on nothing that is moving.
 */

// ─────────────────────────────────────────────────────────────────────────
// deel's 03g, rebuilt from the run document
// ─────────────────────────────────────────────────────────────────────────

function candidate(topic: string, headline: string, brandFit: number, interest: number, mode: ContentMode): TrendCandidate {
  return {
    topic,
    headline,
    mode,
    brandFit,
    interest,
    brandFitReason: "recorded on the 2026-09-16 run",
    angle: "as scouted",
    hook: headline,
    whyNow: "this week",
    sourceUrls: ["https://offline.test/deel/0"],
    publishedAt: "2026-09-15",
    hasNumbers: true,
    mediaHint: "data",
  } as TrendCandidate;
}

/** The five candidates `03g` ranked, with the SCORES the run recorded. */
const DEEL_CANDIDATES: Array<{ candidate: TrendCandidate; score: number }> = [
  { candidate: candidate("Balancing global vision with local market insights", "Global ambition, local insight: How well do you know your market?", 5, 5, "open-discussion"), score: 37.5 },
  { candidate: candidate("Ideal Customer Profile (ICP) for founders' pitches", "Your first pitch isn't about your product. It's about your customer.", 5, 5, "deep-value"), score: 28.75 },
  { candidate: candidate("Jobs-to-be-Done (JTBD) framework for product pitching", "Forget features. What 'job' does your product get hired to do?", 5, 5, "deep-value"), score: 28.75 },
  { candidate: candidate("Streamlining founder communications and pitch materials", "Your pitch deck is a product. Treat it like one.", 4, 4, "deep-value"), score: 18.4 },
  { candidate: candidate("Defining anti-personas for sharper market focus", "Who isn't your customer? Defining your anti-persona can sharpen your focus.", 4, 4, "deep-value"), score: 18.4 },
];

/** `03f`'s output as `resolveTopicClaim` reads it. Only `ranked` is consulted on the reserved branch. */
function rankedWith(rows: Array<{ candidate: TrendCandidate; score: number }>): RankedTopics {
  return {
    ranked: rows.map((r) => ({
      ...r,
      components: { brandFit: r.candidate.brandFit, interest: r.candidate.interest, distance: 1, modeBonus: 1, engineBonus: 1, freshness: 1, engine: "niche-news" as const },
    })),
    ...(rows[0] !== undefined ? { chosen: rows[0].candidate } : {}),
    alternatives: [],
    dropped: [],
  };
}

const DEEL_SEED: InstagramTopicClaim = {
  reservationKey: "pubsub-21864573169935321__topic",
  topic: "a workflow we would rebuild from scratch",
  source: "reserved",
};

const NO_HISTORY = { avoidTopics: [] as string[], recentExcerpts: [] as string[], scoutStatus: "ran" as const };

// ─────────────────────────────────────────────────────────────────────────
// G5.1 — a planned row keeps its slot only while it still fits
// ─────────────────────────────────────────────────────────────────────────

describe("a mis-seeded catalog row loses its slot", () => {
  it("deel's exact 03g input: the row at 12 against 37.5 (ratio 0.32) is released and the best story leads", () => {
    const result = resolveTopicClaim(DEEL_SEED, undefined, "deep-value", { ...NO_HISTORY, ranked: rankedWith(DEEL_CANDIDATES) });

    // The premise, asserted: this really is the ratio the run recorded.
    expect(PLANNED_ROW_SCORE / 37.5).toBeCloseTo(0.32, 2);
    expect(PLANNED_ROW_SCORE).toBeLessThan(CATALOG_MIN_FIT_RATIO * 37.5);

    expect(result.claim.source).toBe("trend");
    expect(result.claim.topic).toBe(DEEL_CANDIDATES[0]!.candidate.topic);
    // The row goes BACK to the catalog rather than being consumed: the planner's
    // row is still there for a week when nothing outclasses it.
    expect(result.releaseReservation).toBe(true);
    expect(result.claim.reservationKey).toBeUndefined();
    expect(result.claim.alternatives![0]).toMatchObject({ topic: DEEL_SEED.topic, reason: "outranked-by-trend", score: PLANNED_ROW_SCORE });
  });

  it("the reason string says WHICH branch fired, and it is not the trend-jacking one", () => {
    const result = resolveTopicClaim(DEEL_SEED, undefined, "deep-value", { ...NO_HISTORY, ranked: rankedWith(DEEL_CANDIDATES) });
    const rule = result.claim.weighting!.rule;
    expect(rule).toMatch(/lost its slot on fit/);
    expect(rule).toMatch(/ratio 0\.32/);
    expect(rule).toMatch(new RegExp(`below the ${CATALOG_MIN_FIT_RATIO} a row must keep`));
    // deel never set trendJacking, and the reason must not imply it did.
    expect(rule).not.toMatch(/trendJacking is "always"/);
  });

  it("keeps its slot at ratio 0.80, and the reason carries the arithmetic there too", () => {
    const fits = rankedWith([{ candidate: DEEL_CANDIDATES[0]!.candidate, score: 15 }]);
    expect(PLANNED_ROW_SCORE / 15).toBeCloseTo(0.8, 2);

    const result = resolveTopicClaim(DEEL_SEED, undefined, "deep-value", { ...NO_HISTORY, ranked: fits });
    expect(result.claim.source).toBe("reserved");
    expect(result.claim.reservationKey).toBe(DEEL_SEED.reservationKey);
    expect(result.releaseReservation).toBe(false);
    expect(result.claim.alternatives![0]!.reason).toBe("outranked-by-catalog");
    expect(result.claim.weighting!.rule).toMatch(/keeps its slot on fit/);
    expect(result.claim.weighting!.rule).toMatch(/ratio 0\.8/);
  });

  it("THE CONTROL THAT CALIBRATES THE RATIO: a plain 5/5 story does NOT take a row without the client's opt-in", () => {
    // `scoreCandidate` gives a 5/5 story at full distance exactly 25, and 28.75
    // with the mode bonus. Both must LOSE to the row, because displacing a
    // planned row on a strong story is the `trendJacking: "always"` behaviour
    // and it is a client SETTING. This is the measurement that puts
    // `CATALOG_MIN_FIT_RATIO` at 0.4 rather than the 0.5 the spec wrote: at 0.5
    // the threshold is 24 and both of these would take the row.
    for (const score of [25, 28.75]) {
      const result = resolveTopicClaim(DEEL_SEED, undefined, "deep-value", {
        ...NO_HISTORY,
        ranked: rankedWith([{ candidate: DEEL_CANDIDATES[1]!.candidate, score }]),
      });
      expect(result.claim.source, `score ${score}`).toBe("reserved");
      expect(result.releaseReservation, `score ${score}`).toBe(false);
    }
    // And the threshold really does sit between them and deel's 37.5.
    expect(PLANNED_ROW_SCORE / CATALOG_MIN_FIT_RATIO).toBe(30);
  });

  it("will not hand the slot to a story that is not on-brand enough to jack, however high it scores", () => {
    // The eligibility filter is the trend-jack one: brand fit 4+, interest 4+,
    // and no overlap with a subject another channel already covered. A score
    // inflated by engine bonuses cannot buy a row with a weak candidate.
    const weak = candidate("a loosely related story", "A loosely related story", 3, 5, "deep-value");
    const result = resolveTopicClaim(DEEL_SEED, undefined, "deep-value", { ...NO_HISTORY, ranked: rankedWith([{ candidate: weak, score: 60 }]) });
    expect(result.claim.source).toBe("reserved");

    const covered = resolveTopicClaim(DEEL_SEED, undefined, "deep-value", {
      ...NO_HISTORY,
      avoidTopics: ["balancing global vision"],
      ranked: rankedWith(DEEL_CANDIDATES),
    });
    // The 37.5 candidate is refused for overlap, and the next eligible one is
    // 28.75, which is below the 30 threshold: the row keeps its slot.
    expect(covered.claim.source).toBe("reserved");
  });

  it("trend-jacking still fires first and still names itself", () => {
    const result = resolveTopicClaim(DEEL_SEED, undefined, "deep-value", {
      ...NO_HISTORY,
      trendJacking: "always",
      ranked: rankedWith([{ candidate: DEEL_CANDIDATES[1]!.candidate, score: 25 }]),
    });
    expect(result.claim.source).toBe("trend");
    expect(result.claim.weighting!.rule).toMatch(/trendJacking is "always" and a story/);
    expect(result.claim.weighting!.rule).not.toMatch(/lost its slot on fit/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// D3 — the format rotation advances on DELIVERED posts
// ─────────────────────────────────────────────────────────────────────────

function decisions(formats: readonly InstagramFormat[]): Array<{ at: number; summary: string }> {
  // Newest FIRST, the way `memory.read` with a limit hands rows back.
  return formats.map((format, i) => ({
    at: i,
    summary: topicDecisionSummary({ topic: `post ${i}`, mode: "deep-value", source: "trend", archetypes: ["cover"], format }),
  }));
}

describe("the decision-log row carries the format it delivered", () => {
  it("round-trips through the parser, and the mode still round-trips beside it", () => {
    const summary = topicDecisionSummary({ topic: "our new onboarding flow", mode: "open-discussion", source: "requested", archetypes: ["photo", "cover"], format: "single" });
    expect(summary).toBe('instagram post: "our new onboarding flow" (mode: open-discussion; source: requested; format: single; archetypes: photo,cover)');
    expect(parsePostFormatFromSummary(summary)).toBe("single");
    expect(parseContentModeFromSummary(summary)).toBe("open-discussion");
  });

  it("a row written before this phase has no format and is SKIPPED, never defaulted", () => {
    const old = topicDecisionSummary({ topic: "t", mode: "hot-news", source: "trend", archetypes: [] });
    expect(old).not.toContain("format:");
    expect(parsePostFormatFromSummary(old)).toBeUndefined();
    expect(recentFormatsFromDecisions([{ at: 1, summary: old }, { at: 2, summary: "some other agent's row" }])).toEqual([]);
  });

  it("reads oldest-first out of a newest-first log, like `recentModesFromDecisions`", () => {
    // `at: 0` is the oldest row; `memory.read` returns them newest-first, and
    // the window has to be the LAST posts, not the first.
    expect(recentFormatsFromDecisions(decisions(["carousel", "single", "carousel"]))).toEqual(["carousel", "single", "carousel"]);
  });
});

describe("selectPostFormat", () => {
  it("an explicit request wins outright, and an unset format is the standing default", () => {
    expect(selectPostFormat("single", ["carousel", "carousel"])).toMatchObject({ format: "single", source: "requested" });
    expect(selectPostFormat("carousel", ["carousel", "carousel"])).toMatchObject({ format: "carousel", source: "requested" });
    expect(selectPostFormat(undefined, ["carousel", "carousel"])).toMatchObject({ format: DEFAULT_POST_FORMAT, source: "default" });
    expect(selectPostFormat("something else", ["carousel", "carousel"])).toMatchObject({ format: DEFAULT_POST_FORMAT, source: "default" });
  });

  it("'auto' picks the format the last two DELIVERED posts did not use", () => {
    const picked = selectPostFormat("auto", ["carousel", "carousel"]);
    expect(picked).toMatchObject({ format: "single", source: "rotation" });
    expect(picked.rule).toMatch(/last 2 DELIVERED posts were both carousel/);
  });

  it("reproduces the one-in-three cadence `ownShippedCount % 3` intended, counted on delivered posts", () => {
    const delivered: InstagramFormat[] = [];
    const sequence: InstagramFormat[] = [];
    for (let post = 0; post < 6; post++) {
      const { format } = selectPostFormat("auto", delivered);
      sequence.push(format);
      delivered.push(format);
    }
    expect(sequence).toEqual(["carousel", "carousel", "single", "carousel", "carousel", "single"]);
  });

  it("THE FIX: a failed or held run does not advance the rotation, because it writes no decision row", () => {
    // `09b` appends one row per DELIVERED post. Five runs that never delivered
    // leave the log untouched, so the rotation is in the same place afterwards
    // — where `ownShippedCount % 3` would have moved on a window that slid.
    const delivered: InstagramFormat[] = ["carousel", "carousel"];
    for (let failedRun = 0; failedRun < 5; failedRun++) {
      expect(selectPostFormat("auto", delivered).format).toBe("single");
    }
    // And only a delivery moves it.
    delivered.push("single");
    expect(selectPostFormat("auto", delivered).format).toBe(DEFAULT_POST_FORMAT);
  });

  it("a client with fewer delivered posts than the window gets carousels, and says why", () => {
    expect(POST_FORMAT_WINDOW).toBe(2);
    for (const history of [[] as InstagramFormat[], ["carousel"] as InstagramFormat[], ["single"] as InstagramFormat[]]) {
      const picked = selectPostFormat("auto", history);
      expect(picked.format).toBe(DEFAULT_POST_FORMAT);
      expect(picked.rule).toMatch(/fewer than the 2 the rotation reads/);
    }
  });

  it("reads only the LAST two, so a long history does not stall the rotation", () => {
    expect(selectPostFormat("auto", ["single", "single", "single", "carousel", "carousel"]).format).toBe("single");
    expect(selectPostFormat("auto", ["carousel", "carousel", "carousel", "single", "carousel"]).format).toBe(DEFAULT_POST_FORMAT);
  });
});
