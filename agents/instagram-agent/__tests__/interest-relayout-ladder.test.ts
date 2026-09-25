import { describe, expect, it } from "vitest";
import { checkInterestFloor, type InterestFinding } from "../src/workflow/interest-floor.js";
import { planInterestRelayout, type InterestRelayoutChange, type InterestRelayoutOptions } from "../src/workflow/interest-relayout.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import { goodCopyOutput, goodImageVettingOutput, passingSlideMetrics, passingSlideProbe, SIX_RESEARCH_FACTS } from "./test-helpers.js";
import { imageryShortfallsFor } from "../src/workflow/imagery-floor.js";

/**
 * THE RELAYOUT LADDER AFTER PHASE 5.5 — the order, and the rung that is now
 * last.
 *
 * `interest-floor.ts` records the incident this reordering exists for, in its
 * own comment: on run `pubsub-21839432908803804` the `attach-device` remedy
 * **fabricated the digit `2` out of the middle of the word `B2B`**, labelled
 * it with the claim minus that digit, and sourced it to a real company. On
 * 2026-09-16 the same remedy's cover limb shipped `7.2%` under "Only of
 * organizations respond to inbound leads within five minutes, meaning", on two
 * posts about different subjects.
 *
 * **A gate that cannot be satisfied honestly will be satisfied dishonestly.**
 * The answer is not a better gate: it is to put the honest remedies first —
 * merge the slide away, promote a picture onto it, render the content it
 * already has — and to make the last one prove it is inventing nothing.
 *
 * `interest-floor.test.ts` owns the per-kind table; this file owns the ORDER
 * and the two rungs Phase 5.5 added.
 */

const FACTS = SIX_RESEARCH_FACTS;

/** A `one-element` finding on `slide` at `role`, built through the REAL rule so the fixture cannot drift from what the gate emits. */
function weightFinding(slide: number, role: "cover" | "interior" | "closer", weight = 2): InterestFinding {
  const verdict = checkInterestFloor(passingSlideMetrics(), passingSlideProbe(slide), role, { slide, contentWeight: weight });
  const finding = verdict.findings.find((f) => f.kind === "one-element");
  if (finding === undefined) throw new Error(`weight ${weight} produced no finding at role ${role}`);
  return finding;
}

/** The copy with slide `n`'s structured blocks stripped, so the archetype rung cannot act and the ladder runs to its end. */
function withoutBlocks(copy: InstagramCopyOutput, n: number): InstagramCopyOutput {
  return {
    ...copy,
    slides: copy.slides.map((s) => (s.n === n ? { ...s, stat: undefined, items: undefined, quote: undefined, comparison: undefined } : s)),
  };
}

const MERGE_ON: InterestRelayoutOptions = { mergeSupported: true, slideCountFloor: 4 };

