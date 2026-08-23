/**
 * Turning a proposed moment into a real cut.
 *
 * The legacy engine does this in `clip_video.clip_bounds`: a clip never starts
 * or ends mid-sentence, because a cut that opens on half a word reads as
 * broken to a viewer in the first half-second — which is the whole budget a
 * clip gets. Ported here as a pure function so its behaviour is pinned by unit
 * tests rather than by a Python subprocess.
 *
 * It is also the validation layer for the model step above it. A model asked
 * for a timestamp returns a plausible number whether or not the transcript
 * supports it, so nothing downstream uses the proposed times directly: they are
 * snapped to word boundaries that demonstrably exist, and a proposal that
 * cannot be snapped into a legal clip is refused rather than clamped into one.
 */

/** The subset of a transcript word this module needs. */
export interface TranscriptWordLike {
  text: string;
  start: number;
  end: number;
}

/** Sentence-final punctuation. A word ending in one of these can end a clip. */
const SENTENCE_END = /[.!?]["')\]]?\s*$/;

export interface ClipBoundsOptions {
  minSeconds: number;
  maxSeconds: number;
}

export type ClipBoundsResult =
  | { ok: true; startSeconds: number; endSeconds: number; text: string; words: TranscriptWordLike[] }
  | { ok: false; reason: string };

/**
 * The transcript as the selector should see it: words grouped into sentences,
 * each carrying the timestamps a legal cut could use.
 *
 * Handing the model sentence starts and ends rather than a flat word list is
 * what makes "snap to sentence boundaries" a request it can actually honour
 * instead of a rule it gets marked down against afterwards.
 */
export function sentenceBoundedWords(words: readonly TranscriptWordLike[]): Array<{ text: string; start: number; end: number }> {
  const sentences: Array<{ text: string; start: number; end: number }> = [];
  let buffer: TranscriptWordLike[] = [];

  for (const word of words) {
    buffer.push(word);
    if (SENTENCE_END.test(word.text)) {
      sentences.push({
        text: buffer.map((w) => w.text).join(" ").trim(),
        start: buffer[0]!.start,
        end: word.end,
      });
      buffer = [];
    }
  }
  // A trailing fragment is still offered: a transcript that never punctuates
  // (many auto-transcripts do not) would otherwise produce no sentences at
  // all, and the selector would have nothing to choose from.
  if (buffer.length > 0) {
    sentences.push({
      text: buffer.map((w) => w.text).join(" ").trim(),
      start: buffer[0]!.start,
      end: buffer[buffer.length - 1]!.end,
    });
  }
  return sentences;
}

/**
 * Snaps a proposed window onto real word boundaries and checks it is a legal
 * clip.
 *
 * Start moves BACKWARD to the first word at or after the proposal only when
 * that word begins a sentence; otherwise it walks back to the sentence that
 * contains the proposal, so the clip opens on a whole thought. End moves
 * FORWARD to the next sentence-final word, so it closes on one.
 */
export function boundsFromTranscript(
  words: readonly TranscriptWordLike[],
  proposedStart: number,
  proposedEnd: number,
  options: ClipBoundsOptions,
): ClipBoundsResult {
  if (words.length === 0) return { ok: false, reason: "the transcript has no words" };
  if (proposedEnd <= proposedStart) {
    return { ok: false, reason: `proposed end (${proposedEnd}s) is not after proposed start (${proposedStart}s)` };
  }

  const sentences = sentenceBoundedWords(words);
  // The sentence the proposed start falls in, or the first one after it.
  const startSentence =
    sentences.find((s) => proposedStart >= s.start && proposedStart <= s.end) ??
    sentences.find((s) => s.start >= proposedStart);
  if (!startSentence) {
    return { ok: false, reason: `proposed start ${proposedStart}s is past the end of the transcript` };
  }

  // The last sentence that ends at or after the proposed end — closing on a
  // sentence rather than cutting the speaker off mid-clause.
  const endSentence = sentences.find((s) => s.end >= proposedEnd) ?? sentences[sentences.length - 1]!;
  if (endSentence.end <= startSentence.start) {
    return { ok: false, reason: "the proposed window collapses to nothing once snapped to sentence boundaries" };
  }

  const startSeconds = startSentence.start;
  const endSeconds = endSentence.end;
  const duration = endSeconds - startSeconds;

  if (duration < options.minSeconds) {
    return {
      ok: false,
      reason: `snapped clip is ${duration.toFixed(1)}s, under the ${options.minSeconds}s floor`,
    };
  }
  if (duration > options.maxSeconds) {
    // Deliberately not trimmed back to the cap. Cutting a clip short to fit
    // would drop the payoff the moment was chosen for, and shipping the first
    // 120 seconds of a 200-second answer is a worse outcome than picking again.
    return {
      ok: false,
      reason: `snapped clip is ${duration.toFixed(1)}s, over the ${options.maxSeconds}s ceiling`,
    };
  }

  const kept = words.filter((w) => w.start >= startSeconds && w.end <= endSeconds);
  return {
    ok: true,
    startSeconds,
    endSeconds,
    text: kept.map((w) => w.text).join(" ").trim(),
    words: kept,
  };
}
