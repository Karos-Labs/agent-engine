import { describe, expect, it } from "vitest";
import { alignScriptToTimings, buildPhraseCues, buildScriptCaptions, cuesToSrt, normalizeToken, scriptWords } from "../src/workflow/captions.js";

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
