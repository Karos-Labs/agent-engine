import { describe, expect, it } from "vitest";
import { HIGHLIGHT_SCALE, buildKaraokeCaptionsAss, karaokeEventText, type KaraokePhrase } from "../src/tools/karaoke-captions.js";

/**
 * The script is the product: one Dialogue event per word STATE, the whole
 * phrase in each, the word being said in the accent and a step larger,
 * every other word white, events abutting so exactly one is on screen.
 */

const phrases: KaraokePhrase[] = [
  {
    words: [
      { text: "We", start: 0.2, end: 0.4 },
      { text: "cap", start: 0.4, end: 0.7 },
      { text: "every", start: 0.75, end: 1.0 },
      { text: "short.", start: 1.0, end: 1.5 },
    ],
    end: 1.9,
  },
  { words: [{ text: "On", start: 2.0, end: 2.2 }, { text: "purpose.", start: 2.25, end: 2.9 }], end: 3.4 },
];

describe("buildKaraokeCaptionsAss", () => {
  it("emits one event per word, the whole phrase in each, the said word in the accent and scaled, from its start to the next word's start", () => {
    const ass = buildKaraokeCaptionsAss(phrases, { accent: "#FF6B2C" })!;
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events).toHaveLength(6);
    const pct = Math.round(HIGHLIGHT_SCALE * 100);
    // #FF6B2C → ASS &H00BBGGRR = &H002C6BFF.
    expect(events[0]).toBe(`Dialogue: 0,0:00:00.20,0:00:00.40,Cap,,0,0,0,,{\\1c&H002C6BFF\\fscx${pct}\\fscy${pct}}We{\\r} cap every short.`);
    expect(events[1]).toBe(`Dialogue: 0,0:00:00.40,0:00:00.75,Cap,,0,0,0,,We {\\1c&H002C6BFF\\fscx${pct}\\fscy${pct}}cap{\\r} every short.`);
    // The last word of a phrase holds the phrase until the phrase leaves, not until the word ends.
    expect(events[3]).toBe(`Dialogue: 0,0:00:01.00,0:00:01.90,Cap,,0,0,0,,We cap every {\\1c&H002C6BFF\\fscx${pct}\\fscy${pct}}short.{\\r}`);
    expect(events[5]).toContain("0:00:02.25,0:00:03.40");
  });

  it("styles the block in canvas pixels: white, black outline, bottom-centre, held above the bar by the gap, the same clearance the SRT path kept", () => {
    const ass = buildKaraokeCaptionsAss(phrases, { accent: "#FF6B2C", barHeight: 200, gapAboveBarPx: 56 })!;
    expect(ass).toContain("PlayResX: 1080\nPlayResY: 1920");
    // Alignment 2 (bottom-centre), MarginL/R 60, MarginV 256 = 200 + 56.
    expect(ass).toContain("Style: Cap,Liberation Sans,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,7,0,2,60,60,256,1");
  });

  it("takes the language's face and a custom size", () => {
    const ass = buildKaraokeCaptionsAss(phrases, { accent: "#FF6B2C", fontName: "Noto Sans Hebrew", fontSizePx: 72 })!;
    expect(ass).toContain("Style: Cap,Noto Sans Hebrew,72,");
  });

  it("returns nothing for nothing: no phrases, or phrases whose words sanitise to empty", () => {
    expect(buildKaraokeCaptionsAss([], { accent: "#FF6B2C" })).toBeUndefined();
    expect(buildKaraokeCaptionsAss([{ words: [{ text: "\u0001\u0002", start: 0, end: 1 }], end: 1 }], { accent: "#FF6B2C" })).toBeUndefined();
  });

  it("neutralises braces and backslashes inside a word so a script word can never open an override block", () => {
    expect(karaokeEventText(["a{b}", "c\\d"], 0, "&H00FFFFFF")).toBe(`{\\1c&H00FFFFFF\\fscx${Math.round(HIGHLIGHT_SCALE * 100)}\\fscy${Math.round(HIGHLIGHT_SCALE * 100)}}a(b){\\r} c/d`);
  });

  it("never emits an event that ends before it starts, and events of one phrase abut", () => {
    const ass = buildKaraokeCaptionsAss(
      [{ words: [{ text: "one", start: 1.0, end: 1.5 }, { text: "two", start: 0.9, end: 1.2 }], end: 1.0 }],
      { accent: "#FF6B2C" },
    )!;
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    for (const e of events) {
      const [, start, end] = e.match(/Dialogue: 0,([\d:.]+),([\d:.]+),/)!;
      expect(start! < end!).toBe(true);
    }
  });
});
