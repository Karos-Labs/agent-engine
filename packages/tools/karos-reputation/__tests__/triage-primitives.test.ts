import { describe, expect, it } from "vitest";
import { parseTs } from "../src/triage/timestamps.js";
import { keywordHits } from "../src/triage/keywords.js";
import { pyRound } from "../src/triage/round.js";
import { detectRatingDip, triggerSignature } from "../src/triage/bursts.js";
import { compareReviewIds } from "../src/triage/sort.js";
import { proposedAction } from "../src/triage/proposed-action.js";
import { triage } from "../src/triage/triage.js";
import { DEFAULT_TRIAGE_CONFIG } from "../src/triage/config.js";
import type { Review, TriagePayload } from "../src/triage/types.js";

describe("parseTs (naive timestamps default to UTC, matching Python's datetime.fromisoformat + tzinfo backfill)", () => {
  it("parses a Z-suffixed timestamp as UTC", () => {
    expect(parseTs("2026-07-20T12:00:00Z").toISOString()).toBe("2026-07-20T12:00:00.000Z");
  });

  it("parses a naive (zoneless) timestamp as UTC, not local time", () => {
    expect(parseTs("2026-07-18T15:00:00").toISOString()).toBe("2026-07-18T15:00:00.000Z");
  });

  it("respects an explicit non-UTC offset", () => {
    expect(parseTs("2026-07-20T12:00:00+02:00").toISOString()).toBe("2026-07-20T10:00:00.000Z");
  });
});

describe("keywordHits (word-boundary scan across every language set)", () => {
  it("matches a whole-word keyword case-insensitively", () => {
    expect(keywordHits("This is a SCAM.", { en: ["scam"] })).toEqual(["scam"]);
  });

  it("does not match a keyword as a substring of a longer word", () => {
    expect(keywordHits("scampering around", { en: ["scam"] })).toEqual([]);
  });

  it("matches keywords across multiple language sets in the same text", () => {
    expect(keywordHits("scam and golpe", { en: ["scam"], pt: ["golpe"] })).toEqual(["golpe", "scam"]);
  });

  it("returns sorted unique hits", () => {
    expect(keywordHits("lawsuit and lawyer and lawsuit again", { en: ["lawsuit", "lawyer"] })).toEqual(["lawsuit", "lawyer"]);
  });
});

describe("pyRound (round-half-to-even, matching Python 3's round())", () => {
  it("rounds down below the midpoint", () => {
    expect(pyRound(2.4)).toBe(2);
  });

  it("rounds up above the midpoint", () => {
    expect(pyRound(2.6)).toBe(3);
  });

  it("rounds an exact .5 tie to the nearest even integer", () => {
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
  });

  it("rounds to N decimal places", () => {
    expect(pyRound(0.66666, 4)).toBe(0.6667);
  });

  /**
   * The regression this function was rewritten for. Scaling by `10 ** ndigits`
   * before deciding the rounding direction is itself a lossy float operation:
   * it can push a value ACROSS a boundary the true binary double was never
   * near. Python never does this — `round(x, n)` reads the exact stored value.
   *
   * Every expectation below was cross-checked against CPython 3.12's own
   * `round()` (16k+ generated cases, including the full `sum/count` grid a
   * rating window can actually produce and a random-bit-pattern sweep).
   */
  describe("operates on the exact binary double, never a scaled proxy", () => {
    it("pyRound(43/40, 2) === 1.07 — the rating-window average that used to answer 1.08", () => {
      // 43/40 is the double 1.0749999999999999555910790149937..., strictly BELOW
      // the 1.075 midpoint, so Python rounds DOWN. The old scaled implementation
      // computed 1.07499999999999995559 * 100 === exactly 107.5, read that as a
      // tie, applied half-to-even, and answered 1.08.
      expect(43 / 40).toBe(1.075); // the shortest round-tripping literal — the trap
      expect(pyRound(43 / 40, 2)).toBe(1.07);
    });

    it("pyRound(2.675, 2) === 2.67 — the canonical float-precision example", () => {
      // 2.675 as a double is 2.67499999999999982236431605997495...
      expect(pyRound(2.675, 2)).toBe(2.67);
    });

    it("pyRound(1.005, 2) === 1.0 — another below-the-midpoint double that looks like a tie", () => {
      // 1.005 as a double is 1.00499999999999989341858963598497...
      expect(pyRound(1.005, 2)).toBe(1.0);
    });

    it("still applies half-to-even on a genuine, exactly-representable tie", () => {
      // 0.125 and 0.375 ARE exactly representable, so these really are ties.
      expect(pyRound(0.125, 2)).toBe(0.12); // 2 is even -> stay
      expect(pyRound(0.375, 2)).toBe(0.38); // 7 is odd -> up
    });

    it("preserves sign, including Python's -0.0", () => {
      expect(pyRound(-43 / 40, 2)).toBe(-1.07);
      expect(Object.is(pyRound(-0.4), -0)).toBe(true);
    });
  });
});

