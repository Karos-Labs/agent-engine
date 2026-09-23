import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { colourDistance } from "../../../packages/tools/karos-publish/src/slide-metrics.js";
import { contrastRatio } from "../src/workflow/brand-render-tokens.js";
import {
  ACCENT_EXCLUSION,
  MARK_GROUND_CONTRAST_FLOOR,
  MARK_HOST_INK_ALPHA,
  MARK_KINDS,
  MARK_RING_MAX,
  MARK_SEPARATION,
  MARK_TEXT_CONTRAST_FLOOR,
  MARK_TOL,
  MAX_MARKED_SHARE,
  MAX_MARKS_PER_FIELD,
  MAX_MARKS_PER_SLIDE,
  MAX_MARK_WORDS,
  assignSpansToFields,
  boundedFirstOccurrence,
  buildMarkRing,
  buildMarkedRuns,
  collectEmphasisIssues,
  markCapabilitiesFor,
  markColourDistance,
  markCssBlock,
  markKindsFor,
  markRotation,
  normaliseEmphasis,
  resolveSlideMarks,
  ringIndexesFor,
  slideMarkKinds,
  slideMarkSeed,
  type MarkField,
  type MarkKind,
  type MarkRun,
  type SlideMarkContext,
} from "../src/workflow/emphasis-marks.js";
import { MAX_MARK_CHARS, SlideEmphasisSchema } from "../src/workflow/types.js";

/**
 * RFC-17 (Phase 5) — the mark engine.
 *
 * These tests were written AFTER the module (the build was interrupted
 * mid-flight and committed as a WIP, and the wire form was then re-cut to the
 * flat span array of §6.4), so each one below was run against a DELIBERATELY
 * BROKEN copy of the thing it guards before it was trusted — the rule this
 * project records as "do not write a test that cannot fail". Where the
 * falsification is not obvious from the assertion, the comment names the
 * mutation that turns it red.
 *
 * Nothing in this file is a render test: every claim here is about strings,
 * numbers and source text, so none of it self-skips on a machine with no
 * Chromium. The PIXEL claims are P2's, and CI is the authoritative gate for
 * those.
 */

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

/** Our bundled default ground and ink — the pair `rf-6` says decides everything. */
const DARK_GROUND = "#17181C";
const LIGHT_INK = "#F5F3EF";

/** A paper kit: light ground, dark ink. The reference accounts' own situation. */
const PALE_GROUND = "#FAF7F0";
const DARK_INK = "#17181C";

/** Three in-kit hexes, pairwise separable, all legible on `DARK_GROUND`. */
const DARK_KIT = { brandAccent: "#FF6B2C", palette: ["#4ADE80", "#38BDF8", "#C084FC"] } as const;

/**
 * The three ring slots the resolver fixtures below mark with, and what each
 * can be drawn as on `DARK_GROUND`/`LIGHT_INK`.
 *
 * REAL COLOURS, not placeholders, and that is load-bearing since RFC-20:
 * `resolveSlideMarks` now re-asserts every (colour, kind) pair against its own
 * kind's floor at the point of emission, so a context carrying invented hexes
 * would have every mark in this file silently degrade to plain type and most
 * of the resolver's tests would go green measuring nothing.
 */
const CTX_HEXES = ["#FF6B2C", "#4ADE80", "#38BDF8"] as const;
const CTX_KINDS: readonly MarkKind[] = ["underline", "swish", "double"];

const ctx = (over: Partial<SlideMarkContext & { alreadyAccepted: number }> = {}): SlideMarkContext & { alreadyAccepted: number } => ({
  dir: "ltr",
  allowedIndexes: [0, 1, 2],
  kinds: CTX_KINDS,
  kindsByIndex: [CTX_KINDS, CTX_KINDS, CTX_KINDS],
  hexes: [...CTX_HEXES],
  groundHex: DARK_GROUND,
  fgHex: LIGHT_INK,
  seed: 12345,
  alreadyAccepted: 0,
  ...over,
});

/** The wire form is a flat array of verbatim spans; `resolveSlideMarks` takes them one field at a time. */
const dec = (...spans: string[]): { text: string }[] => spans.map((text) => ({ text }));

/**
 * A field long enough that three short marks stay under `MAX_MARKED_SHARE`.
 *
 * Sized deliberately. The 35% rule is real and it bites: on a four-word
 * headline a SINGLE five-letter mark is already over the line, which is
 * correct behaviour — a mark covering a third of a short line marks nothing —
 * but it makes a toy fixture useless for testing anything else. 87 word
 * characters here, so the 30-character budget comfortably holds three marks.
 */
const LONG = "The quiet compounding of small decisions beats every clever shortcut anyone will ever recommend to you";

// ─────────────────────────────────────────────────────────────────────────
// The mirrored distance — the whole accent-exclusion argument rests on it
// ─────────────────────────────────────────────────────────────────────────

