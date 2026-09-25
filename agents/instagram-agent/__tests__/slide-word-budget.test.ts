import { describe, expect, it } from "vitest";
import type { RenderCarouselInput } from "@agent-engine/tool-karos-publish";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import {
  MAX_WORDS_PER_BLOCK,
  MAX_WORDS_PER_SLIDE,
  MAX_WORDS_PER_SLIDE_TOTAL,
  TARGET_WORDS_PER_SLIDE,
  checkSlideWordBudget,
  countWords,
  slideWordLoad,
} from "../src/workflow/slide-word-budget.js";
import type { ImageSelection, InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";
import { goodCopyOutput } from "./test-helpers.js";

/**
 * # THE WORD BUDGET
 *
 * The module's header carries the argument. What this file has to hold is the
 * half that argument depends on and that nothing else in the suite checks:
 * **that the count is taken on what RENDERS.**
 *
 * `contentFor` emits a different set of text fields per archetype, and two of
 * them never render the copy's `headline`/`body` pair at all. The schema
 * requires both on every slide, so a `quote_card` carries a headline and a body
 * nobody will ever see. A budget counted on the copy object would charge that
 * slide for words that are not on the plate, refuse it, and send the writer to
 * cut copy that was never the problem. Every case below is built through
 * `assembleSlidesData` — the same function `07c-emit-slides-data` calls — for
 * exactly that reason.
 */

const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 };
const BRAND_TOKENS = { templateDir: "fixtures/templates", slideTemplate: "slide.html" };

type SlideOverride = Partial<InstagramSlideCopy>;

function copyWith(overrides: SlideOverride[]): { copy: InstagramCopyOutput; selections: ImageSelection[] } {
  const slides = overrides.map((o, i) => ({
    n: i + 1,
    headline: `Finding ${i + 1}`,
    body: `A plain sentence about finding ${i + 1}.`,
    visualNeed: `need ${i + 1}`,
    sourceRef: `claim ${i + 1}`,
    layout: "photo" as const,
    ...o,
  }));
  const selections: ImageSelection[] = overrides.map((_o, i) => ({
    n: i + 1,
    imagePath: null,
    reason: "fixture",
    license: "CC0",
    rightsUsable: true,
    watermarkFree: true,
    claimMatch: 5,
    claimMatchReason: "fixture",
  }));
  return { copy: { format: "carousel", caption: "A caption.", slides }, selections };
}

function assemble(copy: InstagramCopyOutput, selections: ImageSelection[]): RenderCarouselInput {
  return assembleSlidesData({ clientSlug: "acme", postId: "post_wb", repoRoot: "/repo", brandTokens: BRAND_TOKENS, copy, selections, canvas: CANVAS });
}

/** The findings for one carousel, assembled the way the workflow assembles it. */
function check(overrides: SlideOverride[]) {
  const { copy, selections } = copyWith(overrides);
  return checkSlideWordBudget(assemble(copy, selections), copy);
}

/** N words of filler, so a fixture's LENGTH is exact and a reader can see it is the point. */
const filler = (n: number): string => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(" ");

