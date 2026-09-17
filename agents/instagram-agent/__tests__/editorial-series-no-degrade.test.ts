import { describe, expect, it } from "vitest";
import { BUNDLED_SERIES, seriesDirectedSlides, skeletonFor, type EditorialSeries } from "../src/workflow/editorial-series.js";
import { assembleSlidesData, resolveLayout, type SlidePosition } from "../src/workflow/slides-data.js";
import type { InstagramCopyOutput, InstagramSlideCopy, InstagramSlideLayout } from "../src/workflow/types.js";

/**
 * PHASE 5.5, BRIEF ITEM E — the series/singleton collision.
 *
 * ## The defect, from the runs the owner judged
 *
 * `slides-data.ts` degrades any structured archetype a second slide in the
 * same carousel asks for. Four of the six bundled series ask for exactly that,
 * on purpose: `by_the_numbers` is three `stat_callout`s, `the_playbook` three
 * `list_takeaway`s, `head_to_head` and `in_their_words` two each. So those four
 * formats could not ship without degraded plates — and the degrade CASCADES,
 * because each one claims an archetype off the fallback ladder that the next
 * slide then cannot have.
 *
 * Prep run `pubsub-21868183257380937` (karoslabs, `by_the_numbers`,
 * 2026-09-16) is the whole argument in one row. The writer drafted the
 * skeleton faithfully:
 *
 *   `cover, stat_callout, photo, stat_callout, headline_focus, stat_callout,
 *    list_takeaway, closer`
 *
 * and the carousel rendered:
 *
 *   `cover.html, stat-callout.html, headline-focus.html, slide.html,
 *    slide.html, slide.html, list-takeaway.html, closer.html`
 *
 * Slides 4, 5 and 6 on the client's bare base template. They are the plates
 * the owner pointed at — *"חלק מהשקפים ריקים"* — and nothing in the run was
 * broken: every gate passed, the copy was good, and the format itself
 * guaranteed the holes.
 *
 * ## What this file pins
 *
 * 1. Every series, at both canvas lengths, assembles with NOTHING degraded.
 *    This test fails on four of the six series without the exemption, and the
 *    premise test below runs the same fixtures with `seriesDirected` withheld
 *    to prove that is still true — a guard that cannot fail is not a guard.
 * 2. The two negative controls that keep the exemption honest: a
 *    series-directed slide whose CONTENT is missing still degrades, and a
 *    repeat the WRITER chose off its own bat still degrades.
 * 3. The six series still produce six visibly different posts once they stop
 *    degrading — the reason the series layer exists at all.
 */

const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 };

const BRAND_TOKENS = { templateDir: "fixtures/templates", slideTemplate: "slide.html" };

/**
 * The content each archetype REQUIRES, filled for real and differently on
 * every slide.
 *
 * Differently, because the exemption is deliberately not a blanket pass: three
 * `stat_callout`s need three different figures, and a fixture that reused one
 * would be asserting something weaker than the thing being shipped.
 */
function contentFor(layout: InstagramSlideLayout, n: number): Partial<InstagramSlideCopy> {
  switch (layout) {
    case "stat_callout":
      return { stat: { figure: `${60 + n}%`, subLabel: `of teams surveyed in round ${n}`, source: `Acme Research, 202${n % 10}` } };
    case "quote_card":
      return { quote: { text: `We rebuilt the whole thing in week ${n}.`, attribution: `A founder, 202${n % 10}` } };
    case "comparison_card":
      return { comparison: { leftLabel: `Before ${n}`, leftBody: "Two weeks of manual triage.", rightLabel: `After ${n}`, rightBody: "Forty minutes, once a week." } };
    case "list_takeaway":
      return { items: [{ title: `Move ${n}.1` }, { title: `Move ${n}.2` }, { title: `Move ${n}.3` }] };
    default:
      return {};
  }
}

/** A complete carousel written to a series' own skeleton, with every archetype's content actually supplied. */
function copyForSeries(series: EditorialSeries, slideCount: number): InstagramCopyOutput {
  const skeleton = skeletonFor(series, slideCount);
  return {
    format: "carousel",
    caption: `A caption for the ${series.id} fixture carousel.`,
    slides: skeleton.map((layout, index) => ({
      n: index + 1,
      headline: `Headline ${index + 1} for ${series.id}`,
      body: `Body copy ${index + 1}. Save this one for the next planning cycle.`,
      visualNeed: `need ${index + 1}`,
      sourceRef: `claim ${index + 1}`,
      layout,
      ...contentFor(layout, index + 1),
    })),
  };
}

