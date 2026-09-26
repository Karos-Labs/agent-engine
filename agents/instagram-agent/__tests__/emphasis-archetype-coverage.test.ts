import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMarkRing } from "../src/workflow/emphasis-marks.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import { InstagramSlideCopySchema, type InstagramCopyOutput, type InstagramSlideCopy } from "../src/workflow/types.js";
import type { EmphasisIssue } from "../src/workflow/emphasis-marks.js";
import type { ImageSelection } from "../src/workflow/types.js";

/**
 * RFC-17 — DOES EVERY ARCHETYPE A MARK CAN BE DECLARED ON ACTUALLY PAINT IT?
 *
 * ── WHY THIS FILE EXISTS, SEPARATELY FROM THE OTHER FOUR MARK SUITES ─────
 *
 * The mark system has two reporting channels and, on two archetypes, BOTH are
 * blind at once.
 *
 *  - `collectEmphasisIssues` reports what the RESOLVER refused. It only ever
 *    sees a span the resolver was asked about.
 *  - `marks-missing` / `marks-not-visible` (`interest-floor.ts`) report what
 *    the RENDERER failed to paint. Both deliberately abstain when the probe
 *    finds `markRuns === 0`, because a document with no mark spans is the
 *    normal unmarked case and firing there would refuse every plain slide.
 *
 * A span that is claimed by a field, and then never handed to the resolver
 * because its archetype emits no runs slot for that field, falls exactly
 * between them: the resolver was never asked, so nothing is refused; and no
 * `.mk-runs` span reaches the DOM, so the pixel side abstains. The model
 * declared it, the run paid output tokens for it, `marksAccepted` did not
 * count it, and NOTHING anywhere says so.
 *
 * `template-mark-slots.test.ts` cannot see this. Its guard compares the names
 * `slides-data.ts` EMITS against the slots a template DECLARES — a fragment
 * that is never emitted at all is not in either set.
 *
 * ── THE SCOPE OF THE GAP, MEASURED ───────────────────────────────────────
 *
 * `stat_callout` and `comparison_card` are the two archetypes RFC-17 leaves
 * deliberately unmarked, and `contentFor` returns `htmlFragments: {}` for
 * both. But `markFieldsInReadingOrder` (`slides-data.ts`) is built from the
 * COPY, not from the layout, and so always contains `headline` and `body`.
 * And §28 of `instagram-copy@18` tells the model, with no archetype
 * exception, that `emphasis` may be carried by "a slide" and is searched
 * across "the headline, then the body, then the quote, then the list rows".
 *
 * So a model following the shipped prompt exactly, on a `stat_callout`, marks
 * a phrase out of its own headline and loses it silently. That is a contract
 * mismatch between the prompt and the renderer, not a fixture detail.
 *
 * ── THE GAP IS NOW CLOSED, AND THIS IS WHICH WAY IT WAS CLOSED ───────────
 *
 * The integrator left this file pinning the gap as an equality and named
 * three options. The one taken is the third, deliberately:
 *
 *  (a) RENDERER-SIDE (twin slots on both templates): REJECTED. It moves
 *      rendered pixels on two archetypes while the interest floor is under
 *      live Chromium calibration, and RFC-17 leaves them unmarked on purpose
 *      — their content is a figure and two labels, not clauses.
 *  (b) PROMPT-SIDE (one sentence in §28): REJECTED on cost. It is a prompt
 *      bump — the five-step checklist, the registry, and a re-measure of
 *      `EMPHASIS_CHAR_DELTA` and the `copyAttempt` key, which sits $0.0017
 *      under the rung that costs a cold Hebrew run a whole drafting attempt.
 *      A trace note is not worth a real chance of a $0.18 re-draft.
 *  (c) REPORT IT through `collectEmphasisIssues` — TAKEN. That channel never
 *      gates, by its own contract, so the cost is zero dollars and zero
 *      refusals, and the writer is told where their mark went instead of the
 *      mark evaporating with every instrument saying it was fine.
 *
 * TWO changes in `slides-data.ts` implement it, and both are asserted below:
 *
 *  1. `UNMARKED_LAYOUTS` — a span claimed on either archetype now records a
 *     drop naming the archetype and why it paints nothing.
 *  2. `markFieldsInReadingOrder` grew `stat.subLabel`,
 *     `comparison.leftBody` and `comparison.rightBody`. Those are rendered
 *     prose; leaving them out of the search is what produced the second,
 *     WORSE defect — a span verbatim in them was reported as not appearing
 *     "on this slide", advising the writer to do what they had already done.
 *     `stat.figure` and the two column LABELS stay out: a bare numeral in a
 *     lockup and a one-word heading are furniture, not clauses.
 *
 * What did NOT change: neither archetype paints a mark, and neither template
 * grew a slot. The loss is the same; it is now REPORTED.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEMPLATE_DIR = "agents/instagram-agent/assets/templates/default";
const GROUND = "#17181C";
const FOREGROUND = "#F4F2EC";
const ACCENT = "#C4552F";
const RING = ["#E8C547", "#9BE6E0", "#D9BFF2", "#5BD1A0"];

const ALL_TEMPLATES = new Set([
  "cover.html",
  "closer.html",
  "stat-callout.html",
  "quote-card.html",
  "comparison-card.html",
  "list-takeaway.html",
  "headline-focus.html",
  "slide.html",
]);

/** One slide of copy, through the REAL schema so a fixture cannot declare a shape a run could not produce. */
function slide(over: Record<string, unknown>): InstagramSlideCopy {
  return InstagramSlideCopySchema.parse({ visualNeed: "a plain need", sourceRef: "a sourced claim", ...over });
}

