import { describe, expect, it } from "vitest";
import { beatsForWindow, nearestPlateSeconds, splitTranscriptIntoBeats, type TimedWord } from "../src/workflow/podcast-beats.js";

/**
 * A podcast clip's words are NOT written — they are the recording.
 *
 * This is where they are cut, in code, from the transcript's own word
 * timings. The model that dresses these beats is given the verbatim text and
 * asked only for a picture and an on-screen line, so it cannot paraphrase a
 * speaker, tighten a quote, or desynchronise the captions from the audio.
 *
 * That safety property rests entirely on this function, which makes its
 * tests the load-bearing ones: a beat whose text is not exactly what was said
 * between its two timestamps would put a caption on screen that the audio
 * does not match.
 */

/** Builds a word list from a sentence, at `wps` words per second from `from`. */
function say(text: string, from: number, wps = 2.5): TimedWord[] {
  return text.split(" ").map((word, i) => ({ text: word, start: from + i / wps, end: from + (i + 1) / wps }));
}

const SPEECH: TimedWord[] = [
  ...say("Every brand is using the same three tools right now.", 0),
  ...say("So the output converges and nobody can tell you apart.", 4),
  ...say("The teams winning are not producing more of it.", 8),
  ...say("They are simply moving before the window closes.", 12),
  ...say("That is the entire advantage and it is a timing one.", 16),
];

describe("splitTranscriptIntoBeats", () => {
  it("keeps every word, in order, with nothing invented and nothing dropped", () => {
    // The property the whole path rests on. Concatenating the beats must
    // reproduce the speech exactly: a beat that paraphrased, reordered or
    // skipped a word would caption something nobody said.
    //
    // The window is 21s, not 20: the last sentence runs to 20.8, and a word
    // that STARTS after the window ends is correctly outside it. Asserting
    // against the full string with a 20s window would be asserting that the
    // splitter ignores its own bounds.
    const beats = splitTranscriptIntoBeats(SPEECH, 0, 21, 4);
    const rejoined = beats.map((b) => b.narration).join(" ");
    expect(rejoined).toBe(SPEECH.map((w) => w.text).join(" "));
  });

  it("prefers a sentence end over the arithmetic boundary", () => {
    // A picture that changes halfway through a clause reads as a mistake even
    // when the audio is continuous.
    const beats = splitTranscriptIntoBeats(SPEECH, 0, 20, 4);
    expect(beats.length).toBeGreaterThanOrEqual(3);
    for (const beat of beats.slice(0, -1)) {
      expect(beat.narration.trim(), beat.narration).toMatch(/[.!?]$/);
    }
  });

  it("rebases the timings onto the CUT, not the episode", () => {
    // The renderer aligns plates to the audio file it is handed, and that
    // file starts at the moment. A beat still carrying episode timestamps
    // would place every picture minutes into a forty-second clip.
    const beats = splitTranscriptIntoBeats(SPEECH, 8, 20, 3);
    expect(beats[0]!.startSeconds).toBeLessThan(1);
    expect(beats[beats.length - 1]!.endSeconds).toBeLessThanOrEqual(12.5);
  });

  it("takes only the words inside the window", () => {
    const beats = splitTranscriptIntoBeats(SPEECH, 8, 16, 3);
    const text = beats.map((b) => b.narration).join(" ");
    expect(text).not.toContain("Every brand");
    expect(text).not.toContain("entire advantage");
    expect(text).toContain("winning");
  });

  it("cuts on time when a run of speech has no sentence end in it", () => {
    // People talk in runs. A window with no punctuation must still divide,
    // or the clip is one still picture for forty seconds.
    const run = say("and then we tried it again and again and again and it still did not move the number at all", 0);
    const beats = splitTranscriptIntoBeats(run, 0, 40, 4);
    expect(beats).toHaveLength(4);
    expect(beats.map((b) => b.narration).join(" ")).toBe(run.map((w) => w.text).join(" "));
  });

  it("never returns an empty beat, and never more beats than words", () => {
    // Five beats out of four words is four empty beats and one real one.
    const beats = splitTranscriptIntoBeats(say("Three words here.", 0), 0, 5, 5);
    expect(beats.length).toBeLessThanOrEqual(3);
    for (const beat of beats) expect(beat.narration.length).toBeGreaterThan(0);
  });

  it("returns nothing for a window with no speech in it, rather than an empty beat", () => {
    expect(splitTranscriptIntoBeats([], 0, 20, 4)).toEqual([]);
    expect(splitTranscriptIntoBeats(SPEECH, 100, 120, 4)).toEqual([]);
    // Whitespace-only words are what an ASR emits for a pause.
    expect(splitTranscriptIntoBeats([{ text: "   ", start: 0, end: 1 }], 0, 5, 3)).toEqual([]);
  });

  it("gives each beat a legal plate length near its real span", () => {
    const beats = splitTranscriptIntoBeats(SPEECH, 0, 20, 4);
    for (const beat of beats) {
      expect([4, 6, 8]).toContain(beat.seconds);
    }
  });

  it("keeps the beats contiguous and monotonic in time", () => {
    // A later beat that starts before an earlier one ends would have two
    // pictures claiming the same audio.
    const beats = splitTranscriptIntoBeats(SPEECH, 0, 20, 5);
    for (let i = 1; i < beats.length; i += 1) {
      expect(beats[i]!.startSeconds).toBeGreaterThanOrEqual(beats[i - 1]!.endSeconds - 0.5);
      expect(beats[i]!.endSeconds).toBeGreaterThan(beats[i]!.startSeconds);
    }
  });
});

describe("beatsForWindow", () => {
  it("asks for more beats the longer the moment runs", () => {
    expect(beatsForWindow(20)).toBe(3);
    expect(beatsForWindow(30)).toBe(4);
    expect(beatsForWindow(40)).toBe(5);
  });
});

describe("nearestPlateSeconds", () => {
  it("snaps to the legal plate lengths", () => {
    expect(nearestPlateSeconds(3.2)).toBe(4);
    expect(nearestPlateSeconds(5.4)).toBe(6);
    expect(nearestPlateSeconds(30)).toBe(8);
  });
});
