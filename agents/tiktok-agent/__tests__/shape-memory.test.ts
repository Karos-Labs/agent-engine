import { describe, expect, it } from "vitest";
import {
  SHAPE_WINDOW,
  openingDevice,
  parseShapeMemory,
  shapeRepeatDirective,
  skeletonEntry,
  skeletonOf,
  stockClipEntry,
} from "../src/workflow/shape-memory.js";

/**
 * What this account has already MADE, as a unit.
 *
 * The topic catalog and `checkOutputDedupe` answer "have we said this before".
 * Nothing answered "have we made this before", and the owner's standing ruling
 * is that repetition across runs is the AI tell.
 */

const beat = (n: string) => ({ narration: n, onScreenText: n.slice(0, 20), visualBrief: "a street at dusk, wide static frame", seconds: 4 as const });
const script = (over: { hook: string; beats?: number; voiceover?: boolean; format?: "footage" | "text-led"; stats?: number }) => ({
  format: over.format ?? ("footage" as const),
  hook: over.hook,
  voiceover: over.voiceover ?? true,
  beats: Array.from({ length: over.beats ?? 4 }, (_, i) => (i < (over.stats ?? 0) ? { ...beat(`line ${i}`), stat: { value: "47%", label: "of budgets" } } : beat(`line ${i}`))),
});

describe("openingDevice", () => {
  it("reads a leading figure as a number, whatever else is in the line", () => {
    // Tested first on purpose: a leading figure is the loudest opener there
    // is and reads as one even when the rest of the line is a question.
    expect(openingDevice("47% of your budget goes somewhere you never approved")).toBe("number");
    expect(openingDevice("3 things nobody tells you?")).toBe("number");
  });

  it("separates a question, a negation and second person", () => {
    expect(openingDevice("Why does the first hire never last?")).toBe("question");
    expect(openingDevice("Nobody tells you the first hire is the one you fire")).toBe("negation");
    expect(openingDevice("Your budget is going to placements you never approved")).toBe("second-person");
  });

  it("falls through to a plain statement, so the classification is total", () => {
    // Every hook gets exactly one device. A hook that matched nothing would
    // make two runs disagree about the same line.
    expect(openingDevice("The first hire is a bet on a company that does not exist yet")).toBe("statement");
  });

  it("does not mistake a Hebrew word that merely CONTAINS a negation for one", () => {
    // `\b` is ASCII-only even under the `u` flag, so a bare /לא/ matches inside
    // שלא ("that ... not") and misreads a second-person opener as a negation.
    // instagram-agent's `target-language.ts` documents the same trap.
    expect(openingDevice("התקציב שלך הולך למקומות שלא אישרת")).toBe("second-person");
  });

  it("reads the OPENING, not the whole line", () => {
    // A hook that starts on "you" and carries a negation seven words later
    // opens on second person; a viewer experiences the first breath, not the
    // sentence's full vocabulary.
    expect(openingDevice("Your budget is going to placements you never approved")).toBe("second-person");
    expect(openingDevice("The first hire is a bet on a company that does not exist yet")).toBe("statement");
  });

  it("reads Hebrew hooks, because this client base writes them", () => {
    expect(openingDevice("אף אחד לא מספר לך שהעובד הראשון הוא זה שתפטר")).toBe("negation");
    expect(openingDevice("התקציב שלך הולך למקומות שלא אישרת")).toBe("second-person");
    expect(openingDevice("למה העובד הראשון אף פעם לא נשאר?")).toBe("question");
  });
});

describe("skeletonOf", () => {
  it("fingerprints structure and never subject", () => {
    // Two shorts about completely different things, built identically, must
    // produce the same skeleton — that sameness is the thing being caught.
    const a = skeletonOf(script({ hook: "Nobody tells you about hiring" }));
    const b = skeletonOf(script({ hook: "Nobody tells you about pricing" }));
    expect(a).toBe(b);
    expect(a).toBe("footage/4beats/0stat/voiced/negation");
  });

  it("separates shorts that differ in length, voice, format or opener", () => {
    const base = script({ hook: "Nobody tells you about hiring" });
    expect(skeletonOf({ ...base, beats: base.beats.slice(0, 3) })).not.toBe(skeletonOf(base));
    expect(skeletonOf({ ...base, voiceover: false })).not.toBe(skeletonOf(base));
    expect(skeletonOf({ ...base, format: "text-led" })).not.toBe(skeletonOf(base));
    expect(skeletonOf(script({ hook: "47% of budgets go unapproved" }))).not.toBe(skeletonOf(base));
  });
});