/**
 * `resolveLayout` walked over a whole carousel, in carousel order, the way
 * `assembleSlidesData` walks it — the only way to read `downgradedFrom`, which
 * assembly discards once it has the layout.
 *
 * Every assertion that matters is ALSO made against the real
 * `assembleSlidesData` output (`assertTemplates`), so this mirror cannot drift
 * away from production without a test failing.
 */
function walk(copy: InstagramCopyOutput, seriesDirected?: ReadonlySet<number>): { n: number; layout: InstagramSlideLayout; downgradedFrom?: string }[] {
  const usedLayouts = new Set<string>();
  const lastIndex = copy.slides.length - 1;
  return copy.slides.map((slide, index) => {
    const position: SlidePosition = { index, lastIndex, hasHeroImage: false, earlier: copy.slides.slice(0, index) };
    const resolved = resolveLayout(slide, undefined, usedLayouts, undefined, position, seriesDirected);
    if (resolved.layout !== "photo" && resolved.layout !== "text_only") usedLayouts.add(resolved.layout);
    return { n: slide.n, ...resolved };
  });
}

/** The template file each slide actually rendered through, from the production assembler. */
function templatesOf(copy: InstagramCopyOutput, seriesDirected?: ReadonlySet<number>): string[] {
  const data = assembleSlidesData({
    clientSlug: "acme",
    postId: "post_1",
    repoRoot: "/repo",
    brandTokens: BRAND_TOKENS,
    copy,
    selections: [],
    canvas: CANVAS,
    ...(seriesDirected !== undefined ? { seriesDirected } : {}),
  });
  return data.slides.map((slide) => slide.template);
}

/** What a slide's layout renders as, for the fixtures here: the archetype file, or the client's own base plate for `photo`/`text_only`. */
const TEMPLATE_OF: Record<string, string> = {
  cover: "cover.html",
  closer: "closer.html",
  stat_callout: "stat-callout.html",
  quote_card: "quote-card.html",
  comparison_card: "comparison-card.html",
  list_takeaway: "list-takeaway.html",
  headline_focus: "headline-focus.html",
  photo: "slide.html",
  text_only: "slide.html",
};

