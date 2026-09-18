import type { TranscriptWord } from "@agent-engine/tool-karos-video";

/**
 * Turning the highlight model's proposed emphasis into emphasis that exists.
 *
 * ## The gap
 *
 * `branded-shorts-highlights` returns `highlightStarts` — a list of
 * timestamps, one per word it wants set in the second caption font. Its prompt
 * has said since v1: *"Never invent a word. Every timestamp you return must be
 * the `start` time of a real word already in the transcript you were given."*
 * Nothing checked. The schema is `z.array(z.number().nonnegative())`, so any
 * number at all cleared it and went straight into the render job's
 * `highlight_starts`, where the Python engine matches it against the real
 * words and emphasises whatever happens to be nearest, or nothing.
 *
 * This is the same defect the clipping agent fixed on its own model years
 * ago, in the same repo, with the comment that says it best: *a model asked
 * for a timestamp will return one whether or not the transcript supports it.*
 * The moment picker's proposal is snapped to real word boundaries and
 * validated. This one was not.
 *
 * ## What is enforced here, and why each one is code and not a prompt line
 *
 * Every rule below is one the prompt already states. A prompt states an
 * intention; this is the part that makes it true.
 *
 * 1. **A real word.** A timestamp matching no kept word is dropped.
 * 2. **Never a filler.** The prompt bans emphasising "uh"/"um"; those words
 *    are not even captioned, so emphasising one is emphasis nobody sees.
 * 3. **Never two in a breath.** An emphasis run is atomic, and two emphasised
 *    words with no clause boundary between them read as shouting rather than
 *    as rhythm.
 *
 * Nothing here HOLDS. A plan whose emphasis was invented becomes a short with
 * less emphasis, never no short: the owner's rule, and the same shape as every
 * other repair in this agent.
 */

/**
 * How close a proposed timestamp must be to a real word's start to BE that
 * word, in seconds.
 *
 * Not zero: the model is copying numbers out of a transcript it was given as
 * JSON, and a value that round-trips through a float is not always
 * byte-identical. 40ms is far tighter than the gap between two spoken words
 * (the shortest is ~120ms) so this can never match the wrong word, and loose
 * enough that a correctly-copied timestamp is never rejected on a rounding
 * artefact.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 0.04;

/**
 * The silence that makes two emphasised words a rhythm rather than a shout.
 *
 * Roughly a clause boundary. Below it the two words are inside one breath, and
 * the prompt's "an emphasis run is atomic, not a cluster" applies.
 */
export const MIN_EMPHASIS_GAP_SECONDS = 0.6;

/** Disfluencies, which this pipeline does not caption at all — so emphasising one is emphasis nobody ever sees. */
const FILLER = new Set(["uh", "um", "er", "ah", "erm", "hmm", "mm", "mhm", "uhh", "umm"]);

export interface RhythmResult {
  /** The emphasis that survived, ascending. */
  highlightStarts: number[];
  /** What was dropped and why, one line each, in the words a reviewer reads. Empty on the normal path. */
  dropped: string[];
}

/** A word's text, normalised for the filler comparison. */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Snaps the model's proposed emphasis onto words that exist, drops what the
 * prompt already forbids, and reports every drop.
 *
 * Pure and synchronous. `kept` is the words that survive the cut — the same
 * list the model was given — so a timestamp from a word the cut removed is
 * correctly treated as invented: it is not in the short.
 */
export function applyHighlightRhythm(proposed: readonly number[], kept: readonly TranscriptWord[]): RhythmResult {
  const words = kept.filter((w) => w.type === "word");
  const dropped: string[] = [];
  const accepted: Array<{ start: number; text: string }> = [];

  // Ascending, so "two in the same breath" always drops the LATER one — the
  // first emphasis in a stretch is the one the reader's eye lands on, and
  // dropping it to keep its neighbour would move the beat rather than fix it.
  for (const start of [...new Set(proposed)].sort((a, b) => a - b)) {
    const word = words.find((w) => Math.abs(w.start - start) <= TIMESTAMP_TOLERANCE_SECONDS);
    if (word === undefined) {
      dropped.push(`${start.toFixed(2)}s matches no word in the cut — the model proposed a timestamp the transcript does not contain`);
      continue;
    }
    if (FILLER.has(bare(word.text))) {
      dropped.push(`${start.toFixed(2)}s is a disfluency ("${word.text}"), which this pipeline never captions, so emphasising it is emphasis nobody sees`);
      continue;
    }
    const previous = accepted[accepted.length - 1];
    if (previous !== undefined && word.start - previous.start < MIN_EMPHASIS_GAP_SECONDS) {
      dropped.push(
        `${start.toFixed(2)}s ("${word.text}") is ${(word.start - previous.start).toFixed(2)}s after "${previous.text}" — inside one breath, and an emphasis run is atomic, not a cluster`,
      );
      continue;
    }
    accepted.push({ start: word.start, text: word.text });
  }

  return { highlightStarts: accepted.map((a) => a.start), dropped };
}