describe("the ladder's order: merge, picture, archetype, type step, device", () => {
  it("merges the slide away first — the cheapest true answer to a plate with too little on it", () => {
    const copy = goodCopyOutput();
    const plan = planInterestRelayout(copy, goodImageVettingOutput().selections, FACTS, [weightFinding(3, "interior")], MERGE_ON);
    expect(plan?.changes[0]).toMatchObject({ kind: "merge-into-neighbour", slide: 3, into: 2 });
    const change = plan?.changes[0] as Extract<InterestRelayoutChange, { kind: "merge-into-neighbour" }>;
    // The text travels with the change, so the workflow applies a merge this
    // module described rather than one it invents.
    expect(change.carry.headline.length).toBeGreaterThan(0);
    // 2026-09-25 (owner feedback WS-09): this fixture's slide 2 is a photo plate whose body
    // plus the carry is over its budget, so the words go to the caption rather than be cut.
    expect(change.toCaption).toBe(true);
    expect(change.reason).toMatch(/the carousel runs 5 slides instead of 6/u);
  });

  it("...and never on the cover or the closer, which are positions rather than spare plates", () => {
    const copy = goodCopyOutput();
    for (const [slide, role] of [[1, "cover"], [6, "closer"]] as const) {
      const plan = planInterestRelayout(copy, goodImageVettingOutput().selections, FACTS, [weightFinding(slide, role, 2)], MERGE_ON);
      expect(plan?.changes[0]?.kind, role).not.toBe("merge-into-neighbour");
    }
  });

  it("...and never below the client's own slides_min, and never when the caller cannot apply one", () => {
    const copy = goodCopyOutput(); // six slides
    const atFloor = planInterestRelayout(copy, goodImageVettingOutput().selections, FACTS, [weightFinding(3, "interior")], {
      mergeSupported: true,
      slideCountFloor: 6,
    });
    expect(atFloor?.changes[0]?.kind).not.toBe("merge-into-neighbour");

    // No floor supplied: unknown, so the merge is refused rather than guessed
    // at — `checkSlidesData` would reject an assembly outside the range.
    const noFloor = planInterestRelayout(copy, goodImageVettingOutput().selections, FACTS, [weightFinding(3, "interior")], { mergeSupported: true });
    expect(noFloor?.changes[0]?.kind).not.toBe("merge-into-neighbour");

    // And the default: a caller that has not said it can apply a merge does
    // not get one. A change whose `switch` case does not exist is a
    // byte-identical re-render dressed as a remedy — this module's own header
    // refuses exactly that.
    const unsupported = planInterestRelayout(copy, goodImageVettingOutput().selections, FACTS, [weightFinding(3, "interior")]);
    expect(unsupported?.changes[0]?.kind).not.toBe("merge-into-neighbour");
  });

  it("promotes a vetted picture onto an INTERIOR plate, not only onto the cover", () => {
    // Slide 5 ships typographic, so its vetted picture is going nowhere; slide
    // 3 has nothing to look at.
    const copy = goodCopyOutput();
    const typographic: InstagramCopyOutput = {
      ...copy,
      slides: copy.slides.map((s) => (s.n === 5 ? { ...s, layout: "text_only" as const } : s)),
    };
    const plan = planInterestRelayout(withoutBlocks(typographic, 3), goodImageVettingOutput().selections, FACTS, [weightFinding(3, "interior")]);
    expect(plan?.changes[0]).toMatchObject({ kind: "promote-image-to-cover", slide: 3, fromSlide: 5, archetype: "photo" });
    // The compliance record travels with the path, capped — nothing re-vetted
    // that picture against slide 3's claim.
    const change = plan?.changes[0] as Extract<InterestRelayoutChange, { kind: "promote-image-to-cover" }>;
    expect(change.record.claimMatch).toBeLessThanOrEqual(3);
    expect(change.record.claimMatchReason).toMatch(/without a re-vet/u);
  });

  /**
   * THE SAME PICTURE TWICE IN ONE POST — the owner, on the XO Digital
   * carousel of 2026-09-24: *"what is on slide 3 looks excellent in placement;
   * it is simply the same picture as on the first slide"*.
   *
   * Step `06f2` enforces one picture per post and reads `HERO_IMAGE_LAYOUTS`
   * — all six archetypes that PAINT a picture. This rung read
   * `layout !== "photo"`, which is two of the six, so a photograph already
   * rendering in a panel's bounded band counted as unused and could be
   * promoted onto the cover. The re-layout put back exactly what the dedupe
   * had removed, and the reader met the picture twice.
   */
  it("never promotes a picture another slide is already rendering, in a band or otherwise", () => {
    const copy = goodCopyOutput();
    // Slide 5 keeps a picture, in a PANEL archetype: a bounded band, not a
    // full-bleed photo plate. A reader sees it there.
    const panelled: InstagramCopyOutput = {
      ...copy,
      slides: copy.slides.map((s) => (s.n === 5 ? { ...s, layout: "quote_card" as const } : s)),
    };
    // Every other slide's selection is emptied, so the ONLY candidate this
    // rung could reach for is the one slide 5 is showing.
    const selections = goodImageVettingOutput().selections.map((sel) =>
      sel.n === 5 ? sel : { ...sel, imagePath: null },
    );

    const plan = planInterestRelayout(withoutBlocks(panelled, 3), selections, FACTS, [weightFinding(3, "interior")]);
    const promoted = (plan?.changes ?? []).filter((c) => c.kind === "promote-image-to-cover");
    expect(promoted).toEqual([]);
  });

  it("still promotes a picture no slide paints — the rung is not disabled, only corrected", () => {
    // The control for the test above: the same shape, except slide 5 ships
    // TYPOGRAPHIC, so its vetted picture really is going nowhere.
    const copy = goodCopyOutput();
    const typographic: InstagramCopyOutput = {
      ...copy,
      slides: copy.slides.map((s) => (s.n === 5 ? { ...s, layout: "text_only" as const } : s)),
    };
    const selections = goodImageVettingOutput().selections.map((sel) =>
      sel.n === 5 ? sel : { ...sel, imagePath: null },
    );
    const plan = planInterestRelayout(withoutBlocks(typographic, 3), selections, FACTS, [weightFinding(3, "interior")]);
    expect(plan?.changes[0]).toMatchObject({ kind: "promote-image-to-cover", slide: 3, fromSlide: 5 });
  });

  it("never promotes a screen-cliche picture, which is how a monitor-in-a-dark-room frame became KAROS's cover (2026-09-24)", () => {
    const copy = goodCopyOutput();
    const typographic: InstagramCopyOutput = {
      ...copy,
      slides: copy.slides.map((s) => (s.n === 5 ? { ...s, layout: "text_only" as const } : s)),
    };
    const selections = goodImageVettingOutput().selections.map((sel) =>
      sel.n === 5 ? { ...sel, reason: "The generated image shows a desktop monitor with multiple disconnected browser tabs in a dim room." } : sel,
    );
    const plan = planInterestRelayout(withoutBlocks(typographic, 3), selections, FACTS, [weightFinding(3, "interior")]);
    const promoted = plan?.changes.filter((c) => c.kind === "promote-image-to-cover") as Array<Extract<InterestRelayoutChange, { kind: "promote-image-to-cover" }>> | undefined;
    expect((promoted ?? []).map((c) => c.fromSlide)).not.toContain(5);
  });

  /**
   * The device rung is reached only when every rung above it has declined, and
   * `verbatimDeviceFor` then has to prove the figure came out of this slide's
   * own words with a label that reads as a clause.
   */
  it("reaches the device last, and refuses one whose label is a fragment", () => {
    const copy = goodCopyOutput();
    const headlineFocus: InstagramCopyOutput = {
      ...copy,
      slides: copy.slides.map((s) => (s.n === 3 ? { ...s, layout: "headline_focus" as const } : s)),
    };

    // A slide whose own sentence yields a WHOLE clause when the figure is cut
    // out of it: "Support resolved 30% more tickets…" → "Support resolved more
    // tickets…". The device is offered.
    const clean: InstagramCopyOutput = {
      ...withoutBlocks(headlineFocus, 3),
      slides: withoutBlocks(headlineFocus, 3).slides.map((s) =>
        s.n === 3 ? { ...s, headline: "Triage changed the queue", body: "Support resolved 30% more tickets after the new flow.", sourceRef: s.sourceRef } : s,
      ),
    };
    const withDevice = planInterestRelayout(clean, [], FACTS, [weightFinding(3, "interior")], { styleOverrides: new Map([[3, { fontScale: "l" as const }]]) });
    const change = withDevice?.changes[0] as Extract<InterestRelayoutChange, { kind: "attach-device" }> | undefined;
    expect(change?.kind).toBe("attach-device");
    expect(change?.device.value).toBe("30%");

    // The same slide carrying the karoslabs sentence, verbatim in shape: the
    // figure sits after a subordinator, so cutting it out by position leaves a
    // label that does not start. No device is offered at all, and with every
    // other rung spent there is no plan: the redraft is what that case is for.
    const fragmentary: InstagramCopyOutput = {
      ...clean,
      slides: clean.slides.map((s) =>
        s.n === 3
          ? { ...s, headline: "Response time decides the deal.", body: "Only 7.2% of organizations respond to inbound leads within five minutes." }
          : s,
      ),
    };
    const refused = planInterestRelayout(fragmentary, [], FACTS, [weightFinding(3, "interior")], { styleOverrides: new Map([[3, { fontScale: "l" as const }]]) });
    expect(refused).toBeUndefined();
  });

  /**
   * And the honest bookkeeping: when nothing is free, the plan says so in the
   * operator's vocabulary, and the writer gets the floor's own steer — whose
   * first remedy is the merge this module could not apply.
   */
  it("records what it could not remedy in words an operator can act on", () => {
    const copy = withoutBlocks(goodCopyOutput(), 3);
    const stripped: InstagramCopyOutput = {
      ...copy,
      slides: copy.slides.map((s) => (s.n === 3 ? { ...s, layout: "headline_focus" as const, headline: "What changed", body: "The team reworked its process end to end." } : s)),
    };
    const plan = planInterestRelayout(stripped, [], FACTS, [weightFinding(3, "interior")], { styleOverrides: new Map([[3, { fontScale: "l" as const }]]) });
    expect(plan).toBeUndefined();

    // With a second failing slide that DOES have a remedy — slide 4 is a wall
    // of text, and dropping its type step is free — the unremedied row rides
    // alongside the change rather than disappearing.
    const textWall = checkInterestFloor(passingSlideMetrics({ textShare: 0.7 }), passingSlideProbe(4), "interior", { slide: 4 }).findings[0]!;
    expect(textWall.kind).toBe("text-wall");
    const withOther = planInterestRelayout(stripped, [], FACTS, [weightFinding(3, "interior"), textWall], {
      styleOverrides: new Map([[3, { fontScale: "l" as const }]]),
    });
    expect(withOther?.changes.map((c) => c.slide)).toEqual([4]);
    expect(withOther?.unremedied.map((u) => u.slide)).toEqual([3]);
    expect(withOther?.unremedied[0]?.reason).toMatch(/no unused vetted picture, no unclaimed content-shaped archetype, and no figure in its own copy/u);
  });
});