describe("a series-directed layout repeats on purpose", () => {
  for (const series of BUNDLED_SERIES) {
    for (const slideCount of [6, 8]) {
      it(`${series.id} at ${slideCount} slides assembles with nothing degraded`, () => {
        const copy = copyForSeries(series, slideCount);
        const directed = seriesDirectedSlides(series, copy.slides);
        // The premise: the writer followed the skeleton on every slide, so
        // every slide is series-directed. A fixture that quietly deviated
        // would be testing the exemption on the wrong plates.
        expect(directed.size, "the fixture follows the skeleton exactly").toBe(copy.slides.length);

        const resolved = walk(copy, directed);
        expect(
          resolved.filter((slide) => slide.downgradedFrom !== undefined).map((slide) => `slide ${slide.n}: ${slide.downgradedFrom}`),
          "nothing may degrade when the series asked for the repeat and the content is there",
        ).toEqual([]);
        expect(resolved.map((slide) => slide.layout)).toEqual(copy.slides.map((slide) => slide.layout));

        // ...and the same thing through the production assembler, so the walk
        // above is a reader of `resolveLayout` and not a second implementation
        // of it.
        const expectedTemplates = copy.slides.map((slide) => TEMPLATE_OF[slide.layout]!);
        expect(templatesOf(copy, directed)).toEqual(expectedTemplates);
      });
    }
  }

  /**
   * THE PREMISE, stated as its own failing case. Without the exemption the
   * four repeat-bearing series degrade — and `the_breakdown` and `field_notes`
   * do not, because the only layout they repeat is `photo`, which the
   * singleton rule has always exempted. If this test ever goes green for all
   * six, the exemption above has stopped being what makes the suite pass.
   */
  it("...and WITHOUT the exemption the four repeat-bearing series degrade, exactly as they did on 2026-09-16", () => {
    const degradedSeries = BUNDLED_SERIES.filter((series) => walk(copyForSeries(series, 8)).some((slide) => slide.downgradedFrom !== undefined)).map((s) => s.id);
    expect(degradedSeries).toEqual(["by_the_numbers", "head_to_head", "the_playbook", "in_their_words"]);
  });

  /**
   * karoslabs' post, reproduced: the skeleton the writer drafted, the picture
   * slide that lost its photograph, and the three plates that fell through to
   * the base template behind it.
   *
   * The cascade is the part a per-slide reading misses. Slide 3 degrades
   * because its photo never arrived and takes `headline_focus` off the ladder;
   * slide 4's series-directed `stat_callout` is refused as a repeat and finds
   * `headline_focus` already claimed; slide 5's own `headline_focus` is
   * refused for the same reason. One rule, three plates.
   */
  it("reproduces the karoslabs plates, and the exemption removes all three", () => {
    const byTheNumbers = BUNDLED_SERIES.find((s) => s.id === "by_the_numbers")!;
    const copy = copyForSeries(byTheNumbers, 8);
    // Slide 3 is the series' `photo`, and on 16.9 no candidate passed vetting:
    // `07a-downgrade-unfillable-slides` rewrote it through
    // `fallbackArchetypeFor` and it arrived here as a `headline_focus`. That
    // is modelled exactly, because it is the FIRST link in the cascade — the
    // degrade that costs slide 5 its own archetype.
    expect(copy.slides[2]!.layout).toBe("photo");
    const slides = copy.slides.map((slide) => (slide.n === 3 ? { ...slide, layout: "headline_focus" as const } : slide));
    const live = { ...copy, slides } as InstagramCopyOutput;

    const before = walk(live);
    expect(before.filter((s) => s.downgradedFrom !== undefined).map((s) => s.n)).toEqual([4, 5, 6]);
    expect(before[3]!.downgradedFrom).toContain("already used earlier in this carousel");
    // The render that shipped, verbatim from the run's `07c-emit-slides-data`
    // checkpoint.
    expect(before.map((s) => TEMPLATE_OF[s.layout]!)).toEqual([
      "cover.html",
      "stat-callout.html",
      "headline-focus.html",
      "slide.html",
      "slide.html",
      "slide.html",
      "list-takeaway.html",
      "closer.html",
    ]);

    // Slide 3 no longer matches the skeleton — it lost its photograph — so it
    // is NOT exempt, which is right: that plate is a picture slide's remedy,
    // not a format decision. Slide 5's `headline_focus` IS the series', and
    // with the repeat rule off its back it renders as one.
    const directed = seriesDirectedSlides(byTheNumbers, live.slides);
    expect(directed.has(3)).toBe(false);
    const after = walk(live, directed);
    expect(after.every((s) => s.downgradedFrom === undefined)).toBe(true);
    expect(after.map((s) => TEMPLATE_OF[s.layout]!)).toEqual([
      "cover.html",
      "stat-callout.html",
      "headline-focus.html",
      "stat-callout.html",
      "headline-focus.html",
      "stat-callout.html",
      "list-takeaway.html",
      "closer.html",
    ]);
  });
});