describe("detectRatingDip (the crisis trigger pyRound's precision actually decides)", () => {
  const cfg = {
    ...DEFAULT_TRIAGE_CONFIG,
    crisis: { ...DEFAULT_TRIAGE_CONFIG.crisis, rating_dip: { delta: 0.3, window_days: 30, min_reviews_in_window: 5, baseline_days: 90 } },
  };
  const NOW = new Date("2026-07-20T12:00:00Z");

  /** `n` window reviews on `platform` whose ratings sum to `sum`, all inside the window. */
  function windowReviews(n: number, sum: number): Review[] {
    // Spread the sum across n reviews using only legal 1..5 integer ratings.
    const ratings: number[] = [];
    let remaining = sum;
    for (let i = 0; i < n; i++) {
      const left = n - i - 1;
      const value = Math.min(5, Math.max(1, remaining - left));
      ratings.push(value);
      remaining -= value;
    }
    expect(ratings.reduce((a, b) => a + b, 0)).toBe(sum);
    return ratings.map((rating, i) => ({
      review_id: `google:loc:dip-${String(i).padStart(3, "0")}`,
      platform: "google",
      source: "manual_export",
      capture_tier: "MEASURED" as const,
      rating,
      created_at: "2026-07-10T00:00:00Z",
    }));
  }

  it("fires at the n=40 / sum=43 boundary, because the window average is 1.07 (not 1.08)", () => {
    // window_avg = round(43/40, 2). Python: 1.07 -> baseline 1.37 - 1.07 = 0.30 >= 0.3 -> FIRES.
    // The old pyRound answered 1.08 -> 1.37 - 1.08 = 0.29 -> silently did NOT fire.
    const dips = detectRatingDip(windowReviews(40, 43), { google: 1.37 }, cfg, NOW);
    expect(dips).toHaveLength(1);
    expect(dips[0]!.window_rating_avg).toBe(1.07);
    expect(dips[0]!.window_review_count).toBe(40);
  });

  it("correctly does NOT fire one hundredth below the threshold at the same boundary value", () => {
    // 1.36 - 1.07 = 0.29 < 0.3.
    expect(detectRatingDip(windowReviews(40, 43), { google: 1.36 }, cfg, NOW)).toEqual([]);
  });

  it("skips a platform with no supplied baseline — data unavailable is not a zero", () => {
    expect(detectRatingDip(windowReviews(40, 43), {}, cfg, NOW)).toEqual([]);
  });
});

describe("review_id ordering (Python's code-point order, never ICU collation)", () => {
  /**
   * `triage.py` iterates `sorted(reviews, key=lambda r: r["review_id"])`, and
   * Python compares strings by code point: `"B-9" < "a_9"` because `0x42 <
   * 0x61`. `localeCompare` disagrees on BOTH counts — it orders
   * case-insensitively first (`a` before `B`) and reweights `-`/`_`.
   *
   * All 4 golden fixtures use lowercase, punctuation-free ids, which is
   * exactly why this divergence survived undetected; these ids are shaped like
   * the base64-ish tokens GBP actually issues.
   */
  const IDS = ["google:loc:AbFvOq1", "google:loc:B-9", "google:loc:a_9", "google:loc:abFvOq1"];

  function payload(): TriagePayload {
    return {
      now: "2026-07-20T12:00:00Z",
      reviews: IDS.map((review_id) => ({
        review_id,
        platform: "google",
        source: "manual_export",
        capture_tier: "MEASURED" as const,
        rating: 3,
        text: "It was fine.",
        created_at: "2026-07-19T00:00:00Z",
      })),
      already_responded_ids: [],
      seen_review_ids: [],
      alerted_crisis_signatures: [],
      baseline_rating_avg: {},
    };
  }

  it("emits results[] in code-point order, which is NOT the locale order", () => {
    const codePointOrder = [...IDS].sort(compareReviewIds);
    expect(codePointOrder).toEqual(["google:loc:AbFvOq1", "google:loc:B-9", "google:loc:a_9", "google:loc:abFvOq1"]);

    // Guard the premise: if these two ever agreed, this test would prove nothing.
    const localeOrder = [...IDS].sort((a, b) => a.localeCompare(b));
    expect(localeOrder).not.toEqual(codePointOrder);

    const result = triage(payload(), DEFAULT_TRIAGE_CONFIG);
    expect(result.results.map((r) => r.review_id)).toEqual(codePointOrder);
  });

  it("carries that same order into the crisis_keywords trigger's member list and signature", () => {
    const p = payload();
    p.reviews = p.reviews.map((r) => ({ ...r, text: "This is a scam." }));
    const result = triage(p, DEFAULT_TRIAGE_CONFIG);
    const trigger = result.crisis.triggers.find((t) => t.type === "crisis_keywords");
    if (trigger?.type !== "crisis_keywords") throw new Error("expected a crisis_keywords trigger");
    expect(trigger.reviews.map((r) => r.review_id)).toEqual([...IDS].sort(compareReviewIds));
  });
});

describe("triggerSignature (stable identity: type + sorted platforms + sorted review_ids)", () => {
  it("is stable regardless of input order", () => {
    const a = triggerSignature("negative_burst", ["yelp", "google"], ["r2", "r1"]);
    const b = triggerSignature("negative_burst", ["google", "yelp"], ["r1", "r2"]);
    expect(a).toBe(b);
  });

  it("deduplicates repeated platforms", () => {
    expect(triggerSignature("rating_dip", ["google", "google"], ["r1"])).toBe("rating_dip|google|r1");
  });
});

describe("proposedAction (proposal-first doctrine: first matching rule wins, already_responded overrides)", () => {
  it("returns the already-responded action when respondBlocked, ignoring every other signal", () => {
    const action = proposedAction(["crisis_keywords:scam"], true, DEFAULT_TRIAGE_CONFIG);
    expect(action.id).toBe("already-responded");
  });

  it("matches the first rule in config order when multiple signals could match", () => {
    // crisis-escalation (prefix match) is listed before burst-response in triage-config.json.
    const action = proposedAction(["burst_context", "crisis_keywords:scam"], false, DEFAULT_TRIAGE_CONFIG);
    expect(action.id).toBe("crisis-escalation");
  });

  it("falls back to default when no signal matches any rule", () => {
    const action = proposedAction(["some_unmapped_signal"], false, DEFAULT_TRIAGE_CONFIG);
    expect(action.id).toBe("default");
  });
});
