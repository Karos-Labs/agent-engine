import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Slide } from "@agent-engine/tool-karos-publish";
import {
  checkInterestFloor,
  CONTENT_FIELD_WEIGHTS,
  CONTENT_WEIGHTS,
  CONTENT_WEIGHT_FLOOR,
  slideRoleFor,
  type SlideRole,
} from "../src/workflow/interest-floor.js";
import { weighContentElements, countContentElements } from "../src/workflow/visual-qa-pre-checks.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import { InstagramSlideCopySchema, type InstagramCopyOutput } from "../src/workflow/types.js";
import { passingSlideMetrics, passingSlideProbe } from "./test-helpers.js";

/**
 * THE ANTI-REGRESSION ASSET OF PHASE 5.5.
 *
 * On 2026-09-16 the owner ran three prep posts (karoslabs, thepitchbydeel,
 * geektime) and judged them as a CMO. Verbatim, twice:
 *
 *   *"השקף הראשון יחסית ריק ומשעמם"* — the first slide is fairly empty and
 *   boring.
 *   *"חלק מהשקפים ריקים"* — some of the slides are empty.
 *
 * Every one of those plates cleared the floor that was running. This file
 * pins the three runs' archived `07c-emit-slides-data` outputs and asserts
 * that the WEIGHTED floor reproduces his verdicts on the post he named plate
 * by plate — **every slide he pointed at fails, and no slide he did not point
 * at fails.**
 *
 * That reproduction, and not an argument about what a good slide is, is the
 * justification for moving this threshold. If a later phase changes the
 * weights, the floor or the field map, this file says which of the owner's
 * own verdicts it just stopped reproducing.
 *
 * The fixtures are the runs' real step outputs, trimmed only by truncating
 * each `htmlFragments` value (the counter reads a fragment's PRESENCE, never
 * its markup) — nothing else is edited, including the work-note that leaked
 * into geektime's slide 4 body.
 */

const FIXTURES = path.resolve(__dirname, "fixtures", "live-2026-09-16");

interface LiveSlidesData {
  client: string;
  runId: string;
  slides: Slide[];
}

async function live(slug: string): Promise<LiveSlidesData> {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, `${slug}.json`), "utf8")) as LiveSlidesData;
}

/** The verdict clause H reaches for one live slide, through the REAL rule rather than by comparing numbers here. */
function verdictFor(doc: LiveSlidesData, index: number): { role: SlideRole; weight: number; failed: boolean } {
  const slide = doc.slides[index]!;
  const role = slideRoleFor(index, doc.slides.length);
  const { weight } = weighContentElements(slide, index === 0);
  // Real metrics and a real probe: a clause-H case must not be decided by a
  // second clause firing on a fixture's numbers, so the plate is otherwise a
  // passing one and `hasHero` matches what the document actually carries.
  const verdict = checkInterestFloor(passingSlideMetrics(), passingSlideProbe(slide.n), role, {
    slide: slide.n,
    contentWeight: weight,
    hasHero: slide.images?.["hero"] !== undefined,
  });
  return { role, weight, failed: verdict.findings.some((f) => f.kind === "one-element") };
}

