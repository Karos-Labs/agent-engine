import { describe, expect, it } from "vitest";
import { alignScriptToTimings, beatHoldsFromTimings, buildPhraseCues, buildPhraseGroups, buildScriptCaptions, cuesToSrt, normalizeToken, scriptWords } from "../src/workflow/captions.js";

/** A recognizer's take on a narration: each word timed 0.4s apart, with the mis-hearings the 2026-09-08 renders actually shipped. */
function heard(words: readonly string[], step = 0.4) {
  return words.map((text, i) => ({ text, start: i * step, end: i * step + step * 0.8 }));
}

describe("scriptWords / normalizeToken", () => {
  it("joins beats in order and keeps punctuation on the word; normalization strips it for matching", () => {
    expect(scriptWords(["Hello there.", "  Second beat, yes. "])).toEqual(["Hello", "there.", "Second", "beat,", "yes."]);
    expect(normalizeToken("karoslabs.com.")).toBe("karoslabscom");
    expect(normalizeToken("0.05%")).toBe("005");
    expect(normalizeToken("Café,")).toBe("cafe");
  });
});

describe("alignScriptToTimings", () => {
  it("keeps the script's spelling and takes the recognizer's clock: 'Kairoslabs.com' never reaches the screen", () => {
    const script = scriptWords(["That's what always-on strategic intelligence does. karoslabs.com. No pitch, just a plan."]);
    const asr = heard(["That's", "what", "always", "on", "strategic", "intelligence", "does.", "Kairoslabs.com.", "No", "pitch,", "just", "a", "plan."]);
    const timed = alignScriptToTimings(script, asr);
    expect(timed.map((w) => w.text)).toEqual(script);
    // "karoslabs.com." was not heard as such; it borrows the slot between "does." and "No".
    const brand = timed.find((w) => w.text === "karoslabs.com.")!;
    const does = timed.find((w) => w.text === "does.")!;
    const no = timed.find((w) => w.text === "No")!;
    expect(brand.start).toBeGreaterThanOrEqual(does.end);
    expect(brand.end).toBeLessThanOrEqual(no.start + 1e-9);
    // "always-on" (one script word) against "always" "on" (two heard): anchored on the prefix match, the rest skipped.
    expect(timed.find((w) => w.text === "always-on")!.start).toBeCloseTo(0.8, 5);
  });

  it("a16z heard as 'a Sixteen Z' is one script word timed over the recognizer's three", () => {
    const script = scriptWords(["The panel includes a16z and J.P. Morgan."]);
    const asr = heard(["The", "panel", "includes", "a", "Sixteen", "Z", "and", "J.P.", "Morgan."]);
    const timed = alignScriptToTimings(script, asr);
    expect(timed.map((w) => w.text)).toEqual(script);
    const a16z = timed.find((w) => w.text === "a16z")!;
    const includes = timed.find((w) => w.text === "includes")!;
    const and = timed.find((w) => w.text === "and")!;
    expect(a16z.start).toBeGreaterThanOrEqual(includes.end);
    expect(a16z.end).toBeLessThanOrEqual(and.start + 1e-9);
    for (let i = 1; i < timed.length; i++) expect(timed[i]!.start).toBeGreaterThanOrEqual(timed[i - 1]!.end);
  });

  it("with nothing heard, spreads the words evenly over the voice's duration", () => {
    const timed = alignScriptToTimings(["one", "two", "three", "four"], [], 8);
    expect(timed).toHaveLength(4);
    expect(timed[0]!.start).toBe(0);
    expect(timed[3]!.end).toBeCloseTo(7.98, 5);
  });
});

describe("buildPhraseCues", () => {
  it("ends a cue at a sentence, at a comma once it has three words, or at four words; never mid-clause because a counter ran out", () => {
    const script = scriptWords(["Google is running your ad campaigns now. You're just paying for them."]);
    const cues = buildPhraseCues(alignScriptToTimings(script, heard(script)));
    expect(cues.map((c) => c.text)).toEqual(["Google is running your", "ad campaigns now.", "You're just paying for", "them."]);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
  });

  it("holds a short cue on screen at least the minimum, but never into the next cue", () => {
    const words = [
      { text: "No.", start: 0, end: 0.2 },
      { text: "Really", start: 0.3, end: 0.6 },
      { text: "not.", start: 0.6, end: 0.9 },
    ];
    const cues = buildPhraseCues(words, { minSeconds: 0.6 });
    expect(cues[0]!.text).toBe("No.");
    expect(cues[0]!.end).toBeCloseTo(0.28, 5);
    expect(cues[1]!.end).toBeCloseTo(0.9, 5);
  });
});

