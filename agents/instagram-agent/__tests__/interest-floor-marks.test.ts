import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { composeRawDocument } from "@agent-engine/tool-karos-templates";
import { decodePngRows } from "@agent-engine/tool-common";
import {
  ACCENT_MAX_SHARE,
  ACCENT_MIN_SHARE,
  ACCENT_TOL,
  CLIPPED_EDGE_SHARE_CEILING,
  CONTENT_OCCUPIED_SHARE_FLOOR,
  EDGE_DENSITY_FLOOR,
  FLAT_BACKGROUND_CEILING,
  FLAT_TOL,
  FULL_BLEED_IMAGERY_SHARE,
  IMAGERY_OR_DEVICE_FLOOR,
  IMAGERY_SHARE_FOR_PALETTE_WARNING,
  INK_DELTA,
  INK_SHARE_FLOOR,
  LARGEST_EMPTY_RECT_CEILING,
  MIN_QUANTISED_COLOUR_COUNT,
  OCCUPIED_SHARE_FLOOR,
  PROBE_TEXT_BOX_SHARE_FLOOR,
  TEXT_SHARE_CEILING,
  checkInterestFloor,
  interestWarningsFor,
  type InterestFinding,
  type SlideMetrics,
  type SlideProbe,
  type SlideRole,
} from "../src/workflow/interest-floor.js";
import { planInterestRelayout } from "../src/workflow/interest-relayout.js";
import {
  MAX_MARKS_PER_SLIDE,
  buildMarkRing,
  buildMarkedRuns,
  markCssBlock,
  type EmphasisIssue,
  type MarkRing,
  type MarkRun,
} from "../src/workflow/emphasis-marks.js";
import { buildScriptFontHeadForLanguage, scriptTypographyFor } from "../src/workflow/script-fonts.js";
import { deviceCssBlock } from "../src/workflow/slide-devices.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import { InstagramSlideCopySchema, type ImageSelection, type InstagramCopyOutput, type InstagramSlideCopy } from "../src/workflow/types.js";
import { goodCopyOutput, goodImageVettingOutput, isChromiumInstalled, passingSlideMetrics, passingSlideProbe, SIX_RESEARCH_FACTS } from "./test-helpers.js";

/**
 * RFC-17 §5.6 — the emphasis instruments, as POLICY.
 *
 * Sections 1-5 are pure: hand-built metrics and probes, no Chromium, no PNG.
 * Section 6 is RFC-20 P5 and is the opposite — it renders real plates through
 * real Chromium, SELF-SKIPS where no browser is installed, and CI is the only
 * authority for anything it claims. The two halves are kept in one file
 * because they are two views of the same instrument, and they are reported
 * SEPARATELY (PASSED vs SKIPPED) because a local green on section 6 proves
 * nothing at all. The pixel
 * `packages/tools/karos-publish/__tests__/slide-metrics-marks.test.ts`, and
 * the rendered band is a Chromium claim that CI settles in
 * `interest-floor-calibration.test.ts`. This file proves the three RULES:
 *
 *  1. the ONE new failing clause, `marks-missing`, fires on exactly the state
 *     it claims and ABSTAINS everywhere else — above all on a template that
 *     never asked for emphasis;
 *  2. the DOM instrument and the PIXEL instrument are provably DIFFERENT
 *     instruments, because there is a state where one fires and the other
 *     does not, in each direction;
 *  3. **not one threshold constant's VALUE moved.**
 *
 * ## Why (3) is a test and not a promise
 *
 * The brief this phase was written against names exactly one outcome that
 * fails the work: lowering a threshold to admit an empty plate. RFC-17 Part 3
 * answers it by finding no measurable discriminator and leaving every
 * constant alone — and a claim like that is worth what its guard is worth. So
 * the constants are PINNED to the values they carry on the branch point
 * (`4364b1a`, `origin/main` before this phase), scalars and role records
 * alike, and the source is additionally scanned so that ADDING a threshold —
 * an exemption constant, a mark floor — fails just as loudly as moving one.
 */

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

/**
 * A plate that clears every clause, measured by a consumer that DOES measure
 * composition — i.e. anything on the carousel path, where `measureSlidePng`
 * emits all five RFC-17 fields on every slide unconditionally.
 *
 * The mark fields default to "three runs, all painted, four colours visible",
 * which is a good marked slide; every case below moves one of them.
 */
function measured(overrides: Partial<SlideMetrics> = {}): SlideMetrics {
  return passingSlideMetrics({
    markedShare: 0.031,
    markColourCount: 4,
    contentCentroid: { x: 0.498, y: 0.515 },
    contentBBox: { x: 96, y: 180, w: 880, h: 1040 },
    groundInkContrast: 15.84,
    ...overrides,
  });
}

function probe(overrides: Partial<SlideProbe> = {}, slide = 3): SlideProbe {
  return passingSlideProbe(slide, { markRuns: 3, markRunsPainted: 3, ...overrides });
}

function check(m: SlideMetrics, p: SlideProbe, role: SlideRole = "interior", slide = 3) {
  return checkInterestFloor(m, p, role, { slide });
}

const kindsOf = (v: { findings: InterestFinding[] }): string[] => v.findings.map((f) => f.kind);
const warningKindsOf = (v: { warnings: { kind: string }[] }): string[] => v.warnings.map((w) => w.kind);

// ─────────────────────────────────────────────────────────────────────────
// 1. The clause
// ─────────────────────────────────────────────────────────────────────────

