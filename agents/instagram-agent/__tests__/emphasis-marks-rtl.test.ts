import { describe, expect, it } from "vitest";

import { FSI, PDI, isolateForeignRuns, stripIsolates } from "../src/workflow/bidi-isolate.js";
import {
  MAX_MARK_WORDS,
  assignSpansToFields,
  buildMarkRing,
  buildMarkedRuns,
  markCssBlock,
  markKindsFor,
  normaliseEmphasis,
  resolveSlideMarks,
  type SlideMarkContext,
} from "../src/workflow/emphasis-marks.js";

/**
 * RFC-17 — MARKED EMPHASIS IN RIGHT-TO-LEFT COPY, and the Phase 4 guarantee
 * it must not regress.
 *
 * ── WHAT IS ACTUALLY AT RISK ─────────────────────────────────────────────
 *
 * Phase 4 made Hebrew first-class by wrapping each adjacent run of Latin or
 * digit tokens in one FSI…PDI isolate (`bidi-isolate.ts`). Its own header
 * records that an EARLIER cut of that module isolated per TOKEN instead of
 * per RUN, and that the result — `⁨API⁩ ⁨v2⁩` — renders **backwards**, which
 * is strictly worse than doing nothing at all.
 *
 * Marking re-opens exactly that wound from a new direction. A mark SPLITS a
 * field into runs, and each run is isolated independently. So a mark whose
 * edge lands in the middle of a Latin run would cut one foreign run into two
 * spans and produce two isolates out of what Phase 4 guarantees is one —
 * reproducing the regression without touching `bidi-isolate.ts` at all.
 *
 * That is what `resolveSlideMarks`' foreign-run boundary rule exists to stop,
 * and it is what most of this file is about. Hebrew is not a degraded mode
 * here: it keeps all five mark kinds, and its own block geometry, because it
 * has no ascenders.
 *
 * No Chromium: every claim is about strings, so nothing here self-skips.
 */

const HEBREW_CTX: SlideMarkContext & { alreadyAccepted: number } = {
  dir: "rtl",
  allowedIndexes: [0, 1, 2],
  kinds: ["underline", "swish", "double"],
  seed: 4242,
  alreadyAccepted: 0,
};

const dec = (...spans: string[]): { text: string }[] => spans.map((text) => ({ text }));

/** The rendered text of a fragment, with this module's own span markup removed. */
const textOf = (fragment: string): string => fragment.replace(/<\/?span[^>]*>/g, "");

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** How many isolates `bidi-isolate.ts` would put in this string on its own — the number marking must not change. */
const nativeIsolates = (text: string): number => count(isolateForeignRuns(text, "rtl"), FSI);

// ─────────────────────────────────────────────────────────────────────────
// The acceptance condition: one foreign run, one isolate, marked or not
// ─────────────────────────────────────────────────────────────────────────