describe("cuesToSrt / buildScriptCaptions", () => {
  it("formats SRT with millisecond timestamps and numbered blocks", () => {
    const srt = cuesToSrt([{ text: "Hello there.", start: 0, end: 1.25 }]);
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,250\nHello there.\n");
  });

  it("end to end: the SRT carries the script's words, phrase-bounded", () => {
    const narrations = ["Our selection rate is 0.05%. The panel includes a16z and J.P. Morgan."];
    const asr = heard(["Our", "selection", "rate", "is", "zero", "point", "zero", "five", "percent.", "The", "panel", "includes", "a", "Sixteen", "Z", "and", "JP", "Morgan."]);
    const srt = buildScriptCaptions(narrations, asr);
    expect(srt).toContain("a16z");
    expect(srt).toContain("0.05%.");
    expect(srt).not.toContain("Sixteen");
    expect(srt.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });
});

describe("buildPhraseGroups", () => {
  it("groups on the same boundaries as buildPhraseCues and keeps the words, so a karaoke script and an SRT show the same phrases", () => {
    const words = alignScriptToTimings(scriptWords(["One two three four five. Six seven."]), heard(["One", "two", "three", "four", "five.", "Six", "seven."]));
    const groups = buildPhraseGroups(words);
    const cues = buildPhraseCues(words);
    expect(groups.map((g) => g.words.map((w) => w.text).join(" "))).toEqual(cues.map((c) => c.text));
    expect(groups.map((g) => g.end)).toEqual(cues.map((c) => c.end));
    // The words survive with their own times — what a per-word highlight needs.
    expect(groups[0]!.words[0]).toMatchObject({ text: "One", start: 0 });
    expect(groups[0]!.words).toHaveLength(4);
  });
});

describe("beatHoldsFromTimings", () => {
  /** Three beats of 2, 3 and 2 words, spoken 0.5s apart with a 0.1s gap between beats. */
  const timed = [
    { text: "a", start: 0.0, end: 0.4 },
    { text: "b.", start: 0.5, end: 0.9 },
    // gap 0.9 → 1.5: the boundary belongs at 1.2
    { text: "c", start: 1.5, end: 1.9 },
    { text: "d", start: 2.0, end: 2.4 },
    { text: "e.", start: 2.5, end: 2.9 },
    // gap 2.9 → 3.5: boundary at 3.2
    { text: "f", start: 3.5, end: 3.9 },
    { text: "g.", start: 4.0, end: 4.4 },
  ];

  it("cuts in the breath between beats: each boundary is the midpoint of the silence, and the holds still sum to the voice", () => {
    const holds = beatHoldsFromTimings(timed, [2, 3, 2], 5, [4, 6, 4], 0.5);
    expect(holds).toEqual([1.2, 2, 1.8]);
    expect(holds.reduce((a, b) => a + b, 0)).toBeCloseTo(5, 6);
  });

  it("floors a short beat and pays for it out of the longest one, never out of the total", () => {
    // A minimum of 2 s makes beat 1 (1.2 s) and beat 3 (1.8 s) short; both
    // are raised and beat 2 gives up the difference.
    const holds = beatHoldsFromTimings(timed, [2, 3, 2], 6, [4, 6, 4], 2);
    expect(holds[0]).toBe(2);
    expect(holds[2]).toBeGreaterThanOrEqual(2);
    expect(holds.reduce((a, b) => a + b, 0)).toBeCloseTo(6, 6);
  });

  it("falls back to the scripted proportion when there are no timings, when the counts do not add up, or when the voice cannot hold every beat at the floor", () => {
    const scripted = [4, 6, 4];
    // No timings at all: the scripted seconds, scaled to the voice.
    expect(beatHoldsFromTimings([], [2, 3, 2], 7, scripted, 0.5)).toEqual([2, 3, 2]);
    // A count that does not match the words: the alignment is not trustworthy, so nothing is inferred from it.
    expect(beatHoldsFromTimings(timed, [2, 2, 2], 7, scripted, 0.5)).toEqual([2, 3, 2]);
    // Three beats cannot each hold 3 s inside a 5 s voice: the old rule stands rather than inventing time.
    const squeezed = beatHoldsFromTimings(timed, [2, 3, 2], 5, scripted, 3);
    expect(squeezed.map((h) => Number(h.toFixed(4)))).toEqual([1.4286, 2.1429, 1.4286]);
  });

  it("returns nothing for no beats", () => {
    expect(beatHoldsFromTimings(timed, [], 5, [], 2)).toEqual([]);
  });
});
