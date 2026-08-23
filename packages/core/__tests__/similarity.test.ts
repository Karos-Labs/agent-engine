import { describe, expect, it } from "vitest";
import {
  DEDUPE_SIMILARITY_THRESHOLD,
  closestMatch,
  normalizeForSimilarity,
  shingles,
  similarity,
} from "../src/agent-definitions/similarity.js";

/**
 * The de-duplication measure (docs/dynamic-agent-guardrails.md §3.3).
 *
 * This is the whole reason the scoring is a pure function rather than an
 * embedding call: the threshold is a product decision, and these tests are
 * what pin it. The calibration block below is the load-bearing part — it
 * asserts the BANDS the 0.40 threshold sits between, so a change to the
 * measure that quietly moved "honestly rewritten" above the line, or
 * "re-emitted with edits" below it, turns this file red rather than silently
 * changing what staff get flagged about.
 */

describe("normalizeForSimilarity", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeForSimilarity("  Hello,   WORLD!!  ")).toBe("hello world");
  });

  it("keeps non-Latin letters rather than stripping them to nothing", () => {
    // An ASCII-only strip would reduce this to "" and then score every pair of
    // Hebrew drafts as identical. This platform's clients are not all English.
    expect(normalizeForSimilarity("שלום, עולם!")).toBe("שלום עולם");
    expect(normalizeForSimilarity("café — naïve")).toBe("café naïve");
  });

  it("keeps digits, which carry real meaning in marketing copy", () => {
    expect(normalizeForSimilarity("Up 30% in Q3.")).toBe("up 30 in q3");
  });
});

describe("shingles", () => {
  it("produces word trigrams", () => {
    expect([...shingles("a b c d")]).toEqual(["a b c", "b c d"]);
  });

  it("falls back to the whole text when it is shorter than one trigram", () => {
    // Otherwise two identical one-word outputs would compare as "no overlap".
    expect([...shingles("hello")]).toEqual(["hello"]);
    expect(similarity("hello", "hello")).toBe(1);
  });

  it("is empty for text with no words at all", () => {
    expect(shingles("   !!!   ").size).toBe(0);
  });
});

describe("similarity", () => {
  it("scores identical text as 1", () => {
    const text = "The quarterly report shows steady growth across every region we serve.";
    expect(similarity(text, text)).toBe(1);
  });

  it("scores two empty texts as 0, not 1", () => {
    // "Both produced nothing" is not evidence of repetition. Returning 1 here
    // would flag every run whose deliverable failed to serialize.
    expect(similarity("", "")).toBe(0);
    expect(similarity("something", "")).toBe(0);
  });

  it("is symmetric", () => {
    const a = "we launched a new onboarding flow for enterprise customers this quarter";
    const b = "this quarter we shipped an onboarding flow aimed at enterprise buyers";
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10);
  });

  it("ignores punctuation and casing differences", () => {
    expect(similarity("Growth was steady, and margins held.", "growth was steady and margins held")).toBe(1);
  });
});

describe("threshold calibration — the bands 0.40 sits between", () => {
  const original =
    "Our new onboarding flow cuts setup time for enterprise teams. We rebuilt the invite step, removed three screens, and moved billing to the end. Early customers finished setup in under ten minutes.";

  it("flags the same draft re-emitted with light edits", () => {
    const lightlyEdited =
      "Our new onboarding flow cuts setup time for enterprise teams. We rebuilt the invite step, removed three screens, and moved billing to the very end. Early customers finished setup in well under ten minutes.";
    expect(similarity(original, lightlyEdited)).toBeGreaterThan(DEDUPE_SIMILARITY_THRESHOLD);
  });

  it("does NOT flag the same subject written afresh", () => {
    // Same topic, same facts, genuinely different writing. This is the case a
    // recurring agent hits legitimately, and flagging it would make the feature
    // noise rather than signal.
    const rewritten =
      "Setting up an enterprise account used to take the better part of an hour. Three screens are gone, invites work differently, and payment details come last. Most teams are now live within ten minutes.";
    expect(similarity(original, rewritten)).toBeLessThan(DEDUPE_SIMILARITY_THRESHOLD);
  });

  it("does NOT flag two unrelated drafts that share stock marketing phrasing", () => {
    const a = "We are excited to share that our team has been working hard on something new for all of you.";
    const b = "We are excited to share that our team has been listening to what matters most to our customers.";
    expect(similarity(a, b)).toBeLessThan(DEDUPE_SIMILARITY_THRESHOLD);
  });

  it("keeps the threshold where the product decision put it", () => {
    // A bare constant assertion on purpose: moving this number changes what
    // staff get flagged about, so it should be a deliberate edit to a test,
    // not a silent drift.
    expect(DEDUPE_SIMILARITY_THRESHOLD).toBe(0.4);
  });
});

describe("closestMatch", () => {
  it("returns null when there is no history to compare against", () => {
    expect(closestMatch("anything", [])).toBeNull();
  });

  it("picks the highest-scoring prior draft and names its job", () => {
    const candidate = "the quarterly report shows steady growth across every region";
    const best = closestMatch(candidate, [
      { jobId: "job-old", excerpt: "completely unrelated text about hiring and office moves" },
      { jobId: "job-dupe", excerpt: "the quarterly report shows steady growth across every region" },
    ]);
    expect(best).not.toBeNull();
    expect(best!.jobId).toBe("job-dupe");
    expect(best!.score).toBe(1);
  });

  it("still returns the closest match when nothing is actually similar", () => {
    // The caller decides against the threshold — this function reports, it does
    // not judge. A match below the line is how "ok, closest was 12%" is shown.
    const best = closestMatch("apples and oranges in a bowl", [
      { jobId: "job-a", excerpt: "an entirely different sentence about servers" },
    ]);
    expect(best).not.toBeNull();
    expect(best!.jobId).toBe("job-a");
    expect(best!.score).toBeLessThan(DEDUPE_SIMILARITY_THRESHOLD);
  });
});