describe("countWords", () => {
  it("counts a word once however it is punctuated, and counts Hebrew the same as Latin", () => {
    expect(countWords("Three simple words")).toBe(3);
    // A trailing stop is not a word; a hyphenated compound and a figure with a
    // unit are each one. All three of these used to be two under a whitespace
    // split, which would have made the limit mean something different per
    // sentence.
    expect(countWords("Ship it.")).toBe(2);
    expect(countWords("state-of-the-art")).toBe(1);
    // A decimal is one figure and so one word; the comma that ENDS a word
    // still ends it. Both halves come from the same digit lookahead.
    expect(countWords("4.2x faster, 30% cheaper")).toBe(4);
    expect(countWords("1,200 teams")).toBe(2);
    expect(countWords("B2B")).toBe(1);
    // Hebrew is space-separated like Latin, so one rule covers both scripts.
    // This is the client roster's actual second language, not a hypothetical.
    expect(countWords("שלוש מילים בעברית")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
  });
});

describe("checkSlideWordBudget: the statement", () => {
  it("PASSES the canonical good copy, so this gate can be passed at all", () => {
    // The guard-that-cannot-fail check, run in the direction that matters
    // first. `goodCopyOutput()` is the suite's exemplary draft and four of its
    // six slides were 31 to 33 words when this landed; they were trimmed rather
    // than the limit raised. If a later edit pushes one back over, this fails
    // here rather than in production.
    const copy = goodCopyOutput();
    const selections: ImageSelection[] = copy.slides.map((s) => ({
      n: s.n, imagePath: null, reason: "fixture", license: "CC0", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "fixture",
    }));
    expect(checkSlideWordBudget(assemble(copy, selections), copy)).toEqual([]);
  });

  it("refuses a slide over the limit and tells the writer where the words go instead", () => {
    const findings = check([{}, { headline: filler(10), body: filler(21) }, {}]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.slide).toBe(2);
    expect(findings[0]!.measured).toEqual({ words: 31, limit: MAX_WORDS_PER_SLIDE, scope: "statement" });
    // The remedy is the owner's own and it is the one that keeps the
    // information in the post rather than deleting it.
    expect(findings[0]!.reason).toMatch(/move the rest of the detail into the caption/u);
    expect(findings[0]!.reason).toContain(`aim for about ${TARGET_WORDS_PER_SLIDE}`);
    // And it says WHY, because "too long" is not a reason a writer can weigh
    // against a sentence they think is worth keeping.
    expect(findings[0]!.reason).toMatch(/set smaller to fit/u);
  });

  it("is a ceiling and not a target: exactly at the limit passes, one over does not", () => {
    // The boundary in both directions, because an off-by-one here is a gate
    // that refuses every compliant draft or one that never refuses anything.
    expect(check([{ headline: filler(10), body: filler(20) }])).toEqual([]);
    expect(check([{ headline: filler(10), body: filler(21) }])).toHaveLength(1);
    // And nothing has a floor: a six-word headline over a photograph is a good
    // slide, not an underfilled one. The interest floor answers emptiness, on
    // pixels.
    expect(check([{ headline: "Stop", body: "Now." }])).toEqual([]);
  });

  it("counts the kicker, because it is words on the plate", () => {
    const findings = check([{ headline: filler(10), body: filler(19), kicker: filler(2) }]);
    expect(findings[0]!.measured.words).toBe(31);
  });

  it("reports one finding per slide, and every offending slide", () => {
    const findings = check([{ body: filler(40) }, {}, { body: filler(40) }]);
    expect(findings.map((f) => f.slide)).toEqual([1, 3]);
  });
});

describe("checkSlideWordBudget: what each archetype actually renders", () => {
  it("counts a quote card on its QUOTE, not on the headline and body nobody sees", () => {
    // `contentFor`'s `quote_card` case emits `quoteText` and `attribution` and
    // nothing else. The headline and body below are 40 words of copy the
    // schema requires and the template drops on the floor; charging the slide
    // for them would refuse a perfectly short plate.
    const short = check([
      { layout: "quote_card", headline: filler(20), body: filler(20), quote: { text: filler(12), attribution: "A named person, 2026" } },
    ]);
    expect(short, "the unrendered headline and body were counted").toEqual([]);

    // And the quote itself IS counted, so the archetype is not a way around
    // the limit.
    const long = check([
      { layout: "quote_card", headline: "Short", body: "Short.", quote: { text: filler(40), attribution: "A named person, 2026" } },
    ]);
    expect(long).toHaveLength(1);
    expect(long[0]!.measured.scope).toBe("statement");
  });

  it("counts a list on its ROWS, one at a time, because a reader takes a row in at a glance", () => {
    // ── THE SUM IS NOW ALSO A MEASUREMENT, AND THE PROMPT MOVED WITH IT. ──
    //
    // This used to assert that four rows of 15 words passed, on the grounds
    // that prompt §7 invited two to four items each with a note and charging
    // the sum would refuse a compliant draft. The reasoning was sound and the
    // premise stopped being true: the owner read a shipped plate with four
    // rows and four notes, about a hundred words, and said *"a lot of copy on
    // one page is not good either, regardless of small type"*.
    //
    // So `MAX_WORDS_PER_SLIDE_TOTAL` exists and `instagram-copy@26` §7 asks
    // for three rows with notes, or four with short ones. A compliant draft
    // still passes; this fixture is no longer one, so it is the SHORT four-row
    // shape now, which is the version §7 invites.
    const spread = check([
      {
        layout: "list_takeaway",
        // 2026-09-25: four rows inside the 35-word lane (decision 20).
        items: [
          { title: filler(4), note: filler(4) },
          { title: filler(4), note: filler(4) },
          { title: filler(4), note: filler(4) },
          { title: filler(4), note: filler(4) },
        ],
      },
    ]);
    expect(spread).toEqual([]);

    // One row over the block limit fails, and the finding names the row.
    const fat = check([
      {
        layout: "list_takeaway",
        items: [
          { title: filler(3), note: filler(3) },
          { title: filler(10), note: filler(11) },
        ],
      },
    ]);
    expect(fat).toHaveLength(1);
    expect(fat[0]!.measured).toEqual({ words: 21, limit: MAX_WORDS_PER_BLOCK, scope: "list row 2" });
    expect(fat[0]!.reason).toMatch(/a phrase, not a sentence/u);
  });

  it("counts a comparison one COLUMN at a time, for the same reason", () => {
    const even = check([
      {
        layout: "comparison_card",
        headline: "Before and after",
        body: "What changed.",
        comparison: { leftLabel: filler(2), leftBody: filler(12), rightLabel: filler(2), rightBody: filler(12) },
      },
    ]);
    expect(even).toEqual([]);

    const lopsided = check([
      {
        layout: "comparison_card",
        headline: "Before and after",
        body: "What changed.",
        comparison: { leftLabel: filler(2), leftBody: filler(3), rightLabel: filler(2), rightBody: filler(19) },
      },
    ]);
    expect(lopsided).toHaveLength(1);
    expect(lopsided[0]!.measured).toEqual({ words: 21, limit: MAX_WORDS_PER_BLOCK, scope: "right column" });
  });

  it("NEVER charges a slide for its own citation, because that would push the archetype toward dropping it", () => {
    // `sourceLine` and `figure` are exempt. A `stat_callout` whose source is a
    // long attribution must not be refused for citing properly: prompt §7 makes
    // the source mandatory precisely because "a large unattributed number is
    // exactly the kind of claim a reader should distrust", and a gate that
    // charged for it would pull the other way.
    const findings = check([
      {
        layout: "stat_callout",
        body: filler(25),
        stat: { figure: "73%", subLabel: filler(4), source: "The Annual Industry Benchmark Report, published by a named research institute, 2026" },
      },
    ]);
    expect(findings).toEqual([]);

    // The figure is exempt too, and it has to be: it is one glyph group set at
    // 200px however many characters it holds.
    //
    // TWO, and the number is worth reading slowly, because it is this file's
    // whole thesis in one assertion. The copy below carries a headline, a body,
    // a figure, a sub-label and a source: five fields. contentFor's stat_callout
    // case renders figure, subLabel, body and sourceLine and DOES NOT RENDER THE
    // HEADLINE AT ALL; then figure and sourceLine are exempt. So what a reader
    // reads is subLabel and body: two words. Counted on the copy object this
    // slide would have measured five.
    const stat = copyWith([{ layout: "stat_callout", headline: "Headline", body: "Body.", stat: { figure: "4.2x", subLabel: "faster", source: "a named source" } }]);
    const load = slideWordLoad(assemble(stat.copy, stat.selections).slides[0]!, stat.copy.slides[0]);
    expect(load.statement, "the headline, the figure or the source line was counted").toBe(2);
  });
});

describe("slideWordLoad", () => {
  it("separates the statement from the blocks, so the ledger can print what was measured", () => {
    const { copy, selections } = copyWith([
      {
        layout: "comparison_card",
        headline: filler(4),
        body: filler(6),
        comparison: { leftLabel: filler(1), leftBody: filler(4), rightLabel: filler(1), rightBody: filler(4) },
      },
    ]);
    const load = slideWordLoad(assemble(copy, selections).slides[0]!, copy.slides[0]);
    expect(load.statement).toBe(10);
    expect(load.blocks).toEqual([
      { label: "left column", words: 5 },
      { label: "right column", words: 5 },
    ]);
    expect(load.total).toBe(20);
  });
});

/**
 * # THE PLATE THAT WAS LEGAL PART BY PART
 *
 * Slide 4 of the Karos carousel of 2026-09-19: a headline and four items each
 * with a two or three line note. Every block under 20, the statement under 30,
 * the pixel gate passed it, about a hundred words on the plate.
 *
 * The owner, twice: *"there are slides with too much copy for one slide"*, and
 * then, after type size was raised separately, *"a lot of copy on one page is
 * not good either, regardless of small type"*.
 */
describe("the 35-word lane and the photo cover (decision 20, 2026-09-25)", () => {
  it("refuses the old 57-word three-row plate", () => {
    const old = check([
      {
        layout: "list_takeaway",
        headline: filler(6),
        items: [
          { title: filler(5), note: filler(12) },
          { title: filler(5), note: filler(12) },
          { title: filler(5), note: filler(12) },
        ],
      },
    ]);
    expect(old.map((f) => f.measured)).toContainEqual({ words: 57, limit: 35, scope: "slide-total" });
  });
});

describe("MAX_WORDS_PER_SLIDE_TOTAL", () => {
  it("refuses the shipped plate, and says what it measured", () => {
    const shipped = check([
      {
        layout: "list_takeaway",
        headline: "What attribution misses by design",
        items: [
          { title: filler(3), note: filler(20) },
          { title: filler(6), note: filler(21) },
          { title: filler(5), note: filler(17) },
          { title: filler(5), note: filler(18) },
        ],
      },
    ]);
    expect(shipped).toHaveLength(1);
    expect(shipped[0]!.measured.scope).toBe("slide-total");
    expect(shipped[0]!.measured.limit).toBe(MAX_WORDS_PER_SLIDE_TOTAL);
    expect(shipped[0]!.measured.words).toBeGreaterThan(90);
    expect(shipped[0]!.reason).toMatch(/together they are a page/);
  });

  it("admits the three-row shape prompt §7 now asks for", () => {
    // 2026-09-25 (decision 20, the 35-word lane): a five-word headline and
    // three rows of a four-word title and a six-word note: 35. The old
    // 57-word shape (6 + 3 x (5 + 12)) is exactly what the lane now refuses.
    expect(
      check([
        {
          layout: "list_takeaway",
          headline: filler(5),
          items: [
            { title: filler(4), note: filler(6) },
            { title: filler(4), note: filler(6) },
            { title: filler(4), note: filler(6) },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("does NOT count rows, because four short rows read perfectly well", () => {
    // The defect is volume, not count. A count rule would refuse the good
    // version of the same plate.
    expect(
      check([
        {
          layout: "list_takeaway",
          headline: filler(5),
          items: [
            { title: filler(4), note: filler(3) },
            { title: filler(4), note: filler(3) },
            { title: filler(4), note: filler(3) },
            { title: filler(4), note: filler(3) },
          ],
        },
      ]),
    ).toEqual([]);
  });
});
