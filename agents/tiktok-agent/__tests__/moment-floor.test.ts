import { describe, expect, it } from "vitest";
import { MIN_WORDS_PER_SECOND, OPENING_WORDS_CHECKED, scoreMoment } from "../src/workflow/moment-floor.js";

/**
 * The watchability floor, as a unit.
 *
 * `boundsFromTranscript` proves a window is LEGAL. This is the check that
 * asks whether it is any good, and its whole design is the line between what
 * is arithmetic (blocking) and what is a guess (a note that never decides).
 */

/** `n` words spread evenly over `seconds`, so density is exactly what a test asks for. */
function speech(texts: readonly string[], seconds: number, from = 0): Array<{ text: string; start: number; end: number }> {
  const step = seconds / texts.length;
  return texts.map((text, i) => ({ text, start: from + i * step, end: from + (i + 1) * step }));
}

/**
 * Letter-only filler, because `word0` contains a DIGIT and the claim note
 * looks for exactly that. A fixture that accidentally satisfies the check
 * under test is how a green suite proves nothing.
 */
const plain = (n: number, prefix = "alpha"): string[] => Array.from({ length: n }, (_, i) => `${prefix}${"x".repeat((i % 5) + 1)}`);
const DENSE = [...plain(10), "47%", ...plain(79)];

describe("scoreMoment", () => {
  it("passes an ordinary dense window", () => {
    const score = scoreMoment(speech(DENSE, 30), 0, 30);
    expect(score.ok).toBe(true);
    expect(score.wordsPerSecond).toBeCloseTo(3, 1);
    expect(score.failures).toEqual([]);
  });

  it("refuses a window that is mostly silence, and says so in seconds and words", () => {
    // 30 words over 40 seconds is 0.75 a second — not a measured speaker, a
    // recording with real gaps in it.
    const score = scoreMoment(speech(plain(30), 40), 0, 40);
    expect(score.ok).toBe(false);
    expect(score.failures[0]).toContain("0.75 a second");
    expect(score.failures[0]).toContain(`${MIN_WORDS_PER_SECOND} floor`);
  });

  it("does not refuse a merely thoughtful speaker", () => {
    // The floor is well under the slowest ordinary speech on purpose: a bar
    // that also refused a deliberate speaker would cost good clips to catch
    // bad ones.
    const score = scoreMoment(speech(plain(60), 30), 0, 30);
    expect(score.wordsPerSecond).toBe(2);
    expect(score.ok).toBe(true);
  });

  it("refuses a clip that opens on nothing but filler", () => {
    const opening = ["So", "um", "you", "know", "I", "mean"];
    const score = scoreMoment(speech([...opening, ...DENSE], 30), 0, 30);
    expect(score.ok).toBe(false);
    expect(score.failures.join(" ")).toContain("opens on");
    expect(score.failures.join(" ")).toContain("So um you know I mean");
  });

  it("allows filler in the MIDDLE, because that is just speech", () => {
    // "you know" at second twelve is how people talk; the same words at
    // second zero are why a stranger keeps scrolling.
    const score = scoreMoment(speech(["Budgets", "collapse", "when", "you", "know", "nobody", ...DENSE], 30), 0, 30);
    expect(score.ok).toBe(true);
  });

  it("only inspects the opening it says it inspects", () => {
    const opening = Array.from({ length: OPENING_WORDS_CHECKED }, () => "um");
    const score = scoreMoment(speech([...opening, ...DENSE], 30), 0, 30);
    expect(score.ok).toBe(false);
    // One real word inside the window is enough to clear it.
    const rescued = scoreMoment(speech([...opening.slice(0, OPENING_WORDS_CHECKED - 1), "budgets", ...DENSE], 30), 0, 30);
    expect(rescued.ok).toBe(true);
  });

  it("treats a missing claim as a NOTE and never as a failure", () => {
    // The repo's rule: code proves presence, never absence. A window with no
    // figure and no contrast connective may still be the best thirty seconds
    // in the episode.
    const bland = scoreMoment(speech(plain(90), 30), 0, 30);
    expect(bland.ok).toBe(true);
    expect(bland.notes.join(" ")).toContain("may be setup");
  });

  it("says nothing about a claim when it can see one", () => {
    expect(scoreMoment(speech(DENSE, 30), 0, 30).notes).toEqual([]);
    const contrast = scoreMoment(speech(["Everyone", "assumes", "that", "but", ...plain(86)], 30), 0, 30).notes;
    expect(contrast).toEqual([]);
  });

  it("does not mistake a word CONTAINING a connective for one", () => {
    // `\b` is ASCII-only under `u`; "butter" must not read as "but".
    const score = scoreMoment(speech(["butter", "howevering", ...plain(88)], 30), 0, 30);
    expect(score.notes.join(" ")).toContain("may be setup");
  });

  it("scores only the window it was given, not the whole transcript", () => {
    // The caller passes the whole transcript on purpose, so it cannot
    // accidentally score a window it did not cut.
    const transcript = [...speech(plain(20, "slow"), 40, 0), ...speech(DENSE, 30, 40)];
    expect(scoreMoment(transcript, 0, 40).ok).toBe(false);
    expect(scoreMoment(transcript, 40, 70).ok).toBe(true);
  });

  it("refuses an empty or inverted window rather than dividing by zero", () => {
    expect(scoreMoment(speech(DENSE, 30), 0, 0).ok).toBe(false);
    expect(scoreMoment(speech(DENSE, 30), 100, 130).failures[0]).toContain("no transcribed speech");
  });
});