describe("the exemption is only from the repeat rule", () => {
  /**
   * NEGATIVE CONTROL 1 — content. Break the exemption to be unconditional and
   * this test refuses: a series that cannot fill its own archetype should
   * still degrade, visibly, rather than render an empty 300px figure.
   */
  it("a series-directed stat_callout with no stat still degrades on its missing content", () => {
    const series = BUNDLED_SERIES.find((s) => s.id === "by_the_numbers")!;
    const copy = copyForSeries(series, 8);
    // Slide 6 is the third `stat_callout`; strip the figure it was going to
    // carry and leave everything else exactly as it was.
    const slides = copy.slides.map((slide) => (slide.n === 6 ? { ...slide, stat: undefined } : slide));
    const stripped = { ...copy, slides } as InstagramCopyOutput;

    const resolved = walk(stripped, seriesDirectedSlides(series, stripped.slides));
    const slide6 = resolved.find((s) => s.n === 6)!;
    expect(slide6.downgradedFrom).toContain("no stat supplied");
    expect(slide6.layout).not.toBe("stat_callout");
    // ...and only that slide. The other two stat callouts are untouched.
    expect(resolved.filter((s) => s.downgradedFrom !== undefined).map((s) => s.n)).toEqual([6]);
  });

  /**
   * NEGATIVE CONTROL 2 — authorship. The rule was written for a writer that
   * repeated an archetype nobody asked for (a real prep run shipped two
   * `stat_callout`s and two `comparison_card`s in one post), and that is
   * exactly what still has to degrade.
   */
  it("a repeat the WRITER chose, on a run that has a series, still degrades", () => {
    const series = BUNDLED_SERIES.find((s) => s.id === "field_notes")!;
    const copy = copyForSeries(series, 8);
    // `field_notes` puts `quote_card` at slide 4 and `stat_callout` at slide
    // 5. Make slide 7 — the series' second `photo` — a second `quote_card`
    // the skeleton never asked for.
    const slides = copy.slides.map((slide) => (slide.n === 7 ? { ...slide, layout: "quote_card" as const, ...contentFor("quote_card", 7) } : slide));
    const deviated = { ...copy, slides } as InstagramCopyOutput;

    const directed = seriesDirectedSlides(series, deviated.slides);
    expect(directed.has(7), "slide 7 no longer matches the skeleton, so the series did not direct it").toBe(false);
    expect(directed.has(4), "the slides that still match are still directed").toBe(true);

    const resolved = walk(deviated, directed);
    const slide7 = resolved.find((s) => s.n === 7)!;
    expect(slide7.downgradedFrom).toContain("already used earlier in this carousel");
    expect(resolved.filter((s) => s.downgradedFrom !== undefined).map((s) => s.n)).toEqual([7]);
  });

  /**
   * NEGATIVE CONTROL 3 — the client's own templateDir. A client configured
   * before the archetype set shipped holds only its own `slide.html`, and a
   * series cannot conjure a template file that is not on disk. That check runs
   * first and the exemption never reaches it.
   */
  it("a client whose templateDir lacks the archetype still degrades, series or no series", () => {
    const series = BUNDLED_SERIES.find((s) => s.id === "by_the_numbers")!;
    const copy = copyForSeries(series, 8);
    const directed = seriesDirectedSlides(series, copy.slides);
    const legacyDir = new Set<string>(["cover.html", "closer.html"]);
    const resolved = resolveLayout(copy.slides[1]!, legacyDir, new Set(), undefined, { index: 1, lastIndex: 7, hasHeroImage: false, earlier: [] }, directed);
    expect(resolved.downgradedFrom).toContain("no stat-callout.html");
  });
});

describe("seriesDirectedSlides", () => {
  it("is positional, and returns each slide's own n", () => {
    const series = BUNDLED_SERIES.find((s) => s.id === "the_playbook")!;
    const copy = copyForSeries(series, 6);
    expect([...seriesDirectedSlides(series, copy.slides)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /**
   * A draft that numbers its slides badly must not exempt the wrong plate.
   * The skeleton is positional, so the comparison is positional and only the
   * RETURNED value is the model's `n`.
   */
  it("matches by position even when the model's own numbering is wrong", () => {
    const series = BUNDLED_SERIES.find((s) => s.id === "by_the_numbers")!;
    const copy = copyForSeries(series, 6);
    const misnumbered = copy.slides.map((slide, index) => ({ ...slide, n: index === 2 ? 99 : slide.n }));
    const directed = seriesDirectedSlides(series, misnumbered);
    expect(directed.has(99), "position 3 still matches the skeleton, under whatever number it gave itself").toBe(true);
    expect(directed.has(3)).toBe(false);
  });

  it("directs nothing on a draft that ignored the skeleton entirely", () => {
    const series = BUNDLED_SERIES.find((s) => s.id === "in_their_words")!;
    const copy = copyForSeries(series, 8);
    const ignored = copy.slides.map((slide) => ({ ...slide, layout: "text_only" as const }));
    expect(seriesDirectedSlides(series, ignored).size).toBe(0);
  });
});

/**
 * The reason the series layer exists: six formats that produce six visibly
 * different posts. Until this change four of them collapsed toward the same
 * shape — a couple of archetypes followed by base plates — which is the
 * mechanism behind the owner's *"רואים שאותו AI ייצר אותו"*.
 *
 * Signature is the rendered TEMPLATE sequence rather than the drafted layout
 * sequence, because the template file is what a reader actually sees; two
 * series that drafted differently and rendered the same would be a failure
 * this assertion has to be able to catch. A browser render would assert the
 * same tuple through a slower instrument — the template file fully determines
 * the plate's construction — so this stays Chromium-free and runs everywhere.
 */
describe("six series, six posts", () => {
  it("renders six distinct skeleton signatures at the full canvas length", () => {
    const signatures = BUNDLED_SERIES.map((series) => {
      const copy = copyForSeries(series, 8);
      return templatesOf(copy, seriesDirectedSlides(series, copy.slides)).join(">");
    });
    expect(new Set(signatures).size, signatures.join("\n")).toBe(BUNDLED_SERIES.length);
  });
});