describe("a mark never splits a Latin run across two isolates", () => {
  /**
   * The spec's own example. `Gemini 3` is ONE foreign run; marking `Gemini`
   * must not emit `Gemini` and `3` as two isolates.
   *
   * Kept because it is the stated acceptance condition, but note what it can
   * and cannot prove: with the boundary rule REMOVED this field still emits
   * only one isolate, because the leftover `3` is a single character and
   * `bidi-isolate.ts` deliberately leaves a lone character bare
   * (`MIN_ISOLATED_RUN_CHARS`). The test below with `Gemini 3 Pro` is the one
   * that actually falsifies the rule, and it is here for that reason.
   */
  it("marks `Gemini` inside `Gemini 3` without emitting two isolates", () => {
    const field = "שוחרר Gemini 3 בגרסה חדשה שמשנה הכל למפתחים";
    const out = resolveSlideMarks("body", field, dec("Gemini"), HEBREW_CTX);
    expect(out.accepted).toBe(1);
    const fragment = buildMarkedRuns(out.runs, "rtl");
    expect(count(fragment, FSI)).toBe(1);
    expect(count(fragment, PDI)).toBe(1);
    expect(textOf(fragment)).toContain(`${FSI}Gemini 3${PDI}`);
  });

  /**
   * THE REAL FALSIFICATION. `Gemini 3 Pro` is one foreign run whose tail is
   * long enough to be isolated on its own, so marking `Gemini` alone would
   * emit `⁨Gemini⁩` and `⁨3 Pro⁩` — the `⁨API⁩ ⁨v2⁩` regression exactly.
   *
   * The rule EXTENDS the mark to the run's own boundary instead, so the whole
   * product name is marked and there is still one isolate.
   *
   * BREAK IT: delete the `splitsAForeignRun` branch in `resolveSlideMarks`.
   * This goes red at two isolates; the test above stays green.
   */
  it("EXTENDS a mark to the whole foreign run rather than cutting `Gemini 3 Pro` in half", () => {
    const field = "שוחרר Gemini 3 Pro בגרסה חדשה שמשנה הכל למפתחים בארץ";
    expect(nativeIsolates(field)).toBe(1);
    const out = resolveSlideMarks("body", field, dec("Gemini"), HEBREW_CTX);
    expect(out.accepted).toBe(1);
    const fragment = buildMarkedRuns(out.runs, "rtl");
    expect(count(fragment, FSI)).toBe(1);
    // The mark grew to the run's own edge, so the marked text is the product
    // name whole rather than its first word.
    expect(out.runs.find((r) => r.mark !== undefined)!.text).toBe("Gemini 3 Pro");
    expect(textOf(fragment)).toContain(`${FSI}Gemini 3 Pro${PDI}`);
  });

  /**
   * When extending would make the mark absurd, the mark is DROPPED rather
   * than allowed to split the run. A drop is free; a backwards product name
   * is a defect the reader sees.
   */
  it("DROPS a mark whose foreign run is too long to absorb, rather than splitting it", () => {
    const long = "Gemini 3 Pro Ultra Max Turbo Edition";
    const field = `שוחרר ${long} בגרסה חדשה שמשנה הכל למפתחים בארץ ובעולם כולו היום`;
    expect(nativeIsolates(field)).toBe(1);
    const out = resolveSlideMarks("body", field, dec("Gemini"), HEBREW_CTX);
    expect(out.accepted).toBe(0);
    expect(out.drops[0]!.reason).toMatch(new RegExp(`${MAX_MARK_WORDS} words`));
    expect(out.drops[0]!.reason).toMatch(/bidi isolate/);
  });

  /** A mark that sits entirely inside the Hebrew is untouched by any of this. */
  it("leaves a purely Hebrew mark alone, and still isolates the Latin run beside it", () => {
    const field = "שוחרר Gemini 3 בגרסה חדשה שמשנה לגמרי את העבודה של המפתחים";
    const out = resolveSlideMarks("body", field, dec("חדשה"), HEBREW_CTX);
    expect(out.accepted).toBe(1);
    const fragment = buildMarkedRuns(out.runs, "rtl");
    expect(count(fragment, FSI)).toBe(1);
    expect(out.runs.find((r) => r.mark !== undefined)!.text).toBe("חדשה");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Totality under RTL: the model's bytes survive, and the isolates balance
// ─────────────────────────────────────────────────────────────────────────

describe("every marked RTL field round-trips, and every isolate closes", () => {
  const fields = [
    "שוחרר Gemini 3 בגרסה חדשה שמשנה הכל למפתחים",
    "המודל החדש GPT-4 עולה 20% פחות מקודמו והוא גם מהיר יותר",
    "בין 2020-2024 השוק גדל פי שלושה ואיש לא שם לב לזה בכלל",
    "API v2 יצא סוף סוף והוא שובר תאימות לאחור בכמה מקומות",
    "שלושה דברים שאף אחד לא מספר לך על גיוס הון בשלב מוקדם",
  ];
  const spans = ["Gemini", "GPT-4", "2020-2024", "API", "גיוס הון", "השוק", "מהיר", "דברים"];

  /**
   * THE INVARIANT, over every field/span pair that resolves: stripping the
   * isolates from the rendered runs returns the model's ORIGINAL string, and
   * every FSI has its PDI.
   *
   * An unbalanced isolate is not a cosmetic problem — U+2068 without U+2069
   * leaks the isolate into everything that follows it in the document, so one
   * bad mark mis-renders the rest of the slide.
   */
  it("stripIsolates(join(runs)) is the original, and FSI count === PDI count", () => {
    let marked = 0;
    for (const field of fields) {
      for (const span of spans) {
        const out = resolveSlideMarks("body", field, dec(span), HEBREW_CTX);
        // Totality first: the runs always rejoin to the input, marked or not.
        expect(out.runs.map((r) => r.text).join("")).toBe(field);
        const fragment = buildMarkedRuns(out.runs, "rtl");
        if (fragment.length === 0) continue;
        marked++;
        expect(stripIsolates(textOf(fragment))).toBe(field);
        expect(count(fragment, FSI)).toBe(count(fragment, PDI));
      }
    }
    // The loop has to actually have marked things, or it proves nothing.
    expect(marked).toBeGreaterThanOrEqual(5);
  });

  /**
   * Marking must not change HOW MANY isolates a field gets. Phase 4 decided
   * that number; this phase only decides which words are coloured.
   *
   * BREAK IT: isolate the whole field before splitting instead of isolating
   * each run. The FSI then lands on one side of a span boundary and its PDI
   * on the other, and both counts go wrong at once.
   */
  it("emits exactly as many isolates as bidi-isolate.ts would have emitted unmarked", () => {
    for (const field of fields) {
      for (const span of spans) {
        const fragment = buildMarkedRuns(resolveSlideMarks("body", field, dec(span), HEBREW_CTX).runs, "rtl");
        if (fragment.length === 0) continue;
        expect(count(fragment, FSI)).toBe(nativeIsolates(field));
      }
    }
  });

  it("adds NO isolates at all to an LTR carousel — an English post is byte-identical to before", () => {
    const field = "The quiet compounding of small decisions beats every clever shortcut anyone recommends";
    const fragment = buildMarkedRuns(resolveSlideMarks("body", field, dec("quiet"), { ...HEBREW_CTX, dir: "ltr" }).runs, "ltr");
    expect(count(fragment, FSI)).toBe(0);
    expect(count(fragment, PDI)).toBe(0);
    expect(textOf(fragment)).toBe(field);
  });

  it("escapes before it renders, in RTL too — markup in a Hebrew mark stays entities", () => {
    const field = "שוחרר <b>Gemini</b> בגרסה חדשה שמשנה הכל למפתחים בארץ ובעולם";
    const out = resolveSlideMarks("body", field, dec("<b>Gemini</b>"), HEBREW_CTX);
    const fragment = buildMarkedRuns(out.runs, "rtl");
    expect(fragment).toContain("&lt;b&gt;");
    expect(fragment.replace(/<\/?span[^>]*>/g, "")).not.toContain("<b>");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The cross-field walk, in Hebrew
// ─────────────────────────────────────────────────────────────────────────

describe("the span search works on Hebrew copy", () => {
  const fields = [
    { field: "headline", text: "שלושה דברים על גיוס הון" },
    { field: "body", text: "רוב המייסדים עוקבים אחרי הכנסות ומתעלמים לגמרי מקצב השריפה" },
    { field: "item[0]", text: "שוליים גולמיים, נמדדים ביושר" },
  ];

  it("routes a Hebrew span to the field it occurs in, in reading order", () => {
    const { byField, drops } = assignSpansToFields(fields, ["גיוס הון", "הכנסות"]);
    expect(drops).toEqual([]);
    expect(byField.get("headline")).toEqual(["גיוס הון"]);
    expect(byField.get("body")).toEqual(["הכנסות"]);
  });

  it("reports a Hebrew span that is on no field, without failing anything", () => {
    const { drops } = assignSpansToFields(fields, ["מילה שלא קיימת"]);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.field).toBe("slide");
  });

  it("normalises Hebrew spans without mangling them", () => {
    expect(normaliseEmphasis(["  גיוס הון  ", "הכנסות"]).spans).toEqual(["גיוס הון", "הכנסות"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Hebrew geometry and the RTL stylesheet contract
// ─────────────────────────────────────────────────────────────────────────

describe("the Hebrew mark stylesheet", () => {
  const ring = buildMarkRing({ brandAccent: "#FF6B2C", palette: ["#4ADE80", "#38BDF8", "#C084FC"] }, "#17181C", "#F5F3EF", []);
  const hebrew = markCssBlock("Hebrew", ring);
  const latin = markCssBlock(undefined, ring);
  const declarations = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * Hebrew has no ascenders and a full-height letter body, so the Latin
   * block geometry (.50em tall, .56em down) covers the glyphs instead of
   * sitting under them. Both variables are SET, not inherited.
   */
  it("sets its own block geometry rather than inheriting the Latin one", () => {
    expect(hebrew).toContain("--mk-block-h: .44em");
    expect(hebrew).toContain("--mk-block-y: .60em");
    expect(hebrew).not.toBe(latin);
  });

  /** First-class, not degraded: Hebrew keeps every kind the Latin sheet has. */
  it("keeps ALL FIVE kinds for Hebrew", () => {
    for (const kind of ["block", "underline", "swish", "double", "ink"]) expect(hebrew).toContain(`.mk-k-${kind}`);
  });

  /**
   * LOGICAL PROPERTIES ONLY. With no `left`/`right` anywhere, `dir="rtl"`
   * mirrors every mark on its own and there is no second stylesheet for
   * Hebrew to drift from this one — the rule `slide-devices-rtl.test.ts`
   * already pins for devices.
   */
  it("contains no physical left/right in either script's sheet", () => {
    for (const css of [latin, hebrew]) {
      const body = declarations(css);
      expect(body).not.toMatch(/(^|[\s;{])(left|right)\s*:/);
      expect(body).not.toMatch(/(padding|margin|border|inset)-(left|right)\s*:/);
    }
  });

  it("sizes Hebrew in em as well, so --ts scales it identically", () => {
    expect(declarations(hebrew)).not.toMatch(/\d\s*px/);
  });

  /** The kind set is decided by the GROUND, not by the script — Hebrew on a dark ground gets the same four kinds English does. */
  it("does not let the script change which kinds are legible", () => {
    expect(markKindsFor("#17181C", "#F5F3EF", ring.hexes)).toEqual(markKindsFor("#17181C", "#F5F3EF", ring.hexes));
    // 2026-09-23: the dark slab is a GROUND decision too, identical per script.
    expect(markKindsFor("#17181C", "#F5F3EF", ring.hexes)).toContain("block");
  });
});