describe("markColourDistance is the SAME number the pixel measurement will report", () => {
  /**
   * `emphasis-marks.ts` re-declares `slide-metrics.ts`'s weighted-RGB distance
   * rather than importing it, so the composition path need not depend on the
   * renderer package to decide a colour. That mirroring is only safe while the
   * two agree EXACTLY: the accent exclusion selects on this number so that
   * `markColourCount` can later tell a mark apart from accent furniture on the
   * pixels. If they drift, the exclusion excludes the wrong colours and the
   * metric silently becomes a guard that cannot fail.
   *
   * BREAK IT: change either copy's `4 * dg * dg` to `3 * dg * dg`.
   */
  it("agrees with slide-metrics.ts's colourDistance to the last bit, on every channel", () => {
    const pairs: [string, string][] = [
      ["#000000", "#FFFFFF"],
      ["#FF6B2C", "#4ADE80"],
      ["#17181C", "#1A1B1F"],
      ["#38BDF8", "#C084FC"],
      ["#123456", "#654321"],
    ];
    for (const [a, b] of pairs) {
      const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)] as const;
      const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)] as const;
      expect(markColourDistance(a, b)).toBe(colourDistance(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]));
    }
  });

  it("is 0 for a malformed hex — never repaired, never guessed", () => {
    expect(markColourDistance("nonsense", "#FFFFFF")).toBe(0);
    expect(markColourDistance("#FFF", "#FFFFFF")).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bounded occurrence — the falsification the whole resolution rests on
// ─────────────────────────────────────────────────────────────────────────

describe("boundedFirstOccurrence — the word-boundary rule", () => {
  /**
   * THE falsification of this module. `indexOf` alone marks the `AI` in the
   * middle of `SAID`, which is a visible defect on a slide: two letters of one
   * word painted a different colour.
   *
   * BREAK IT: replace the function body with `haystack.indexOf(needle)`.
   */
  it('does NOT find "AI" inside "SAID"', () => {
    expect(boundedFirstOccurrence("SAID", "AI")).toBe(-1);
    expect("SAID".indexOf("AI")).toBe(1); // …and this is what it would have found.
    expect(boundedFirstOccurrence("What he SAID about it", "AI")).toBe(-1);
  });

  it('finds "AI" when it is its own word, wherever it sits', () => {
    expect(boundedFirstOccurrence("AI slop is everywhere", "AI")).toBe(0);
    expect(boundedFirstOccurrence("the rise of AI", "AI")).toBe(12);
    expect(boundedFirstOccurrence("beware AI, mostly", "AI")).toBe(7);
  });

  it("takes the FIRST bounded occurrence, skipping an unbounded earlier one", () => {
    expect(boundedFirstOccurrence("SAID that AI wins", "AI")).toBe(10);
  });

  it("resumes from an offset, which is what lets a second occurrence be found", () => {
    const line = "AI here and AI there";
    expect(boundedFirstOccurrence(line, "AI")).toBe(0);
    expect(boundedFirstOccurrence(line, "AI", 1)).toBe(12);
    expect(boundedFirstOccurrence(line, "AI", 13)).toBe(-1);
  });

  it("does not demand a boundary on a side where the span itself is not a word character", () => {
    expect(boundedFirstOccurrence("costs(hidden) matter", "(hidden)")).toBe(5);
  });

  it("returns -1 for an empty needle and for a span that is simply absent", () => {
    expect(boundedFirstOccurrence("anything", "")).toBe(-1);
    expect(boundedFirstOccurrence("anything", "nothing")).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────

describe("resolveSlideMarks — pure, total, and it drops rather than fails", () => {
  const join = (runs: readonly MarkRun[]): string => runs.map((r) => r.text).join("");

  it("is TOTAL: the joined runs are byte-identical to the input for every outcome", () => {
    const field = "Plot twist: the boring one wins, every single time you try it";
    for (const declared of [dec(), dec("twist"), dec("absent"), dec("twist", "boring one"), dec(field)]) {
      expect(join(resolveSlideMarks("headline", field, declared, ctx()).runs)).toBe(field);
    }
  });

  it("marks the span and leaves the prose either side, in three runs", () => {
    const out = resolveSlideMarks("headline", "Plot twist ahead of absolutely everyone", dec("twist"), ctx());
    expect(out.accepted).toBe(1);
    expect(out.runs.map((r) => r.text)).toEqual(["Plot ", "twist", " ahead of absolutely everyone"]);
    expect(out.runs[1]!.mark).toBeDefined();
    expect(out.runs[0]!.mark).toBeUndefined();
    expect(out.runs[2]!.mark).toBeUndefined();
  });

  it('never marks "AI" inside "SAID" — the span is dropped with a reason', () => {
    const out = resolveSlideMarks("body", "That is what he SAID.", dec("AI"), ctx());
    expect(out.accepted).toBe(0);
    expect(out.runs).toEqual([{ text: "That is what he SAID." }]);
    expect(out.drops).toHaveLength(1);
    expect(out.drops[0]!.reason).toMatch(/does not occur/);
  });

  it("orders the RUNS by position whatever order the model declared them in", () => {
    const out = resolveSlideMarks("body", LONG, dec("clever", "quiet"), ctx());
    const marked = out.runs.filter((r) => r.mark !== undefined);
    expect(marked.map((r) => r.text)).toEqual(["quiet", "clever"]);
    expect(marked[0]!.mark!.ordinal).toBe(0);
    expect(marked[1]!.mark!.ordinal).toBe(1);
  });

  /**
   * LONGEST FIRST. `AI` and `AI slop` both declared, both starting at the same
   * character: whichever is located first wins the overlap, so locating the
   * SHORT one first marks two letters out of the middle of the phrase the
   * model meant.
   *
   * BREAK IT: drop the `longestFirst` sort, or change the tie-break at
   * `located.sort` from `b.end - a.end` back to `a.end - b.end`.
   */
  it("keeps the LONGER span when two spans start at the same character", () => {
    const field = "AI slop is the problem that nobody wants to talk about openly";
    const out = resolveSlideMarks("body", field, dec("AI", "AI slop"), ctx());
    expect(out.runs.filter((r) => r.mark !== undefined).map((r) => r.text)).toEqual(["AI slop"]);
    // …and declaring them the other way round gives the same answer, which is
    // the whole point of ordering by length rather than by the model's array.
    const reversed = resolveSlideMarks("body", field, dec("AI slop", "AI"), ctx());
    expect(reversed.runs.filter((r) => r.mark !== undefined).map((r) => r.text)).toEqual(["AI slop"]);
  });

  /**
   * A term that genuinely appears TWICE is marked at its second appearance
   * rather than dropped. Without the free-occurrence scan, `AI` resolves
   * inside `AI slop`, overlaps, and is lost — and the drop names the wrong
   * cause, which is worse than the missing mark.
   *
   * BREAK IT: replace `freeOccurrence(text, needle, taken)` with
   * `boundedFirstOccurrence(text, needle)`.
   */
  it("takes the first FREE occurrence, so a term appearing twice is marked at its second", () => {
    const field = "AI slop is everywhere now, and honestly AI deserves much better than that";
    const out = resolveSlideMarks("body", field, dec("AI slop", "AI"), ctx());
    const marked = out.runs.filter((r) => r.mark !== undefined);
    expect(marked.map((r) => r.text)).toEqual(["AI slop", "AI"]);
    expect(out.accepted).toBe(2);
    expect(out.drops).toEqual([]);
    // The SECOND "AI" is the one marked — the one at index 39, not index 0.
    expect(join(out.runs)).toBe(field);
    expect(out.runs.findIndex((r) => r.mark !== undefined && r.text === "AI")).toBeGreaterThan(1);
  });

  it("drops a span longer than MAX_MARK_WORDS — a mark that long is a second sentence", () => {
    const long = "one two three four five six seven";
    const out = resolveSlideMarks("body", `${long} and more words besides here`, dec(long), ctx());
    expect(out.accepted).toBe(0);
    expect(out.drops[0]!.reason).toMatch(new RegExp(`longer than ${MAX_MARK_WORDS} words`));
  });

  it("drops the span that would take the field past MAX_MARKED_SHARE — a mark covering everything marks nothing", () => {
    const out = resolveSlideMarks("body", "alpha beta gamma delta", dec("alpha", "beta"), ctx());
    expect(out.accepted).toBe(1);
    expect(out.drops).toHaveLength(1);
    expect(out.drops[0]!.reason).toMatch(new RegExp(`${Math.round(MAX_MARKED_SHARE * 100)}% marked`));
  });

  /**
   * Two spans sharing the word `brown`: the longer is placed, and the shorter
   * has no free occurrence left. The DROP REASON matters as much as the drop —
   * saying "does not occur" here would send a reader hunting for a typo in
   * copy that is perfectly fine.
   *
   * BREAK IT: collapse the two branches of that drop back into one message.
   */
  it("drops an overlapping span, keeping the longer one, and says overlap rather than absence", () => {
    const out = resolveSlideMarks("body", "the quick brown fox jumps over it all today", dec("quick brown", "brown fox"), ctx());
    expect(out.accepted).toBe(1);
    expect(out.runs.filter((r) => r.mark !== undefined).map((r) => r.text)).toEqual(["quick brown"]);
    expect(out.drops[0]!.reason).toMatch(/overlaps a longer span/);
    expect(out.drops[0]!.reason).not.toMatch(/does not occur/);
  });

  it("still says ABSENT for a span that genuinely is not there — the two reasons stay distinct", () => {
    const out = resolveSlideMarks("body", "the quick brown fox jumps over it all today", dec("hallucinated"), ctx());
    expect(out.drops[0]!.reason).toMatch(/does not occur/);
  });

  it("caps at MAX_MARKS_PER_FIELD and reports every extra", () => {
    const field = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
    const out = resolveSlideMarks("body", field, dec("alpha", "beta", "gamma", "delta"), ctx());
    expect(out.accepted).toBe(MAX_MARKS_PER_FIELD);
    expect(out.drops.some((d) => d.reason.includes(`already carries ${MAX_MARKS_PER_FIELD} marks`))).toBe(true);
  });

  it("caps at MAX_MARKS_PER_SLIDE across FIELDS, through alreadyAccepted", () => {
    const field = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
    const out = resolveSlideMarks("body", field, dec("alpha", "beta"), ctx({ alreadyAccepted: MAX_MARKS_PER_SLIDE }));
    expect(out.accepted).toBe(0);
    expect(out.drops.every((d) => d.reason.includes(`already carries ${MAX_MARKS_PER_SLIDE} marks`))).toBe(true);
    // …and it still renders. A cap is a degradation, never a failure.
    expect(join(out.runs)).toBe(field);
  });

  /**
   * Since RFC-20 "no legible kind" is a PER-SLOT fact, so the second fixture
   * empties `kindsByIndex` rather than `kinds`: a slot can be allowed (far
   * enough from this slide's accent) and still be drawable as nothing, which
   * is exactly the `quote_card`-plus-highlighter case below. `kinds` is
   * emptied alongside it because it is the union of the same thing and a
   * context where the two disagree is not a state any caller can produce.
   */
  it("marks nothing and says why when the slide has no allowed colour or no legible kind", () => {
    for (const broken of [ctx({ allowedIndexes: [] }), ctx({ kinds: [], kindsByIndex: [[], [], []] })]) {
      const out = resolveSlideMarks("headline", "Plot twist ahead of everyone", dec("twist"), broken);
      expect(out.accepted).toBe(0);
      expect(out.runs).toEqual([{ text: "Plot twist ahead of everyone" }]);
      expect(out.drops[0]!.reason).toMatch(/no legible mark colour/);
    }
  });

  it("is deterministic: the same seed and the same input give a byte-identical fragment", () => {
    const run = (): string => buildMarkedRuns(resolveSlideMarks("body", LONG, dec("quiet", "beats", "clever"), ctx()).runs, "ltr");
    expect(run()).toBe(run());
    expect(run()).toBe(run());
  });

  it("a different seed moves the rotation — so the seed is actually read", () => {
    const at = (seed: number): string => buildMarkedRuns(resolveSlideMarks("body", LONG, dec("quiet", "beats", "clever"), ctx({ seed })).runs, "ltr");
    expect(at(1)).not.toBe(at(2));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The wire form and the cross-field walk (RFC-17 §6.4)
// ─────────────────────────────────────────────────────────────────────────

describe("normaliseEmphasis — a flat array of verbatim spans", () => {
  it("keeps well-formed spans in the model's own order", () => {
    expect(normaliseEmphasis(["Business", "Founder", "Know"])).toEqual({ spans: ["Business", "Founder", "Know"], drops: [] });
  });

  it("trims, and collapses a repeat rather than reporting it", () => {
    // A repeated declaration could only ever produce a drop that says nothing
    // useful: the span is claimed once, at one position, either way.
    const { spans, drops } = normaliseEmphasis(["Runway", " Runway ", "Runway"]);
    expect(spans).toEqual(["Runway"]);
    expect(drops).toEqual([]);
  });

  it("drops a blank, a single character and an over-long span — each with a reason, none fatal", () => {
    const { spans, drops } = normaliseEmphasis(["", "x", "ok", "y".repeat(MAX_MARK_CHARS + 1)]);
    expect(spans).toEqual(["ok"]);
    expect(drops).toHaveLength(3);
    expect(drops.filter((d) => d.reason.includes("blank or a single character"))).toHaveLength(2);
    expect(drops.some((d) => d.reason.includes("is a sentence, not emphasis"))).toBe(true);
  });

  it("returns nothing at all for an absent emphasis array", () => {
    expect(normaliseEmphasis(undefined)).toEqual({ spans: [], drops: [] });
  });

  it("round-trips through the SCHEMA, which is the flat form and nothing else", () => {
    expect(SlideEmphasisSchema.safeParse(["Business", "Founder"]).success).toBe(true);
    // The refused shapes: an object per mark, and a tagged string's old union.
    expect(SlideEmphasisSchema.safeParse([{ field: "headline", text: "Business" }]).success).toBe(false);
    // `.max(8)` is the contract; MAX_MARKS_PER_SLIDE = 5 is the furniture
    // budget, and the gap is why a sixth mark degrades instead of failing a
    // $0.180 draft.
    expect(SlideEmphasisSchema.safeParse(Array.from({ length: 8 }, (_, i) => `mark ${i}`)).success).toBe(true);
    expect(SlideEmphasisSchema.safeParse(Array.from({ length: 9 }, (_, i) => `mark ${i}`)).success).toBe(false);
    expect(MAX_MARKS_PER_SLIDE).toBeLessThan(8);
  });
});

describe("assignSpansToFields — a SEARCH, which is why it cannot resolve to the wrong field", () => {
  const fields = (over: Partial<Record<string, string>> = {}): MarkField[] => [
    { field: "headline", text: over["headline"] ?? "Runway is what kills a startup" },
    { field: "body", text: over["body"] ?? "Most founders count revenue when they should count runway instead" },
    { field: "quote", text: over["quote"] ?? "Cash is a fact and profit is an opinion entirely" },
    { field: "item[0]", text: over["item[0]"] ?? "Burn multiple" },
    { field: "item[1]", text: over["item[1]"] ?? "Runway in months" },
  ];

  /**
   * READING ORDER IS PINNED HERE, not left to the order the list happens to
   * be built in. Order-dependent behaviour with no test fixing the order is a
   * coin flip that happens to be landing heads.
   */
  it("routes a span to the FIRST field in reading order that contains it", () => {
    // "Runway" is in headline, body (lowercase, so not a match) and item[1].
    // Headline comes first and wins.
    const { byField } = assignSpansToFields(fields(), ["Runway"]);
    expect(byField.get("headline")).toEqual(["Runway"]);
    expect(byField.get("item[1]")).toEqual([]);
  });

  it("prefers the BODY over a later list row when the same string is in both", () => {
    const { byField } = assignSpansToFields(fields({ body: "A startup dies when Burn multiple goes wrong for too long" }), ["Burn multiple"]);
    expect(byField.get("body")).toEqual(["Burn multiple"]);
    expect(byField.get("item[0]")).toEqual([]);
  });

  it("reaches a list row when no earlier field has the span", () => {
    const { byField, drops } = assignSpansToFields(fields(), ["Burn multiple"]);
    expect(byField.get("item[0]")).toEqual(["Burn multiple"]);
    expect(drops).toEqual([]);
  });

  /**
   * BREAK IT: drop the `ordered` sort so the model's own array order is used.
   * `AI` then claims characters 0-1 of the only field, `AI slop` finds no free
   * occurrence, and the reader gets two letters marked out of the middle of
   * the phrase the model meant.
   */
  it("claims the longest span first, so a short one cannot eat the opening of a long one", () => {
    const f: MarkField[] = [{ field: "headline", text: "AI slop is the whole problem here" }];
    // Declared shortest-first on purpose. `AI slop` still wins, and the bare
    // `AI` is dropped because its ONLY occurrence is inside that phrase.
    const { byField, drops } = assignSpansToFields(f, ["AI", "AI slop"]);
    expect(byField.get("headline")).toEqual(["AI slop"]);
    expect(drops.map((d) => d.text)).toEqual(["AI"]);
    // Declaring them the other way round gives the same answer, which is the
    // whole point of ordering by length rather than by the model's array.
    expect(assignSpansToFields(f, ["AI slop", "AI"]).byField.get("headline")).toEqual(["AI slop"]);
  });

  it("gives BOTH a mark when the short span has a free occurrence of its own", () => {
    const f: MarkField[] = [{ field: "headline", text: "AI slop is the problem, and AI is not going away" }];
    const { byField, drops } = assignSpansToFields(f, ["AI", "AI slop"]);
    expect(byField.get("headline")).toEqual(["AI slop", "AI"]);
    expect(drops).toEqual([]);
  });

  /**
   * THE INSTRUMENT-POISONING TEST (RFC-17 §6.4, and the reason `claimed`
   * exists). A healthy slide whose marks are spread across four fields must
   * produce ZERO drops. The naive walk — ask every field, report a drop each
   * time the answer is no — records a dozen "not in this field" facts into
   * `collectEmphasisIssues`, which is the one channel that reports genuine
   * mark failures. The noise does not merely annoy: it buries the real drop.
   *
   * BREAK IT: push a drop inside the `fields.find` predicate.
   */
  it("records NO drops for a healthy slide whose marks are spread across four fields", () => {
    const { byField, drops } = assignSpansToFields(fields(), ["Runway", "revenue", "opinion", "Burn multiple"]);
    expect(drops).toEqual([]);
    expect(byField.get("headline")).toEqual(["Runway"]);
    expect(byField.get("body")).toEqual(["revenue"]);
    expect(byField.get("quote")).toEqual(["opinion"]);
    expect(byField.get("item[0]")).toEqual(["Burn multiple"]);
  });

  /**
   * …and the suppression must NOT reach the honest failure. A span that is
   * nowhere on the slide is exactly what tells us the model invented a word,
   * and it is the one thing this channel exists to say.
   *
   * BREAK IT: `continue` instead of pushing the drop when `target` is
   * undefined. The previous test still passes; this one goes red.
   */
  it("STILL records the drop when a span appears nowhere on the slide", () => {
    const { byField, drops } = assignSpansToFields(fields(), ["Runway", "hallucinated phrase"]);
    expect(byField.get("headline")).toEqual(["Runway"]);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.text).toBe("hallucinated phrase");
    expect(drops[0]!.field).toBe("slide");
    // It is missing from the POST, not from one field — the honest report.
    expect(drops[0]!.reason).toMatch(/does not appear on this slide/);
  });

  it("falls through to a later field when an earlier one has no FREE occurrence left", () => {
    const f: MarkField[] = [
      { field: "headline", text: "Runway matters" },
      { field: "body", text: "Runway is the only number that ever really matters to anyone" },
    ];
    // "Runway matters" claims the headline whole; the bare "Runway" then has
    // no free occurrence there and falls through to the body.
    const { byField, drops } = assignSpansToFields(f, ["Runway", "Runway matters"]);
    expect(byField.get("headline")).toEqual(["Runway matters"]);
    expect(byField.get("body")).toEqual(["Runway"]);
    expect(drops).toEqual([]);
  });

  it("is deterministic — the same spans and fields give the same routing every time", () => {
    const once = assignSpansToFields(fields(), ["Runway", "revenue", "opinion"]);
    const twice = assignSpansToFields(fields(), ["Runway", "revenue", "opinion"]);
    expect([...once.byField.entries()]).toEqual([...twice.byField.entries()]);
  });

  it("handles a slide with no declared spans, and one with no fields, without throwing", () => {
    expect(assignSpansToFields(fields(), []).drops).toEqual([]);
    expect(assignSpansToFields([], ["Runway"]).drops).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The ring
// ─────────────────────────────────────────────────────────────────────────

describe("buildMarkRing — measurability is a SELECTION criterion", () => {
  it("builds a hue rotation from an in-kit palette, capped at MARK_RING_MAX", () => {
    const ring = buildMarkRing(DARK_KIT, DARK_GROUND, LIGHT_INK, []);
    expect(ring.rotation).toBe("hue");
    expect(ring.hexes.length).toBeGreaterThanOrEqual(3);
    expect(ring.hexes.length).toBeLessThanOrEqual(MARK_RING_MAX);
    expect(ring.cssValues).toEqual(ring.hexes);
  });

  /**
   * BREAK IT: delete the `clash` branch in `buildMarkRing`. A mark colour
   * pixel-indistinguishable from accent furniture makes `markColourCount`
   * report "the mark painted" on a slide where the badge painted instead.
   */
  it("refuses a candidate within ACCENT_EXCLUSION of the accent, and says so", () => {
    const near = "#FF6E30"; // a couple of points from the kit's own #FF6B2C
    expect(markColourDistance(near, DARK_KIT.brandAccent)).toBeLessThan(ACCENT_EXCLUSION);
    const ring = buildMarkRing({ brandAccent: near, palette: [...DARK_KIT.palette] }, DARK_GROUND, LIGHT_INK, DARK_KIT.brandAccent);
    expect(ring.hexes).not.toContain(near);
    expect(ring.notes.some((n) => n.includes(near) && n.includes("pixel-confused"))).toBe(true);
  });

  it("keeps every pair in the ring at least MARK_SEPARATION apart", () => {
    const ring = buildMarkRing({ brandAccent: "#4ADE80", palette: ["#4BDF81", "#38BDF8", "#C084FC"] }, DARK_GROUND, LIGHT_INK, []);
    for (let i = 0; i < ring.hexes.length; i++) {
      for (let j = i + 1; j < ring.hexes.length; j++) {
        expect(markColourDistance(ring.hexes[i]!, ring.hexes[j]!)).toBeGreaterThanOrEqual(MARK_SEPARATION);
      }
    }
    expect(ring.hexes).toContain("#4ADE80");
    expect(ring.hexes).not.toContain("#4BDF81");
  });

  it("drops a candidate that is the ground or the ink — a mark the colour of what it sits on is nothing at all", () => {
    const ring = buildMarkRing({ brandAccent: DARK_GROUND, palette: [LIGHT_INK, "#38BDF8", "#C084FC", "#4ADE80"] }, DARK_GROUND, LIGHT_INK, []);
    expect(ring.hexes).not.toContain(DARK_GROUND);
    expect(ring.hexes).not.toContain(LIGHT_INK);
    expect(ring.notes.some((n) => n.includes("ground or the ink"))).toBe(true);
  });

  it("falls back to TINTS of what it has on a one-hue kit, and says the rotation is a tint", () => {
    const ring = buildMarkRing({ brandAccent: "#38BDF8", palette: [] }, DARK_GROUND, LIGHT_INK, []);
    expect(ring.rotation).toBe("tint");
    expect(ring.hexes.length).toBeGreaterThan(1);
    // The CSS keeps the color-mix form so the tint tracks a template that
    // repaints --bg; `hexes` carries what it resolves to, for the pixels.
    expect(ring.cssValues.slice(1).some((v) => v.startsWith("color-mix(in srgb,"))).toBe(true);
    expect(ring.cssValues[0]).toBe("#38BDF8");
    expect(ring.notes.some((n) => n.includes("tints"))).toBe(true);
  });

  /**
   * BREAK IT: return `{ hexes: ["#000000"], … }` instead of the empty ring.
   * The contract is that an illegible kit marks NOTHING and reports it — never
   * that it marks with something unreadable.
   */
  it("returns an EMPTY ring when nothing is legible — no marks, reported, nothing fails", () => {
    const ring = buildMarkRing({ brandAccent: "#191A1E", palette: ["#1C1D21", "#151619"] }, DARK_GROUND, LIGHT_INK, []);
    expect(ring.hexes).toEqual([]);
    expect(ring.cssValues).toEqual([]);
    expect(ring.rotation).toBe("none");
    expect(ring.notes.some((n) => n.includes("marks nothing"))).toBe(true);
  });

  /**
   * `groundMayInvert` PREFERS the both-grounds ring — it does not demand it,
   * and since RFC-20 §6.2 item 8 it intersects CAPABILITY rather than
   * membership.
   *
   * The pairs it walks are (GROUND, INK), not two grounds: on an inverted
   * slide the kit's `--fg` IS the ground and its `--bg` is the ink. A member
   * survives when it is legible as at least one kind on each pair, and it
   * keeps the union of what it can do on each — so `#7A5AA8` here carries
   * `underline`/`swish`/`double` on the dark ground and gains `ink` on the
   * pale one, rather than being judged by one ratio that means different
   * things at each end.
   *
   * BREAK IT: pass `[groundHex, fgHex]` as two bare grounds against one fixed
   * ink, which is what "two membership sets" amounted to. `block` then has no
   * pair to be true of and every capability set on the inverted side collapses
   * to the old 3:1 test — this test's `block` assertions go red and the
   * fallback below fires on a kit that does not need it.
   */
  it("intersects CAPABILITY per member when the run may invert, and keeps what each ground grants", () => {
    const kit = { brandAccent: "#C084FC", palette: ["#7A5AA8"] };
    const inverting = buildMarkRing(kit, DARK_GROUND, "#FAF7F0", [], { groundMayInvert: true });
    expect(inverting.hexes).toContain("#C084FC");
    // The strict pass SUCCEEDED, so this is not the fallback's output.
    expect(inverting.notes.some((n) => n.includes("rebuilt against the ground alone"))).toBe(false);
    const purple = inverting.kindsByIndex[inverting.hexes.indexOf("#C084FC")]!;
    // Granted on the DARK pair (3:1 against #17181C) …
    expect(purple).toContain("underline");
    // … and on the INVERTED one, where #FAF7F0 is the ground, #17181C is the
    // ink and the ink reads on this purple at better than 4.5:1. Neither pair
    // grants both, and the member keeps both.
    expect(purple).toContain("block");
    expect(contrastRatio("#C084FC", "#FAF7F0")).toBeLessThan(MARK_GROUND_CONTRAST_FLOOR);
    expect(contrastRatio("#17181C", "#C084FC")).toBeGreaterThanOrEqual(MARK_TEXT_CONTRAST_FLOOR);
  });

  /**
   * THE FALLBACK IS STILL REACHABLE — "far less often" is not "never", and a
   * fallback no test can reach is dead code pretending to be a safety net.
   *
   * The kit is constructed, and it has to be: on the SHIPPED pair
   * (`#17181C`/`#F5F3EF`) no colour can be legible on the dark ground and dead
   * on the inverted one, because the two bands do not overlap — a colour needs
   * luminance >= 0.135 to clear 3:1 on `#17181C` and > 0.266 to fail 3:1 on
   * `#F5F3EF`, while `block` on the inverted side needs < 0.228. That is worth
   * writing down: it is WHY the shipped dark kit's strict pass now succeeds,
   * and it means this branch is reached only by a kit with a mid-tone ink.
   */
  it("still falls back to the primary ground when a member really is dead on the inverted one", () => {
    const MID_INK = "#9A9A9A";
    const kit = { brandAccent: "#2F6FC4", palette: ["#7A5AA8"] };
    // The premise, measured rather than assumed: each member is legible on the
    // dark ground and legible as NOTHING once the pair inverts.
    for (const hex of ["#2F6FC4", "#7A5AA8"]) {
      expect(markCapabilitiesFor(hex, DARK_GROUND, MID_INK).length).toBeGreaterThan(0);
      expect(markCapabilitiesFor(hex, MID_INK, DARK_GROUND)).toEqual([]);
    }
    const ring = buildMarkRing(kit, DARK_GROUND, MID_INK, [], { groundMayInvert: true });
    expect(ring.hexes.length, "the mark ring is empty — this run would paint nothing at all").toBeGreaterThan(0);
    expect(ring.rotation).not.toBe("none");
    expect(ring.notes.some((n) => n.includes("rebuilt against the ground alone"))).toBe(true);
  });

  /**
   * THE BLOCKER THIS BRANCH SHIPPED WITH, AND THE ONE NO EXISTING TEST COULD
   * SEE.
   *
   * `runMarkRing()` in `create-instagram-agent-workflow.ts` passes
   * `groundMayInvert: true` unconditionally, and that is the ring the
   * stylesheet and the composition BOTH read in production. Every other test
   * in this file omits the option, so the whole suite measured a code path no
   * run takes.
   *
   * On any kit with real contrast the two floors pull opposite ways: `--fg`
   * is near-white on every dark kit we ship, so a saturated accent that
   * clears 3:1 against `#17181C` cannot also clear 3:1 against the ink. The
   * intersection is EMPTY, not smaller — measured on this suite's own
   * `DARK_KIT`, all four candidates scored 2.56, 1.57, 1.93 and 2.38 against
   * the ink — so the ring came back `[]`, `ringIndexesFor` returned `[]` for
   * every slide, `resolveSlideMarks` took its no-allowed-index branch, and a
   * shipping run emitted ZERO `.mk` elements plus one drop per declared span,
   * on every archetype.
   *
   * This test drives `runMarkRing()`'s EXACT argument shape.
   *
   * WHAT RFC-20 CHANGED ABOUT IT, and why the assertion moved rather than
   * softened. The blocker was "a shipping run emits zero `.mk` elements", and
   * that is still what this test refuses. What changed is the ROUTE: the
   * strict pass no longer comes back empty, because a member the old cull
   * judged by one 3:1 ratio against the near-white ink is now judged by the
   * test belonging to the kind it would be drawn as — and on the inverted
   * paper ground that kind is `block`, which every member clears. The ring is
   * byte-identical to the single-ground ring either way, which is asserted
   * below; only the notes differ.
   */
  it("emits a non-empty ring for the shape runMarkRing passes, and now clears the STRICT pass", () => {
    const palette: readonly string[] = DARK_KIT.palette;
    const ring = buildMarkRing(
      { brandAccent: DARK_KIT.brandAccent, palette },
      DARK_GROUND,
      LIGHT_INK,
      palette.length === 1 ? palette[0]! : [],
      { groundMayInvert: true },
    );
    // The premise, stated so this cannot pass by the kit having got easier:
    // under the OLD pre-kind cull the strict intersection really was empty.
    const candidates: readonly string[] = [DARK_KIT.brandAccent, ...DARK_KIT.palette];
    const legacyStrict = candidates.filter((hex) => contrastRatio(hex, LIGHT_INK) >= MARK_GROUND_CONTRAST_FLOOR);
    expect(legacyStrict, "this kit no longer exercises the empty-intersection case").toEqual([]);

    expect(ring.hexes.length, "the mark ring is empty — this run would paint nothing at all").toBeGreaterThan(0);
    expect(ring.rotation).not.toBe("none");
    // Identical to the single-ground ring — the shipped kit is UNCHANGED by
    // this phase, which is the claim RFC-20 §6.1's dark row makes.
    expect(ring.hexes).toEqual(buildMarkRing({ brandAccent: DARK_KIT.brandAccent, palette }, DARK_GROUND, LIGHT_INK, []).hexes);
    // And it got there through the strict pass, so nothing was refused at all.
    expect(ring.notes).toEqual([]);
  });

  it("still returns an empty ring when NEITHER ground yields a member — the fallback is not a licence", () => {
    const ring = buildMarkRing({ brandAccent: "#191A1E", palette: ["#1C1D21"] }, DARK_GROUND, LIGHT_INK, [], { groundMayInvert: true });
    expect(ring.hexes).toEqual([]);
    expect(ring.rotation).toBe("none");
    expect(ring.notes.some((n) => n.includes("marks nothing"))).toBe(true);
  });
});

describe("ringIndexesFor — the accent exclusion applied where the accent is actually known", () => {
  it("removes the slots this slide's accent would be confused with, and keeps the rest positional", () => {
    const ring = buildMarkRing(DARK_KIT, DARK_GROUND, LIGHT_INK, []);
    const allowed = ringIndexesFor(ring, ring.hexes[1]!);
    expect(allowed).not.toContain(1);
    expect(allowed).toContain(0);
    expect(allowed.every((i) => Number.isInteger(i) && i < ring.hexes.length)).toBe(true);
  });

  it("returns every slot when the slide has no accent at all", () => {
    const ring = buildMarkRing(DARK_KIT, DARK_GROUND, LIGHT_INK, []);
    expect(ringIndexesFor(ring, undefined)).toEqual(ring.hexes.map((_, i) => i));
  });

  /**
   * REGRESSION, and it was a silent feature-killer rather than a crash.
   *
   * `markColourDistance` returns 0 — the value that means IDENTICAL — when
   * either argument does not parse as a hex, and this function compares it
   * with `<` against `ACCENT_EXCLUSION`. So before the parse check, a
   * malformed accent excluded EVERY ring slot, `allowedIndexes` came back
   * empty, `resolveSlideMarks` took its `plain()` path, and the entire slide
   * rendered unmarked — reported as "no legible mark colour survived this
   * slide's kit and accent", which blames the kit for what the accent did.
   *
   * `""` is the case that matters: an unset brand accent field is far more
   * likely to arrive as an empty string than as `undefined`.
   */
  it("treats an UNPARSEABLE accent as no accent, rather than excluding the entire ring", () => {
    const ring = buildMarkRing(DARK_KIT, DARK_GROUND, LIGHT_INK, []);
    // Premise: this ring has slots to lose, so an empty result below would be
    // a real loss and not an empty fixture.
    expect(ring.hexes.length).toBeGreaterThan(1);
    const every = ring.hexes.map((_, i) => i);
    for (const bad of ["", "not-a-hex", "rgb(196,85,47)", "#GGGGGG", "#C4552", "transparent"]) {
      expect(ringIndexesFor(ring, bad), `accent ${JSON.stringify(bad)} emptied the ring`).toEqual(every);
    }
    // And a WELL-FORMED accent still excludes its own slot — the fix must not
    // have turned the exclusion off for everyone.
    expect(ringIndexesFor(ring, ring.hexes[0]!)).not.toContain(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The kinds — computed from the ground, never chosen by the model
// ─────────────────────────────────────────────────────────────────────────

describe("markKindsFor — the ground decides, and #17181C is our case", () => {
  /**
   * The honest answer to "the references are paper and we are not". On our
   * bundled near-black ground a pastel swatch behind near-white ink is
   * illegible, so `block` is refused BY COMPUTATION, and `rf-6`'s glyph
   * gradient (`ink`) is what carries a dark ground instead.
   *
   * WHICH CLAUSE ACTUALLY REFUSES IT, measured rather than assumed. `block`'s
   * precondition is `contrast(ink, mark) >= 4.5` AND `ground lighter than
   * ink`, and on THIS kit BOTH are false, so either alone would refuse it.
   * The deciding one here is the ink-on-mark clause: every ring member scores
   * 1.57-2.56 against `#F5F3EF` ink, nowhere near 4.5. That is asserted below
   * rather than left implicit, because "block is absent" passing for a reason
   * nobody checked is how a guard stops guarding what it claims to.
   *
   * BREAK IT: drop the `contrastRatio(fgHex, hex) >= MARK_TEXT_CONTRAST_FLOOR`
   * clause. Dropping `groundIsLighter` instead does NOT turn this red — it is
   * redundant on a dark ground with light ink — which is why the separate test
   * below exists to hold that clause on its own.
   */
  it("draws `block` on the default #17181C ground as a SLAB, the run in the ground colour (2026-09-23)", () => {
    // The Karos Labs feed's signature: a dark ground, an orange block, the
    // phrase in the ground colour. The light ink would NOT read on these
    // marks (the old refusal's premise, still true below), which is exactly
    // why the run's ink flips to the ground instead.
    const ring = buildMarkRing(DARK_KIT, DARK_GROUND, LIGHT_INK, []);
    const kinds = markKindsFor(DARK_GROUND, LIGHT_INK, ring.hexes);
    expect(new Set(kinds)).toEqual(new Set<MarkKind>(["block", "underline", "swish", "double", "ink"]));
    for (const hex of ring.hexes) {
      expect(contrastRatio(LIGHT_INK, hex)).toBeLessThan(4.5);
      expect(contrastRatio(DARK_GROUND, hex)).toBeGreaterThanOrEqual(MARK_TEXT_CONTRAST_FLOOR);
    }
  });

  /**
   * The `ground lighter than ink` clause, ISOLATED — the only test that can
   * see it, and the reason it is written as an odd-looking kit.
   *
   * A highlighter swatch only reads as a highlighter when it sits UNDER the
   * type rather than glowing behind it, which is a statement about which of
   * the two is lighter and not about contrast at all. Every other fixture in
   * this file has the two clauses failing together, so this one puts a ground
   * DARKER than its ink beside a ring every member of which the ink reads
   * cleanly on (>=5:1). Ink-on-mark therefore PASSES, and `groundIsLighter` is
   * the only thing left refusing `block`.
   *
   * BREAK IT: drop the `groundIsLighter` conjunct. `block` appears here and
   * nowhere else in this file.
   */
  it("on a ground DARKER than its ink, decides `block` by the GROUND on the mark, never by the ink", () => {
    // 2026-09-23: the run's ink flips to the ground there, so the ink's own
    // contrast on the mark is irrelevant. A bright mark carries the slab; a
    // mark too close to the ground to read the ground on it does not, however
    // well the ink would have read on it.
    const ground = "#000000";
    const ink = "#555555";
    expect(markCapabilitiesFor("#00FF66", ground, ink)).toContain("block");
    expect(contrastRatio(ground, "#00FF66")).toBeGreaterThanOrEqual(MARK_TEXT_CONTRAST_FLOOR);
    expect(markCapabilitiesFor("#3A3A3A", ground, ink)).not.toContain("block");
    expect(contrastRatio(ground, "#3A3A3A")).toBeLessThan(MARK_TEXT_CONTRAST_FLOOR);
  });

  /**
   * A pale kit gets `block` back automatically — no taste call anywhere.
   *
   * The kit is picked, not invented: `markKindsFor` requires the precondition
   * to hold for EVERY ring member, and the band where a colour is both >=3:1
   * against pale paper AND leaves dark ink >=4.5:1 ON it is genuinely narrow.
   * See the standing-finding test below, which records exactly how narrow.
   */
  it("gets `block` back on a pale kit, by the same computation", () => {
    const paleKit = { brandAccent: "#0088DD", palette: ["#009900", "#339999"] };
    const ring = buildMarkRing(paleKit, PALE_GROUND, DARK_INK, []);
    expect(ring.hexes.length).toBeGreaterThanOrEqual(3);
    expect(markKindsFor(PALE_GROUND, DARK_INK, ring.hexes)).toContain("block");
  });

  it("refuses `block` on quote_card regardless of ground — an italic run's background box is a parallelogram", () => {
    const paleKit = { brandAccent: "#0088DD", palette: ["#009900", "#339999"] };
    const ring = buildMarkRing(paleKit, PALE_GROUND, DARK_INK, []);
    expect(markKindsFor(PALE_GROUND, DARK_INK, ring.hexes, { refuseBlock: true })).not.toContain("block");
  });

  it("has no kinds at all for an empty ring", () => {
    expect(markKindsFor(DARK_GROUND, LIGHT_INK, [])).toEqual([]);
  });

  it("names only kinds the module actually draws", () => {
    const ring = buildMarkRing(DARK_KIT, DARK_GROUND, LIGHT_INK, []);
    for (const k of markKindsFor(DARK_GROUND, LIGHT_INK, ring.hexes)) expect(MARK_KINDS).toContain(k);
  });

  /**
   * THE STANDING FINDING IS DISCHARGED — and this is what replaced it.
   *
   * Two tests used to sit here: "a highlighter yellow is refused by the ring
   * floor on paper" and "rf-11's own five colours produce an EMPTY ring". The
   * second carried an explicit instruction — *"IF YOU ARE HERE BECAUSE THIS
   * TEST WENT RED … if you made that happen deliberately, delete this test and
   * say so in the RFC"* — and RFC-20 §6 is that RFC. Both are deleted here,
   * deliberately, and the block below is the replacement. It asserts the
   * OPPOSITE outcome on the same pixels, and it asserts the reason.
   *
   * The finding's own prescription is what was built: *"admit `block` on what
   * the pixel metric can see while keeping `contrastRatio` for the three
   * adjacent kinds."* RFC-20 sharpened it — `block` is admitted on the test
   * that actually governs it (the ink's contrast ON the swatch, 4.5:1, which
   * is STRICTER than the 3:1 it replaces), while `markColourDistance >
   * MARK_TOL` stays as the separability cull it always was.
   */
  it("DISCHARGES THE FINDING: rf-11's own colours now populate a ring on rf-11's own paper", () => {
    const PAPER = "#EDEBE6";
    const RF11 = ["#F2ED3A", "#A8E5E5", "#C6EF5A", "#FFE44D"];
    const ring = buildMarkRing({ brandAccent: "#888888", palette: RF11 }, PAPER, DARK_INK, []);
    expect(ring.hexes.length).toBeGreaterThan(0);
    expect(ring.rotation).not.toBe("none");
    // Every member is admitted for `block` and for `block` ALONE — which is
    // the honest result. A highlighter is far from the paper in hue and close
    // to it in luminance, so it can sit BEHIND a word and cannot be drawn as a
    // rule beside one. The old code judged it only by the second test.
    ring.hexes.forEach((hex, i) => {
      expect(ring.kindsByIndex[i], hex).toEqual(["block"]);
      expect(contrastRatio(hex, PAPER)).toBeLessThan(MARK_GROUND_CONTRAST_FLOOR);
      expect(contrastRatio(DARK_INK, hex)).toBeGreaterThanOrEqual(MARK_TEXT_CONTRAST_FLOOR);
    });
    // And on the dark ground (2026-09-23) `block` is the slab, decided by the
    // ground on the mark: a bright mark carries it, a dark one does not.
    for (const hex of ["#F2ED3A", "#0088CC", "#FFFFFF", "#2A2B30"]) {
      expect(markCapabilitiesFor(hex, DARK_GROUND, LIGHT_INK).includes("block"), hex).toBe(contrastRatio(DARK_GROUND, hex) >= MARK_TEXT_CONTRAST_FLOOR);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// RFC-20 §6 — kind-aware admission, and the quantifier that had to go
// ─────────────────────────────────────────────────────────────────────────

/**
 * The reference accounts' own situation, and the kit every number in RFC-20
 * §6.4 was measured on. Re-measured here rather than inherited — each figure
 * below is asserted, not quoted.
 */
const PAPER_GROUND = "#F0EAE6";
const PAPER_INK = "#12100E";
/** rf-11's highlighter yellow: 1.02:1 against the paper, 15.55:1 for the ink ON it. */
const HIGHLIGHTER = "#FFEB3B";
/** A dark navy: 5.62:1 against the paper, 2.83:1 for the ink ON it. The opposite squeeze. */
const NAVY = "#1D4ED8";
/** rf-11's lilac — 16.2 from the paper on the PIXEL metric's own scale, and refused for that reason alone. */
const LILAC = "#E8D4F0";

/** Which kinds a colour must be legible as, re-derived from RFC-20 §6.2 rather than called out of the module. */
/**
 * The ink a reader actually gets inside a `block` run, re-derived here rather
 * than imported, so this check is an independent statement of the rule and not
 * a restatement of the implementation. `color-mix(in srgb, …)` is a plain
 * channel-wise lerp of the 0-255 values.
 */
const compositedInk = (ink: string, mark: string): string => {
  const rgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  const [ir, ig, ib] = rgb(ink);
  const [mr, mg, mb] = rgb(mark);
  const lerp = (a: number, b: number): number => Math.round(a * MARK_HOST_INK_ALPHA + b * (1 - MARK_HOST_INK_ALPHA));
  return `#${[lerp(ir, mr), lerp(ig, mg), lerp(ib, mb)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
};

const satisfiesOwnFloor = (hex: string, kind: MarkKind, ground: string, ink: string): boolean => {
  if (kind === "block") {
    const groundIsLighter = contrastRatio(ground, "#FFFFFF") < contrastRatio(ink, "#FFFFFF");
    // 2026-09-23: on a DARK ground the run's ink flips to the ground
    // (`body[data-tone="dark"] .mk-k-block`), so the ground on the mark is
    // what must read. On a light ground the EFFECTIVE ink, not the kit token:
    // no bundled archetype paints its body ink neat. See `MARK_HOST_INK_ALPHA`.
    if (!groundIsLighter) return contrastRatio(ground, hex) >= MARK_TEXT_CONTRAST_FLOOR;
    return contrastRatio(compositedInk(ink, hex), hex) >= MARK_TEXT_CONTRAST_FLOOR;
  }
  if (kind === "ink") return contrastRatio(hex, ground) >= MARK_TEXT_CONTRAST_FLOOR;
  return contrastRatio(hex, ground) >= MARK_GROUND_CONTRAST_FLOOR;
};

/**
 * THE OLD ALGORITHM, re-implemented here so the superset claim is CHECKABLE
 * rather than asserted.
 *
 * A pre-kind cull at 3:1 against every ground, then a kind set admitted only
 * when its precondition held for EVERY member. Deliberately a copy: a superset
 * claim that called the new code to compute the old answer would prove
 * nothing, and this is the one place in the suite where duplication is the
 * point rather than the risk.
 *
 * IT REPRODUCES THE WHOLE OLD PIPELINE, not just the old legibility predicate,
 * and the difference is not pedantry — it is a finding. Admission is
 * order-dependent: `MARK_SEPARATION` drops the LATER of two near-identical
 * members and `MARK_RING_MAX` caps the ring at six, so a version that admits
 * MORE candidates can in principle displace a member the old one kept, and the
 * pair set would then not be a superset at all. Leaving those two filters out
 * of this reference produced a false failure on the first run of the sweep
 * (`#297443|underline`, reported as lost when the old ring had never legally
 * held it). With them in, the sweep reports ZERO losses over 1,000 kits — so
 * the superset property survives the ordering, which is worth knowing rather
 * than assuming.
 */
const legacyPairs = (
  palette: readonly string[],
  ground: string,
  ink: string,
  options?: { refuseBlock?: boolean },
): Set<string> => {
  const ring: string[] = [];
  for (const hex of palette) {
    if (ring.length >= MARK_RING_MAX) break;
    if (markColourDistance(hex, ground) <= MARK_TOL || markColourDistance(hex, ink) <= MARK_TOL) continue;
    if (contrastRatio(hex, ground) < MARK_GROUND_CONTRAST_FLOOR) continue;
    if (ring.some((prev) => markColourDistance(hex, prev) < MARK_SEPARATION)) continue;
    ring.push(hex);
  }
  const out = new Set<string>();
  if (ring.length === 0) return out;
  const kinds: MarkKind[] = [];
  const groundIsLighter = contrastRatio(ground, "#FFFFFF") < contrastRatio(ink, "#FFFFFF");
  if (options?.refuseBlock !== true && groundIsLighter && ring.every((h) => contrastRatio(ink, h) >= MARK_TEXT_CONTRAST_FLOOR)) kinds.push("block");
  if (ring.every((h) => contrastRatio(h, ground) >= MARK_GROUND_CONTRAST_FLOOR)) kinds.push("underline", "swish", "double");
  if (ring.every((h) => contrastRatio(h, ground) >= MARK_TEXT_CONTRAST_FLOOR)) kinds.push("ink");
  for (const hex of ring) for (const kind of kinds) out.add(`${hex}|${kind}`);
  return out;
};

describe("RFC-20 §6.4 — the two-sided pin: the two squeezes are provably independent", () => {
  /**
   * THE SHARPEST FALSIFICATION THIS PHASE HAS, and it is two-sided on purpose.
   *
   * A one-sided pin ("the highlighter is admitted") would also pass if the
   * change had simply dropped a floor. This one demands that the SAME kit
   * admit each colour for the kind its own numbers support and REFUSE it for
   * the kind they do not — in opposite directions. Only a per-kind test can
   * satisfy both halves at once.
   *
   * REVERT TEST (run, not reasoned about): restore the pre-kind
   * `contrastRatio(hex, ground) >= 3` cull ahead of admission and `#FFEB3B` is
   * culled at 1.02:1 before `block` is ever considered — the first half cannot
   * be satisfied at all. Restore `every()` on top of that and the paper ring
   * yields `block` for nobody, because `#1D4ED8` vetoes it for the whole run.
   */
  it("admits #FFEB3B for `block` and refuses it for `underline`; #1D4ED8 the other way round", () => {
    // The four numbers, measured here against the shipped formula.
    expect(contrastRatio(HIGHLIGHTER, PAPER_GROUND)).toBeCloseTo(1.02, 2);
    expect(contrastRatio(PAPER_INK, HIGHLIGHTER)).toBeCloseTo(15.55, 2);
    expect(contrastRatio(NAVY, PAPER_GROUND)).toBeCloseTo(5.62, 2);
    expect(contrastRatio(PAPER_INK, NAVY)).toBeCloseTo(2.83, 2);

    const yellow = markCapabilitiesFor(HIGHLIGHTER, PAPER_GROUND, PAPER_INK);
    expect(yellow).toContain("block");
    expect(yellow).not.toContain("underline");
    expect(yellow).not.toContain("swish");
    expect(yellow).not.toContain("double");
    expect(yellow).not.toContain("ink");

    const navy = markCapabilitiesFor(NAVY, PAPER_GROUND, PAPER_INK);
    expect(navy).toContain("underline");
    expect(navy).not.toContain("block");

    // And it survives the whole ring, not just the predicate — both in one
    // kit, so neither is admitted by being alone.
    const ring = buildMarkRing({ brandAccent: HIGHLIGHTER, palette: [NAVY] }, PAPER_GROUND, PAPER_INK, []);
    expect(ring.hexes).toContain(HIGHLIGHTER);
    expect(ring.hexes).toContain(NAVY);
    expect(ring.kindsByIndex[ring.hexes.indexOf(HIGHLIGHTER)]).toEqual(["block"]);
    expect(ring.kindsByIndex[ring.hexes.indexOf(NAVY)]).toEqual(["underline", "swish", "double", "ink"]);
  });

  /**
   * BREAK 1 OF 4 — draw the rotation's kind from the UNION instead of the
   * member's own set, and the pairing guard must refuse the result.
   *
   * This is the break the RFC names first, and it is performed here rather
   * than described: the context below hands slot 0 the ring's UNION, which is
   * exactly what indexing a flattened kind list would produce. `#FFEB3B` is
   * then eligible for `underline` at 1.02:1 against the paper — a mark nobody
   * can see, on the very plate this phase exists to fix.
   *
   * *If the guard does not refuse it, the guard is the bug.*
   */
  it("BREAK 1: a union-drawn (#FFEB3B, underline) at 1.02:1 is refused at the point of emission", () => {
    const ring = buildMarkRing({ brandAccent: HIGHLIGHTER, palette: [NAVY] }, PAPER_GROUND, PAPER_INK, []);
    const union = markKindsFor(PAPER_GROUND, PAPER_INK, ring.hexes);
    // The premise: the union really does offer `underline` for a slot that
    // cannot carry it. Without this the test could pass on an empty union.
    expect(union).toContain("underline");
    expect(ring.kindsByIndex[ring.hexes.indexOf(HIGHLIGHTER)]).not.toContain("underline");

    const broken = resolveSlideMarks("headline", "Save this before the quarter closes", dec("Save this"), {
      dir: "ltr",
      allowedIndexes: [ring.hexes.indexOf(HIGHLIGHTER)],
      kinds: union,
      // THE BREAK: every slot gets the union.
      kindsByIndex: ring.hexes.map(() => union),
      hexes: ring.hexes,
      groundHex: PAPER_GROUND,
      fgHex: PAPER_INK,
      seed: 3,
      alreadyAccepted: 0,
    });
    // The guard refuses it, names the pair, and DEGRADES — never holds.
    expect(broken.runs.some((r) => r.mark !== undefined)).toBe(false);
    expect(broken.accepted).toBe(0);
    expect(broken.drops.length).toBeGreaterThan(0);
    expect(broken.drops[0]!.reason).toContain(HIGHLIGHTER);
    expect(broken.drops[0]!.reason).toContain("plain type");
    // The text is intact: a refused mark costs the reader nothing.
    expect(broken.runs.map((r) => r.text).join("")).toBe("Save this before the quarter closes");

    // The control: the SAME call with the member's own set paints.
    const honest = resolveSlideMarks("headline", "Save this before the quarter closes", dec("Save this"), {
      dir: "ltr",
      allowedIndexes: [ring.hexes.indexOf(HIGHLIGHTER)],
      kinds: union,
      kindsByIndex: ring.kindsByIndex,
      hexes: ring.hexes,
      groundHex: PAPER_GROUND,
      fgHex: PAPER_INK,
      seed: 3,
      alreadyAccepted: 0,
    });
    expect(honest.runs.find((r) => r.mark !== undefined)?.mark?.kind).toBe("block");
  });

  /**
   * BREAK 2 OF 4 — `MARK_TEXT_CONTRAST_FLOOR` -> 1.
   *
   * Performed by re-deriving admission at the broken floor and asserting the
   * REAL module disagrees. `#7A7000` is a dark olive on paper: the paper is
   * lighter than the ink, so `groundIsLighterThanInk` holds and the ONLY thing
   * standing between this colour and a `block` is the floor — the ink reads on
   * it at 3.75:1, which a floor of 1 admits and 4.5 refuses. A swatch that
   * dark behind near-black type is exactly the illegible mark the floor is
   * for, and the fixture is chosen so no OTHER clause can take the credit.
   */
  it("BREAK 2: an unreadable `block` stays refused — the admission floor is the real constant", () => {
    const MUD = "#7A7000";
    const onMark = contrastRatio(PAPER_INK, MUD);
    // The premise, in three parts, so a refusal below can only be the floor:
    // the colour is separable, the ground IS lighter than the ink, and the
    // contrast lands between a broken floor of 1 and the real one.
    expect(markColourDistance(MUD, PAPER_GROUND)).toBeGreaterThan(MARK_TOL);
    expect(markColourDistance(MUD, PAPER_INK)).toBeGreaterThan(MARK_TOL);
    expect(contrastRatio(PAPER_GROUND, "#FFFFFF")).toBeLessThan(contrastRatio(PAPER_INK, "#FFFFFF"));
    expect(onMark).toBeGreaterThan(1);
    expect(onMark).toBeLessThan(MARK_TEXT_CONTRAST_FLOOR);

    expect(markCapabilitiesFor(MUD, PAPER_GROUND, PAPER_INK)).not.toContain("block");
    // …and it is NOT simply dropped: it is admitted for the kinds it can
    // carry, which is what makes this a per-kind refusal rather than a cull.
    expect(markCapabilitiesFor(MUD, PAPER_GROUND, PAPER_INK)).toContain("underline");

    const ring = buildMarkRing({ brandAccent: MUD, palette: [] }, PAPER_GROUND, PAPER_INK, []);
    const at = ring.hexes.indexOf(MUD);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(ring.kindsByIndex[at]).not.toContain("block");
    // The union DOES contain `block` here, and that is not a hole — a one-hue
    // kit falls to the tint ladder, and a tint lerped toward this paper ground
    // is lighter than its parent and clears the floor honestly. So the claim
    // is made where it belongs, on every member: nothing carries `block`
    // without earning it, and the mud is not among them.
    ring.hexes.forEach((h, i) => {
      if (ring.kindsByIndex[i]!.includes("block")) expect(contrastRatio(PAPER_INK, h), h).toBeGreaterThanOrEqual(MARK_TEXT_CONTRAST_FLOOR);
    });
  });

  /**
   * BREAK 3 OF 4 — drop the `groundIsLighterThanInk` conjunct.
   *
   * A SWEEP rather than a spot check, because a spot check on `DARK_KIT` would
   * pass for the wrong reason: those four members also fail the ink-on-mark
   * test, so removing the conjunct would not move them and the guard would be
   * green while broken. The premise below finds the colours that WOULD be
   * admitted without the conjunct and asserts there are some — then asserts
   * the module admits none of them.
   */
  it("BREAK 3: on the #17181C ground `block` is admitted for EXACTLY the colours the ground reads on, over every colour", () => {
    // 2026-09-23: the dark slab. Both sides are counted so neither a module
    // that refuses everything nor one that admits everything can pass.
    let admitted = 0;
    let refused = 0;
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
          if (markColourDistance(hex, DARK_GROUND) <= MARK_TOL || markColourDistance(hex, LIGHT_INK) <= MARK_TOL) continue;
          const expected = contrastRatio(DARK_GROUND, hex) >= MARK_TEXT_CONTRAST_FLOOR;
          const got = markCapabilitiesFor(hex, DARK_GROUND, LIGHT_INK).includes("block");
          expect(got, hex).toBe(expected);
          if (got) admitted++;
          else refused++;
        }
      }
    }
    expect(admitted, "the sweep admitted nothing").toBeGreaterThan(100);
    expect(refused, "the sweep refused nothing").toBeGreaterThan(100);
  });

  /**
   * BREAK 4 OF 4 — drop the `MARK_TOL` cull.
   *
   * `#E8D4F0` is rf-11's own lilac and it sits at 16.2 from the paper on
   * `slide-metrics.ts`'s own weighted-RGB scale — INSIDE the resolution of the
   * instrument that will later decide whether the cell was marked. The ink
   * reads on it at 13.66:1, so kind-aware admission alone would take it
   * happily; only the separability cull refuses it, and that cull is the thing
   * that stops this phase being a general loosening.
   */
  it("BREAK 4: #E8D4F0 at 16.2 from the paper is refused for EVERY kind, though `block` would take it", () => {
    expect(markColourDistance(LILAC, PAPER_GROUND)).toBeCloseTo(16.2, 1);
    expect(markColourDistance(LILAC, PAPER_GROUND)).toBeLessThan(MARK_TOL);
    // The premise: legibility alone would admit it.
    expect(contrastRatio(PAPER_INK, LILAC)).toBeGreaterThanOrEqual(MARK_TEXT_CONTRAST_FLOOR);
    expect(markCapabilitiesFor(LILAC, PAPER_GROUND, PAPER_INK)).toContain("block");

    const ring = buildMarkRing({ brandAccent: HIGHLIGHTER, palette: [LILAC, NAVY] }, PAPER_GROUND, PAPER_INK, []);
    expect(ring.hexes).not.toContain(LILAC);
    expect(ring.notes.some((n) => n.includes(LILAC) && n.includes(`within ${MARK_TOL}`))).toBe(true);
    // And the ring it was dropped from is otherwise healthy, so this is a
    // refusal and not an empty fixture. (The ring is two HUES; a two-hue kit
    // is under MIN_HUE_RING, so the tint ladder tops it up — which is the
    // pre-existing behaviour and not this phase's doing.)
    expect(ring.hexes.filter((h) => [HIGHLIGHTER, LILAC, NAVY].includes(h))).toEqual([HIGHLIGHTER, NAVY]);
    // Every tint the ladder added is separable too — the cull now applies to
    // the tint path, which it did not before RFC-20.
    for (const h of ring.hexes) expect(markColourDistance(h, PAPER_GROUND)).toBeGreaterThan(MARK_TOL);
  });

  /**
   * THE OTHER HALF OF THE SQUEEZE — `every()` is gone.
   *
   * MEASURED: a kind-aware admission ALONE still yields `block` for nobody on
   * this kit, because `#1D4ED8` — perfectly legible, and admitted for four
   * kinds — reads at 2.83:1 under the ink and vetoes `block` for the whole
   * ring. Both defects had to be repaired together, and this is the test that
   * says so.
   */
  it("one dark member no longer vetoes `block` for the whole run", () => {
    const ring = buildMarkRing({ brandAccent: HIGHLIGHTER, palette: [NAVY] }, PAPER_GROUND, PAPER_INK, []);
    // The veto, reproduced: under `every()` the answer was nothing.
    expect(ring.hexes.every((h) => contrastRatio(PAPER_INK, h) >= MARK_TEXT_CONTRAST_FLOOR)).toBe(false);
    // And the answer now.
    expect(markKindsFor(PAPER_GROUND, PAPER_INK, ring.hexes)).toContain("block");
    const perMember = ring.hexes.map((_, i) => ring.kindsByIndex[i]!);
    expect(perMember.some((k) => k.includes("block"))).toBe(true);
    expect(perMember.every((k) => k.includes("block"))).toBe(false);
  });

  /**
   * `ringIndexesFor`'s new limb, and it is LOAD-BEARING rather than tidy.
   *
   * On `quote_card` the archetype refuses `block` outright, and a paper kit's
   * highlighter can be drawn as NOTHING ELSE. Without this limb the rotation
   * selects a colour with no kind at all and the slide silently marks nothing
   * while reporting a colour it chose.
   *
   * BREAK IT: drop the `markCapabilitiesFor(...).length === 0` line. The
   * highlighter's slot comes back and the `quote_card` assertion below fails.
   */
  it("excludes a block-only member from a slide that refuses `block`, and keeps it otherwise", () => {
    const ring = buildMarkRing({ brandAccent: HIGHLIGHTER, palette: [NAVY] }, PAPER_GROUND, PAPER_INK, []);
    const yellowAt = ring.hexes.indexOf(HIGHLIGHTER);
    const navyAt = ring.hexes.indexOf(NAVY);
    const slide = { groundHex: PAPER_GROUND, fgHex: PAPER_INK };
    expect(ringIndexesFor(ring, undefined, slide)).toContain(yellowAt);
    const quote = ringIndexesFor(ring, undefined, { ...slide, refuseBlock: true });
    expect(quote).not.toContain(yellowAt);
    expect(quote).toContain(navyAt);
    // Without the slide it is pure accent exclusion — today's behaviour, for
    // the inventory callers that have no slide.
    expect(ringIndexesFor(ring, undefined)).toContain(yellowAt);
  });

  /**
   * THE PROPERTY SWEEP — ~4,000 synthetic kits, both luminance polarities,
   * with and without `refuseBlock` and inversion.
   *
   * Three properties, and the third is the one that makes this a repair rather
   * than a rewrite:
   *
   *  1. every emitted (hex, kind) pair satisfies THAT KIND's own floor against
   *     the exact ground the slide renders on;
   *  2. no colour inside `MARK_TOL` of a ground or an ink is ever admitted for
   *     any kind;
   *  3. the admitted pair set is a SUPERSET of what the old algorithm emitted
   *     — checked against a re-implementation of the old algorithm, not
   *     against the new code.
   */
  it("holds all three properties over ~4,000 synthetic kits", () => {
    // A deterministic LCG, so a failure is reproducible from the seed alone.
    let state = 0x2545f491;
    const next = (): number => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const chan = (): number => next() % 256;
    const hex = (): string => `#${[chan(), chan(), chan()].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

    let kits = 0;
    let evaluations = 0;
    let blockPairs = 0;
    let supersetChecks = 0;
    let narrowedByHostAlpha = 0;
    for (let k = 0; k < 1000; k++) {
      // Both polarities: a paper kit and a dark kit, alternating.
      const light = k % 2 === 0;
      const ground = light ? `#${[240 + (next() % 16), 235 + (next() % 16), 230 + (next() % 16)].map((c) => Math.min(255, c).toString(16).padStart(2, "0")).join("")}` : `#${[next() % 32, next() % 32, next() % 32].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      const ink = light ? `#${[next() % 32, next() % 32, next() % 32].map((c) => c.toString(16).padStart(2, "0")).join("")}` : `#${[240 + (next() % 16), 235 + (next() % 16), 230 + (next() % 16)].map((c) => Math.min(255, c).toString(16).padStart(2, "0")).join("")}`;
      const palette = [hex(), hex(), hex(), hex()];
      kits++;

      for (const mayInvert of [false, true]) {
        const ring = buildMarkRing({ brandAccent: palette[0]!, palette: palette.slice(1) }, ground, ink, [], { groundMayInvert: mayInvert });
        // Property 2 — the honest cull, on every surface the ring was built
        // against. When the run may invert, BOTH members of the pair are
        // surfaces.
        const surfaces = mayInvert ? [ground, ink] : [ground, ink];
        for (const h of ring.hexes) {
          for (const s of surfaces) {
            expect(markColourDistance(h, s), `${h} was admitted within ${MARK_TOL} of ${s}`).toBeGreaterThan(MARK_TOL);
          }
        }

        for (const refuseBlock of [false, true]) {
          // The pairs the ring renders on each ground it can land on.
          for (const pair of mayInvert ? [[ground, ink], [ink, ground]] : [[ground, ink]]) {
            const [g, f] = pair as [string, string];
            const { kindsByIndex, kinds } = slideMarkKinds(ring, g, f, { refuseBlock });
            evaluations++;
            // Property 1 — every emitted pair clears its OWN kind's floor.
            kindsByIndex.forEach((set, i) => {
              const h = ring.hexes[i]!;
              for (const kind of set) {
                if (kind === "block") blockPairs++;
                expect(refuseBlock && kind === "block", `refuseBlock admitted a block for ${h}`).toBe(false);
                expect(satisfiesOwnFloor(h, kind, g, f), `${h} as ${kind} on ${g}/${f}`).toBe(true);
              }
            });
            // The union really is the union — `kinds` must not invent a kind
            // no member carries, which is what would happen if `every()` came
            // back as an `some()` by accident.
            for (const kind of kinds) expect(kindsByIndex.some((set) => set.includes(kind))).toBe(true);

            // Property 3 — superset of the old algorithm, on the primary pair
            // (which is the only one the old algorithm could express).
            if (!mayInvert) {
              const before = legacyPairs(palette, g, f, { refuseBlock });
              const after = new Set<string>();
              kindsByIndex.forEach((set, i) => {
                for (const kind of set) after.add(`${ring.hexes[i]!}|${kind}`);
              });
              for (const pairKey of before) {
                supersetChecks++;
                if (after.has(pairKey)) continue;
                // ── THE ONE SANCTIONED EXCEPTION, AND IT IS CHECKED RATHER
                //    THAN EXCUSED. ──
                //
                // RFC-20 §6.3 claimed the new pair set is a superset "by
                // construction". It is not, in exactly one direction: `block`
                // admission now measures the host's EFFECTIVE ink rather than
                // the kit token (`MARK_HOST_INK_ALPHA`), so a swatch the old
                // algorithm admitted on a ratio the reader never gets is now
                // refused. That is a repair and it is strictly STRICTER, so
                // the honest invariant is "superset, except where the old
                // answer was wrong" — and the `expect`s below are what stop
                // that sentence from excusing anything else. A dropped pair
                // must be a `block`, it must have cleared 4.5 on the neat
                // token, and it must fail 4.5 on the composited ink.
                const [droppedHex, droppedKind] = pairKey.split("|") as [string, MarkKind];
                expect(droppedKind, `the old algorithm emitted ${pairKey} and the new one does not`).toBe("block");
                expect(contrastRatio(f, droppedHex), `${pairKey} was dropped but did not clear the neat-token floor either`).toBeGreaterThanOrEqual(MARK_TEXT_CONTRAST_FLOOR);
                expect(contrastRatio(compositedInk(f, droppedHex), droppedHex), `${pairKey} was dropped but its composited ink clears the floor`).toBeLessThan(MARK_TEXT_CONTRAST_FLOOR);
                narrowedByHostAlpha++;
              }
            }
          }
        }
      }
    }
    // The sweep's own premises, so none of the above can pass by measuring
    // nothing: it really ran, it really produced `block` pairs (the thing this
    // phase unlocks), and it really had old pairs to be a superset of.
    expect(kits).toBe(1000);
    expect(evaluations).toBeGreaterThan(4000);
    expect(blockPairs, "the sweep produced no `block` at all").toBeGreaterThan(0);
    expect(supersetChecks, "the superset property was never exercised").toBeGreaterThan(0);
    // And the exception was exercised too — otherwise the block above is dead
    // code and `MARK_HOST_INK_ALPHA` could be 1.0 with nothing noticing.
    expect(narrowedByHostAlpha, "no pair was ever narrowed by the host's ink alpha — the effective-ink correction is inert here").toBeGreaterThan(0);
  });

  /**
   * THE ONE THING THAT MUST NOT MOVE: the shipped dark kit.
   *
   * RFC-20 §6.1's dark row claims this change is inert on every client we run
   * today, and an inertness claim is worth nothing unless a test holds it.
   */
  it("keeps the bundled #17181C kit's ring, and (2026-09-23) gives every member the dark slab", () => {
    for (const mayInvert of [false, true]) {
      const ring = buildMarkRing(DARK_KIT, DARK_GROUND, LIGHT_INK, [], { groundMayInvert: mayInvert });
      expect(ring.hexes).toEqual(["#FF6B2C", "#4ADE80", "#38BDF8", "#C084FC"]);
      expect(ring.rotation).toBe("hue");
      const { kinds, kindsByIndex } = slideMarkKinds(ring, DARK_GROUND, LIGHT_INK);
      expect(kinds).toEqual(["block", "underline", "swish", "double", "ink"]);
      for (const set of kindsByIndex) expect(set).toEqual(["block", "underline", "swish", "double", "ink"]);
    }
  });

  /**
   * THE SOURCE SCAN, and it is the only thing that can hold an OPTIONAL
   * parameter honest.
   *
   * `ringIndexesFor`'s slide constraint and `SlideMarkContext`'s emission
   * inputs are optional so that `emphasis-marks-rtl.test.ts` — which composes
   * a context by hand to exercise Phase 4's bidi isolation, and which RFC-20
   * §5.9 forbids editing — keeps compiling. That is a real reason and it comes
   * with a real cost: omitting them is SILENT. Both production call sites are
   * pinned here instead.
   */
  it("both production call sites pass the slide constraint and the emission inputs", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const slidesData = readFileSync(path.join(here, "../src/workflow/slides-data.ts"), "utf8");
    const studio = readFileSync(path.join(here, "../src/workflow/template-studio.ts"), "utf8");

    // `ringIndexesFor` is never called with two arguments in production.
    for (const [name, src] of [["slides-data.ts", slidesData], ["template-studio.ts", studio]] as const) {
      const calls = [...src.matchAll(/ringIndexesFor\(([^;]*?)\)[,;\n]/gs)];
      expect(calls.length, `${name} does not call ringIndexesFor`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call[1], `${name} calls ringIndexesFor without the slide constraint`).toMatch(/groundHex/);
        expect(call[1], `${name} calls ringIndexesFor without refuseBlock`).toMatch(/refuseBlock/);
      }
    }
    // And the resolver gets the per-member kinds plus what it needs to
    // re-assert the pair at emission.
    for (const [name, src] of [["slides-data.ts", slidesData], ["template-studio.ts", studio]] as const) {
      const call = /resolveSlideMarks\([\s\S]*?\n\s*\}\);/.exec(src);
      expect(call, `${name} does not call resolveSlideMarks`).not.toBeNull();
      for (const field of ["kindsByIndex", "hexes", "groundHex", "fgHex", "refuseBlock"]) {
        expect(call![0], `${name} omits \`${field}\` from the mark context`).toContain(field);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The rotation
// ─────────────────────────────────────────────────────────────────────────

describe("markRotation — seeded, never random", () => {
  const kinds: MarkKind[] = ["underline", "swish", "double", "ink"];
  /** Every slot carries the same set — the pre-RFC-20 world, where colour and kind were independent axes. */
  const uniform = (slots: number, set: readonly MarkKind[] = kinds): MarkKind[][] => Array.from({ length: slots }, () => [...set]);

  it("never gives two CONSECUTIVE marks the same colour, at every seed", () => {
    for (let seed = 0; seed < 300; seed++) {
      for (const allowed of [[0, 1], [0, 1, 2], [1, 3, 4, 5]]) {
        const by = uniform(6);
        for (let ord = 0; ord < 5; ord++) {
          expect(markRotation(seed, ord, allowed, by)!.colourIndex).not.toBe(markRotation(seed, ord + 1, allowed, by)!.colourIndex);
        }
      }
    }
  });

  /**
   * The second published invariant, with RFC-20's qualifier: it holds whenever
   * the two selected colours share a kind set of >= 2 members, which is every
   * slide of every dark kit we ship. The fixture makes the sets equal on
   * purpose — the case where they differ is covered by the pairing guard
   * below, and there the kinds differ because the SETS do.
   */
  it("puts at least TWO kinds on a slide whenever it puts two marks on it, at every seed", () => {
    for (let seed = 0; seed < 300; seed++) {
      const by = uniform(2);
      expect(markRotation(seed, 0, [0, 1], by)!.kind).not.toBe(markRotation(seed, 1, [0, 1], by)!.kind);
    }
  });

  it("only ever returns a colour the slide is ALLOWED and a kind that is legible", () => {
    for (let seed = 0; seed < 200; seed++) {
      for (let ord = 0; ord < 6; ord++) {
        const by = uniform(5, ["swish", "ink"]);
        const r = markRotation(seed, ord, [2, 4], by)!;
        expect([2, 4]).toContain(r.colourIndex);
        expect(["swish", "ink"]).toContain(r.kind);
      }
    }
  });

  /**
   * RFC-20 §6.2 item 5 — THE BOUND. The kind comes from the set belonging to
   * the slot the rotation landed on, never from a set shared by the ring.
   *
   * BREAK IT: index `kindsByIndex` by `ordinal` instead of by `colourIndex`,
   * or flatten it to a union before indexing. Either makes slot 1 emit `block`
   * here, and slot 1 cannot carry `block`.
   */
  it("draws the kind from the SELECTED COLOUR'S own set, never from a union", () => {
    const by: MarkKind[][] = [["block"], ["underline"], ["ink"]];
    for (let seed = 0; seed < 400; seed++) {
      for (let ord = 0; ord < 4; ord++) {
        const r = markRotation(seed, ord, [0, 1, 2], by)!;
        expect(by[r.colourIndex], `slot ${r.colourIndex} was drawn as ${r.kind}`).toContain(r.kind);
      }
    }
  });

  it("degrades rather than throws when there is nothing to rotate through", () => {
    expect(markRotation(1, 0, [], uniform(2))).toBeUndefined();
    expect(markRotation(1, 0, [0], [[]])).toBeUndefined();
    // A slot outside the table is the same answer, not a crash.
    expect(markRotation(1, 0, [7], [[], []])).toBeUndefined();
  });

  it("survives a single allowed slot and a single kind without dividing by zero", () => {
    expect(markRotation(7, 3, [2], [[], [], ["ink"]])).toEqual({ colourIndex: 2, kind: "ink" });
  });

  it("slideMarkSeed is stable per slide and differs across slides", () => {
    expect(slideMarkSeed("kit-a", 3)).toBe(slideMarkSeed("kit-a", 3));
    expect(slideMarkSeed("kit-a", 3)).not.toBe(slideMarkSeed("kit-a", 4));
    expect(slideMarkSeed("kit-a", 3)).not.toBe(slideMarkSeed("kit-b", 3));
    expect(slideMarkSeed(undefined, 1)).toBe(slideMarkSeed(undefined, 1));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The fragment
// ─────────────────────────────────────────────────────────────────────────

describe("buildMarkedRuns — EVERY run is wrapped, and that is a measurement contract", () => {
  /**
   * THE MOST IMPORTANT TEST IN THIS FILE.
   *
   * `probePage` counts a text-bearing LEAF as an element with words and no
   * element children (`render-carousel.ts:455-462`). Wrap only the MARKED runs
   * and the h1 gains an element child, stops being a leaf, and takes two
   * things down with it silently: its box stops counting toward
   * `textBoxShare` (clause G limb 2), and its family stops entering
   * `fontFamiliesUsed` — which is the only proof a Phase 0 script font ever
   * loaded. Both failures are invisible in a screenshot.
   *
   * BREAK IT: `if (run.mark === undefined) return inner;` in buildMarkedRuns.
   */
  it("wraps every run in a span — the unmarked prose too", () => {
    const out = resolveSlideMarks("body", LONG, dec("quiet", "clever"), ctx());
    const fragment = buildMarkedRuns(out.runs, "ltr");
    expect(out.runs).toHaveLength(5);
    expect(out.runs.filter((r) => r.mark !== undefined)).toHaveLength(2);
    expect(fragment.match(/<span class="[^"]*">/g) ?? []).toHaveLength(out.runs.length);
    // No text escapes a span: stripping every complete span leaves nothing.
    expect(fragment.replace(/<span class="[^"]*">[^<]*<\/span>/g, "")).toBe("");
  });

  it("distinguishes a MARKED run from a wrapper run, so `marks-missing` cannot fire on plain copy", () => {
    const out = resolveSlideMarks("body", LONG, dec("quiet"), ctx());
    const fragment = buildMarkedRuns(out.runs, "ltr");
    // If both carried `.mk`, the "markRuns > 0 && markRunsPainted === 0"
    // clause would fire on every slide that is wrapped but unmarked — which
    // is most of them.
    expect(fragment).toMatch(/<span class="mk mk-c\d mk-k-(block|underline|swish|double|ink)">quiet<\/span>/);
    expect(fragment).toContain('<span class="mk-t">');
    expect(fragment.match(/class="mk /g) ?? []).toHaveLength(1);
  });

  it("emits NOTHING when no run is marked, so the twin slot stays unfilled and the plain field shows", () => {
    expect(buildMarkedRuns([{ text: "nothing marked here" }], "ltr")).toBe("");
    expect(buildMarkedRuns([], "ltr")).toBe("");
  });

  /**
   * The `{{html:}}` substitution form is deliberately NOT escaped by the
   * renderer, which makes escaping HERE the only thing between a
   * model-authored mark and live markup in a rendered slide.
   *
   * BREAK IT: return `run.text` instead of `esc(...)`.
   */
  it("escapes a mark whose text is markup — it renders as entities, never as a tag", () => {
    const field = "Try <script>alert(1)</script> today and see whether anything at all actually happens here";
    const out = resolveSlideMarks("body", field, dec("<script>alert(1)</script>"), ctx());
    expect(out.accepted).toBe(1);
    const fragment = buildMarkedRuns(out.runs, "ltr");
    expect(fragment).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(fragment).not.toContain("<script>");
    // The only `<` characters left are the spans this module authored.
    expect(fragment.replace(/<\/?span[^>]*>/g, "")).not.toContain("<");
  });

  it("escapes quotes and ampersands in the UNMARKED runs too", () => {
    const out = resolveSlideMarks("body", 'Ben & "Jerry" made the twist happen for everyone', dec("twist"), ctx());
    const fragment = buildMarkedRuns(out.runs, "ltr");
    expect(fragment).toContain("&amp;");
    expect(fragment).toContain("&quot;");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The stylesheet — a source scan, in the shape slide-devices-rtl already uses
// ─────────────────────────────────────────────────────────────────────────

describe("markCssBlock — the source contract", () => {
  const ring = buildMarkRing(DARK_KIT, DARK_GROUND, LIGHT_INK, []);
  const latin = markCssBlock(undefined, ring);
  const hebrew = markCssBlock("Hebrew", ring);
  /** The declaration bodies only — the prose above them is allowed to say "left" in English. */
  const declarations = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("uses LOGICAL properties only — no physical left/right anywhere", () => {
    const body = declarations(latin);
    expect(body).not.toMatch(/(^|[\s;{])(left|right)\s*:/);
    expect(body).not.toMatch(/(padding|margin|border|inset)-(left|right)\s*:/);
    expect(body).toContain("padding-block-start");
  });

  /**
   * A MARK MUST NOT MOVE THE MEASURE, AND THE ONLY WAY TO GUARANTEE THAT IS
   * TO GIVE IT NO INLINE BOX MODEL AT ALL.
   *
   * `.mk` used to carry `padding-inline: .06em` against `margin-inline:
   * -.06em`. The pair cancels for a mark that fits on one line, but
   * `box-decoration-break: clone` — which the design needs, so a mark spanning
   * a line break paints on both fragments instead of straight through the
   * gutter — duplicates the PADDING onto every fragment while the MARGINS
   * only cancel the two outer edges. A wrapped mark therefore kept `2 x bleed`
   * of extra measure, and on real Chromium that was enough to add a whole line
   * to a headline and push the block out of its column: a hard `clipped`
   * finding, on `cover.html` and `slide.html` at fontScale `l`. Halving it to
   * `.03em` only moved the cliff — the same defect came back on `slide.html`
   * with the long fixture at `textAlign: end`.
   *
   * So: no inline padding, no inline margin, no border. A mark's box is the
   * glyph advance, and a marked field measures exactly what an unmarked one
   * does. This is a source scan because the pixel proof is Chromium-gated and
   * self-skips off CI, and a constant this easy to "restore" needs a guard
   * that runs everywhere.
   */
  it("gives a mark NO inline box model — the measure cannot move, wrapped or not", () => {
    const body = declarations(latin);
    expect(body).not.toMatch(/padding-inline\s*:/);
    expect(body).not.toMatch(/margin-inline\s*:/);
    expect(body).not.toMatch(/border-inline\s*:/);
    // The block axis is a different question and is answered differently:
    // the twin host's bleed is the one box-model value in this sheet.
    // TWO CONTRIBUTORS, COMBINED AT THE CONSUMPTION SITE. The SCRIPT's share
    // is `--mk-twin-bleed` (Latin .14em, Hebrew .22em); the FACE's is
    // `--mk-face-bleed`, published per display register by
    // `clientVisualSystemCss`. They are independent reasons for the same
    // padding — Oswald overshoots 0.22em where Fraunces overshoots 0.10em —
    // so the rule takes whichever is LARGER rather than whichever sheet
    // happened to land last. Before that, a `condensed` client's cover,
    // statement plate and closer all reported `probe.overflow` and clause B
    // refused them as `clipped` on every attempt.
    expect(body).toMatch(/:has\(> span\.mk-plain\) \{ padding-block-start: max\(var\(--mk-twin-bleed, \.22em\), var\(--mk-face-bleed, 0em\)\); \}/);
    // Latin and Hebrew carry DIFFERENT bleeds, because Heebo and Assistant
    // overshoot 0.1926em where Fraunces overshoots 0.0865em. A property, not
    // a second selector, so the sheet never has to out-specify the identical
    // rule each bundled template carries for the no-sheet case.
    expect(body).toContain("--mk-twin-bleed: .14em;");
    expect(declarations(hebrew)).toContain("--mk-twin-bleed: .22em;");
    // THE FALLBACK IS THE HEBREW VALUE, not the Latin one. A document composed
    // WITHOUT this sheet — `bidi-isolation.test.ts` renders a Hebrew cover
    // through the script-font head alone — cannot know its own script, so the
    // fallback has to be safe for the worse case. It is what that test caught.
    const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "templates", "default");
    for (const file of ["cover.html", "slide.html", "closer.html", "headline-focus.html", "list-takeaway.html", "quote-card.html"]) {
      const template = readFileSync(path.join(templates, file), "utf8");
      expect(template, `${file}'s own twin-bleed rule`).toContain(":has(> span.mk-plain) { padding-block-start: max(var(--mk-twin-bleed, .22em), var(--mk-face-bleed, 0em)); }");
    }
    // And `clone` — the reason the inline pair could never be made safe — is
    // still here, because losing it is what the pair was protecting against.
    expect(body).toContain("box-decoration-break: clone");
  });

  /**
   * A GRADIENT ANGLE IS A PHYSICAL DIRECTION, and the scan above cannot see
   * one. `.mk-k-ink` shipped `linear-gradient(100deg, …)`: a `deg` angle does
   * not mirror under `dir="rtl"`, so on a Hebrew run every glyph-fill mark
   * ramped in the LATIN reading direction — on the one kind the bundled
   * `#17181C` ground is forced onto, because `markKindsFor` refuses `block`
   * there. The block's own header claimed "`dir="rtl"` mirrors every mark on
   * its own", which was false for exactly this rule.
   *
   * So: the only literal angle allowed anywhere in the sheet is the
   * `--mk-ink-angle` property itself, declared twice — once on `:root` and
   * once under `[dir="rtl"]`. Every consumer reads the variable.
   */
  it("has no physical gradient ANGLE outside --mk-ink-angle, and flips that one under rtl", () => {
    const body = declarations(latin);
    const angles = [...body.matchAll(/[-\d.]+deg/g)].map((m) => m[0]);
    expect(angles, "every literal angle must be an --mk-ink-angle declaration").toEqual(["100deg", "260deg"]);
    expect(body).toMatch(/:root\s*\{[^}]*--mk-ink-angle:\s*100deg/s);
    expect(body).toMatch(/\[dir="rtl"\]\s*\{\s*--mk-ink-angle:\s*260deg/);
    // 260 is 100 reflected about the vertical axis — the same ramp, read the
    // other way. Asserted as arithmetic so a typo'd flip fails here.
    expect(360 - 100).toBe(260);
    expect(body).toContain("linear-gradient(var(--mk-ink-angle)");
    // And the Hebrew sheet inherits the same flip rather than restating it.
    expect([...declarations(hebrew).matchAll(/[-\d.]+deg/g)].map((m) => m[0])).toEqual(["100deg", "260deg"]);
  });

  /**
   * WHERE THE BAND SITS, NOT JUST THAT IT PAINTS.
   *
   * Nothing measured mark POSITION before this. The band sweep asserts `if
   * (runs > 0) expect(painted).toBe(runs)` and never asks where the band
   * landed, so `--mk-swish-y: .78em` shipped a marker stroke that ran
   * [.78em, .98em] from the inline content-box top — ENDING at the baseline
   * and covering the bottom fifth of the letterforms. On the cover and the
   * closer it read as a smear THROUGH the type. In the rendered PNG the
   * yellow band occupied y=1776..1808 while the line's ink ran y=1684..1809:
   * zero mark pixels below the baseline.
   *
   * THE BASELINE IS A MEASURED FACT, not the 1em the old `:root` comment
   * assumed. Every `--mk-*-y` is an offset from the inline box's CONTENT-BOX
   * top (`background-origin: content-box`), and that box is the font's
   * ascent+descent. Measured in Chromium with the real webfonts loaded, on
   * cover/headline-focus/closer/slide, Latin and Hebrew: the content area is
   * 1.225-1.242em and the baseline sits 0.975-0.985em down it. 0.975 is the
   * conservative end and is what this test uses.
   *
   * The assertion is on the band's CENTRE rather than its top edge, because a
   * marker stroke is allowed to kiss the bottom of the glyphs — that is what
   * a marker does — but its weight must be BELOW them. At .78em the centre
   * was .88em, a tenth of an em ABOVE the baseline, and this test refuses it.
   */
  it("puts the swish's weight BELOW the measured baseline, not through the glyphs", () => {
    const body = declarations(latin);
    const swishY = Number(/--mk-swish-y:\s*([\d.]+)em/.exec(body)?.[1]);
    const bandH = Number(/\.mk-k-swish\s*\{[^}]*background-size:\s*[\d.]+%\s+([\d.]+)em/s.exec(body)?.[1]);
    expect(Number.isFinite(swishY), "could not read --mk-swish-y out of the sheet").toBe(true);
    expect(Number.isFinite(bandH), "could not read the swish band height out of the sheet").toBe(true);

    /** Measured, Chromium, real webfonts: the baseline's distance below the inline content-box top. */
    const BASELINE_EM = 0.975;
    const centre = swishY + bandH / 2;
    expect(centre, `the swish band's centre sits at ${centre}em, at or above the ${BASELINE_EM}em baseline — it is painting through the type`).toBeGreaterThan(
      BASELINE_EM,
    );
    // BREAK IT: the shipped value, refused.
    expect(0.78 + bandH / 2).toBeLessThan(BASELINE_EM);
    // And the band must still fit inside the content box, or it is clipped
    // away rather than drawn: 1.225em is the SHALLOWEST content area measured.
    expect(swishY + bandH, "the swish band runs past the inline content box and would not paint").toBeLessThanOrEqual(1.225);
  });

  /**
   * The Hebrew sheet must not restate a baseline-relative constant. It carried
   * `--mk-swish-y: .82em`, a second wrong value for the same reason as the
   * Latin `.78em`, and a second copy of a number is a second place to be
   * wrong. Only the BLOCK swatch — which is sized to the letter body, and
   * Hebrew's really is different — is overridden.
   */
  it("does not restate the baseline-relative constants for Hebrew", () => {
    const body = declarations(hebrew);
    expect(body).toContain("--mk-block-h: .44em");
    expect(body).toContain("--mk-block-y: .60em");
    expect(body).not.toMatch(/--mk-swish-y:[^;]*;[\s\S]*--mk-swish-y:/);
    expect((body.match(/--mk-swish-y:/g) ?? []).length, "Hebrew restates --mk-swish-y").toBe(1);
    expect((body.match(/--mk-rule-y:/g) ?? []).length, "Hebrew restates --mk-rule-y").toBe(1);
  });

  it("sizes everything in `em` or a variable, never in px — so --ts scales the mark for free", () => {
    const body = declarations(latin);
    expect(body).not.toMatch(/\d\s*px/);
    expect(body).toMatch(/background-size:\s*[^;]*\.\d+em/);
  });

  it("uses text-decoration ONLY for the two rules, placed from the baseline, with skip-ink off (2026-09-23)", () => {
    // The rules were background bands at a fixed offset below the inline box's
    // top, and on Geektime's Inter + Heebo stack (prep pubsub-21770129683022110)
    // that offset put the underline through the Hebrew letters: it read as a
    // strikethrough. A decoration is placed from the baseline in every face.
    // Skip-ink is OFF because it differs across scripts, which was the old
    // guard's reason; the swish, block and ink still cannot be a decoration.
    const ruleFor = (kind: string) => {
      const rule = latin.slice(latin.indexOf(`.mk-k-${kind} {`));
      return rule.slice(0, rule.indexOf("}"));
    };
    for (const kind of MARK_KINDS) {
      if (kind === "underline" || kind === "double") {
        expect(ruleFor(kind), kind).toContain("text-decoration-line: underline");
        expect(ruleFor(kind), kind).toContain("text-decoration-skip-ink: none");
        expect(ruleFor(kind), kind).toContain("text-underline-offset:");
        expect(ruleFor(kind), kind).not.toContain("--mk-rule-y");
      } else {
        expect(ruleFor(kind), kind).not.toContain("text-decoration");
      }
    }
  });

  it("never emits an inline style attribute — assertSafeMarkup refuses it, correctly", () => {
    expect(latin).not.toContain("style=");
    expect(buildMarkedRuns([{ text: "x", mark: { ordinal: 0, colourIndex: 0, kind: "ink" } }], "ltr")).not.toContain("style=");
  });

  it("emits all five kind classes and all six colour classes", () => {
    for (const kind of MARK_KINDS) expect(latin).toContain(`.mk-k-${kind}`);
    for (let i = 1; i <= MARK_RING_MAX; i++) expect(latin).toContain(`.mk-c${i}`);
    expect(latin).toContain("box-decoration-break: clone");
  });

  it("declares the wrapper class, so a `.mk-t` run has a rule to match even though it paints nothing", () => {
    expect(latin).toContain(".mk-t");
  });

  it("gives every kind a limb the probe reads as `painted`: a background image, or (the two rules) an underline decoration", () => {
    for (const kind of MARK_KINDS) {
      const rule = latin.slice(latin.indexOf(`.mk-k-${kind}`));
      const body = rule.slice(0, rule.indexOf("}"));
      expect(body, kind).toContain(kind === "underline" || kind === "double" ? "text-decoration-line: underline" : "background-image:");
    }
  });

  /**
   * Hebrew has no ascenders and a full-height letter body, so a Latin block at
   * .50em/.56em covers the glyphs rather than sitting under them.
   *
   * BREAK IT: return the same string for both scripts. Hebrew then ships a
   * swatch over the top of its own type.
   */
  it("sets BOTH block variables on the Hebrew branch, and differs from the Latin one", () => {
    expect(hebrew).toContain("--mk-block-h: .44em");
    expect(hebrew).toContain("--mk-block-y: .60em");
    expect(latin).toContain("--mk-block-h: .50em");
    expect(hebrew).not.toBe(latin);
    // Hebrew keeps ALL FIVE kinds — first-class, not degraded.
    for (const kind of MARK_KINDS) expect(hebrew).toContain(`.mk-k-${kind}`);
  });

  it("carries the ring's own CSS values into the colour classes", () => {
    ring.cssValues.forEach((value, i) => expect(latin).toContain(`.mk-c${i + 1} { --mk-c: ${value}; }`));
  });

  it("is well-formed with no ring at all — braces balance and nothing is left undefined", () => {
    const bare = markCssBlock(undefined, undefined);
    expect(bare).not.toContain("undefined");
    expect((bare.match(/\{/g) ?? []).length).toBe((bare.match(/\}/g) ?? []).length);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Reporting — facts, never findings
// ─────────────────────────────────────────────────────────────────────────

describe("collectEmphasisIssues — it reports, and that is ALL it does", () => {
  it("turns per-slide drops and ring notes into flat facts", () => {
    const issues = collectEmphasisIssues([{ slide: 3, drops: [{ field: "body", text: "gone", reason: "the span does not occur" }] }], ["the kit offered 1 separable hue"]);
    expect(issues).toEqual([
      { slide: 0, field: "ring", text: "", reason: "the kit offered 1 separable hue" },
      { slide: 3, field: "body", text: "gone", reason: "the span does not occur" },
    ]);
  });

  it("is empty when nothing went wrong, and never throws on an empty run", () => {
    expect(collectEmphasisIssues([])).toEqual([]);
    expect(collectEmphasisIssues([{ slide: 1, drops: [] }])).toEqual([]);
  });

  /**
   * A source pin on the posture, not just the data. This module must contain
   * no way to fail: a mark is FURNITURE, and a redraft loop over furniture
   * would spend the whole self-check budget on a slide whose copy was fine.
   *
   * BREAK IT: add a `throw new Error(...)` anywhere in emphasis-marks.ts.
   */
  it("the whole module can neither throw nor hold: no `throw` and no finding anywhere in its source", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "workflow", "emphasis-marks.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bthrow\b/);
    expect(code).not.toMatch(/\bfindings?\.push\b/);
    expect(code).not.toMatch(/WorkflowHeld/);
  });
});