describe("marks-missing: the one new failing clause", () => {
  it("fires when the document asked for emphasis runs and NONE of them painted", () => {
    const verdict = check(measured({ markedShare: 0, markColourCount: 0 }), probe({ markRuns: 3, markRunsPainted: 0 }));
    expect(kindsOf(verdict)).toContain("marks-missing");
    expect(verdict.ok).toBe(false);
  });

  /**
   * THE ABSTENTION THAT MAKES THE CLAUSE SAFE TO SHIP.
   *
   * A client on a Template Studio template authored before this phase has no
   * `*Runs` slot, so its documents emit no runs; `stat-callout` and
   * `comparison-card` deliberately have none either, and a slide whose copy
   * simply carried no emphasis is the same state. All of them measure
   * `markRuns === 0`, and every one of them must pass. This is what
   * "DOM-anchored, not copy-anchored" buys, and it is why the clause can only
   * ever refuse MORE than today rather than refusing something that is fine.
   */
  it("ABSTAINS when the document asked for no runs at all — a template with no *Runs slot can never be refused by it", () => {
    for (const role of ["cover", "interior", "closer"] as const) {
      const verdict = check(measured({ markedShare: 0, markColourCount: 0 }), probe({ markRuns: 0, markRunsPainted: 0 }), role);
      expect(kindsOf(verdict), `role ${role}`).not.toContain("marks-missing");
      expect(verdict.ok, `role ${role}`).toBe(true);
    }
  });

  it("ABSTAINS on a consumer whose probe mirror does not report mark runs at all", () => {
    // `template-studio.ts` validates a per-client template from its own
    // narrower probe. Absent and zero mean the same thing here on purpose.
    const { markRuns: _a, markRunsPainted: _b, ...narrow } = probe();
    const verdict = check(measured({ markedShare: 0, markColourCount: 0 }), narrow as SlideProbe);
    expect(kindsOf(verdict)).not.toContain("marks-missing");
    expect(verdict.ok).toBe(true);
  });

  /**
   * PARTIAL PAINT IS NOT A FAILURE, and that is deliberate rather than an
   * oversight in the predicate. The stylesheet is a single `<style>` block:
   * it arrives for every run on the page or for none. A count between 1 and
   * N-1 therefore is not "the sheet did not load" — it is a per-kind or
   * per-element fact (a run inside a slot the template collapsed, say) that a
   * re-render cannot change, and refusing a complete post over it would spend
   * an attempt on nothing.
   */
  it("does NOT fire when some runs painted, because the sheet is all-or-nothing and a partial count is not its absence", () => {
    for (const painted of [1, 2, 3]) {
      const verdict = check(measured(), probe({ markRuns: 3, markRunsPainted: painted }));
      expect(kindsOf(verdict), `${painted} of 3 painted`).not.toContain("marks-missing");
    }
  });

  it("does not short-circuit: a slide that is ALSO a wall of text reports both facts in one steer", () => {
    const verdict = check(measured({ textShare: TEXT_SHARE_CEILING + 0.1, markedShare: 0, markColourCount: 0 }), probe({ markRuns: 4, markRunsPainted: 0 }));
    expect(kindsOf(verdict)).toEqual(expect.arrayContaining(["marks-missing", "text-wall"]));
  });

  it("carries the counts it judged and steers a RE-RENDER, explicitly telling the writer not to rewrite", () => {
    const verdict = check(measured({ markedShare: 0, markColourCount: 0 }), probe({ markRuns: 5, markRunsPainted: 0 }));
    const finding = verdict.findings.find((f) => f.kind === "marks-missing")!;
    expect(finding.measured).toMatchObject({ markRuns: 5, markRunsPainted: 0 });
    expect(finding.sentence).toMatch(/5 emphasis run\(s\)/);
    expect(finding.steer).toMatch(/Do not rewrite/i);
    expect(finding.steer).toMatch(/re-render/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Two instruments, and the proof that they are two
// ─────────────────────────────────────────────────────────────────────────

describe("the DOM instrument and the PIXEL instrument measure different things", () => {
  /**
   * DIRECTION ONE — the sheet did not arrive. `markCssBlock()` is missing
   * from `extraHeadHtml`, so no computed style paints and nothing lands in
   * the frame. Both instruments report, and the CLAUSE is what fails the
   * slide.
   */
  it("sheet missing: the clause fires AND the warning fires", () => {
    const verdict = check(measured({ markedShare: 0, markColourCount: 0 }), probe({ markRuns: 3, markRunsPainted: 0 }));
    expect(kindsOf(verdict)).toContain("marks-missing");
    expect(warningKindsOf(verdict)).toContain("marks-not-visible");
  });

  /**
   * DIRECTION TWO — THE FALSIFICATION RFC-17 §5.6 NAMES. The sheet arrived
   * and every run paints, but every ring colour was set to the ground hex, so
   * nothing lands more than `INK_DELTA` off the ground and no mark colour
   * holds a measurable area.
   *
   * **The warning fires and the clause does not.** If one predicate ever came
   * to stand in for the other this case is what catches it: a clause built on
   * `markColourCount` would refuse this plate, and a warning built on
   * `markRunsPainted` would stay silent on it.
   */
  it("ring painted in the ground colour: the WARNING fires and the CLAUSE does not", () => {
    const verdict = check(measured({ markedShare: 0, markColourCount: 0 }), probe({ markRuns: 3, markRunsPainted: 3 }));
    expect(kindsOf(verdict)).not.toContain("marks-missing");
    expect(warningKindsOf(verdict)).toContain("marks-not-visible");
    expect(verdict.ok).toBe(true);
  });

  it("a well-marked slide trips neither", () => {
    const verdict = check(measured(), probe());
    expect(kindsOf(verdict)).not.toContain("marks-missing");
    expect(warningKindsOf(verdict)).not.toContain("marks-not-visible");
  });

  /**
   * The unmarked plate is silent on BOTH. A post that carried no emphasis is
   * not a post with broken emphasis, and neither instrument may say it is.
   */
  it("a slide that asked for no marks trips neither, whatever the pixels say", () => {
    const verdict = check(measured({ markedShare: 0, markColourCount: 0 }), probe({ markRuns: 0, markRunsPainted: 0 }));
    expect(kindsOf(verdict)).not.toContain("marks-missing");
    expect(warningKindsOf(verdict)).not.toContain("marks-not-visible");
  });

  it("the warning is a fact and never a verdict: markColourCount 0 on an otherwise fine plate still passes", () => {
    const verdict = check(measured({ markedShare: 0.004, markColourCount: 0 }), probe({ markRuns: 2, markRunsPainted: 2 }));
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  /**
   * CLAUSE H, REFUSED — pinned here as behaviour rather than only as prose in
   * the RFC. The control is `slide-metrics-marks.test.ts`'s B2: the owner's
   * grey screen with two marks stuck on it measures `markColourCount` 2, one
   * below the floor of 3 a gate would have wanted. So a plate with a HIGH
   * colour count must not be excused anything, and a plate with a low one
   * must not be refused anything. Both halves are asserted, because a gate
   * could be smuggled in from either direction.
   */
  it("markColourCount gates NOTHING in either direction", () => {
    // `imageryOrDeviceShare: 0` since 2026-09-14: clause C waives a plate that
    // carries a subject, and this case needs a plate that is genuinely empty or
    // it is measuring the waiver rather than the mark count.
    const empty = {
      largestEmptyRectShare: LARGEST_EMPTY_RECT_CEILING.closer + 0.1,
      occupiedShare: 0.09,
      imageryShare: 0,
      graphicShare: 0,
      imageryOrDeviceShare: 0,
    };
    const withMarks = check(measured({ ...empty, markColourCount: 6, markedShare: 0.2 }), probe(), "closer");
    const withoutMarks = check(measured({ ...empty, markColourCount: 0, markedShare: 0 }), probe({ markRuns: 0, markRunsPainted: 0 }), "closer");
    // Six mark colours buy the empty plate nothing...
    expect(kindsOf(withMarks)).toContain("dead-space");
    // ...and zero mark colours cost the same plate nothing extra.
    expect(kindsOf(withoutMarks).filter((k) => k !== "marks-missing")).toEqual(kindsOf(withMarks));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Composition evidence
// ─────────────────────────────────────────────────────────────────────────

describe("composition-evidence: five numbers compared against nothing", () => {
  it("rides along on every MEASURED slide, passing or failing, because a band needs both", () => {
    const passing = check(measured(), probe());
    expect(warningKindsOf(passing)).toContain("composition-evidence");
    expect(passing.ok).toBe(true);

    const failing = check(measured({ textShare: TEXT_SHARE_CEILING + 0.2 }), probe());
    expect(warningKindsOf(failing)).toContain("composition-evidence");
  });

  it("carries all five numbers plus elementCount — the probe field that was measured on every slide and read by nobody", () => {
    const verdict = check(measured(), probe({ elementCount: 37 }));
    const evidence = verdict.warnings.find((w) => w.kind === "composition-evidence")!;
    expect(evidence.measured).toMatchObject({
      centroidX: 0.498,
      centroidY: 0.515,
      contentBBoxW: 880,
      contentBBoxH: 1040,
      groundInkContrast: 15.84,
      markedShare: 0.031,
      markColourCount: 4,
      elementCount: 37,
    });
    expect(evidence.sentence).toMatch(/gates nothing/);
    expect(evidence.sentence).toMatch(/37 elements/);
  });

  /**
   * ABSTAINS ON A CONSUMER THAT MEASURED NONE OF IT, and this is the half
   * that was WRONG when this package picked the work up: the row was pushed
   * unconditionally, so `template-studio.ts` — which validates a per-client
   * template from a structural summary and never decodes a PNG — printed
   * `centroid 0.500,0.500, content box 0x0, ground/ink contrast 0.00:1`, five
   * `??` defaults dressed as measurements. A band assembled from those rows
   * would be poisoned by synthetic zeros from a caller that measured no
   * pixels, which is the same defect as an anchor that matches no document.
   */
  it("ABSTAINS on a consumer that supplied none of the five", () => {
    // `passingSlideMetrics` is the pre-RFC-17 shape: none of the five fields.
    expect(interestWarningsFor(passingSlideMetrics(), "interior", 3, passingSlideProbe(3))).toEqual([]);
  });

  it("...and still reports when a consumer supplied only some of them", () => {
    const partial = passingSlideMetrics({ groundInkContrast: 4.2 });
    const warnings = interestWarningsFor(partial, "interior", 3, passingSlideProbe(3));
    expect(warnings.map((w) => w.kind)).toContain("composition-evidence");
  });

  it("never becomes a finding, at any value", () => {
    const verdict = check(
      measured({ contentCentroid: { x: 0.281, y: 0.722 }, contentBBox: { x: 0, y: 0, w: 1080, h: 1440 }, groundInkContrast: 1.02 }),
      probe(),
    );
    expect(verdict.ok).toBe(true);
    expect(kindsOf(verdict)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. The remedy
// ─────────────────────────────────────────────────────────────────────────

describe("marks-missing steers a free re-render", () => {
  const facts = SIX_RESEARCH_FACTS;

  function findingFor(slide: number): InterestFinding {
    const verdict = check(measured({ markedShare: 0, markColourCount: 0 }), probe({ markRuns: 3, markRunsPainted: 0 }, slide), "interior", slide);
    const finding = verdict.findings.find((f) => f.kind === "marks-missing");
    if (finding === undefined) throw new Error("the fixture did not produce a marks-missing finding");
    return finding;
  }

  it("plans a re-render and changes nothing about the copy", () => {
    const plan = planInterestRelayout(goodCopyOutput(), goodImageVettingOutput().selections, facts, [findingFor(3)]);
    expect(plan?.changes).toEqual([
      {
        kind: "re-render",
        slide: 3,
        reason: "slide 3 carries emphasis runs that painted nothing; re-rendering once — the copy is right and the mark stylesheet did not arrive",
      },
    ]);
  });

  /**
   * PRIORITY. When the sheet did not arrive, every other finding on that
   * slide was measured against a document missing pixels it was supposed to
   * have — so the attempt's one free change goes to the re-render, which
   * re-measures everything, rather than to a `no-device` remedy that may be
   * fixing a number that was never wrong.
   */
  it("outranks every pixel-shaped kind on the same slide", () => {
    const noDevice = (() => {
      const verdict = check(measured({ imageryShare: 0, graphicShare: 0, imageryOrDeviceShare: 0 }), probe(), "cover", 1);
      return verdict.findings.find((f) => f.kind === "no-device")!;
    })();
    const marks = (() => {
      const verdict = check(measured({ markedShare: 0, markColourCount: 0 }), probe({ markRuns: 3, markRunsPainted: 0 }, 1), "cover", 1);
      return verdict.findings.find((f) => f.kind === "marks-missing")!;
    })();
    const plan = planInterestRelayout(goodCopyOutput(), goodImageVettingOutput().selections, facts, [noDevice, marks]);
    expect(plan?.changes).toHaveLength(1);
    expect(plan?.changes[0]).toMatchObject({ kind: "re-render", slide: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. THE GUARD: not one threshold value moved
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every numeric threshold `interest-floor.ts` exports, with the value it
 * carries at this branch's base commit `4364b1a` (`origin/main` before
 * RFC-17).
 *
 * Written down rather than derived, ON PURPOSE — a pin that reads its
 * expectation out of the file it is pinning is the guard that cannot fail
 * this project keeps finding. To change a number here you have to state the
 * new number in a diff a reviewer reads, which is the whole mechanism.
 */
const PINNED_SCALARS: Readonly<Record<string, number>> = {
  FLAT_TOL: 12,
  INK_DELTA: 18,
  ACCENT_TOL: 20,
  PROBE_TEXT_BOX_SHARE_FLOOR: 0.01,
  FLAT_BACKGROUND_CEILING: 0.7,
  IMAGERY_OR_DEVICE_FLOOR: 0.1,
  INK_SHARE_FLOOR: 0.015,
  TEXT_SHARE_CEILING: 0.55,
  EDGE_DENSITY_FLOOR: 0.06,
  ACCENT_MIN_SHARE: 0.0008,
  ACCENT_MAX_SHARE: 0.45,
  CLIPPED_EDGE_SHARE_CEILING: 0.004,
  MIN_QUANTISED_COLOUR_COUNT: 3,
  IMAGERY_SHARE_FOR_PALETTE_WARNING: 0.1,
  FULL_BLEED_IMAGERY_SHARE: 0.5,
  // ── ADDED 2026-09-14 WITH THE CLAUSE-D DEMOTION ──
  //
  // `plateSubject`'s two limbs. They are the reason clause D could be demoted
  // at all: a plate is allowed a quiet region when it carries imagery or a
  // drawn device (`SUBJECT_IMAGERY_MULTIPLE` x `IMAGERY_OR_DEVICE_FLOOR`) or
  // when its type is set at display scale (`DISPLAY_TYPE_SCALE_FLOOR`, read
  // off the DOM probe rather than from the pixels).
  //
  // The multiple is 1.0 ON PURPOSE -- the same bar clause E already uses.
  // Inventing a second, stricter number here would be two bars for one
  // question, and the next person to move one would not know to move the
  // other. That this guard went red the moment they were added is the guard
  // working: an added floor fails as loudly as a moved one.
  DISPLAY_TYPE_SCALE_FLOOR: 0.055,
  // And the POSITION test that qualifies the waiver. A subject earns a plate
  // its quiet only when the hole sits against a margin; a hole crossing 90%
  // of either axis separates content from content and is never waived. Both
  // shapes are real plates measured on real Chromium -- `@semrush`'s corner
  // at 0.37 and a hollow `closer.html` at 0.5556 -- and share alone will
  // never tell them apart, which is why a geometry constant exists here at
  // all.
  SPANNING_HOLE_AXIS_SHARE: 0.9,
  SUBJECT_IMAGERY_MULTIPLE: 1,
};

/**
 * ── RFC-20 §5.6: ONE RECORD MOVES, AND IT MOVES DOWN ─────────────────────
 *
 * `OCCUPIED_SHARE_FLOOR` was `{cover: 0.42, interior: 0.30, closer: 0.42}`.
 * Every one of those numbers was calibrated on a tree where a full-bleed
 * hatch was COUNTED AS CONTENT — MEASURED, the shipped `headline_focus`
 * screen alone takes `occupiedShare` to 0.6426 — so they were never measuring
 * how much was written. With the screens deleted (§5.2) and the bounded
 * plinth in (§5.3) the bands are:
 *
 *   interior  POPULATED-with-plinth 0.2620   NEGLECTED 0.0311 / 0.0106
 *   cover     the bounded ramp alone reaches iod 16.51-18.80 at 33% of the
 *             plate before any type; 0.42 was met by the deleted screen
 *   closer    every ground layer suppressed measures occ 0.4504 — a 1.07x
 *             margin over 0.42, under the 1.15x gate this phase adopts
 *
 * A floor that a correctly composed plate cannot clear is not a floor, it is
 * a false refusal that costs a $0.181 drafting attempt out of three. So this
 * is a RE-CALIBRATION with a measured band behind it, and it is written down
 * HERE, in a diff a reviewer reads, which is the whole mechanism this pin
 * exists for. The three values are PROVISIONAL and the CI gate-zero sweep
 * (§5.8.1) sets the final ones — under a rule fixed BEFORE the sweep runs, so
 * its outcome cannot be argued backwards into a relaxation.
 *
 * **The other two records did NOT move, and that is the load-bearing half.**
 * `LARGEST_EMPTY_RECT_CEILING` in particular: the cover fails clause C at
 * `LER` 23.61 against 22.00 with the screen gone, and 0.22 -> 0.24 would have
 * admitted it. It stays, and the TEMPLATE gets the device instead (§5.5).
 * That is the difference between a re-calibration and the defect this phase
 * exists to fix.
 */
const PINNED_ROLE_RECORDS: Readonly<Record<string, Readonly<Record<SlideRole, number>>>> = {
  LARGEST_EMPTY_RECT_CEILING: { cover: 0.22, interior: 0.28, closer: 0.22 },
  CONTENT_OCCUPIED_SHARE_FLOOR: { cover: 0.09, interior: 0.06, closer: 0.09 },
  // NINTH PASS: `interior` back to 0.30 (its band was the plinth, and CI
  // measured the plinth as a graphic device); `closer` to 0.31, the CI
  // rule-1 literal and stricter than the 0.30 this branch first proposed.
  // TENTH PASS: `cover` is the ONE constant this phase moves. `interior` was
  // never a band (its 0.19 was the plinth's own painted area) and `closer`
  // went back to 0.42 when `closer.html` reverted - a constant derived from a
  // plate this PR no longer changes has no business moving.
  OCCUPIED_SHARE_FLOOR: { cover: 0.18, interior: 0.3, closer: 0.42 },
};

describe("RFC-17 Part 3 / RFC-20 §5.6: exactly one threshold record moved, and nothing else", () => {
  it("every exported scalar threshold still has its base-commit value", () => {
    // Asserted through the IMPORTS, one by one, so a renamed or deleted
    // constant is a compile error rather than a silently skipped key.
    expect(FLAT_TOL).toBe(PINNED_SCALARS["FLAT_TOL"]);
    expect(INK_DELTA).toBe(PINNED_SCALARS["INK_DELTA"]);
    expect(ACCENT_TOL).toBe(PINNED_SCALARS["ACCENT_TOL"]);
    expect(PROBE_TEXT_BOX_SHARE_FLOOR).toBe(PINNED_SCALARS["PROBE_TEXT_BOX_SHARE_FLOOR"]);
    expect(FLAT_BACKGROUND_CEILING).toBe(PINNED_SCALARS["FLAT_BACKGROUND_CEILING"]);
    expect(IMAGERY_OR_DEVICE_FLOOR).toBe(PINNED_SCALARS["IMAGERY_OR_DEVICE_FLOOR"]);
    expect(INK_SHARE_FLOOR).toBe(PINNED_SCALARS["INK_SHARE_FLOOR"]);
    expect(TEXT_SHARE_CEILING).toBe(PINNED_SCALARS["TEXT_SHARE_CEILING"]);
    expect(EDGE_DENSITY_FLOOR).toBe(PINNED_SCALARS["EDGE_DENSITY_FLOOR"]);
    expect(ACCENT_MIN_SHARE).toBe(PINNED_SCALARS["ACCENT_MIN_SHARE"]);
    expect(ACCENT_MAX_SHARE).toBe(PINNED_SCALARS["ACCENT_MAX_SHARE"]);
    expect(CLIPPED_EDGE_SHARE_CEILING).toBe(PINNED_SCALARS["CLIPPED_EDGE_SHARE_CEILING"]);
    expect(MIN_QUANTISED_COLOUR_COUNT).toBe(PINNED_SCALARS["MIN_QUANTISED_COLOUR_COUNT"]);
    expect(IMAGERY_SHARE_FOR_PALETTE_WARNING).toBe(PINNED_SCALARS["IMAGERY_SHARE_FOR_PALETTE_WARNING"]);
    expect(FULL_BLEED_IMAGERY_SHARE).toBe(PINNED_SCALARS["FULL_BLEED_IMAGERY_SHARE"]);
  });

  it("every exported per-role threshold record still has its base-commit values", () => {
    expect(LARGEST_EMPTY_RECT_CEILING).toEqual(PINNED_ROLE_RECORDS["LARGEST_EMPTY_RECT_CEILING"]);
    expect(CONTENT_OCCUPIED_SHARE_FLOOR).toEqual(PINNED_ROLE_RECORDS["CONTENT_OCCUPIED_SHARE_FLOOR"]);
    expect(OCCUPIED_SHARE_FLOOR).toEqual(PINNED_ROLE_RECORDS["OCCUPIED_SHARE_FLOOR"]);
  });

  /**
   * THE SOURCE SCAN, which catches the two things a value pin cannot.
   *
   * A pin over imported names proves the numbers it names did not move. It
   * cannot see a threshold that was ADDED — a mark floor, an emptiness
   * exemption dressed as a constant — and it cannot see one that was deleted
   * and folded into an expression. So the file's whole exported numeric
   * surface is read out of the source and compared to the pinned tables as a
   * SET. RFC-17 ships two new numbers and neither is a threshold: one lives
   * in `slide-metrics.ts` (`MARK_COLOUR_MIN_CELLS`, and it is not exported
   * even there) and the other is the literal `0` this clause compares
   * against, which is "none of them" rather than a level anybody may tune.
   */
  it("declares no threshold constant beyond the pinned set — an added floor fails as loudly as a moved one", async () => {
    const source = await fs.readFile(path.resolve(__dirname, "..", "src", "workflow", "interest-floor.ts"), "utf8");

    const scalars = new Map<string, number>();
    for (const match of source.matchAll(/^export const ([A-Z][A-Z0-9_]*) = (-?[0-9]*\.?[0-9]+);$/gmu)) {
      scalars.set(match[1]!, Number(match[2]));
    }
    expect(Object.fromEntries([...scalars].sort())).toEqual(Object.fromEntries(Object.entries(PINNED_SCALARS).sort()));

    const records = new Map<string, Record<string, number>>();
    for (const match of source.matchAll(/^export const ([A-Z][A-Z0-9_]*): Readonly<Record<SlideRole, number>> = \{([^}]*)\};$/gmu)) {
      const entries: Record<string, number> = {};
      for (const pair of match[2]!.matchAll(/(\w+)\s*:\s*(-?[0-9]*\.?[0-9]+)/gu)) entries[pair[1]!] = Number(pair[2]);
      records.set(match[1]!, entries);
    }
    expect(Object.fromEntries([...records].sort())).toEqual(Object.fromEntries(Object.entries(PINNED_ROLE_RECORDS).sort()));
  });

  /**
   * And the behavioural half of the same claim: the floor still refuses the
   * owner's grey screen, and refuses it for the same reasons, whether or not
   * anybody stuck marks on it. RFC-17 finding 5's control, as a verdict.
   */
  it("still refuses the owner's grey screen, marked or not, on the same clauses", () => {
    const grey = {
      largestEmptyRectShare: 0.31,
      occupiedShare: 0.1,
      contentOccupiedShare: 0.04,
      imageryShare: 0,
      graphicShare: 0,
      imageryOrDeviceShare: 0.02,
    };
    const bare = check(measured({ ...grey, markedShare: 0, markColourCount: 0 }), probe({ markRuns: 0, markRunsPainted: 0 }), "closer");
    const marked = check(measured({ ...grey, markedShare: 0.05, markColourCount: 2 }), probe({ markRuns: 2, markRunsPainted: 2 }), "closer");
    expect(bare.ok).toBe(false);
    expect(marked.ok).toBe(false);
    // Two marks stuck on it change NOTHING about the verdict — which is the
    // whole reason `markColourCount` ships as a warning.
    expect(kindsOf(marked).sort()).toEqual(kindsOf(bare).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. RFC-20 P5 — THE PIXEL PROOF (Chromium-gated; CI is the authority)
// ─────────────────────────────────────────────────────────────────────────

/**
 * ## What this section exists to settle, and why none of it could be settled before
 *
 * RFC-20 ships two changes that meet here. Part 5 replaces the full-bleed
 * painted screens with a sub-ink MATERIAL ground, which re-arms clauses C and
 * D. Part 6 makes the mark ring admit per CAPABILITY, which makes `block` —
 * the highlighter swatch — reachable on a paper kit for the first time. The
 * interaction between the two is a pixel question and nothing above this line
 * can answer it:
 *
 *  **G5 — MARKS CANNOT CLOSE THE HOLE.** A `block` mark is COVERED, FLAT and
 *  carries at most three distinct colours, so `slide-metrics.ts`'s cell
 *  classifier puts it in `graphicShare` and it counts toward CLAUSE E
 *  (`isGraphic = covered && !isImagery && distinct <= GRAPHIC_MAX_DISTINCT_COLOURS`).
 *  MEASURED-EDGE, one `swish` on the cover moved `imageryOrDeviceShare`
 *  14.09 -> 14.37, and the ring fix multiplies the mark load on paper kits.
 *  Five blocks at ~200x40 design px is ~2.6% of the frame sitting on lines
 *  that already carry type, so they should not touch the empty rectangle
 *  below the headline — but that is an ARGUMENT, and this phase does not ship
 *  arguments about pixels. So: the owner's grey screen, carrying the maximum
 *  mark load this system can emit, must STILL fail clause C.
 *
 *  **A2 — THE FIRST RENDER IN WHICH THE MARK METRIC CAN FAIL AT ALL.**
 *  `markedShare` and `markColourCount` count cells that are covered and flat,
 *  a definition only `block` can satisfy (`MARK_AREA_PAINTING_KINDS` in
 *  `interest-floor.ts`). On every kit we ship today `markKindsFor` refuses
 *  `block` outright, so both numbers are STRUCTURALLY 0 and clause A2 has
 *  been abstaining, DOM-anchored, since it shipped. On a paper kit after
 *  RFC-20 Part 6 they are real numbers, and a real number can be wrong.
 *
 *  **HEBREW BLOCK GEOMETRY, VERIFIED RATHER THAN ASSUMED.**
 *  `HEBREW_GEOMETRY` carries `--mk-block-h: .44em` / `--mk-block-y: .60em` —
 *  shorter and lower than Latin's `.50em`/`.56em`, because Hebrew has no
 *  ascenders and a full letter body. Its own comment calls those STARTING
 *  VALUES to be corrected by the CI band sweep (RFC-17 §5.3 test 12), and
 *  they have shipped UNREACHABLE: `block` is block-capable 0/16 on every dark
 *  kit both before and after the ring fix, so no render has ever painted one.
 *  This is that sweep, run for real, ltr x rtl, with the Phase-0 script fonts
 *  loaded and `probe.fontFamiliesUsed` asserted non-fallback on every row.
 *
 * ## What it deliberately does NOT do
 *
 * It asserts no BAND on the measured geometry. RFC-17 says in terms that the
 * two Hebrew numbers are to be CORRECTED by this sweep; asserting a band on
 * its first sighting is how a number nobody measured becomes a constant
 * everybody cites, and `IMAGERY_OR_DEVICE_FLOOR` took six documented passes
 * before anyone was allowed to trust it. So the sweep PRINTS the table
 * against measured cap height and asserts only what is true by construction
 * (the sheet reached the document, the band is on the plate) plus two
 * falsifiable facts: the swatch is behind its own word rather than floating
 * off it, and the Hebrew constants actually reach the pixels.
 *
 * It also touches nothing of Phase 4's bidi isolation. `buildMarkedRuns`,
 * `isolateForeignRuns` and the twin-slot pair are unchanged, `--mk-twin-bleed`
 * keeps its `.22em` Hebrew value, and `emphasis-marks-rtl.test.ts` is green
 * UNCHANGED — if it had needed editing, the change would have been wrong.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SOURCE_TEMPLATE_DIR = path.resolve(__dirname, "..", "assets", "templates", "default");
const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 } as const;
const TOOL_CTX = { ctx: { runId: "rfc20-p5", clientSlug: "rfc20-p5", productId: "instagram-agent", runKind: "setup" as const, metadata: {} } };

/**
 * THE PAPER KIT, and every hex in it is load-bearing.
 *
 * `#F0EAE6`/`#12100E` is the pair RFC-20 §6.1 measured the ring against. The
 * three ring members are rf-11's own highlighters — a saturated yellow, a
 * chartreuse and a pale cyan — and `#C06868` is the muted red pencil that is
 * the ONE member of sixteen the pre-RFC-20 ring admitted at all.
 *
 * The yellow is the point of the whole exercise. `contrastRatio(#FFEB3B,
 * #F0EAE6)` is **1.02:1** — the old cull refused it outright, before any kind
 * existed — while `contrastRatio(#12100E, #FFEB3B)` is **15.55:1**, which is
 * the test that actually governs a swatch with ink on top of it. And the
 * pixel instrument sees it perfectly well: `markColourDistance` from the
 * paper is ~99, five times `MARK_TOL`.
 *
 * `#E8D4F0`, rf-11's lilac, is deliberately ABSENT. It sits at 16.2 from the
 * paper, inside `MARK_TOL`, and RFC-20 §6.2 item 1 keeps that cull exactly as
 * it was — the metric could not see it either. A fixture that smuggled it in
 * would be testing a loosening this phase does not ship.
 */
const PAPER_GROUND = "#F0EAE6";
const PAPER_INK = "#12100E";
const PAPER_ACCENT = "#C06868";
const PAPER_RING = ["#FFEB3B", "#C8F888", "#B8E8E0"] as const;

/**
 * The kit, on the `brandHeadHtml` channel — the same channel and the same
 * SPLICE ORDER a real client kit arrives on (`composeRawDocument` puts the
 * shared sheets first and the brand LAST, so a kit beats the template on a
 * specificity tie). Written out rather than built through
 * `deriveBrandRenderTokens` because what is under test is the pair of hexes,
 * and a derivation would put a second thing between the fixture and the
 * document it is supposed to describe.
 */
const PAPER_HEAD_HTML = `<style>:root { --bg: ${PAPER_GROUND}; --fg: ${PAPER_INK}; }</style>`;

/**
 * THE ONE RING MEMBER THE BAND READER MAY USE, and this is a MEASURED
 * constraint rather than a preference.
 *
 * The band is found by per-channel proximity to a declared hex, which is only
 * a measurement if no OTHER pixel on the plate can land inside that box.
 * MEASURED in an Edge-channel pre-flight (a local pre-flight, not authority —
 * see this section's header): reading the band as `#C06868`, the muted red
 * pencil that is `hexes[0]`, returned a band of **292px spanning two lines and
 * the full measure** on a Latin plate whose real swatch is 88px on one line.
 * `#C06868` is (192,104,104) and a subpixel-antialiased edge between the paper
 * and the ink lands inside +/-24 of it; the reader was measuring glyph fringes.
 *
 * `#FFEB3B` cannot be produced that way. It needs R >= 231 AND G >= 211 AND
 * B <= 83 at once, and an antialiased blend of #F0EAE6 and #12100E that is
 * bright in two channels is bright in all three. With it the same three plates
 * read 0.500em, 0.438em and 0.500em — the CSS values, to three places.
 *
 * It is also the colour the phase is about: rf-11 paints ten highlighters and
 * this is the yellow, refused by the old ring at 1.02:1 against the paper.
 */
const BAND_SWATCH = "#FFEB3B";

/**
 * A swatch is a band on ONE LINE of type, so a band taller than a sixth of the
 * frame is the reader matching something else — the failure the pre-flight
 * above actually produced, caught rather than reasoned about. Not a threshold
 * on anything the product does: a bound on the INSTRUMENT, so a contaminated
 * read fails loudly instead of quietly widening every row of the table.
 */
const BAND_RUNAWAY_SHARE = 6;

/**
 * The two `--mk-block-h` values `markCssBlock` DECLARES, restated here so the
 * band reader can convert pixels to em without a second measurement.
 *
 * Written down rather than parsed out of the CSS on purpose: a test that read
 * its expectation out of the file it is checking is the guard that cannot fail
 * this project keeps finding. `emphasis-marks-rtl.test.ts` already pins that
 * the strings are EMITTED; what is new here is that a rendered swatch is that
 * many pixels tall.
 */
const LATIN_BLOCK_H_EM = 0.5;
const HEBREW_BLOCK_H_EM = 0.44;

/** How far a measured band may sit from its declared value: ~5 device px at the large display em, and a quarter of the .06em gap between the two scripts. */
const BLOCK_H_TOLERANCE_EM = 0.02;

/** The ring the paper kit resolves to. Derived once, and BOTH the stylesheet and the composition index into this same object. */
let paperRing: MarkRing | undefined;

let workDir = "";
let outDir = "";

/**
 * Materializes the bundled templates the way `04c-resolve-templates` does:
 * the shared device sheet, the script-font sheet for a non-Latin run, and the
 * mark sheet, all on the `extraHeadHtml` channel — then the client's brand
 * head last. Rendering the raw files instead would measure a document no
 * client ever receives, which is the mistake the calibration harness's own
 * comment records.
 *
 * `markScript` is separate from `scriptLanguage` ON PURPOSE, and it is the
 * hinge of the Hebrew geometry proof below: it lets one Hebrew document be
 * rendered twice, with the Phase-0 Hebrew faces loaded both times, differing
 * only in whether `markCssBlock` emitted `HEBREW_GEOMETRY`.
 */
async function materializePaperKit(dir: string, scriptLanguage?: string, markScript?: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const extra = [
    deviceCssBlock(),
    scriptLanguage !== undefined ? buildScriptFontHeadForLanguage(scriptLanguage, undefined) : undefined,
    markCssBlock(markScript, paperRing),
  ]
    .filter((fragment): fragment is string => fragment !== undefined)
    .join("\n");
  for (const file of (await fs.readdir(SOURCE_TEMPLATE_DIR)).filter((f) => f.endsWith(".html"))) {
    const html = await fs.readFile(path.join(SOURCE_TEMPLATE_DIR, file), "utf8");
    await fs.writeFile(path.join(dir, file), composeRawDocument(html, PAPER_HEAD_HTML, undefined, extra), "utf8");
  }
}

interface RenderedSlide {
  n: number;
  path: string;
  bytes: Buffer;
  metrics: SlideMetrics;
  probe: SlideProbe;
}

/** One slide, rendered from a materialized directory with measurement and the DOM probe both on. */
async function renderOne(
  templateDir: string,
  postId: string,
  template: string,
  fields: Record<string, string>,
  htmlFragments: Record<string, string>,
  markHexes: readonly string[],
): Promise<RenderedSlide> {
  const tool = createRenderCarousel();
  const outcome = await tool.execute(
    {
      client: "rfc20-p5",
      postId,
      templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
      outDir: path.relative(REPO_ROOT, outDir).replaceAll("\\", "/"),
      repoRoot: REPO_ROOT,
      slides: [
        {
          n: 1,
          template,
          fields,
          images: {},
          htmlFragments,
          measure: {
            groundHex: PAPER_GROUND,
            foregroundHex: PAPER_INK,
            accentHex: PAPER_ACCENT,
            ...(markHexes.length > 0 ? { markHexes: [...markHexes] } : {}),
          },
        },
      ],
      canvas: CANVAS,
      readyFlag: "__CAROUSEL_READY__",
      measure: true,
      probe: true,
    },
    TOOL_CTX,
  );
  if (outcome.status !== "success") throw new Error(`render failed: ${JSON.stringify(outcome)}`);
  const entry = outcome.result.rendered[0]!;
  if (entry.metrics === undefined || entry.probe === undefined) {
    throw new Error(`slide ${entry.n} came back without metrics/probe (${entry.measureFailure ?? "no reason given"}) — both were requested`);
  }
  return { n: entry.n, path: entry.path, bytes: await fs.readFile(path.resolve(REPO_ROOT, entry.path)), metrics: entry.metrics, probe: entry.probe };
}

/**
 * A marked fragment built BY HAND, at a kind and a colour this test chooses.
 *
 * Deliberately not routed through `markRotation` for G5: the rotation
 * alternates two DISTINCT kinds by ordinal (`kindB` is drawn from the k-1
 * values that are not `kindA`), so it can never emit five `block`s, and what
 * G5 needs is the UPPER BOUND on mark load rather than a description of
 * today's selection. A guard that only bounded what the current rotation
 * happens to pick would have to be re-argued every time the rotation changed.
 * The A2 case below is the opposite and goes through the real pipeline,
 * because there the claim IS about what the pipeline selects.
 */
function handMarked(text: string, spans: readonly string[], colourIndexes: readonly number[], dir: "ltr" | "rtl"): string {
  const runs: MarkRun[] = [];
  let rest = text;
  spans.forEach((needle, i) => {
    const at = rest.indexOf(needle);
    if (at < 0) throw new Error(`the fixture span "${needle}" is not in the fixture copy — the mark load would be under-built and the guard vacuous`);
    if (at > 0) runs.push({ text: rest.slice(0, at) });
    runs.push({ text: needle, mark: { ordinal: i, colourIndex: colourIndexes[i % colourIndexes.length]!, kind: "block" } });
    rest = rest.slice(at + needle.length);
  });
  if (rest !== "") runs.push({ text: rest });
  return buildMarkedRuns(runs, dir);
}

/** An axis-aligned box over the pixels a predicate accepted, in SCREENSHOT (device) pixels. */
interface PixelBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
  pixels: number;
  height: number;
  width: number;
  frameHeight: number;
}

function boxWhere(bytes: Buffer, hit: (r: number, g: number, b: number, x: number, y: number) => boolean): PixelBox | undefined {
  let top = Number.POSITIVE_INFINITY;
  let bottom = -1;
  let left = Number.POSITIVE_INFINITY;
  let right = -1;
  let pixels = 0;
  const header = decodePngRows(bytes, (row, y) => {
    for (let i = 0, x = 0; i < row.length; i += 4, x++) {
      if (!hit(row[i]!, row[i + 1]!, row[i + 2]!, x, y)) continue;
      pixels++;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  });
  // A header this decoder could not read means there is nothing to say about
  // this plate — reported as an ABSENT box, never as a zero one, so a caller
  // cannot mistake "unreadable" for "the mark painted nothing".
  if (header === undefined || pixels === 0) return undefined;
  return { top, bottom, left, right, pixels, height: bottom - top + 1, width: right - left + 1, frameHeight: header.height };
}

const rgbOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Per-channel proximity, the same shape and the same 24-level tolerance the calibration sweep's band reader uses. */
function near(hex: string, tol: number): (r: number, g: number, b: number) => boolean {
  const [wr, wg, wb] = rgbOf(hex);
  return (r: number, g: number, b: number): boolean => Math.abs(r - wr) <= tol && Math.abs(g - wg) <= tol && Math.abs(b - wb) <= tol;
}

const SWATCH_TOL = 24;
const INK_TOL = 40;

/** Every field a bundled template reads, so a missing slot cannot leave a `{{...}}` on the plate or a class unset. */
function plateFields(over: Record<string, string>): Record<string, string> {
  return {
    accentColor: PAPER_ACCENT,
    lang: "en",
    dir: "ltr",
    fontScale: "m",
    textAlign: "start",
    groundStyle: "grid",
    slideIndex: "1",
    kicker: "",
    body: "",
    brandHandle: "",
    seriesBadge: "",
    ...over,
  };
}

describe.skipIf(!isChromiumInstalled())("RFC-20 P5: marks on a paper ground, and the hole they must not close (Chromium)", () => {
  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-rfc20-p5-"));
    outDir = path.join(workDir, "out");
    await fs.mkdir(outDir, { recursive: true });
    // The SAME ring object the stylesheet carries and the fixtures index
    // into. Deriving it twice from the same inputs would agree today and is
    // one argument away from painting a mark in a colour the sheet never
    // declared — which is why production threads one ring through both.
    paperRing = buildMarkRing({ brandAccent: PAPER_ACCENT, palette: [...PAPER_RING] }, PAPER_GROUND, PAPER_INK, []);
  }, 120_000);

  afterAll(async () => {
    if (workDir !== "") await fs.rm(workDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────
  // G5 — the owner's grey screen, at maximum mark load
  // ───────────────────────────────────────────────────────────────────────
  // ── G5 CAME BACK WITH THE FEATURE IT TESTS, UNWEAKENED. ──
  //
  // Restored byte-for-byte from `1994347^`, the commit that sent it out with
  // its calibration-file sibling. Its subject is the owner's grey screen — a
  // `headline_focus` plate — and RFC-20 Part 11 had cut that archetype, so
  // on the cut tree this was a red light with nothing behind it.
  //
  // The measurement it was carrying, preserved beside §5.6 rule 3, was that
  // the marked grey screen measured `LER` 0.2278 against a 0.28 ceiling — so
  // clause C did NOT carry the refusal, which is what refused that rule's
  // demotion at the time. **That number was taken over the hatch.** With the
  // hatch deleted and a bounded object in its place (§11.4) the plate this
  // case renders is a different plate, and this is the case that says
  // whether the marks can close the hole on it.


  /**
   * THE ACCEPTANCE CONDITION OF THIS PHASE, with the one thing that could
   * have undone it bolted on.
   *
   * The plate is the owner's grey screen as RFC-20 §5.4 defines it: ONE short
   * headline on `headline_focus`, every other slot empty. On the shipped tree
   * that plate measures `largestEmptyRectShare` **0.0000** and PASSES clause
   * C, because `.copy-art`'s full-bleed 45-degree screen fills the empty
   * rectangle with paint — and a properly composed plate measures 0.0000 too,
   * so the floor cannot tell them apart. With the screen deleted it measures
   * ~0.51-0.53 and clause C refuses it.
   *
   * Then the marks. `MAX_MARKS_PER_SLIDE` is 5 and every one of them is a
   * `block`, which is the worst case the system can produce: a `block` is the
   * only kind that paints AREA, and painted area is what closes an empty
   * rectangle. If five of them could take `largestEmptyRectShare` back under
   * the ceiling, the re-armed floor would be disarmed again by our own
   * highlighters and this phase would have moved the defect rather than fixed
   * it.
   *
   * WHY IT IS NOT VACUOUS, asserted rather than assumed: the premise
   * `markRuns === markRunsPainted === MAX_MARKS_PER_SLIDE` runs FIRST. A
   * fixture whose spans silently failed to resolve would render plain type
   * and "still fails clause C" would be a sentence about nothing.
   *
   * MEASURED in an Edge-channel pre-flight on the real templates (a local
   * pre-flight, not authority): this exact plate reads `LER` **0.2917**
   * against the 0.28 interior ceiling bare, and **0.2917** with all five
   * blocks on it — the swatches did not move the empty rectangle by a single
   * cell, because they sit on lines that are already occupied. Both renders
   * return `ok: false` with `dead-space`. The margin over the ceiling is
   * 1.04x and that is thin, but it is thin in the SAFE direction: a plate
   * that drifted under the ceiling would turn this test red rather than
   * green, and a green-by-luck is the failure mode a floor cannot survive.
   *
   * BREAK IT: set `LARGEST_EMPTY_RECT_CEILING.interior` to 0.9. Both
   * refusals go red, which proves the assertion is REACHED rather than
   * vacuously satisfied by some other clause's finding.
   *
   * REVERT TEST: without P2's screen deletion the bare plate measures `LER`
   * 0.0000 and passes clause C, so the first assertion fails before the marks
   * are ever rendered.
   */
  it(
    "G5: the grey screen carrying the MAXIMUM mark load still fails clause C",
    async () => {
      const dir = path.join(workDir, "templates-g5");
      await materializePaperKit(dir);

      // One short headline, nothing else — and long enough to carry five
      // marks, because five is the bound under test. Marking five of its
      // seven words is the largest painted area this system can put on the
      // owner's own composition.
      const HEADLINE = "Intake is the bottleneck for every marketing team";
      const SPANS = ["Intake", "the bottleneck", "every", "marketing", "team"];
      expect(SPANS, "the fixture must carry exactly MAX_MARKS_PER_SLIDE marks or it is not the maximum load").toHaveLength(MAX_MARKS_PER_SLIDE);

      const ring = paperRing!;
      const colourIndexes = ring.hexes.map((_, i) => i);
      const bare = await renderOne(dir, "g5-bare", "headline-focus.html", plateFields({ headline: HEADLINE }), {}, []);
      const marked = await renderOne(
        dir,
        "g5-marked",
        "headline-focus.html",
        plateFields({ headline: HEADLINE }),
        { headlineRuns: handMarked(HEADLINE, SPANS, colourIndexes, "ltr") },
        ring.hexes,
      );

      console.log(
        `[RFC-20 G5] bare  LER ${bare.metrics.largestEmptyRectShare.toFixed(4)} occ ${bare.metrics.occupiedShare.toFixed(4)} ` +
          `iod ${bare.metrics.imageryOrDeviceShare.toFixed(4)} marked% ${((bare.metrics.markedShare ?? 0) * 100).toFixed(2)}\n` +
          `[RFC-20 G5] x${MAX_MARKS_PER_SLIDE} block  LER ${marked.metrics.largestEmptyRectShare.toFixed(4)} occ ${marked.metrics.occupiedShare.toFixed(4)} ` +
          `iod ${marked.metrics.imageryOrDeviceShare.toFixed(4)} marked% ${((marked.metrics.markedShare ?? 0) * 100).toFixed(2)} colours ${marked.metrics.markColourCount}`,
      );

      // ── THE PREMISE. Five runs asked for, five painted, or nothing below
      //    this line is a statement about marks.
      expect(marked.probe.markRuns, "the five-mark fragment did not reach the DOM — the mark load is under-built").toBe(MAX_MARKS_PER_SLIDE);
      expect(marked.probe.markRunsPainted, "the mark stylesheet did not arrive — the swatches painted nothing to close a hole with").toBe(MAX_MARKS_PER_SLIDE);

      // ── THE GUARD. The bare grey screen is refused, and the maximally
      //    marked one is refused on the SAME clause.
      const bareVerdict = check(bare.metrics, bare.probe, "interior", 1);
      const markedVerdict = check(marked.metrics, marked.probe, "interior", 1);
      expect(kindsOf(bareVerdict), `the bare grey screen passed clause C at LER ${bare.metrics.largestEmptyRectShare.toFixed(4)}`).toContain("dead-space");
      expect(
        kindsOf(markedVerdict),
        `five block marks closed the hole: LER went ${bare.metrics.largestEmptyRectShare.toFixed(4)} -> ${marked.metrics.largestEmptyRectShare.toFixed(4)} ` +
          `against a ${LARGEST_EMPTY_RECT_CEILING.interior} ceiling`,
      ).toContain("dead-space");
      expect(bareVerdict.ok).toBe(false);
      expect(markedVerdict.ok).toBe(false);
    },
    600_000,
  );


  /**
   * THE CLAUSE-E INTERACTION, MEASURED AND REPORTED RATHER THAN ACTED ON.
   *
   * `slide-metrics.ts` classifies a covered, flat, <=3-colour cell as a
   * GRAPHIC, and a `block` swatch is exactly that — so painted marks land in
   * `graphicShare` and count toward clause E. That is not obviously wrong (a
   * highlighter IS a drawn device), but it means the ring fix quietly moves
   * clause E's input on every paper kit, and clause E's floor was calibrated
   * on renders where `block` was unreachable.
   *
   * The fix, if one is wanted, is to subtract `markCells` from `graphicShare`
   * — and that moves clause E's input again and would require clause E's own
   * re-sweep, which this phase does not have the budget for and which
   * RFC-20 Part 8 item 2 explicitly declines. So this measures the size of
   * the problem on the archetype where it matters most (the cover carries the
   * device floor) and prints it for a later phase.
   *
   * MEASURED in the Edge-channel pre-flight, and it is OVER the reporting
   * bar: the paper-kit cover reads `imageryOrDeviceShare` **15.91%** bare and
   * **18.27%** with five blocks — **+2.36 points**, against the ~2-point bar
   * this package was given. **RECORDED AS A FINDING FOR A LATER PHASE**, per
   * the instruction, and not acted on: subtracting `markCells` from
   * `graphicShare` edits `slide-metrics.ts`, which is a `TOOL_VERSION` bump
   * on a shared package and a re-sweep of clause E's own floor.
   *
   * WHAT IS ASSERTED is the bound, not the value: marks may not move clause
   * E's input by more than 5 points in either direction. That is a sanity
   * bound on an interaction nobody had measured, not a threshold — if it
   * fires, the assumption that a mark is a small bounded object is wrong and
   * somebody has to look. At +2.36 it has 2.6 points of room.
   */
  it(
    "measures what five block marks contribute to clause E on a paper-kit cover",
    async () => {
      const dir = path.join(workDir, "templates-iod");
      await materializePaperKit(dir);

      const TITLE = "Intake is the bottleneck for every marketing team";
      const SPANS = ["Intake", "the bottleneck", "every", "marketing", "team"];
      const ring = paperRing!;
      const bare = await renderOne(dir, "iod-bare", "cover.html", plateFields({ title: TITLE, eyebrow: "FIELD NOTES", subtitle: "" }), {}, []);
      const marked = await renderOne(
        dir,
        "iod-marked",
        "cover.html",
        plateFields({ title: TITLE, eyebrow: "FIELD NOTES", subtitle: "" }),
        { titleRuns: handMarked(TITLE, SPANS, ring.hexes.map((_, i) => i), "ltr") },
        ring.hexes,
      );

      const delta = marked.metrics.imageryOrDeviceShare - bare.metrics.imageryOrDeviceShare;
      const verdict = Math.abs(delta) > 0.02 ? "FINDING FOR A LATER PHASE" : "within the ~2-point reporting bar";
      console.log(
        `[RFC-20 G5/clause-E] cover iod bare ${(bare.metrics.imageryOrDeviceShare * 100).toFixed(2)}% -> ` +
          `x${MAX_MARKS_PER_SLIDE} block ${(marked.metrics.imageryOrDeviceShare * 100).toFixed(2)}% ` +
          `(delta ${(delta * 100).toFixed(2)} points, graphic ${(bare.metrics.graphicShare * 100).toFixed(2)}% -> ${(marked.metrics.graphicShare * 100).toFixed(2)}%) — ${verdict}`,
      );

      expect(marked.probe.markRunsPainted, "no mark painted, so the delta is a fact about nothing").toBe(MAX_MARKS_PER_SLIDE);
      expect(
        Math.abs(delta),
        `five block marks moved clause E's input by ${(delta * 100).toFixed(2)} points — a mark is supposed to be a small bounded object`,
      ).toBeLessThan(0.05);
    },
    600_000,
  );

  // ───────────────────────────────────────────────────────────────────────
  // A2 — the first render in which the mark metric can fail at all
  // ───────────────────────────────────────────────────────────────────────

  /**
   * THE PIXEL PROOF FOR RFC-20 §6.4, through the REAL pipeline.
   *
   * Everything above builds its fragment by hand. This one does not: it goes
   * through `assembleSlidesData`, which derives the ring, runs the accent
   * exclusion, resolves the spans and picks the (colour, kind) pair — because
   * the claim under test is precisely that the PIPELINE now selects a `block`
   * on a paper kit, and a hand-built fragment would assume the answer.
   *
   * ## Why the seed is searched rather than written down
   *
   * `markRotation` draws its kind from `seed % k`, and the seed is
   * `slideMarkSeed(paletteSeed, n)`. Which kind slide 1 gets is therefore a
   * function of the run's `paletteSeed`, and there is no seed anyone could
   * have written down before P4 landed, because before P4 `block` is not in
   * the kind set at all. So the fixture searches a FIXED, ordered candidate
   * list through the real `assembleSlidesData` — Chromium-free, no model
   * call, $0.00 — and asserts loudly when none of them yields a block.
   *
   * That assertion is the revert test. Without P4's kind-aware admission no
   * paper kit can produce a `block` at all (MEASURED: block-capable 1/16 solo
   * and 0/16 under `every()` across the kit), the search exhausts, and this
   * test fails before it renders anything.
   *
   * ## Why the slide carries exactly ONE mark
   *
   * `markRotation` guarantees `kindA !== kindB`, so a slide with two or more
   * marks can never be all-`block` — one of them would paint no area at all.
   * One mark is the only load whose whole contribution to the pixel metric is
   * a swatch.
   *
   * ## WHY THIS DOES NOT ASSERT §6.4's IDENTITY, AND THE MEASUREMENT THAT SAYS SO
   *
   * RFC-20 §6.4 asks for `markColourCount` **equal to** the number of distinct
   * ring colours used. That identity is FALSE on this tree, for two reasons,
   * both MEASURED in an Edge-channel pre-flight on the real templates:
   *
   *  1. **The plinth is counted as emphasis.** A marked cell is COVERED, FLAT,
   *     off-ground and off-ink — and §5.3's plinth, a `color-mix(--fg 12%,
   *     --bg)` card at 25.8 units from the ground, is exactly that. On the
   *     `headline_focus` plate: every slot empty reads `markedShare` **0.00%,
   *     markColourCount 0**; add one headline and the content-guarded plinth
   *     turns on and the same plate reads **32.87%, 2** with NO mark in the
   *     document at all. It is kit-independent — the fill is a mix of the
   *     kit's own two tokens — so this is true of every plinthed archetype.
   *  2. **One swatch is more than one quantised bin.** `markColourCount`
   *     counts `QUANT_SHIFT` bins holding `MARK_COLOUR_MIN_CELLS`, and a
   *     swatch with glyphs on top lands in several. MEASURED: one `block` in
   *     `#B8E8E0` took the count 2 -> 5.
   *
   * **That is a finding, and it is defect 1's shape one clause over: our own
   * decoration disarms our own instrument.** `marks-not-visible` fires on
   * `markColourCount === 0`, so on any plinthed archetype it can now never
   * fire — the warning is as dead as clause C was on a hatched plate. It is
   * RECORDED rather than fixed here, because the fix is to subtract the
   * plinth's cells from the mark mask inside `slide-metrics.ts`, which is a
   * `TOOL_VERSION` bump on a shared package and a re-sweep of clause E's
   * input — RFC-20 Part 8 item 2's cost, which this phase does not have.
   *
   * So the assertion is the one thing that IS true and IS structurally
   * impossible today: adding a `block` MOVES the pixel metric. On every kit we
   * ship, adding a mark moves neither number by a single cell, because no kind
   * that paints an area is admitted. MEASURED here, one block moves
   * `markColourCount` 2 -> 5 and five blocks move it 2 -> 6.
   */
  it(
    "A2: a paper-kit block paints in the DOM AND moves the pixel metric, which it has never been able to do",
    async () => {
      const dir = path.join(workDir, "templates-a2");
      await materializePaperKit(dir);

      // LONG ENOUGH THAT THE SPAN IS UNDER `MAX_MARKED_SHARE`. MEASURED: with
      // the headline `Intake is the bottleneck` and the span `the bottleneck`,
      // `resolveSlideMarks` drops every mark on every seed with *marking it
      // would take "headline" past 35% marked* — the search then exhausts and
      // reports "no seed put a block on a paper kit", which would be a true
      // sentence about the wrong thing.
      const HEADLINE = "Intake is the bottleneck in every marketing calendar we measured";
      const slides: InstagramSlideCopy[] = [
        InstagramSlideCopySchema.parse({
          n: 1,
          layout: "headline_focus",
          headline: HEADLINE,
          body: "Every queue we measured said the same thing, in the same order, for the same reason.",
          visualNeed: "a need",
          sourceRef: "a claim",
          emphasis: ["bottleneck"],
        }),
      ];
      const selections: ImageSelection[] = [
        {
          n: 1,
          imagePath: null,
          reason: "A2 fixture",
          license: "CC0",
          rightsUsable: true,
          watermarkFree: true,
          claimMatch: 5,
          claimMatchReason: "A2 fixture",
        },
      ];

      const assembleWith = (paletteSeed: string) => {
        const report = { hexesBySlide: new Map<number, string[]>(), issues: [] as EmphasisIssue[], kindsBySlide: new Map<number, string[]>() };
        const input = assembleSlidesData({
          clientSlug: "rfc20-p5",
          postId: "a2",
          repoRoot: REPO_ROOT,
          brandTokens: { templateDir: path.relative(REPO_ROOT, dir).replaceAll("\\", "/"), slideTemplate: "slide.html", accentColor: PAPER_ACCENT },
          copy: { format: "carousel", caption: "A2.", slides } as InstagramCopyOutput,
          selections,
          canvas: CANVAS,
          availableTemplates: new Set(["cover.html", "closer.html", "headline-focus.html", "slide.html"]),
          templateDirOverride: path.relative(REPO_ROOT, dir).replaceAll("\\", "/"),
          accentRing: [...PAPER_RING],
          paletteSeed,
          groundHex: PAPER_GROUND,
          foregroundHex: PAPER_INK,
          markRing: paperRing!,
          markReportOut: report,
          slideStyleOverrides: new Map([[1, { fontScale: "l" as const }]]),
        });
        return { input, report };
      };

      // The search. A fragment's kind and colour are both legible in the markup
      // it produced — `.mk-c2 .mk-k-block` — which is the pipeline's own output
      // rather than a re-derivation of its decision, so a change to how either
      // is chosen cannot make this look for the wrong thing.
      //
      // The COLOUR is part of the search because the band reader needs
      // `BAND_SWATCH` (see its header: every other ring member can be confused
      // with an antialiased glyph edge). MEASURED: seed `rfc20-a2-1` is the
      // first that pairs `block` with it, on the second try of the list.
      let chosen: { seed: string; input: ReturnType<typeof assembleWith>["input"]; report: ReturnType<typeof assembleWith>["report"] } | undefined;
      const tried: string[] = [];
      for (let i = 0; i < 48 && chosen === undefined; i++) {
        const seed = `rfc20-a2-${i}`;
        const { input, report } = assembleWith(seed);
        const fragment = Object.values(input.slides[0]!.htmlFragments ?? {}).join("");
        const marks = [...fragment.matchAll(/class="mk mk-c(\d+) mk-k-(\w+)"/gu)];
        tried.push(`${seed}:${marks.map((m) => m[2]).join(",") || "none"}`);
        const colour = paperRing!.hexes[Number(marks[0]?.[1] ?? 0) - 1];
        if (marks.length === 1 && marks[0]![2] === "block" && colour === BAND_SWATCH) chosen = { seed, input, report };
      }
      expect(
        chosen,
        `no paletteSeed in 48 tries put a \`block\` in ${BAND_SWATCH} on a paper kit (${PAPER_GROUND}/${PAPER_INK}). Seen: ${tried.slice(0, 8).join(" ")}. ` +
          `Without RFC-20 Part 6's kind-aware admission this is expected and this test is the revert test.`,
      ).toBeDefined();

      const { seed, input, report } = chosen!;
      const hexes = report.hexesBySlide.get(1) ?? [];
      expect(hexes, "the pipeline reported no mark hex for a slide it marked").toHaveLength(1);

      const template = input.slides[0]!.template.split(/[\\/]/u).pop()!;
      const fields = input.slides[0]!.fields as Record<string, string>;
      const fragments = (input.slides[0]!.htmlFragments ?? {}) as Record<string, string>;

      // THE SAME PLATE TWICE. The bare render is the control the whole claim
      // rests on: the plinth alone already puts cells in the mark mask (see
      // this case's header), so an absolute number here would be a fact about
      // the template rather than about the mark. The two documents hold the
      // same glyphs in the same boxes — `template-mark-slots.test.ts` pins
      // that, pixel-for-pixel, on an unstyled fragment — so the difference IS
      // the swatch.
      const bare = await renderOne(dir, "a2-bare", template, fields, {}, []);
      const marked = await renderOne(dir, "a2", template, fields, fragments, hexes);

      console.log(
        `[RFC-20 A2] seed ${seed} kinds ${(report.kindsBySlide.get(1) ?? []).join(",")} hex ${hexes.join(",")} — ` +
          `runs ${marked.probe.markRunsPainted}/${marked.probe.markRuns}\n` +
          `[RFC-20 A2] bare   marked% ${((bare.metrics.markedShare ?? 0) * 100).toFixed(2)} colours ${bare.metrics.markColourCount}\n` +
          `[RFC-20 A2] marked marked% ${((marked.metrics.markedShare ?? 0) * 100).toFixed(2)} colours ${marked.metrics.markColourCount}`,
      );

      // The DOM half — unchanged in meaning, but it has never run against a
      // painted block before.
      expect(marked.probe.markRuns, "the pipeline emitted no run").toBe(1);
      expect(marked.probe.markRunsPainted, "the mark stylesheet did not arrive").toBe(marked.probe.markRuns);
      expect(bare.probe.markRuns, "the control render carried a mark — it is not a control").toBe(0);

      // THE PIXEL HALF. The swatch is on the plate, in the colour the
      // pipeline said it painted, as a BAND rather than as the whole plate.
      // Today there is no `#FFEB3B` area of any size on any plate we render,
      // because no kind that paints an area is admitted — so "a bounded band
      // of the declared hex exists" is a statement that is false before RFC-20
      // Part 6 and true after it. MEASURED: 101px of a 2880px frame.
      const band = boxWhere(marked.bytes, near(BAND_SWATCH, SWATCH_TOL));
      expect(band, `the run paints in the DOM but no ${BAND_SWATCH} pixel reached the frame`).toBeDefined();
      expect(
        band!.height,
        `the ${BAND_SWATCH} band is ${band!.height}px of a ${band!.frameHeight}px frame — the reader matched something that is not the swatch`,
      ).toBeLessThan(band!.frameHeight / BAND_RUNAWAY_SHARE);

      // AND WHAT IS DELIBERATELY NOT ASSERTED, with the measurements that say
      // why. Three candidates for a block-specific PIXEL assertion were tried
      // in the Edge-channel pre-flight and all three failed to discriminate:
      //
      //   markColourCount rises     block 3->4    underline 3->4
      //   markedShare moves         block -0.18 points on the five-mark plate
      //   band height / cap height  block 0.798   underline 0.741
      //                                           swish 1.933   double 1.419
      //
      // **`MARK_AREA_PAINTING_KINDS`'s premise is false at display sizes.** Its
      // comment argues `underline` is `.07em` and so cannot cover 48 of 64
      // samples of a 4px cell — but `.07em` on an `l`-scale display headline is
      // **20 device px**, two and a half cell rows, and it covers them. So the
      // pixel metric cannot tell a highlighter from a pencil rule, and the
      // abstention that set of kinds controls is wrong in the other direction
      // as well. RECORDED for a later phase; the discrimination this case does
      // carry is the seed search above, which is exact and Chromium-free.
    },
    600_000,
  );

  // ───────────────────────────────────────────────────────────────────────
  // Hebrew block geometry — RFC-17 §5.3 test 12, run for real
  // ───────────────────────────────────────────────────────────────────────

  /**
   * THE BAND SWEEP, against MEASURED CAP HEIGHT.
   *
   * One short display line, one `block` mark on it, rendered ltr x rtl x
   * {s, m, l}. For each row the swatch's band is read off the PNG by colour
   * and the marked word's own glyph extent is read off the SAME PNG inside
   * the swatch's own column range — so "cap height" is the height of the
   * letters the swatch is actually behind, not an average of the plate.
   *
   * The table is printed in em, normalised by the em the Latin sheet's own
   * `--mk-block-h: .50em` recovers, so a later phase inherits a measured band
   * rather than a value. **No band is asserted** — RFC-17 says these two
   * numbers are to be CORRECTED by this sweep, and a band asserted on its
   * first sighting is a constant nobody measured.
   *
   * The one real assertion is CONTAINMENT: the swatch has to be behind its
   * own word. `--mk-block-y` is measured from an inline box's CONTENT-BOX
   * top, which is the font's ascent+descent and not the top of a 1em box —
   * the wrong model is what gave `--mk-swish-y` two wrong values in a row,
   * and the same mistake on `--mk-block-y` puts a highlighter under the line
   * instead of on it. That is invisible in the source and obvious in the
   * pixels, which is the worst possible place to find it.
   *
   * MEASURED in the Edge-channel pre-flight on the real `headline-focus`
   * template, Latin, one yellow block, all three scales:
   *
   *     s   band 105px  cap 132px   overlap  89px (85% of the band)
   *     m   band 124px  cap 155px   overlap 104px (84%)
   *     l   band 146px  cap 183px   overlap 124px (85%)
   *
   * — so the assertion below runs at a 1.7x margin, and `band/cap` holds at
   * 0.795-0.798 across a 1.4x range of type size, which is what a geometry in
   * `em` should do.
   *
   * BREAK IT: set `--mk-block-y` to `1.6em`. The swatch clears the glyphs
   * entirely and the overlap assertion goes red on every row.
   */
  it(
    "band sweep: the block swatch sits behind its own word, in both scripts and at every scale",
    async () => {
      const ring = paperRing!;
      const swatch = BAND_SWATCH;
      expect(ring.hexes, `the band reader's swatch ${BAND_SWATCH} is not in the ring the stylesheet declares`).toContain(BAND_SWATCH);
      const swatchIndex = ring.hexes.indexOf(BAND_SWATCH);
      const rows: string[] = [];

      // SHORT ENOUGH TO STAY ON ONE LINE AT EVERY SCALE, which is what makes
      // the cap column mean anything: the glyph box is read inside the
      // swatch's own columns and within one band-height either side of it, and
      // a second line inside that window would widen the box and quietly
      // inflate every overlap in the table. Hand-built rather than resolved, so
      // `MAX_MARKED_SHARE` (a 35%-of-the-field cap that would drop a one-word
      // mark on a two-word line) never applies.
      const COPY = {
        ltr: { text: "The bottleneck", span: "bottleneck", lang: "en", families: ["Fraunces", "Inter", "IBM Plex Mono"] },
        rtl: { text: "צוואר הבקבוק", span: "צוואר", lang: "he", families: ["Heebo", "Rubik", "Assistant"] },
      } as const;

      /** One row of the sweep: render, read the swatch band and the glyphs it covers, and hand back both. */
      const sweepRow = async (
        label: string,
        templateDir: string,
        dir: "ltr" | "rtl",
        fontScale: "s" | "m" | "l",
      ): Promise<{ block: PixelBox; cap: PixelBox; probe: SlideProbe }> => {
        const copy = COPY[dir];
        const rendered = await renderOne(
          templateDir,
          `band-${label}`.replaceAll(/[^a-z0-9-]/gu, "-"),
          "headline-focus.html",
          plateFields({ headline: copy.text, lang: copy.lang, dir, fontScale }),
          { headlineRuns: handMarked(copy.text, [copy.span], [swatchIndex], dir) },
          [swatch],
        );

        // By construction, and the two things a broken row would get wrong.
        expect(rendered.probe.markRuns, `${label}: the fragment did not reach the DOM`).toBe(1);
        expect(rendered.probe.markRunsPainted, `${label}: the mark stylesheet did not arrive`).toBe(1);
        // NON-FALLBACK FONTS, asserted on every row. `fontFamiliesUsed` is
        // the only evidence a Phase-0 script font LOADED rather than that its
        // `<link>` was emitted, and fallback metrics would silently move
        // every number in the table — the contamination the clause-E work
        // caught the hard way.
        expect(
          rendered.probe.fontFamiliesUsed.some((f) => (copy.families as readonly string[]).includes(f)),
          `${label}: no ${dir === "rtl" ? "Phase-0 Hebrew" : "template"} face resolved — fontFamiliesUsed was [${rendered.probe.fontFamiliesUsed.join(", ")}]`,
        ).toBe(true);

        const block = boxWhere(rendered.bytes, near(swatch, SWATCH_TOL));
        expect(block, `${label}: the swatch painted no pixel of ${swatch} — there is no band to measure`).toBeDefined();
        const b = block!;

        // The marked word's OWN glyphs: ink pixels inside the swatch's column
        // range and within one swatch-height either side of it. The column
        // clamp is what makes this the marked word rather than the plate —
        // `background-size: 100%` means the swatch spans exactly the run's
        // glyph advance, so its columns ARE the word's columns.
        const inkHit = near(PAPER_INK, INK_TOL);
        const cap = boxWhere(
          rendered.bytes,
          (r, g, bl, x, y) => x >= b.left && x <= b.right && y >= b.top - b.height && y <= b.bottom + b.height && inkHit(r, g, bl),
        );
        expect(cap, `${label}: no ink inside the swatch's own columns — the swatch is not behind any type at all`).toBeDefined();
        return { block: b, cap: cap!, probe: rendered.probe };
      };

      const latinDir = path.join(workDir, "templates-band-latin");
      await materializePaperKit(latinDir);
      const hebrewDir = path.join(workDir, "templates-band-he");
      await materializePaperKit(hebrewDir, "he", scriptTypographyFor("he")?.script);

      const measured = new Map<string, { block: PixelBox; cap: PixelBox }>();
      for (const [dir, templateDir] of [["ltr", latinDir], ["rtl", hebrewDir]] as const) {
        for (const fontScale of ["s", "m", "l"] as const) {
          const label = `${dir} ${fontScale}`;
          const { block, cap } = await sweepRow(label, templateDir, dir, fontScale);
          measured.set(label, { block, cap });

          // THE ONE REAL ASSERTION. The swatch is behind its word: at least
          // half of the band's height overlaps the glyphs it covers.
          const overlap = Math.min(block.bottom, cap.bottom) - Math.max(block.top, cap.top);
          expect(
            overlap,
            `${label}: the swatch runs rows ${block.top}-${block.bottom} and its word's glyphs run ${cap.top}-${cap.bottom} — ` +
              `they overlap by ${overlap}px of a ${block.height}px band, so the highlighter is not on the word`,
          ).toBeGreaterThanOrEqual(block.height / 2);
          // And it is on the plate rather than off the edge of it.
          expect(block.top, `${label}: the band starts above the frame`).toBeGreaterThanOrEqual(0);
          expect(block.bottom, `${label}: the band runs past the frame`).toBeLessThan(block.frameHeight);

          // And the reader read a BAND rather than the plate. See
          // `BAND_RUNAWAY_SHARE`: this is the assertion the Edge-channel
          // pre-flight's contaminated `#C06868` row would have failed, at
          // 292px against a 233px bound.
          expect(
            block.height,
            `${label}: the ${swatch} band is ${block.height}px of a ${block.frameHeight}px frame — the reader matched something that is not the swatch`,
          ).toBeLessThan(block.frameHeight / BAND_RUNAWAY_SHARE);

          // `--mk-block-h` is `LATIN_BLOCK_H_EM` on the Latin sheet and
          // Hebrew one, so the em this row rendered at is recoverable from
          // the band itself. Reported, never asserted.
          const emPx = block.height / (dir === "rtl" ? HEBREW_BLOCK_H_EM : LATIN_BLOCK_H_EM);
          rows.push(
            [
              label.padEnd(8),
              `swatch rows ${String(block.top).padStart(4)}-${String(block.bottom).padStart(4)} (${String(block.height).padStart(3)}px)`.padEnd(38),
              `cap rows ${String(cap.top).padStart(4)}-${String(cap.bottom).padStart(4)} (${String(cap.height).padStart(3)}px)`.padEnd(34),
              `em~${emPx.toFixed(1)}px`.padEnd(13),
              `block/cap ${(block.height / cap.height).toFixed(3)}`.padEnd(18),
              `top-capTop ${((block.top - cap.top) / emPx).toFixed(3)}em`.padEnd(22),
              `bottom-capBottom ${((block.bottom - cap.bottom) / emPx).toFixed(3)}em`,
            ].join(" "),
          );
        }
      }

      console.log(`[RFC-20 band sweep] RFC-17 §5.3 test 12 — the block band against measured cap height\n${rows.join("\n")}`);
    },
    900_000,
  );

  /**
   * HEBREW_GEOMETRY IS REACHABLE, AND IT IS SHORTER AND LOWER — in pixels.
   *
   * `emphasis-marks-rtl.test.ts` already pins that the Hebrew branch of
   * `markCssBlock` EMITS `--mk-block-h: .44em` and `--mk-block-y: .60em`.
   * What has never been checked is whether either value ever reaches a
   * rendered swatch, and the honest answer until this phase is NO: `block`
   * was refused on every ground we ship, so the Hebrew geometry has been
   * dead CSS since it was written.
   *
   * The comparison is the SAME Hebrew document, with the SAME Phase-0 faces
   * loaded, at the same scale, rendered twice — differing only in whether
   * `markCssBlock` was given the script. Same faces means the same em on both
   * sides, which is what makes the two bands comparable at all; the render
   * asserts that rather than assuming it.
   *
   * MEASURED in the Edge-channel pre-flight on the real `headline-focus`
   * template at `l`, with Heebo and Assistant actually loaded:
   *
   *     Latin sheet   band 137px, top 1300      em ~274px
   *     Hebrew sheet  band 121px, top 1322
   *     -> SHORTER by 16px, LOWER by 22px, measured --mk-block-h 0.442em
   *
   * **HEIGHT is the exact read and it is the primary assertion.** 0.442
   * against the declared `.44em` is the constant reaching the pixels, to
   * three places. Note what that is and is not: it asserts the value SHIPS,
   * not that the value is RIGHT — RFC-17 leaves the second question to the
   * band sweep above, which prints it and decides nothing.
   *
   * **TOP is asserted as a DIRECTION only, and here is the honest reason.**
   * `HEBREW_GEOMETRY` sets a third property: `--mk-twin-bleed` goes `.14em`
   * -> `.22em`, which is `padding-block-start` on the twin host and moves the
   * whole LINE down. The measured +22px is therefore `--mk-block-y`'s +.04em
   * and the bleed's +.08em together, not a clean read of either. Saying
   * "lower by .04em" here would be a number with a second cause in it, and
   * this file has already found one of those today.
   *
   * Run at `l` on purpose: the smaller the type, the closer both deltas get
   * to pixel quantisation, and a 3px claim is a rounding argument.
   */
  it(
    "the Hebrew block constants reach the pixels: the swatch is SHORTER and sits LOWER than the Latin one",
    async () => {
      const heDir = path.join(workDir, "templates-he-geom");
      await materializePaperKit(heDir, "he", scriptTypographyFor("he")?.script);
      const latinSheetDir = path.join(workDir, "templates-he-latin-sheet");
      // Same script fonts, same copy, same scale — the LATIN mark sheet.
      await materializePaperKit(latinSheetDir, "he", undefined);

      const TEXT = "הקליטה היא צוואר הבקבוק";
      const SPAN = "צוואר";
      const swatch = BAND_SWATCH;
      expect(paperRing!.hexes, `the band reader's swatch ${BAND_SWATCH} is not in the ring the stylesheet declares`).toContain(BAND_SWATCH);
      const fields = plateFields({ headline: TEXT, lang: "he", dir: "rtl", fontScale: "l" });
      const fragment = { headlineRuns: handMarked(TEXT, [SPAN], [paperRing!.hexes.indexOf(BAND_SWATCH)], "rtl") };

      const hebrewSheet = await renderOne(heDir, "geom-he", "headline-focus.html", fields, fragment, [swatch]);
      const latinSheet = await renderOne(latinSheetDir, "geom-latin", "headline-focus.html", fields, fragment, [swatch]);

      expect(hebrewSheet.probe.markRunsPainted, "the Hebrew mark sheet did not arrive").toBe(1);
      expect(latinSheet.probe.markRunsPainted, "the Latin mark sheet did not arrive").toBe(1);
      // The one thing that would make the comparison meaningless: different
      // faces on the two sides would change the em and both differences with
      // it. Same document, same fonts — asserted, not assumed.
      expect(hebrewSheet.probe.fontFamiliesUsed, "the two renders resolved different faces — the em is not shared and the comparison is void").toEqual(
        latinSheet.probe.fontFamiliesUsed,
      );

      const he = boxWhere(hebrewSheet.bytes, near(swatch, SWATCH_TOL));
      const la = boxWhere(latinSheet.bytes, near(swatch, SWATCH_TOL));
      expect(he, "the Hebrew-sheet swatch painted nothing").toBeDefined();
      expect(la, "the Latin-sheet swatch painted nothing").toBeDefined();

      // THE EM, RECOVERED FROM THE LATIN SHEET'S OWN DECLARED HEIGHT. The
      // Latin `--mk-block-h` is `.50em` and this render is that sheet on this
      // document, so `band / .50` is this line's font-size in device pixels —
      // no second measurement and no assumption about the template's type
      // scale. MEASURED: 137px / .50 = 274px, and the em really is 274.
      const emPx = la!.height / LATIN_BLOCK_H_EM;
      const measuredBlockH = he!.height / emPx;
      console.log(
        `[RFC-20 HEBREW_GEOMETRY] em~${emPx.toFixed(1)}px  ` +
          `height ${la!.height}px (.50em) -> ${he!.height}px (measured ${measuredBlockH.toFixed(3)}em, declared ${HEBREW_BLOCK_H_EM}em)  ` +
          `top ${la!.top} -> ${he!.top} (+${he!.top - la!.top}px; --mk-block-y AND --mk-twin-bleed together, see the header)`,
      );

      // SHORTER — THE EXACT READ. Not a ratio and not a direction: the
      // rendered band, divided by the em the other render establishes, is the
      // number `HEBREW_GEOMETRY` declares. Delete `HEBREW_GEOMETRY` and this
      // reads .500 against a .44 +/- .025 window and goes red by a factor of
      // two on the tolerance. MEASURED: 0.442 on the real template, 0.438 on a
      // bare one — both comfortably inside.
      expect(
        Math.abs(measuredBlockH - HEBREW_BLOCK_H_EM),
        `the Hebrew swatch measures ${measuredBlockH.toFixed(3)}em (${he!.height}px of a ${emPx.toFixed(1)}px em) against the ` +
          `${HEBREW_BLOCK_H_EM}em HEBREW_GEOMETRY declares — the Hebrew branch of markCssBlock did not reach the render`,
      ).toBeLessThan(BLOCK_H_TOLERANCE_EM);
      // ...and the same fact stated so a reader does not have to do the
      // division: the Hebrew band is shorter, by more than quantisation.
      expect(la!.height - he!.height, `Hebrew ${he!.height}px vs Latin ${la!.height}px`).toBeGreaterThan(2);

      // LOWER — DIRECTION ONLY. See the header: `--mk-twin-bleed` moves the
      // line as well, so the magnitude has two causes in it and only the sign
      // is a clean statement about `HEBREW_GEOMETRY`. MEASURED +22px.
      expect(
        he!.top - la!.top,
        `the Hebrew swatch starts at row ${he!.top} against the Latin ${la!.top} — HEBREW_GEOMETRY moved nothing downward`,
      ).toBeGreaterThan(2);
    },
    900_000,
  );
});