describe("parseShapeMemory", () => {
  it("reads only this agent's entries out of a list every agent shares", () => {
    // The used-media ledger is client-scoped and append-only across agents.
    // instagram's photograph paths sit in the same array.
    const memory = parseShapeMemory([
      "media/instagram/run-1/cover.png",
      stockClipEntry(1001),
      "media/instagram/run-2/slide-3.png",
      skeletonEntry("footage/4beats/0stat/voiced/negation"),
      stockClipEntry(1002),
    ]);
    expect(memory.usedStockIds).toEqual([1001, 1002]);
    expect(memory.skeletons).toEqual(["footage/4beats/0stat/voiced/negation"]);
  });

  it("skips an entry it cannot parse instead of taking the run down with it", () => {
    // This list will eventually hold strings written by code that does not
    // exist yet. A reader that threw on one would fail every future run.
    const memory = parseShapeMemory(["tiktok:stock:not-a-number", "tiktok:stock:", "tiktok:shape:", "tiktok:unknown:whatever", stockClipEntry(7)]);
    expect(memory.usedStockIds).toEqual([7]);
    expect(memory.skeletons).toEqual([]);
  });

  it("preserves order, so the newest shapes are the ones the window reads", () => {
    const entries = ["a", "b", "c"].map((s) => skeletonEntry(s));
    expect(parseShapeMemory(entries).skeletons).toEqual(["a", "b", "c"]);
  });
});

describe("shapeRepeatDirective", () => {
  const shape = (device: string, beats = "4beats") => `footage/${beats}/0stat/voiced/${device}`;

  it("says nothing at all until there is a pattern worth naming", () => {
    // Two shorts is not a rut, and telling a writer to avoid the only
    // structure it has used twice makes the shorts worse, not more varied.
    expect(shapeRepeatDirective([])).toBeUndefined();
    expect(shapeRepeatDirective([shape("negation"), shape("negation")])).toBeUndefined();
  });

  it("says nothing when the recent shorts are already varied", () => {
    expect(shapeRepeatDirective([shape("negation"), shape("question", "3beats"), shape("number", "5beats")])).toBeUndefined();
  });

  it("names a device that is a genuine majority of the window", () => {
    const directive = shapeRepeatDirective([shape("negation"), shape("negation"), shape("negation"), shape("question", "3beats")]);
    expect(directive).toBeDefined();
    expect(directive).toContain("negation");
    expect(directive).toContain("3 of this account's last 4");
  });

  it("names a repeated length as well as a repeated opener", () => {
    const directive = shapeRepeatDirective([shape("negation"), shape("question"), shape("number"), shape("statement")])!;
    // Four different devices, one shared length — the length is the finding.
    expect(directive).toContain("4beats");
    expect(directive).not.toContain("open on the same device");
  });

  it("reads only the recent window, so an account's old habits stop counting", () => {
    const old = Array.from({ length: 10 }, () => shape("negation"));
    const recent = Array.from({ length: SHAPE_WINDOW }, (_, i) => shape(["question", "number", "statement", "second-person", "question", "number"][i]!, `${i + 3}beats`));
    expect(shapeRepeatDirective([...old, ...recent])).toBeUndefined();
  });

  it("tells the writer to vary the FORM and never the substance", () => {
    // The failure mode of a note like this is a model that changes the subject
    // to satisfy it, which would cost more than the repetition does.
    const directive = shapeRepeatDirective(Array.from({ length: 4 }, () => shape("negation")))!;
    expect(directive).toContain("never the substance");
  });
});
