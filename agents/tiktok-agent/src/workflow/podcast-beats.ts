import { PLATE_SECONDS } from "./types.js";

/**
 * Turning a clipped podcast segment into the beats a short is rendered from.
 *
 * ## Who owns what, and why it is split this way
 *
 * A podcast clip's narration is NOT written. It is the recording — the
 * speakers' own words, already spoken, already timed. So the words are cut
 * here, in code, from the transcript's word timings: a beat boundary is a
 * point in the audio, and the beat's text is whatever was said between this
 * boundary and the next.
 *
 * The model's job is the PICTURES. It receives each beat's verbatim text and
 * writes the on-screen line and the visual brief for it. That division is
 * deliberate and it is the whole safety property of this path: a model cannot
 * paraphrase a speaker, cannot tighten a quote, and cannot desynchronise the
 * captions from the audio, because it is never asked for the words at all.
 * The worst a bad model turn can do is give a beat a poor picture, which the
 * visual QA already scores and the re-pick already re-sources.
 *
 * This is the opposite arrangement from the original short, where the model
 * writes the script and the voice is synthesised FROM it. There the words are
 * the model's to choose; here they belong to somebody who already said them.
 */

/** A word as `video.transcribe` returns it. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface PodcastBeat {
  /** Verbatim, from the transcript. Never a paraphrase. */
  narration: string;
  /** Seconds from the START OF THE CUT, so the renderer's timings line up with the cut audio rather than with the episode. */
  startSeconds: number;
  endSeconds: number;
  /** The nearest legal plate length, which is what the renderer holds a picture for. */
  seconds: (typeof PLATE_SECONDS)[number];
}

/** Fewer than this and a clip is one long shot; more and no picture is on screen long enough to read. */
export const MIN_PODCAST_BEATS = 3;
export const MAX_PODCAST_BEATS = 5;

/** A sentence has ended when the last word carries one of these. Kept to the marks that survive an ASR's own punctuation. */
const SENTENCE_END = /[.!?…]["')\]]*$/;

/** The legal plate length nearest an actual span, so a picture holds for about as long as the words under it. */
export function nearestPlateSeconds(span: number): (typeof PLATE_SECONDS)[number] {
  // Annotated, not inferred: `PLATE_SECONDS` is a const tuple, so
  // `PLATE_SECONDS[0]` narrows to the literal `4` and the loop below cannot
  // assign a 6 or an 8 to it.
  let best: (typeof PLATE_SECONDS)[number] = PLATE_SECONDS[0]!;
  for (const candidate of PLATE_SECONDS) {
    if (Math.abs(candidate - span) < Math.abs(best - span)) best = candidate;
  }
  return best;
}

/**
 * Splits a window of transcript words into 3-5 contiguous beats.
 *
 * ## The boundaries are sentence ends, and then arithmetic
 *
 * A cut that lands mid-sentence puts a new picture on screen halfway through
 * a clause, which reads as a mistake even when the audio is continuous. So
 * sentence ends are preferred: the function aims for `target` beats of roughly
 * equal length and, for each boundary, takes the nearest sentence end within
 * a tolerance. Only when a stretch of speech has no sentence end at all —
 * which happens, people talk in runs — does it cut on time alone.
 *
 * ## It cannot fail
 *
 * Every input that has any words at all yields at least one beat. A window
 * with too few words for `MIN_PODCAST_BEATS` yields as many as it can rather
 * than refusing: this function sits on the always-deliver path, and "the
 * speaker said three sentences" is not a reason to return no clip.
 *
 * `startSeconds`/`endSeconds` are rebased to the cut, because the renderer
 * aligns its plates to the audio file it is handed and that file starts at the
 * moment, not at the episode.
 */
export function splitTranscriptIntoBeats(words: readonly TimedWord[], windowStart: number, windowEnd: number, target = 4): PodcastBeat[] {
  const inWindow = words
    .filter((w) => typeof w.text === "string" && w.text.trim().length > 0 && w.end > windowStart && w.start < windowEnd)
    .sort((a, b) => a.start - b.start);
  if (inWindow.length === 0) return [];

  const wanted = Math.max(MIN_PODCAST_BEATS, Math.min(MAX_PODCAST_BEATS, target));
  // Never more beats than words: five beats out of four words is four empty
  // beats and one real one.
  const count = Math.max(1, Math.min(wanted, inWindow.length));

  // Indices of words that END a sentence — the boundaries worth preferring.
  const sentenceEnds = new Set<number>();
  inWindow.forEach((w, i) => {
    if (SENTENCE_END.test(w.text.trim())) sentenceEnds.add(i);
  });

  const perBeat = inWindow.length / count;
  /** How far from the arithmetic boundary a sentence end may be and still be preferred. */
  const tolerance = Math.max(1, Math.floor(perBeat / 2));

  const cuts: number[] = [];
  for (let b = 1; b < count; b += 1) {
    const ideal = Math.round(b * perBeat) - 1;
    let chosen = ideal;
    for (let d = 0; d <= tolerance; d += 1) {
      if (sentenceEnds.has(ideal - d) && ideal - d > (cuts[cuts.length - 1] ?? -1)) {
        chosen = ideal - d;
        break;
      }
      if (sentenceEnds.has(ideal + d) && ideal + d < inWindow.length - 1) {
        chosen = ideal + d;
        break;
      }
    }
    // Monotonic and never empty: a sentence end pulled backwards past the
    // previous cut would make a beat of zero words.
    if (chosen <= (cuts[cuts.length - 1] ?? -1)) chosen = ideal;
    cuts.push(chosen);
  }

  const beats: PodcastBeat[] = [];
  let from = 0;
  for (const cut of [...cuts, inWindow.length - 1]) {
    const slice = inWindow.slice(from, cut + 1);
    if (slice.length === 0) continue;
    const start = Math.max(0, slice[0]!.start - windowStart);
    const end = Math.max(start + 0.1, slice[slice.length - 1]!.end - windowStart);
    beats.push({
      narration: slice.map((w) => w.text.trim()).join(" ").replace(/\s+/g, " ").trim(),
      startSeconds: Number(start.toFixed(2)),
      endSeconds: Number(end.toFixed(2)),
      seconds: nearestPlateSeconds(end - start),
    });
    from = cut + 1;
  }
  return beats;
}

/**
 * How many beats a window of this length wants.
 *
 * Long enough for five and it gets five; a twenty-second moment gets three.
 * Kept separate from the splitter so the caller can say what it wants and the
 * splitter stays a pure function of its arguments.
 */
export function beatsForWindow(seconds: number): number {
  if (seconds >= 36) return MAX_PODCAST_BEATS;
  if (seconds >= 26) return 4;
  return MIN_PODCAST_BEATS;
}
