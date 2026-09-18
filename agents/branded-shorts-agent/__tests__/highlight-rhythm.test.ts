import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "@agent-engine/tool-karos-video";
import { MIN_EMPHASIS_GAP_SECONDS, TIMESTAMP_TOLERANCE_SECONDS, applyHighlightRhythm } from "../src/workflow/highlight-rhythm.js";

/**
 * The emphasis the model proposed, against the words that exist.
 *
 * Its prompt has forbidden inventing a timestamp since v1 and nothing
 * checked — the schema is `z.array(z.number().nonnegative())`, so any number
 * at all reached the render job. This is the check that makes the prompt's
 * three hard rules true.
 */

const w = (text: string, start: number, end = start + 0.3): TranscriptWord => ({ text, start, end, type: "word" }) as TranscriptWord;

/** "Budgets collapse when nobody owns the number" — a word a second, so gaps are readable. */
const KEPT: TranscriptWord[] = [
  w("Budgets", 0),
  w("collapse", 1),
  w("um", 2),
  w("when", 3),
  w("nobody", 4),
  w("owns", 5),
  w("the", 6),
  w("number", 7),
];

describe("applyHighlightRhythm", () => {
  it("keeps emphasis that lands on real, well-spaced words", () => {
    const result = applyHighlightRhythm([0, 4, 7], KEPT);
    expect(result.highlightStarts).toEqual([0, 4, 7]);
    expect(result.dropped).toEqual([]);
  });

  it("drops a timestamp the transcript does not contain", () => {
    // The failure this exists for: a model asked for a timestamp returns one
    // whether or not the transcript supports it.
    const result = applyHighlightRhythm([0, 3.5, 4], KEPT);
    expect(result.highlightStarts).toEqual([0, 4]);
    expect(result.dropped.join(" ")).toContain("matches no word in the cut");
  });

  it("tolerates a rounding artefact but never matches the wrong word", () => {
    // The model copies numbers out of JSON, so an exact compare is too strict;
    // the tolerance is far tighter than the gap between two spoken words.
    expect(applyHighlightRhythm([4 + TIMESTAMP_TOLERANCE_SECONDS / 2], KEPT).highlightStarts).toEqual([4]);
    const wrong = applyHighlightRhythm([4.5], KEPT);
    expect(wrong.highlightStarts).toEqual([]);
  });

  it("drops a disfluency, because this pipeline never captions one", () => {
    const result = applyHighlightRhythm([0, 2], KEPT);
    expect(result.highlightStarts).toEqual([0]);
    expect(result.dropped.join(" ")).toContain("disfluency");
  });

  it("drops the LATER of two emphasis words inside one breath", () => {
    // Dropping the earlier one would move the beat rather than fix it: the
    // first emphasis in a stretch is where the reader's eye lands.
    const tight: TranscriptWord[] = [w("Budgets", 0), w("really", 0.3), w("collapse", 2)];
    const result = applyHighlightRhythm([0, 0.3, 2], tight);
    expect(result.highlightStarts).toEqual([0, 2]);
    expect(result.dropped.join(" ")).toContain("inside one breath");
  });

  it("keeps two emphasis words separated by a real clause boundary", () => {
    const spaced: TranscriptWord[] = [w("Budgets", 0), w("collapse", MIN_EMPHASIS_GAP_SECONDS)];
    expect(applyHighlightRhythm([0, MIN_EMPHASIS_GAP_SECONDS], spaced).highlightStarts).toHaveLength(2);
  });

  it("treats a word the CUT removed as invented, because it is not in the short", () => {
    // `kept` is the words that survive the cut — the same list the model was
    // given. A timestamp from a removed word would emphasise nothing.
    const result = applyHighlightRhythm([1], KEPT.filter((word) => word.start !== 1));
    expect(result.highlightStarts).toEqual([]);
    expect(result.dropped.join(" ")).toContain("matches no word");
  });

  it("sorts and de-duplicates whatever order the model returned", () => {
    const result = applyHighlightRhythm([7, 0, 7, 4], KEPT);
    expect(result.highlightStarts).toEqual([0, 4, 7]);
  });

  it("returns nothing, and complains about nothing, for an empty proposal", () => {
    // A highlights step that returned nothing schema-valid produces a flatter
    // short, which is already recorded by its own repair — this must not add
    // a second, contradictory complaint about it.
    expect(applyHighlightRhythm([], KEPT)).toEqual({ highlightStarts: [], dropped: [] });
  });
});
