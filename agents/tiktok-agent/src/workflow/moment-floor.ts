import type { TranscriptWordLike } from "./clip-bounds.js";

/**
 * Whether a proposed cut is worth watching, measured on the transcript.
 *
 * ## The gap this fills
 *
 * The moment picker chooses a window and `boundsFromTranscript` checks it is
 * LEGAL — snapped to sentence boundaries, between the length floor and
 * ceiling. Nothing then asked whether it is any GOOD. instagram-agent scores
 * its rendered output against a measured interest floor; the clipping agent
 * shipped whatever the model pointed at, and the audit's clips included
 * windows that were forty seconds of someone clearing their throat.
 *
 * ## What is measured, and what is deliberately only noted
 *
 * The repo's rule is that a heuristic check is a NOTE, not a gate: code proves
 * presence, never absence. So this separates the two, and the separation is
 * the whole design:
 *
 * - **Blocking, because they are arithmetic.** Speech density (words per
 *   second of runtime) and an opening built of filler. Both are counted, not
 *   judged; a window at 1.1 words a second demonstrably contains long silences,
 *   and a clip that opens on "so… um… you know" demonstrably opens on those
 *   words.
 * - **A note, because it is a guess.** Whether the window contains a CLAIM.
 *   Looking for figures and contrast connectives finds some claims and misses
 *   others, and a window with none of those markers may still be the best
 *   thirty seconds in the episode. It rides to the reviewer; it never decides.
 *
 * ## And it never holds
 *
 * A window under the floor is not a dead run. `bestLegalWindow` already exists
 * and already picks by density, so a refused window is re-picked in code and
 * the substitution is recorded — the same shape as every other repair in this
 * agent.
 */

/**
 * Words per second below which a window is mostly silence.
 *
 * Conversational English runs 2.3-3.3 words a second and a podcast guest
 * making a point sits at the top of that. 1.6 is well under the slowest
 * ordinary speech, so a window that fails it is not "a measured speaker" — it
 * has real gaps in it. Deliberately not set at the middle of the range: the
 * failure this catches is dead air, and a floor that also refused a
 * thoughtful speaker would cost good clips to catch bad ones.
 */
export const MIN_WORDS_PER_SECOND = 1.6;

/** How many of a clip's opening words are inspected for filler. About the first breath. */
export const OPENING_WORDS_CHECKED = 6;

/**
 * Words that carry nothing and are the commonest way a clip opens badly.
 *
 * Only ever consulted about the OPENING: "you know" in the middle of a
 * sentence is ordinary speech, and the same words at second zero are the
 * reason a stranger's thumb keeps moving.
 */
const FILLER = new Set([
  "so", "um", "uh", "er", "ah", "like", "well", "yeah", "yes", "no", "right", "okay", "ok", "and", "but", "i", "mean",
  "you", "know", "actually", "basically", "literally", "just", "kind", "sort", "of", "the", "a",
]);

/** A figure, a percentage or a year — the most checkable kind of claim there is. */
const FIGURE = /\d/;
/** Connectives that introduce a turn: the shape of "what everyone thinks, versus what is true". */
const CONTRAST = /(?<!\p{L})(but|however|actually|instead|whereas|except|the reason|turns out|in fact)(?!\p{L})/iu;

export interface MomentScore {
  /** False when a BLOCKING measure failed. Never a reason to hold — see the module comment. */
  ok: boolean;
  wordsPerSecond: number;
  /** Why it failed, in the words a reviewer reads. Empty when `ok`. */
  failures: string[];
  /** Observations that never decide anything. */
  notes: string[];
}

/**
 * Scores the window `[startSeconds, endSeconds)` of a transcript.
 *
 * Pure and synchronous. Takes the whole transcript rather than a pre-sliced
 * one so the caller cannot accidentally score a window it did not cut.
 */
export function scoreMoment(words: readonly TranscriptWordLike[], startSeconds: number, endSeconds: number): MomentScore {
  const duration = endSeconds - startSeconds;
  const inWindow = words.filter((w) => w.start >= startSeconds && w.end <= endSeconds);
  if (duration <= 0 || inWindow.length === 0) {
    return { ok: false, wordsPerSecond: 0, failures: ["the window contains no transcribed speech at all"], notes: [] };
  }

  const wordsPerSecond = inWindow.length / duration;
  const failures: string[] = [];
  const notes: string[] = [];

  if (wordsPerSecond < MIN_WORDS_PER_SECOND) {
    failures.push(
      `this window runs ${duration.toFixed(1)}s for ${inWindow.length} words (${wordsPerSecond.toFixed(2)} a second, under the ${MIN_WORDS_PER_SECOND} floor) — ` +
        "it is mostly silence, and a viewer meets the silence before they meet the point",
    );
  }

  const opening = inWindow.slice(0, OPENING_WORDS_CHECKED).map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
  const meaningful = opening.filter((w) => w.length > 0 && !FILLER.has(w));
  if (opening.length >= OPENING_WORDS_CHECKED && meaningful.length === 0) {
    failures.push(`the clip opens on ${OPENING_WORDS_CHECKED} words of filler ("${inWindow.slice(0, OPENING_WORDS_CHECKED).map((w) => w.text).join(" ")}") — the first second is the whole budget`);
  }

  // A NOTE, never a failure. Absence of a figure or a contrast connective is
  // not absence of a claim; it is absence of the two markers code can see.
  const text = inWindow.map((w) => w.text).join(" ");
  if (!FIGURE.test(text) && !CONTRAST.test(text)) {
    notes.push("no figure and no contrast connective in this window — it may be setup rather than the point, which is a judgment for the reviewer");
  }

  return { ok: failures.length === 0, wordsPerSecond, failures, notes };
}