/**
 * ── THE IMAGERY SHORTFALL'S OWN REMEDY, WHICH COULD NOT BE CHOSEN. ──
 *
 * `imageryShortfallsFor` picks a remedy per slide that lost its photograph,
 * from facts the interest floor's finding kind does not carry: whether the run
 * holds a spare vetted image, whether the slide's own copy states a figure with
 * a complete label, whether the plate already renders a designed object.
 *
 * Two of its five remedies were unreachable outside a test. The workflow built
 * the record, wrote it to the gate payload, and never handed it to the planner
 * — `grep shortfall interest-relayout.ts` returned nothing — while two comments
 * said the record *"travels into 08a1b-relayout-for-interest, so the relayout
 * reaches for a remedy that fits the reason instead of manufacturing
 * furniture"*. And `hasOwnFigure` / `hasDesignedObject` were never supplied at
 * the call site, so `attach-device` and `none` could not be chosen at all.
 *
 * Both halves are wired now, and both halves are asserted here: that the fields
 * reach the chooser, and that the chooser's answer reaches the plan.
 */
describe("a slide that lost its photograph is remedied for the reason it lost it", () => {
  it("chooses `attach-device` for a slide whose own copy states a figure, and `none` for one that already carries an object", () => {
    const shortfalls = imageryShortfallsFor(
      [
        { slide: 2, wanted: "stock", got: "text_only", why: "no candidate cleared the vet", hasOwnFigure: true },
        { slide: 3, wanted: "stock", got: "text_only", why: "no candidate cleared the vet", hasDesignedObject: true },
      ],
      { spareVettedImages: 0 },
    );
    // Both were unreachable in production until the workflow started supplying
    // the two fields they key on.
    expect(shortfalls.find((s) => s.slide === 2)?.remedy).toBe("attach-device");
    expect(shortfalls.find((s) => s.slide === 3)?.remedy).toBe("none");
  });

  it("the planner takes the shortfall's remedy over the pixel symptom's", () => {
    const base = goodCopyOutput();
    // A slide whose own sentence yields a whole clause when its figure is cut
    // out — the precondition `attach-device` keys on, and the same fixture the
    // device rung above uses.
    const copy: InstagramCopyOutput = {
      ...withoutBlocks(base, 3),
      slides: withoutBlocks(base, 3).slides.map((s) =>
        s.n === 3 ? { ...s, layout: "headline_focus" as const, headline: "Triage changed the queue", body: "Support resolved 30% more tickets after the new flow." } : s,
      ),
    };
    const findings = [weightFinding(3, "interior")];

    // Without the record the ladder answers the SYMPTOM and merges the plate
    // away, which is the right answer to "this plate is thin" and the wrong one
    // to "this plate lost a picture and still states its own number".
    const blind = planInterestRelayout(copy, goodImageVettingOutput().selections, FACTS, findings, MERGE_ON);
    expect(blind?.changes[0]?.kind).toBe("merge-into-neighbour");

    const withRecord = planInterestRelayout(copy, goodImageVettingOutput().selections, FACTS, findings, {
      ...MERGE_ON,
      imageryShortfalls: imageryShortfallsFor(
        [{ slide: 3, wanted: "stock", got: "text_only", why: "no candidate cleared the vet", hasOwnFigure: true }],
        { spareVettedImages: 0 },
      ),
    });
    const change = withRecord?.changes[0] as Extract<InterestRelayoutChange, { kind: "attach-device" }> | undefined;
    expect(change?.kind, "the shortfall said `attach-device` and the planner merged the plate away anyway").toBe("attach-device");
    // And it is the slide's OWN figure, verbatim — the rule the fabricated `2`
    // out of `B2B` exists to make impossible.
    expect(change?.device.value).toBe("30%");
  });

  it("falls through to the kind ladder when the shortfall's own answer is `none`", () => {
    const copy = withoutBlocks(goodCopyOutput(), 3);
    const plan = planInterestRelayout(copy, goodImageVettingOutput().selections, FACTS, [weightFinding(3, "interior")], {
      ...MERGE_ON,
      imageryShortfalls: imageryShortfallsFor(
        [{ slide: 3, wanted: "stock", got: "text_only", why: "no candidate cleared the vet", hasDesignedObject: true }],
        { spareVettedImages: 0 },
      ),
    });
    // `none` means the plate is not empty, so there is nothing for the SHORTFALL
    // to fix — the floor's own finding still gets its answer.
    expect(plan?.changes[0]?.kind).toBe("merge-into-neighbour");
  });
});

