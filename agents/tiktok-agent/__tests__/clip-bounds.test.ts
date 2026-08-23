import { describe, expect, it } from "vitest";
import { boundsFromTranscript, sentenceBoundedWords, type TranscriptWordLike } from "../src/workflow/clip-bounds.js";

/**
 * The layer that turns a model's proposed moment into a real cut.
 *
 * These are the properties that decide whether a clip is watchable: it opens on
 * a whole thought, it closes on one, and a proposal the transcript does not
 * support is refused rather than clamped into something shippable-looking.
 */

/** Builds a transcript where each word occupies one second. */
function transcript(text: string, startAt = 0): TranscriptWordLike[] {
  return text.split(" ").map((word, i) => ({ text: word, start: startAt + i, end: startAt + i + 1 }));
}

const OPTS = { minSeconds: 20, maxSeconds: 120 };

describe("sentenceBoundedWords", () => {
  it("groups words into sentences with the timestamps a cut could use", () => {
    const sentences = sentenceBoundedWords(transcript("hello there friend. second one here."));

    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({ text: "hello there friend.", start: 0, end: 3 });
    expect(sentences[1]).toMatchObject({ text: "second one here.", start: 3, end: 6 });
  });

  it("still offers a trailing fragment when the transcript never punctuates", () => {
    // Auto-transcripts frequently return no punctuation at all. Returning
    // nothing here would leave the selector with no candidates and every run
    // for that source would hold.
    const sentences = sentenceBoundedWords(transcript("no punctuation anywhere in this one"));

    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.start).toBe(0);
    expect(sentences[0]?.end).toBe(6);
  });

  it("treats ? and ! as sentence ends, and tolerates a closing quote", () => {
    const sentences = sentenceBoundedWords(transcript(`really? yes! "absolutely."`));

    expect(sentences.map((s) => s.text)).toEqual(["really?", "yes!", `"absolutely."`]);
  });

  it("returns nothing for an empty transcript rather than a fake sentence", () => {
    expect(sentenceBoundedWords([])).toEqual([]);
  });
});

describe("boundsFromTranscript", () => {
  /** 60 one-second sentences — enough to build legal clips from. */
  const long = transcript(Array.from({ length: 60 }, (_, i) => `w${i}.`).join(" "));
  /** 200 seconds, so a clip CAN exceed the 120s ceiling. */
  const veryLong = transcript(Array.from({ length: 200 }, (_, i) => `w${i}.`).join(" "));

  it("snaps a mid-sentence proposal out to whole sentences", () => {
    const words = transcript("aa bb cc dd ee ff. gg hh ii jj kk ll. mm nn oo pp qq rr.");
    // Propose a window that starts and ends inside sentences.
    const result = boundsFromTranscript(words, 2, 14, { minSeconds: 1, maxSeconds: 120 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Start snapped back to the containing sentence's first word, end forward
    // to a sentence-final word.
    expect(result.startSeconds).toBe(0);
    expect(result.endSeconds).toBe(18);
    expect(result.text.endsWith(".")).toBe(true);
  });

  it("refuses a clip under the floor instead of padding it", () => {
    const result = boundsFromTranscript(long, 0, 5, OPTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/under the 20s floor/);
  });

  it("refuses a clip over the ceiling instead of trimming it", () => {
    // Trimming back to the cap would drop the payoff the moment was chosen
    // for. Shipping the first 120s of a 200s answer is worse than picking again.
    const result = boundsFromTranscript(veryLong, 0, 180, OPTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/over the 120s ceiling/);
  });

  it("snaps an end proposed past the transcript back to the last sentence", () => {
    // A model can propose an end beyond the material it was shown. Snapping to
    // the end of what exists is right; the duration check still has to pass,
    // so this cannot become a way to smuggle an illegal clip through.
    const result = boundsFromTranscript(long, 20, 5000, OPTS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.endSeconds).toBe(60);
    expect(result.endSeconds - result.startSeconds).toBeLessThanOrEqual(OPTS.maxSeconds);
  });

  it("refuses a start past the end of the transcript", () => {
    const result = boundsFromTranscript(long, 5000, 5100, OPTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/past the end of the transcript/);
  });

  it("refuses an inverted window", () => {
    const result = boundsFromTranscript(long, 40, 10, OPTS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/not after proposed start/);
  });

  it("refuses an empty transcript", () => {
    expect(boundsFromTranscript([], 0, 30, OPTS)).toMatchObject({ ok: false });
  });

  it("returns only the words inside the snapped window", () => {
    // The subtitle track is built from these, so a word outside the cut would
    // burn a subtitle for audio the viewer never hears.
    const result = boundsFromTranscript(long, 10, 40, OPTS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    for (const word of result.words) {
      expect(word.start).toBeGreaterThanOrEqual(result.startSeconds);
      expect(word.end).toBeLessThanOrEqual(result.endSeconds);
    }
    expect(result.text.split(" ")).toHaveLength(result.words.length);
  });

  it("produces a clip whose duration is inside the declared bounds when it succeeds", () => {
    // The invariant everything downstream relies on: if this says ok, the cut
    // is legal. Swept across many proposals rather than asserted once.
    for (let start = 0; start < 30; start += 3) {
      for (const span of [25, 40, 60, 90]) {
        const result = boundsFromTranscript(long, start, start + span, OPTS);
        if (!result.ok) continue;
        const duration = result.endSeconds - result.startSeconds;
        expect(duration, `start=${start} span=${span}`).toBeGreaterThanOrEqual(OPTS.minSeconds);
        expect(duration, `start=${start} span=${span}`).toBeLessThanOrEqual(OPTS.maxSeconds);
      }
    }
  });
});