describe("the weighted content floor reproduces the owner's own verdicts (2026-09-16)", () => {
  /**
   * The table from `CONTENT_WEIGHTS`'s own doc comment, asserted plate by
   * plate. The owner named slides 1, 4 and 6 by hand (the empty cover, and
   * "some of the slides are empty"); slide 3 is the plate that asked for a
   * photograph and lost it; slide 8 is a closer whose payoff is a recap strip
   * at ~11px and two lines.
   */
  it("karoslabs: slides 1, 3, 4 and 6 fail — and 2, 5, 7 and the closer do not", async () => {
    const doc = await live("karoslabs");
    expect(doc.slides).toHaveLength(8);
    const rows = doc.slides.map((_, index) => verdictFor(doc, index));
    // The weights first, because they are what a reviewer argues with.
    expect(rows.map((r) => r.weight)).toEqual([2.5, 3.0, 2.0, 2.0, 3.5, 2.0, 3.0, 3.0]);
    // ── THE CLOSER (slide 8) PASSES AT 3.0, AND THAT IS THE CORRECTION. ──
    //
    // This package shipped `CONTENT_WEIGHT_FLOOR.closer` at 4.0, which is
    // unreachable for a closer (`closer` is not in `HERO_IMAGE_LAYOUTS`, so the
    // archetype declares no `{{image:hero}}` slot and can never carry the 2.0 a
    // hero is worth), and wave-2 integration corrected it to 3.5. With the
    // recap priced at `device` (1.5) that 3.5 was ALSO exactly what every
    // closer this agent produces weighs, so the floor sat on the one value it
    // could ever see and separated nothing — which is what this case used to
    // record, with the plate asserted as REFUSED.
    //
    // `CONTENT_WEIGHTS.recap` moved to `prose` (1.0) for the render it is
    // priced against, and the floor did not move with it — so for one revision
    // the same plate was refused on EVERY post instead of passing on every
    // post. Neither is a bar. `CONTENT_WEIGHT_FLOOR.closer` carries the
    // re-derivation and the measurement: this plate reads `inkShare` 0.3743
    // and `occupiedShare` 0.3967 — the second heaviest of its own carousel —
    // and the sentence it was refused with ("a headline and a body on bare
    // ground is not a slide") is untrue of it.
    //
    // At 3.0 the bar is where the owner's complaint is: the BARE closer
    // (takeaway + ask, 2.00) is refused and an eyebrow cannot buy it a pass
    // (2.25), while the plate the pipeline composes on purpose is not refused
    // for being composed the only way it can be.
    expect(rows.map((r) => r.failed)).toEqual([true, false, true, true, false, true, false, false]);
    // And the two roles that are held higher are the two the reader actually
    // stops on.
    expect(rows[0]?.role).toBe("cover");
    expect(rows[7]?.role).toBe("closer");
  });

  /**
   * THE GAMEABILITY GUARD, and the reason the weights exist at all.
   *
   * `LAYOUT_FIELD_KEYS` excludes eleven metadata keys and no more, so
   * `kicker`, `eyebrow`, `sourceLine` and `subLabel` each counted a whole
   * element. A flat floor raised from 2 to 3 would therefore have been
   * cleared by PRINTING A KICKER — by adding the exact brand furniture the
   * owner named in the same session as the clearest tell that a post was made
   * by a machine.
   */
  it("a kicker cannot lift a headline-and-body plate over the interior floor", async () => {
    const doc = await live("karoslabs");
    const bare = doc.slides[3]!; // slide 4: headline + body, weight 2.0
    expect(weighContentElements(bare, false).weight).toBe(2);

    const furnished: Slide = {
      ...bare,
      fields: { ...bare.fields, kicker: "by the numbers", eyebrow: "field notes", sourceLine: "BCG, June 2026" },
    };
    // Three pieces of furniture: the COUNT goes from 2 to 5 — over any flat
    // floor anybody would set — and the weight goes from 2.0 to 2.75, which is
    // still under 3.0.
    expect(countContentElements(furnished, false)).toBe(5);
    expect(weighContentElements(furnished, false).weight).toBe(2.75);
    expect(
      checkInterestFloor(passingSlideMetrics(), passingSlideProbe(4), "interior", {
        slide: 4,
        contentWeight: weighContentElements(furnished, false).weight,
      }).findings.map((f) => f.kind),
    ).toEqual(["one-element"]);

    // What DOES lift it is something a reader looks at: the photograph this
    // slide asked for and lost.
    const withPicture: Slide = { ...bare, images: { ...bare.images, hero: "images/slide-4.jpg" } };
    expect(weighContentElements(withPicture, false).weight).toBe(4);
    expect(
      checkInterestFloor(passingSlideMetrics(), passingSlideProbe(4), "interior", {
        slide: 4,
        contentWeight: weighContentElements(withPicture, false).weight,
        hasHero: true,
      }).ok,
    ).toBe(true);
  });

  /**
   * The other two runs, as a regression record rather than as a second
   * calibration. They are not what the floor was fitted to — that was
   * karoslabs, plate by plate — but a floor that reproduces one post's
   * verdicts and mangles the next two is fitted to a post rather than to a
   * defect.
   */
  it("thepitchbydeel: the three plates carrying photographs pass, and the two carrying only words do not", async () => {
    const doc = await live("thepitchbydeel");
    const rows = doc.slides.map((_, index) => verdictFor(doc, index));
    // s3, s4 and s6 carry a hero; s1 is the same gradient cover as karoslabs';
    // s5 is a headline_focus with nothing on it.
    expect(rows.map((r) => r.failed)).toEqual([true, false, false, false, true, false, false, false]);
    expect(rows[2]?.weight).toBe(4.25);
    expect(rows[4]?.weight).toBe(2.25);
  });

  it("geektime: the cover passes on its figure device, and the two word-only plates fail", async () => {
    const doc = await live("geektime");
    const rows = doc.slides.map((_, index) => verdictFor(doc, index));
    // s1 carries a device fragment, which takes the cover to exactly its
    // floor; s2 and s4 are headline-and-body plates.
    // s8 is the same closer karoslabs shipped — takeaway, ask and a recap strip
    // — and it clears the closer floor for the reason the karoslabs case above
    // spells out.
    expect(rows.map((r) => r.failed)).toEqual([false, true, false, true, false, false, false, false]);
    expect(rows[0]?.weight).toBe(4);
    expect(rows[7]?.weight).toBe(3);
  });

  /**
   * ── THE BUNDLED ARCHETYPES, AS A BAND. ──
   *
   * A floor that a correctly composed plate cannot clear is a false refusal
   * that costs a drafting attempt, and this repo has that rule written down in
   * `interest-floor-calibration.test.ts`. So the claim in `CONTENT_WEIGHTS`'s
   * doc comment — every STRUCTURED archetype clears the interior floor on its
   * own content, and only the two shapeless ones do not — is asserted rather
   * than argued.
   */
  it("every structured archetype clears the interior floor on its own fields; the shapeless ones do not", () => {
    const base = { n: 3, images: {}, htmlFragments: {} };
    const plate = (template: string, fields: Record<string, string>, fragments: Record<string, string> = {}): Slide =>
      ({ ...base, template, fields: { accentColor: "#ff6b2c", dir: "ltr", lang: "en", ...fields }, htmlFragments: fragments }) as unknown as Slide;

    const rows: Array<[string, Slide, boolean]> = [
      ["stat_callout", plate("stat-callout.html", { figure: "90%", subLabel: "of CMOs", body: "Buyers decide inside answers.", sourceLine: "BCG, 2026" }), true],
      ["quote_card", plate("quote-card.html", { quoteText: "The funnel moved and nobody told sales.", attribution: "A CMO, 2026" }), true],
      ["list_takeaway", plate("list-takeaway.html", { headline: "Three things" }, { itemRows: "<div>…</div>" }), true],
      [
        "comparison_card",
        plate("comparison-card.html", {
          headline: "Assumption against reality",
          body: "Two readings of the same quarter.",
          leftLabel: "Assumed",
          leftBody: "A Q4 priority",
          rightLabel: "Real",
          rightBody: "Ranked today",
        }),
        true,
      ],
      ["photo", plate("slide.html", { headline: "Discovery moved", body: "And the funnel followed." }), true],
      ["headline_focus", plate("headline-focus.html", { headline: "Discovery moved", body: "And the funnel followed." }), false],
      ["text_only", plate("slide.html", { headline: "Discovery moved", body: "And the funnel followed." }), false],
    ];
    for (const [name, slide, shouldPass] of rows) {
      const withHero = name === "photo" ? ({ ...slide, images: { hero: "images/slide-3.jpg" } } as unknown as Slide) : slide;
      const { weight } = weighContentElements(withHero, false);
      expect(weight >= CONTENT_WEIGHT_FLOOR.interior, `${name} weighed ${weight}`).toBe(shouldPass);
    }
  });

  /**
   * The weights themselves, written down where a reviewer reads them — the
   * same mechanism `interest-floor-marks.test.ts`'s pinned scalars use. To
   * change one you have to state the new number in a diff.
   */
  it("pins the weights and the field map", () => {
    expect(CONTENT_WEIGHTS).toEqual({
      hero: 2.0,
      itemRows: 2.0,
      quote: 2.0,
      device: 1.5,
      recap: 1.0,
      figureAsDevice: 1.5,
      prose: 1.0,
      furniture: 0.25,
    });
    expect(CONTENT_WEIGHT_FLOOR).toEqual({ cover: 4, interior: 3, closer: 3 });
    // Only two classes are named; everything else is prose BY OMISSION, which
    // is the safe direction — a field added to a template later is a content
    // element until somebody argues otherwise, never furniture by accident.
    expect(CONTENT_FIELD_WEIGHTS).toEqual({
      figure: 1.5,
      quoteText: 2.0,
      kicker: 0.25,
      eyebrow: 0.25,
      sourceLine: 0.25,
      // 2026-09-23: a picture's credit line is attribution, never content.
      photoCredit: 0.25,
      itemOrdinal: 0.25,
      subLabel: 0.25,
    });
    expect(CONTENT_FIELD_WEIGHTS["headline"]).toBeUndefined();
  });

  /**
   * The two counters read the same document through the same `proseFieldsOf`,
   * so they can never disagree about WHAT is on a plate — only about what it
   * is worth. That is the drift clause H was built to avoid, and it is worth
   * one assertion.
   */
  it("the count and the weight see the same parts", async () => {
    for (const slug of ["karoslabs", "thepitchbydeel", "geektime"]) {
      const doc = await live(slug);
      for (const [index, slide] of doc.slides.entries()) {
        const { parts } = weighContentElements(slide, index === 0);
        // One part per counted element, plus the headline_focus-cover lockup
        // correction when it applies (a negative part, never a new element).
        const counted = parts.filter((p) => p.weight > 0).length;
        const corrections = parts.filter((p) => p.weight < 0).length;
        expect(counted - corrections, `${slug} slide ${slide.n}`).toBe(countContentElements(slide, index === 0));
      }
    }
  });

  /**
   * ── A THRESHOLD THAT ONLY EVER MEETS ONE VALUE IS NOT A THRESHOLD. ──
   *
   * `CONTENT_WEIGHT_FLOOR.closer` shipped at exactly the weight every closer
   * this agent produces, and this file's own comment said so approvingly. It is
   * the failure mode `guards-that-cannot-fail` is about, reached from the other
   * side: a floor sitting on its role's fixed point passes every plate it will
   * ever see, so the plate the calibration table was written to refuse passed
   * it, and the test recorded that as correct.
   *
   * So the invariant is asserted directly, from the weights rather than from a
   * remembered number: the closer's BEST composition must clear the floor (or
   * it is a redraft tax) and its WORST shipping composition must not (or it is
   * decoration). Both are built here out of `CONTENT_WEIGHTS` itself, so a
   * re-price that collapses the gap fails this case rather than silently
   * disarming the role.
   *
   * ── WHICH COMPOSITION IS "THE WORST SHIPPING ONE" IS THE BARE CLOSER, NOT
   *    THE RECAP ONE, AND GETTING THAT WRONG COST A REVISION. ──
   *
   * This case used to assert `recapOnly < floor`. That reads as a policy — *a
   * contents page is not a payoff* — but the pipeline composes NOTHING ELSE
   * unless the writer's own closer copy states a figure: `contentFor`'s closer
   * emits two prose slots and one code-built fragment, and
   * `BOUNDED_OBJECT_LAYOUTS` excludes `closer`, so the 1.5 device is not
   * something anything upstream can produce. Asserting it therefore asserted
   * that every post ships with a finding on its last slide, which is what
   * `workflow-e2e.test.ts` measured end to end (CI run 35170562382).
   *
   * The owner's complaint was a closer with NOTHING on it. That is `bare`
   * (2.00), and that is what this now holds refused — with the eyebrow limb
   * still beside it, so decoration still cannot buy the pass.
   */
  it("the closer floor sits strictly between what a closer can weigh and what the BARE closer weighs", () => {
    // `contentFor`'s closer emits exactly two prose slots — `takeaway`, and
    // whichever of `question`/`cta` the body is — plus ONE code-built fragment
    // in its single elastic middle, plus a topical eyebrow on the clients whose
    // `eyebrowFor` puts one on the last slide.
    const twoLines = CONTENT_WEIGHTS.prose * 2;
    const best = twoLines + CONTENT_WEIGHTS.device + CONTENT_WEIGHTS.furniture;
    const withObject = twoLines + CONTENT_WEIGHTS.device;
    const recapOnly = twoLines + CONTENT_WEIGHTS.recap;
    const bare = twoLines;

    expect(CONTENT_WEIGHT_FLOOR.closer).toBeLessThan(best);
    // Reachable WITHOUT furniture, which is the other half of the rule: a floor
    // that only an eyebrow can clear is a floor cleared by decoration.
    expect(withObject).toBeGreaterThanOrEqual(CONTENT_WEIGHT_FLOOR.closer);
    // ── AND REACHABLE BY THE COMPOSITION THE PIPELINE ACTUALLY BUILDS. ──
    // Nothing upstream composes the 1.5 device onto a closer, so a floor above
    // `recapOnly` is a floor no post can clear — which is the same "redraft tax
    // wearing a bar's clothes" this case refuses one line up, one composition
    // over.
    expect(recapOnly).toBeGreaterThanOrEqual(CONTENT_WEIGHT_FLOOR.closer);
    // And the composition the owner complained about, refused.
    expect(bare).toBeLessThan(CONTENT_WEIGHT_FLOOR.closer);
    // An eyebrow cannot lift the bare closer over the floor. This is the same
    // un-gameability the weights exist for on the interior, asserted on the one
    // role where the margin is thinnest.
    expect(bare + CONTENT_WEIGHTS.furniture).toBeLessThan(CONTENT_WEIGHT_FLOOR.closer);
  });

  /**
   * ── AND THE PLATE THE CLOSER FLOOR REFUSES, BUILT BY THE REAL ASSEMBLER. ──
   *
   * The case above is arithmetic over `CONTENT_WEIGHTS`. Arithmetic cannot
   * answer the question a reviewer actually asks of a floor — *can anything
   * this pipeline emits be below it?* — and answering that one wrong is how
   * `closer` sat at 3.5 (refuses everything) and then at 3.0 with nothing
   * written down about what 3.0 catches.
   *
   * So the sub-floor closer is COMPOSED here, through `assembleSlidesData`,
   * and weighed by the same `weighContentElements` the workflow uses. The
   * state is a closer whose elastic middle comes through empty:
   * `buildRecapFragment` returns `""` below `MIN_RECAP_PLATES` (2) earlier
   * slides, and the slide carries no device — `closerContentAvailable`'s
   * `hasCloserVoice` branch still routes it to `closer.html`, so it renders as
   * a closer with a takeaway, a question and nothing else.
   *
   * `InstagramCopyOutputSchema`'s six-slide minimum keeps a FIRST-render draft
   * out of that state; a merge, a degrade or a client template that fills no
   * recap does not, and `interest-relayout.ts`'s closer remedy already names
   * it — *"closed on an empty plate and the post has too few earlier points to
   * recap"*. That remedy is what this finding routes to.
   */
  it("a closer whose middle comes through empty weighs 2.00 through the real assembler, and the floor refuses it", () => {
    const copySlide = (over: Record<string, unknown>) =>
      InstagramSlideCopySchema.parse({ n: 1, headline: "A headline", body: "Some body copy.", visualNeed: "a need", sourceRef: "a claim", ...over });
    const copy = {
      format: "carousel",
      caption: "c",
      slides: [
        copySlide({ n: 1, layout: "cover", headline: "GEO is not a future strategy", body: "Your buyers are already inside AI-generated answers." }),
        copySlide({ n: 2, layout: "closer", headline: "Own week three", body: "Which one would you change first?" }),
      ],
    } as unknown as InstagramCopyOutput;
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_closer_floor",
      repoRoot: "/repo",
      brandTokens: { templateDir: "fixtures/templates", slideTemplate: "slide.html", accentColor: "#C4552F" },
      copy,
      selections: [],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 },
    });
    const last = data.slides[1]!;
    // It really is the closer archetype, or this case is measuring something
    // else entirely.
    expect(last.template).toBe("closer.html");
    // ONE earlier slide, so there is no recap strip to build and the middle is
    // empty — that is the whole of the composition under test.
    expect(last.htmlFragments?.["recap"]).toBeUndefined();

    const { weight, parts } = weighContentElements(last, false);
    expect(parts.map((p) => p.part).sort()).toEqual(["question", "takeaway"]);
    expect(weight).toBe(2);
    expect(weight).toBeLessThan(CONTENT_WEIGHT_FLOOR.closer);

    const verdict = checkInterestFloor(passingSlideMetrics(), passingSlideProbe(last.n), "closer", { slide: last.n, contentWeight: weight });
    expect(verdict.findings.map((f) => f.kind)).toEqual(["one-element"]);
  });

  /**
   * ── THE LOST-PICTURE WAIVER IS BOUNDED BY WHAT A PICTURE IS WORTH. ──
   *
   * `downgradedForImages` used to waive EVERY weight finding on a downgraded
   * slide, whatever the shortfall, while the comment justifying it said the
   * plate is *"short by exactly the picture nobody could find"*. Those are two
   * different claims and only the second one is defensible: a cover carrying
   * nothing but a title is 3.0 short of the 4.0 cover floor, and a hero is
   * worth 2.0, so the photograph would not have saved it. That plate is thin
   * for a reason a redraft CAN fix.
   */
  it("waives a downgraded plate only when the missing hero would have cleared the floor", () => {
    const downgraded = new Set([1]);
    const verdictAt = (contentWeight: number) =>
      checkInterestFloor(passingSlideMetrics(), passingSlideProbe(1), "cover", { slide: 1, contentWeight, downgradedForImages: downgraded });

    // Title + sub-line on a cover: 2.0 against 4.0, and 2.0 + the hero's 2.0 is
    // exactly the floor — the picture is the whole of the shortfall.
    const waived = verdictAt(2);
    expect(waived.ok).toBe(true);
    expect(waived.findings).toEqual([]);
    expect(waived.waived.map((f) => f.kind)).toEqual(["one-element"]);
    expect(waived.waived[0]?.waivedReason).toContain("inside the 2.00 a hero is worth");

    // A title and nothing else: 1.0 against 4.0. Even with the hero it would
    // have been 3.0, so this is not a sourcing outage — it is a thin plate.
    const held = verdictAt(1);
    expect(held.findings.map((f) => f.kind)).toEqual(["one-element"]);
    expect(held.waived).toEqual([]);
  });

  /**
   * The closer's middle arrives through ONE slot (`closer.html` declares
   * `{{html:recap}}` and nothing else), so the slot key cannot say which of the
   * two things is in it. `contentFor` sets `deviceKind` exactly when the
   * fragment is the device, and that is what the weighing reads.
   */
  it("a closer's designed object and its recap strip are told apart by `deviceKind`, not by the slot", () => {
    const closer = (fields: Record<string, string>): Slide =>
      ({
        n: 8,
        template: "closer.html",
        fields: { accentColor: "#ff6b2c", dir: "ltr", lang: "en", takeaway: "Own week three", cta: "Save this for your next planning cycle.", ...fields },
        images: {},
        htmlFragments: { recap: "<div class='rc-strip'>…</div>" },
      }) as unknown as Slide;

    // The contents page: two lines and a strip of the post's own earlier
    // headlines, truncated and set small.
    expect(weighContentElements(closer({}), false).weight).toBe(3);
    // The payoff: the same two lines and a designed object built from a figure
    // in the slide's own copy.
    const designed = weighContentElements(closer({ deviceKind: "figure", deviceFigures: "37%" }), false);
    expect(designed.weight).toBe(3.5);
    expect(designed.parts.map((p) => p.part)).toContain("device (closer)");
    // Both are ONE element to the counter — the difference is what it is worth,
    // which is the whole reason the two functions are separate.
    expect(countContentElements(closer({}), false)).toBe(countContentElements(closer({ deviceKind: "figure", deviceFigures: "37%" }), false));
  });
});