describe("a merged slide's words are always seen (2026-09-25, owner feedback WS-09)", () => {
  const withNeighbour = (layout: string, body: string): InstagramCopyOutput => {
    const copy = goodCopyOutput();
    return { ...copy, slides: copy.slides.map((s) => (s.n === 2 ? { ...s, layout: layout as never, body } : s.n === 3 ? { ...s, headline: "One more thing", body: "It ships in May." } : s)) };
  };
  it("merges into a neighbour that paints its body and has room", () => {
    const plan = planInterestRelayout(withNeighbour("photo", "Short body."), goodImageVettingOutput().selections, FACTS, [weightFinding(3, "interior")], MERGE_ON);
    const change = plan?.changes[0] as Extract<InterestRelayoutChange, { kind: "merge-into-neighbour" }>;
    expect(change).toMatchObject({ kind: "merge-into-neighbour", slide: 3, into: 2 });
    expect(change.toCaption).toBeUndefined();
  });
  it("sends the words to the caption when the neighbour is a quote card, which never paints a body", () => {
    const plan = planInterestRelayout(withNeighbour("quote_card", "Short body."), goodImageVettingOutput().selections, FACTS, [weightFinding(3, "interior")], MERGE_ON);
    const change = plan?.changes.find((c) => c.kind === "merge-into-neighbour") as Extract<InterestRelayoutChange, { kind: "merge-into-neighbour" }> | undefined;
    expect(change?.toCaption).toBe(true);
  });
});