const selection = (n: number): ImageSelection => ({
  n,
  imagePath: null,
  reason: "no candidate qualified",
  license: "CC0",
  rightsUsable: true,
  watermarkFree: true,
  claimMatch: 5,
  claimMatchReason: "matches",
});

/** Drives the REAL assembler with the REAL mark ring, and reports both channels. */
function assemble(slides: InstagramSlideCopy[]): {
  runsBySlide: Map<number, string[]>;
  marksBySlide: Map<number, number>;
  issues: EmphasisIssue[];
} {
  const markRing = buildMarkRing({ brandAccent: ACCENT, palette: RING }, GROUND, FOREGROUND, []);
  // The premise every assertion below rests on: the mark system is RUNNING.
  // With no ring, `contentFor` emits no runs slot on ANY archetype and every
  // "silently lost" assertion in this file would pass while measuring nothing.
  //
  // NOTE FOR ANYONE BREAKING THIS ON PURPOSE: passing `markRing: undefined`
  // does NOT turn marking off. `assembleSlidesData` DERIVES its own ring from
  // `accentRing` + `groundHex` + `foregroundHex` when none is handed to it
  // (`slides-data.ts:1816`), so the param is unreachable-as-undefined whenever
  // the ground pair is supplied. The break that actually disarms the mark
  // system is dropping `groundHex`/`foregroundHex`; that was measured, and it
  // is what makes the control case below refuse.
  expect(markRing, "no mark ring was derived — every assertion below would be vacuous").toBeDefined();

  const markReportOut = { hexesBySlide: new Map<number, string[]>(), issues: [] as EmphasisIssue[] };
  const assembled = assembleSlidesData({
    clientSlug: "coverage",
    postId: "emphasis-archetype-coverage",
    repoRoot: REPO_ROOT,
    brandTokens: { templateDir: TEMPLATE_DIR, slideTemplate: "slide.html", accentColor: ACCENT },
    copy: { format: "carousel", caption: "A caption.", slides } as InstagramCopyOutput,
    selections: slides.map((s) => selection(s.n)),
    canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
    availableTemplates: ALL_TEMPLATES,
    templateDirOverride: TEMPLATE_DIR,
    accentRing: RING,
    paletteSeed: "emphasis-archetype-coverage",
    groundHex: GROUND,
    foregroundHex: FOREGROUND,
    markRing,
    markReportOut,
  } as Parameters<typeof assembleSlidesData>[0]);

  const runsBySlide = new Map<number, string[]>();
  const marksBySlide = new Map<number, number>();
  for (const rendered of assembled.slides) {
    const fragments = Object.entries(rendered.htmlFragments ?? {});
    runsBySlide.set(
      rendered.n,
      fragments.filter(([name]) => name.endsWith("Runs")).map(([name]) => name).sort(),
    );
    // Every painted mark on the slide, wherever it landed — the `*Runs`
    // fragments AND the row marks `buildListRows` inlines into `itemRows`.
    marksBySlide.set(
      rendered.n,
      fragments.reduce((total, [, value]) => total + (String(value).match(/class="mk[ "]/g) ?? []).length, 0),
    );
  }
  return { runsBySlide, marksBySlide, issues: markReportOut.issues };
}

describe("RFC-17: a mark declared on a markable archetype reaches a slot", () => {
  /**
   * The CONTROL, and the reason this file is not one long complaint: on the
   * six archetypes RFC-17 does mark, a span copied verbatim out of the
   * headline lands, and NOTHING is reported as a drop.
   *
   * This also verifies the instrument. If `assemble` were silently producing
   * no marks at all — the exact failure that cost a green-but-empty Chromium
   * test earlier in this phase — every "silently lost" assertion below would
   * pass for the wrong reason. This case is what makes them mean something.
   */
  it("lands on all six markable archetypes, and reports nothing", () => {
    const slides = [
      slide({ n: 1, layout: "cover", headline: "Most content calendars stall in the second month", body: "The first month runs on enthusiasm and the second runs on the process you built.", kicker: "THE SHIFT", emphasis: ["stall"] }),
      slide({ n: 2, layout: "headline_focus", headline: "Most content calendars stall in the second month", body: "The first month runs on enthusiasm and the second runs on the process you built.", emphasis: ["stall"] }),
      slide({ n: 3, layout: "text_only", headline: "Most content calendars stall in the second month", body: "The first month runs on enthusiasm and the second runs on the process you built.", emphasis: ["stall"] }),
      slide({ n: 4, layout: "quote_card", headline: "A founder said it plainly", body: "The quote is the slide and the attribution is the proof.", quote: { text: "Process is the only thing that survives the second month.", attribution: "A founder" }, emphasis: ["survives"] }),
      slide({
        n: 5,
        layout: "list_takeaway",
        headline: "Four terms every founder should know before month two",
        body: "Each one is a number you can check this afternoon without asking anybody.",
        items: [
          { title: "Runway is the months of cash you have left", note: "At today's burn, not last quarter's." },
          { title: "Burn multiple is cash spent per dollar earned", note: "Under two is healthy for most teams." },
        ],
        emphasis: ["founder"],
      }),
      slide({ n: 6, layout: "closer", headline: "That is the whole pattern", body: "Which review round would you cut first?", emphasis: ["pattern"] }), // 2026-09-26: never a body mark
    ];
    const { runsBySlide, marksBySlide, issues } = assemble(slides);

    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(runsBySlide.get(n), `slide ${n} emitted no runs slot`).not.toEqual([]);
      expect(marksBySlide.get(n), `slide ${n} emitted a runs slot carrying no mark`).toBeGreaterThan(0);
    }
    expect(issues, `a healthy six-slide carousel reported drops: ${JSON.stringify(issues)}`).toEqual([]);
  });

  /**
   * THE GAP, NOW CLOSED. Read the file header before changing this.
   *
   * Both slides declare a span that occurs VERBATIM, on a word boundary, in
   * their own headline — the first field of the documented search order. On
   * any other archetype that span paints. Here it is claimed by `headline`
   * and then `contentFor` never calls `markRuns` for the field, so the mark
   * still does not paint — that half is RFC-17's deliberate design and is
   * expected to stay true. What changed is that the loss now leaves a
   * record: one drop per claimed span, naming the archetype.
   */
  it("does not paint on stat_callout or comparison_card — and now SAYS SO, one drop per claimed span", () => {
    const slides = [
      slide({
        n: 1,
        layout: "stat_callout",
        headline: "Most content calendars stall in the second month of operation",
        body: "The first month runs on enthusiasm and the second runs on the process you actually built.",
        stat: { figure: "62%", subLabel: "of calendars stall in month two", source: "Internal queue audit, 2026" },
        emphasis: ["stall"],
      }),
      slide({
        n: 2,
        layout: "comparison_card",
        headline: "Enthusiasm versus process in the second month",
        body: "Only one of these survives contact with a genuinely busy week.",
        comparison: {
          leftLabel: "Month one",
          leftBody: "Runs on enthusiasm, and enthusiasm is not a process.",
          rightLabel: "Month two",
          rightBody: "Runs on whatever process you actually wrote down.",
        },
        emphasis: ["survives contact"],
      }),
      // THE IN-TEST CONTROL, in the SAME carousel, through the SAME assembler
      // call. Identical shape to slide 1 — a span lifted verbatim out of the
      // headline — differing only in `layout`. Without it, "no slot, no mark,
      // no drop" is equally true of a run where marking was never switched on
      // at all, and this test would pass for the wrong reason.
      slide({
        n: 3,
        layout: "headline_focus",
        headline: "Most content calendars stall in the second month of operation",
        body: "The first month runs on enthusiasm and the second runs on the process you actually built.",
        emphasis: ["stall"],
      }),
    ];
    const { runsBySlide, marksBySlide, issues } = assemble(slides);

    // The control marked, so the mark system IS running in this very call.
    expect(runsBySlide.get(3), "the control archetype emitted no runs slot — the mark system is off and this test is vacuous").not.toEqual([]);
    expect(marksBySlide.get(3), "the control archetype painted no mark — this test is vacuous").toBeGreaterThan(0);

    // No slot, and therefore no mark. This half IS the deliberate RFC-17
    // design and is expected to stay true even after the gap is closed
    // prompt-side.
    expect(runsBySlide.get(1)).toEqual([]);
    expect(runsBySlide.get(2)).toEqual([]);
    expect(marksBySlide.get(1)).toBe(0);
    expect(marksBySlide.get(2)).toBe(0);

    // And this is the half that changed. Two declared marks did not paint,
    // and both are now on the record with a reason that is TRUE: the
    // archetype paints no marks. The control slide contributes nothing —
    // its mark landed.
    expect(issues.map((i) => ({ slide: i.slide, field: i.field, text: i.text }))).toEqual([
      { slide: 1, field: "headline", text: "stall" },
      // Slide 2's span is in its BODY, not its headline — the search walks
      // reading order and reports the field that actually claimed it, which
      // is the whole point of naming a field at all.
      { slide: 2, field: "body", text: "survives contact" },
    ]);
    expect(issues[0]!.reason).toBe(
      'the "stat_callout" archetype paints no marks — its content is a figure and labels, not clauses, so this span renders as ordinary copy',
    );
    expect(issues[1]!.reason).toContain('the "comparison_card" archetype paints no marks');
    // The reason must NOT be the old falsehood: both spans are verbatim on
    // their slide, and telling a writer otherwise is worse than silence.
    for (const issue of issues) expect(issue.reason).not.toContain("does not appear on this slide");
  });

  /**
   * BREAK IT. The drop above has to come from the ARCHETYPE rule, not from
   * some incidental refusal that happens to fire on these two fixtures.
   *
   * Same two slides, same spans, one thing changed: the layout. Both become
   * `headline_focus`, which IS markable — and every drop disappears while the
   * marks appear. If `UNMARKED_LAYOUTS` were widened to cover everything, or
   * narrowed to cover nothing, exactly one of these two tests fails.
   */
  it("BREAK IT: the same spans on a markable layout paint and report nothing", () => {
    const { runsBySlide, marksBySlide, issues } = assemble([
      slide({
        n: 1,
        layout: "headline_focus",
        headline: "Most content calendars stall in the second month of operation",
        body: "The first month runs on enthusiasm and the second runs on the process you actually built.",
        emphasis: ["stall"],
      }),
      slide({
        n: 2,
        layout: "headline_focus",
        headline: "Enthusiasm versus process in the second month",
        body: "Only one of these survives contact with a genuinely busy week.",
        emphasis: ["versus process"], // 2026-09-26: a mark lives in the headline, never the body
      }),
    ]);
    for (const n of [1, 2]) {
      expect(runsBySlide.get(n), `slide ${n} emitted no runs slot`).not.toEqual([]);
      expect(marksBySlide.get(n), `slide ${n} painted no mark`).toBeGreaterThan(0);
    }
    expect(issues).toEqual([]);
  });

  /**
   * A SECOND, SEPARATE DEFECT on the same two archetypes, also fixed.
   *
   * `stat.subLabel` is real copy the model wrote and the renderer prints, and
   * so are `comparison.leftBody` / `rightBody`. None of the three was in
   * `markFieldsInReadingOrder`, so a span copied verbatim out of one was
   * reported against the whole SLIDE as not occurring "on this slide", with
   * advice to "copy a mark verbatim out of the copy you just wrote" — which
   * is exactly what the writer did. All three are in the search now, so the
   * span is claimed by the field it is actually in and the reason it gets is
   * the true one.
   */
  it("names the FIELD a span is verbatim in — stat.subLabel and comparison.leftBody are searched", () => {
    const slides = [
      slide({
        n: 1,
        layout: "stat_callout",
        headline: "The second month is where the calendar breaks",
        body: "Enthusiasm carries the first month and nothing carries the second one.",
        stat: { figure: "62%", subLabel: "of calendars stall in month two", source: "Internal queue audit, 2026" },
        emphasis: ["stall in month two"],
      }),
      slide({
        n: 2,
        layout: "comparison_card",
        headline: "Enthusiasm versus process",
        body: "One of them is a plan and the other one is a mood.",
        comparison: {
          leftLabel: "Month one",
          leftBody: "Runs on enthusiasm, which is not a plan.",
          rightLabel: "Month two",
          rightBody: "Runs on whatever you wrote down.",
        },
        emphasis: ["which is not a plan"],
      }),
    ];
    const { issues } = assemble(slides);

    // The premise: both spans ARE in the slide's own copy, verbatim.
    expect(slides[0]!.stat!.subLabel).toContain("stall in month two");
    expect(slides[1]!.comparison!.leftBody).toContain("which is not a plan");

    expect(issues).toHaveLength(2);
    expect(issues.map((i) => ({ slide: i.slide, field: i.field, text: i.text }))).toEqual([
      { slide: 1, field: "stat.subLabel", text: "stall in month two" },
      { slide: 2, field: "comparison.leftBody", text: "which is not a plan" },
    ]);
    for (const issue of issues) {
      // The true reason, and never the old falsehood.
      expect(issue.reason).toContain("paints no marks");
      expect(issue.reason).not.toContain("does not appear on this slide");
      expect(issue.reason).not.toContain("copy a mark verbatim out of the copy you just wrote");
    }
  });

  /**
   * The counter-case for the field list: `stat.figure` and the two comparison
   * LABELS stay OUT of the search on purpose. A bare numeral in a
   * `line-height: 0.95` lockup and a one-word column heading are furniture,
   * not clauses, and a highlighter on furniture is decoration pretending to
   * be meaning. A span that lives only there is still reported against the
   * slide with the "not on this slide" reason, which is the honest answer:
   * there is no clause here to mark.
   */
  it("does NOT search stat.figure or the comparison labels — furniture takes no mark", () => {
    const { issues } = assemble([
      slide({
        n: 1,
        layout: "stat_callout",
        headline: "The second month is where the calendar breaks",
        body: "Enthusiasm carries the first month and nothing carries the second one.",
        stat: { figure: "62%", subLabel: "of calendars fail before the review", source: "Internal queue audit, 2026" },
        emphasis: ["62%"],
      }),
      slide({
        n: 2,
        layout: "comparison_card",
        headline: "Enthusiasm versus process",
        body: "One of them is a plan and the other one is a mood.",
        comparison: { leftLabel: "Month one", leftBody: "Runs on enthusiasm.", rightLabel: "Month two", rightBody: "Runs on what you wrote." },
        emphasis: ["Month one"],
      }),
    ]);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.field).toBe("slide");
      expect(issue.reason).toContain("does not appear on this slide");
    }
  });
});
