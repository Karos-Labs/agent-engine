import { describe, expect, it } from "vitest";
import {
  ACCENT_MAX_SHARE,
  ACCENT_MIN_SHARE,
  CLIPPED_EDGE_SHARE_CEILING,
  CONTENT_OCCUPIED_SHARE_FLOOR,
  DISPLAY_TYPE_SCALE_FLOOR,
  FLAT_BACKGROUND_CEILING,
  FULL_BLEED_IMAGERY_SHARE,
  CLOSER_IMAGERY_OR_DEVICE_FLOOR,
  CONTENT_ELEMENT_FLOOR,
  IMAGERY_OR_DEVICE_FLOOR,
  INK_SHARE_FLOOR,
  INTEREST_FINDING_SEPARATOR,
  LARGEST_EMPTY_RECT_CEILING,
  OCCUPIED_SHARE_FLOOR,
  PROBE_TEXT_BOX_SHARE_FLOOR,
  TEXT_SHARE_CEILING,
  checkInterestFloor,
  checkSlidesInterestFloor,
  formatInterestFailures,
  interestDegradedReason,
  interestSteerFor,
  slideRoleFor,
  summarizeInterestFindings,
  type InterestFinding,
  type SlideMetrics,
  type SlideRole,
} from "../src/workflow/interest-floor.js";
import {
  deviceFromText,
  figuresInText,
  planInterestRelayout,
  type InterestRelayoutChange,
} from "../src/workflow/interest-relayout.js";
import {
  SIX_RESEARCH_FACTS,
  boringSlideMetrics,
  decoratedEmptySlideMetrics,
  goodCopyOutput,
  goodImageVettingOutput,
  passingSlideMetrics,
  passingSlideProbe,
} from "./test-helpers.js";
import type { ImageSelection, InstagramCopyOutput } from "../src/workflow/types.js";

/**
 * RFC-14 item L — the visual-interest floor, as policy.
 *
 * Pure: hand-built `SlideMetrics`, no Chromium, no PNG, no workflow. The
 * companion Chromium-gated calibration test is what proves the CONSTANTS are
 * right against real renders; this file proves the RULE is right — that each
 * clause fires on its own number and on nothing else, that a legitimate bold
 * type poster survives it, and that the sentences a failure sends back to the
 * writer carry the numbers.
 */

const EPS = 0.001;

/** A slide that clears every clause at every role, as the base to break one field of. */
function metrics(overrides: Partial<SlideMetrics> = {}): SlideMetrics {
  return passingSlideMetrics(overrides);
}

/**
 * The same base with NO SUBJECT: no imagery, no drawn device.
 *
 * Since 2026-09-14 clause C abstains on a plate that carries a subject — a
 * large quiet region is composition when something is in frame and neglect
 * when nothing is (`plateSubject`). `passingSlideMetrics` carries
 * `imageryOrDeviceShare` 0.34, so every clause-C case has to say explicitly
 * that its plate is bare, or it is testing the waiver rather than the clause.
 *
 * `passingSlideProbe` reports no `displayTypeScale`, so the type limb abstains
 * here too and the plate has neither.
 */
function bare(overrides: Partial<SlideMetrics> = {}): SlideMetrics {
  return passingSlideMetrics({ imageryShare: 0, graphicShare: 0, imageryOrDeviceShare: 0, ...overrides });
}

function check(m: SlideMetrics, role: SlideRole, slide = 3, opts: { downgradedForImages?: ReadonlySet<number> } = {}) {
  return checkInterestFloor(m, passingSlideProbe(slide), role, { slide, ...opts });
}

function kinds(verdict: { findings: InterestFinding[] }): string[] {
  return verdict.findings.map((f) => f.kind);
}

describe("checkInterestFloor: the baseline", () => {
  it("passes a realistic photo-bearing slide at every role, with no findings and no warnings", () => {
    for (const role of ["cover", "interior", "closer"] as const) {
      const verdict = check(metrics(), role);
      expect(verdict.ok, `role ${role}`).toBe(true);
      expect(verdict.findings).toEqual([]);
      expect(verdict.warnings).toEqual([]);
    }
  });

  it("echoes the metrics it judged, so the gate payload carries the evidence and not just the verdict", () => {
    const m = metrics();
    expect(check(m, "interior").metrics).toBe(m);
  });

  it("assigns roles from carousel position: slide 1 is the cover, the last is the closer, a single-slide post is a cover", () => {
    expect(slideRoleFor(0, 6)).toBe("cover");
    expect(slideRoleFor(1, 6)).toBe("interior");
    expect(slideRoleFor(4, 6)).toBe("interior");
    expect(slideRoleFor(5, 6)).toBe("closer");
    expect(slideRoleFor(0, 1)).toBe("cover");
  });
});

describe("checkInterestFloor: every clause fires alone", () => {
  it("A — integrity: almost no ink is a broken render, and it short-circuits every other clause", () => {
    // Deliberately ALSO empty, ALSO holed, ALSO device-free: one broken
    // render must not produce four findings about copy that was never the
    // problem.
    const verdict = check(
      metrics({ inkShare: INK_SHARE_FLOOR - EPS, flatBackgroundShare: 0.99, occupiedShare: 0.01, largestEmptyRectShare: 0.9, imageryOrDeviceShare: 0 }),
      "cover",
      1,
    );
    expect(kinds(verdict)).toEqual(["render-integrity"]);
    expect(verdict.findings[0]?.steer).toMatch(/Re-render it/);
    expect(verdict.findings[0]?.steer).toMatch(/Do not rewrite/);
    // Warnings are not computed on this path either: nothing painted, so
    // there is nothing to have an opinion about.
    expect(verdict.warnings).toEqual([]);
  });

  it("A — boundary: 0.001 above the ink floor passes, 0.001 below fails", () => {
    expect(check(metrics({ inkShare: INK_SHARE_FLOOR + EPS }), "interior").ok).toBe(true);
    expect(kinds(check(metrics({ inkShare: INK_SHARE_FLOOR - EPS }), "interior"))).toEqual(["render-integrity"]);
  });

  // ON A PLATE THAT CARRIES NO PHOTOGRAPH, which `bare()` is. Phase 5.5 moved
  // `FULL_BLEED_IMAGERY_SHARE` to 0.28 from the live photo band (0.329-0.593
  // against 0.022-0.145 for every typographic plate), and
  // `passingSlideMetrics` is a PHOTO-BEARING plate at `imageryOrDeviceShare`
  // 0.34 — so the baseline fixture is now inside the full-bleed exemption,
  // which is the correction the move exists for. The pixel limb is about type
  // running off a plate that is not a photograph; the case says so.
  it("B — clipped: ink inside the bleed band fails on its own", () => {
    const verdict = check(bare({ clippedEdgeShare: CLIPPED_EDGE_SHARE_CEILING + EPS }), "interior", 4);
    expect(kinds(verdict)).toEqual(["clipped"]);
    expect(verdict.findings[0]?.sentence).toMatch(/0\.5% of the frame is ink inside the 8px bleed band \(ceiling 0\.4%\)/);
    expect(verdict.findings[0]?.steer).toMatch(/fontScale/);
  });

  it("B — boundary: exactly at the clipped ceiling passes", () => {
    expect(check(metrics({ clippedEdgeShare: CLIPPED_EDGE_SHARE_CEILING }), "interior").ok).toBe(true);
    expect(check(metrics({ clippedEdgeShare: CLIPPED_EDGE_SHARE_CEILING - EPS }), "interior").ok).toBe(true);
  });

  it("B — a DOM overflow fails even when no pixel is clipped, and names the element", () => {
    const verdict = checkInterestFloor(metrics(), passingSlideProbe(2, { overflow: true, overflowing: [".headline", ".body"] }), "interior", { slide: 2 });
    expect(kinds(verdict)).toEqual(["clipped"]);
    expect(verdict.findings[0]?.sentence).toMatch(/\.headline, \.body/);
  });
  // A FULL-BLEED PHOTOGRAPH PUTS INK IN THE BLEED BAND BY DEFINITION.
  //
  // Measured with the real `measureSlidePng` over a synthetic full-frame
  // photograph: `clippedEdgeShare` 2.57% against clause B's 0.4% ceiling,
  // six times over, with `imageryShare` 82.9%. Unexempted, clause B would
  // therefore fail EVERY photo slide and every hero-bearing cover on every
  // attempt. The exemption is deliberately narrow in three ways, and all
  // three are asserted here and in the case after it: it applies only to the
  // PIXEL limb, only above `FULL_BLEED_IMAGERY_SHARE`, and (since Phase 5.5)
  // only to a plate the assembled document says carries a photograph.
  it("B — the bleed-band limb is inert on a FULL-BLEED slide, and only on one", () => {
    const clipped = { clippedEdgeShare: 0.0257 };
    const fullBleed = metrics({ ...clipped, imageryShare: 0.829, imageryOrDeviceShare: FULL_BLEED_IMAGERY_SHARE, textShare: 0.05 });
    expect(check(fullBleed, "cover").findings).toEqual([]);

    // One notch below the exemption, the same edge ink is clipped type again.
    const panel = metrics({ ...clipped, imageryOrDeviceShare: FULL_BLEED_IMAGERY_SHARE - EPS });
    expect(kinds(check(panel, "cover"))).toEqual(["clipped"]);

    // And the DOM limb is NOT exempt: type running off the plate is the half
     // that catches a Hebrew headline sized for Latin glyph widths, whatever
     // the slide is carrying underneath it.
    const bleedingAndOverflowing = checkInterestFloor(
      fullBleed,
      passingSlideProbe(1, { overflow: true, overflowing: [".title"] }),
      "cover",
      { slide: 1 },
    );
    expect(kinds(bleedingAndOverflowing)).toEqual(["clipped"]);
  });

  /**
   * ── PHASE 5.5: THE PHOTO BAND, AND THE DOM LIMB THAT KEEPS IT HONEST. ──
   *
   * THE DEFECT, from the three live runs of 2026-09-16: three of the five real
   * photo slides in those posts measured `imageryOrDeviceShare` between 0.329
   * and 0.468 and were failed as `clipped` — **while `probe.overflow` was
   * FALSE**. Nothing was running off those plates. A photograph reaching the
   * frame edge was being read as type spilling out of its box, on the one
   * thing the owner had asked for more of, and each false finding cost a
   * drafting attempt and sent the writer to cut copy that fits.
   *
   * The bands do not overlap: photo 0.329 / 0.452 / 0.468 / 0.573 / 0.593
   * against 0.022-0.145 for every typographic plate. Midpoint 0.237, rounded
   * toward the photo band: 0.28.
   *
   * What the rounding costs is the second limb's job. Between 0.28 and 0.5 a
   * DRAWN field can now measure like a photograph, so the exemption asks the
   * assembled document whether the plate actually has one.
   */
  it("B — a real photo slide at 0.33 is no longer clipped, and a drawn field at 0.33 still is", () => {
    const edgeInk = { clippedEdgeShare: 0.0257 };
    // The measured live plate: a photograph at 0.33, no overflow.
    const photo = metrics({ ...edgeInk, imageryShare: 0.33, graphicShare: 0, imageryOrDeviceShare: 0.33 });
    expect(checkInterestFloor(photo, passingSlideProbe(3), "interior", { slide: 3, hasHero: true }).findings).toEqual([]);
    // The same numbers with NO photograph on the assembled slide: a drawn
    // field cannot claim a photograph's exemption.
    expect(kinds(checkInterestFloor(photo, passingSlideProbe(3), "interior", { slide: 3, hasHero: false }))).toEqual(["clipped"]);
    // Unknown abstains, because a caller that cannot say what the plate
    // carries must not have a photograph refused on its behalf.
    expect(checkInterestFloor(photo, passingSlideProbe(3), "interior", { slide: 3 }).findings).toEqual([]);
    // And a genuinely overflowing plate still fails, photograph or not — the
    // DOM limb is what catches Hebrew type sized for Latin glyph widths.
    const overflowing = checkInterestFloor(photo, passingSlideProbe(3, { overflow: true, overflowing: [".headline"] }), "interior", {
      slide: 3,
      hasHero: true,
    });
    expect(kinds(overflowing)).toEqual(["clipped"]);
  });

  /**
   * ── PHASE 5.5, CLAUSE H: THE WEIGHT, AND THE KICKER THAT CANNOT LIFT IT. ──
   *
   * The reproduction against the owner's own verdicts lives in
   * `content-weight-floor.test.ts`, which scores the three archived live
   * posts. This is the clause's own unit behaviour: which input it reads,
   * which floor it compares against, and the gameability guard.
   */
  it("H — the weighted floor refuses a plate a kicker cannot lift, at the role's own number", () => {
    // headline + body = 2.0 on an interior plate, floor 3.0.
    const thin = checkInterestFloor(metrics(), passingSlideProbe(4), "interior", { slide: 4, contentWeight: 2 });
    expect(kinds(thin)).toEqual(["one-element"]);
    expect(thin.findings[0]?.threshold).toBe(3);
    expect(thin.findings[0]?.sentence).toMatch(/content weighs 2\.00 against a floor of 3\.00/u);
    // THE GAMEABILITY GUARD: + a kicker (0.25) is 2.25 and still fails. That
    // is the whole reason the weights exist — a flat floor of 3 would have
    // been cleared by printing exactly the furniture the owner complained of.
    expect(checkInterestFloor(metrics(), passingSlideProbe(4), "interior", { slide: 4, contentWeight: 2.25 }).ok).toBe(false);
    // A picture (2.0) on the same plate clears it.
    expect(checkInterestFloor(metrics(), passingSlideProbe(4), "interior", { slide: 4, contentWeight: 4 }).ok).toBe(true);
    // The COVER is held to 4.0: a title, a subtitle and two pieces of furniture
    // (2.5) is the cover the owner called empty, and 4.0 is reachable by a
    // cover three ways (a photograph, a figure device, a drawn graphic).
    expect(kinds(checkInterestFloor(metrics(), passingSlideProbe(1), "cover", { slide: 1, contentWeight: 2.5 }))).toContain("one-element");
    // The CLOSER is held to 3.5, which is a closer's own MAXIMUM composition —
    // `closer` declares no hero slot and emits two prose slots into one elastic
    // middle, so `takeaway 1.0 + cta 1.0 + recap 1.5` is its ceiling. A complete
    // closer therefore passes and a closer that lost its recap (2.0) fails,
    // which is the plate this clause is actually about. See
    // `CONTENT_WEIGHT_FLOOR`'s own note for why 4.0 was unreachable.
    expect(checkInterestFloor(metrics(), passingSlideProbe(8), "closer", { slide: 8, contentWeight: 3.5 }).ok).toBe(true);
    expect(kinds(checkInterestFloor(metrics(), passingSlideProbe(8), "closer", { slide: 8, contentWeight: 2 }))).toContain("one-element");
    // ABSTAINS with neither input, exactly as the count-only limb does.
    expect(checkInterestFloor(metrics(), passingSlideProbe(4), "interior", { slide: 4 }).ok).toBe(true);
    // And the WEIGHT WINS when both are supplied: a 4-element plate weighing
    // 2.25 is the plate this clause exists to refuse.
    expect(checkInterestFloor(metrics(), passingSlideProbe(4), "interior", { slide: 4, contentElements: 4, contentWeight: 2.25 }).ok).toBe(false);
  });

  /**
   * ── PHASE 5.5, CLAUSE I: A GRADIENT IS NOT A SUBJECT. ──
   *
   * The cover that drew *"השקף הראשון יחסית ריק ומשעמם"* passed every clause
   * in this file, because `cover.html`'s own ramp measures
   * `imageryOrDeviceShare` 0.165-0.188 before any content lands on it. The
   * answer is not a higher pixel share — that would be a threshold fitted to
   * one palette — but a question asked of the DOM. The real-Chromium cases are
   * in `cover-subject.test.ts`; these are the policy's own.
   */
  it("I — the cover carries a subject, measured as boxes, and abstains when nothing measured them", () => {
    const gradientCover = { hero: 0, device: 0.004, graphic: 0.01 };
    const verdict = checkInterestFloor(metrics(), passingSlideProbe(1, { subjectBoxes: gradientCover }), "cover", { slide: 1 });
    expect(kinds(verdict)).toContain("cover-subject");
    expect(verdict.findings.find((f) => f.kind === "cover-subject")?.steer).not.toMatch(/device built from the strongest number/u);
    // A full-bleed photograph, a real figure device and a drawn graphic each
    // satisfy it on their own.
    for (const boxes of [{ hero: 0.45, device: 0, graphic: 0 }, { hero: 0, device: 0.12, graphic: 0 }, { hero: 0, device: 0, graphic: 0.12 }]) {
      expect(kinds(checkInterestFloor(metrics(), passingSlideProbe(1, { subjectBoxes: boxes }), "cover", { slide: 1 }))).not.toContain("cover-subject");
    }
    // An interior slide is allowed to be a quiet typographic turn.
    expect(kinds(checkInterestFloor(metrics(), passingSlideProbe(3, { subjectBoxes: gradientCover }), "interior", { slide: 3 }))).not.toContain("cover-subject");
    // And with no boxes measured the clause sits out rather than guessing.
    expect(kinds(checkInterestFloor(metrics(), passingSlideProbe(1), "cover", { slide: 1 }))).not.toContain("cover-subject");
  });

  it("C — dead space: one contiguous hole over the role's ceiling, with the rectangle's own corners in the sentence", () => {
    const verdict = check(
      bare({ largestEmptyRect: { x: 0, y: 0, w: 1080, h: 590 }, largestEmptyRectShare: 0.41 }),
      "cover",
      1,
    );
    // `bare`, not `metrics`: a plate carrying a subject is allowed this hole.
    expect(kinds(verdict)).toEqual(["dead-space", "no-device"]);
    expect(verdict.findings[0]?.sentence).toBe(
      "slide 1 — an empty rectangle covered 41% of the plate (0,0 to 1080,590); the ceiling is 22% for a cover.",
    );
    expect(verdict.findings[0]?.threshold).toBe(LARGEST_EMPTY_RECT_CEILING.cover);
  });

  it("C — boundary: the interior ceiling is looser than the cover's, and each is exact to 0.001", () => {
    // ── THE INTERIOR ROLE REPORTS RATHER THAN GATES (RFC-21 Part 2). ──
    // Clause C's own comment carries the measurement: `largestEmptyRect` gives
    // four verdicts on four brand palettes for one plate, so it cannot gate
    // colour-agnostically, and clause H refuses that plate instead. The CEILING
    // relationship this case pins is unchanged and still load-bearing, because
    // cover and closer still gate on it.
    expect(check(bare({ largestEmptyRectShare: LARGEST_EMPTY_RECT_CEILING.interior - EPS }), "interior").ok).toBe(true);
    expect(kinds(check(bare({ largestEmptyRectShare: 0.99 }), "interior")), "clause C gates at the interior role again").toEqual([]);
    expect(check(bare({ largestEmptyRectShare: LARGEST_EMPTY_RECT_CEILING.cover - EPS }), "cover").findings.map((f) => f.kind)).toEqual(["no-device"]);
    expect(kinds(check(bare({ largestEmptyRectShare: LARGEST_EMPTY_RECT_CEILING.cover + EPS }), "cover"))).toEqual(["dead-space", "no-device"]);
    // 0.25 sits between the two: legitimate mid-carousel, a defect on a cover.
    expect(check(bare({ largestEmptyRectShare: 0.25 }), "interior").ok).toBe(true);
    expect(kinds(check(bare({ largestEmptyRectShare: 0.25 }), "cover"))).toEqual(["dead-space", "no-device"]);
  });

  /**
   * THE OWNER'S RULE, AS A PAIR. 2026-09-14: *"the difference between clean
   * design and bad design is not the absence of interest, it is the absence of
   * noise."* `@semrush`'s reference plate leaves its whole lower-left quadrant
   * empty and carries a four-node diagram; the owner's grey screen has a hole
   * the same size and nothing in it. Both sides are asserted here, because a
   * waiver tested only on the plate it is meant to admit is a waiver nobody
   * has checked can refuse.
   */
  it("C — a plate that carries a SUBJECT is allowed its quiet; one that carries nothing is not", () => {
    // A CORNER hole, the `@semrush` shape: two thirds of the width, half the
    // height, touching two edges and crossing neither axis. A full-width band
    // is a different plate and gets its own case below.
    const hole = { largestEmptyRect: { x: 0, y: 640, w: 720, h: 800 }, largestEmptyRectShare: 0.37 };
    // Imagery in frame: the hole is composition.
    // At the COVER role, which is where clause C still gates.
    const withImagery = check(metrics({ ...hole, imageryOrDeviceShare: 0.6, imageryShare: 0.6 }), "cover", 1);
    expect(withImagery.findings.map((f) => f.kind)).not.toContain("dead-space");
    expect(withImagery.waived.map((f) => f.kind)).toContain("dead-space");
    expect(withImagery.waived[0]?.waivedReason).toMatch(/imagery or a drawn device/u);
    // ── DISPLAY-SCALE TYPE IS NOT A SUBJECT, AND THE SWEEP IS WHAT DECIDED
    //    THAT. ──
    //
    // This case used to assert a second limb: a plate whose type reaches
    // `DISPLAY_TYPE_SCALE_FLOOR` earns its quiet the way imagery does. CI
    // 34960136572 measured `headline-focus` at fontScale `s` at
    // `displayTypeScale` **0.2715** against that 0.055 floor — and the owner's
    // grey screen reads the same number, because it is the same type at the
    // same size. The limb waived the plate the phase exists to refuse.
    //
    // So it is withdrawn (see `plateSubject`), and what this case now pins is
    // the ABSENCE: **however large the type, type alone does not buy a hole.**
    // A plate with a strong headline and nothing else is refused, which is the
    // reading RFC-20 §4 took off the reference plates — `@semrush`'s empty
    // quadrant is earned by a four-node diagram, not by the size of its
    // headline.
    const hugeType = checkInterestFloor(bare(hole), { ...passingSlideProbe(1), displayTypeScale: 0.3 }, "cover", { slide: 1 });
    expect(hugeType.findings.map((f) => f.kind), "display-scale type bought a hole it has not earned").toContain("dead-space");
    expect(hugeType.waived, "a withdrawn limb is still waiving").toEqual([]);
    // And the floor it used to read is still exported, still printed by the
    // sweep, and read by nothing — asserted so a silent re-wiring is visible.
    expect(DISPLAY_TYPE_SCALE_FLOOR, "the constant moved; if it gates again this case has to say so").toBe(0.055);
  });

  /**
   * THE HOLLOW PLATE, and it is the control that proves the waiver can still
   * refuse. Found on CI 34897578476: `closer.html` with an eyebrow at the top,
   * a CTA at the foot and NOTHING between them measured
   * `largestEmptyRectShare` 0.5556 at full width — and it carries a hero, so
   * the subject test waived it. A genuinely hollow plate passing because of a
   * picture at the other end of it.
   *
   * Almost the same share as the corner hole above. The difference is that one
   * sits against a margin and the other cuts the plate in two.
   */
  /**
   * ── CLAUSE H: THE SEMANTIC FLOOR (RFC-21 Part 2). ──
   *
   * The clause that ends a six-candidate search. `CONTENT_ELEMENT_FLOOR`'s own
   * comment carries the argument; what this case holds is the three properties
   * that make it different in kind from everything that came before it.
   *
   * 1. **It reads no pixels**, so it cannot be palette-dependent — asserted by
   *    driving the same count through four wildly different metric objects.
   * 2. **It ABSTAINS when it has no count**, rather than guessing. An
   *    abstention looks exactly like a pass from the outside, so it is pinned.
   * 3. **It refuses the owner's grey screen**, which is the whole point, and it
   *    is the first clause in this file that can do so on a number a brand kit
   *    cannot move.
   */
  it("H — one element is refused, two is not, and the verdict does not move with the pixels", () => {
    // The owner's grey screen: one headline, nothing else.
    const one = checkInterestFloor(metrics(), passingSlideProbe(3), "interior", { slide: 3, contentElements: 1 });
    expect(one.findings.map((f) => f.kind)).toEqual(["one-element"]);
    expect(one.findings[0]?.measured["contentElements"]).toBe(1);
    expect(one.findings[0]?.threshold).toBe(CONTENT_ELEMENT_FLOOR);
    // A statement and a body is a slide.
    expect(checkInterestFloor(metrics(), passingSlideProbe(3), "interior", { slide: 3, contentElements: 2 }).findings).toEqual([]);
    // Zero is the empty plate, and the sentence says so differently.
    const none = checkInterestFloor(metrics(), passingSlideProbe(3), "interior", { slide: 3, contentElements: 0 });
    expect(none.findings[0]?.sentence).toMatch(/carries nothing/u);
    expect(one.findings[0]?.sentence).toMatch(/one element/u);

    // ── THE PROPERTY SIX PIXEL CANDIDATES COULD NOT OFFER. ──
    //
    // Four metric objects that could not be more different — a dark plate, a
    // bright one, one that is mostly imagery, one that is nearly bare — and the
    // verdict is identical, because the clause never looks at any of them.
    // RFC-21 §2.9 renders this same property over four real brand palettes on
    // real Chromium; this is its Chromium-free twin and it runs on every push.
    for (const m of [
      metrics({ inkShare: 0.02, occupiedShare: 0.10, flatBackgroundShare: 0.97 }),
      metrics({ inkShare: 0.40, occupiedShare: 0.90, flatBackgroundShare: 0.05 }),
      metrics({ imageryShare: 0.8, imageryOrDeviceShare: 0.8, contentOccupiedShare: 0.8 }),
      metrics({ contentOccupiedShare: 0.02, largestEmptyRectShare: 0.9 }),
    ]) {
      expect(
        checkInterestFloor(m, passingSlideProbe(3), "interior", { slide: 3, contentElements: 1 }).findings.map((f) => f.kind),
        "clause H changed its mind about a one-element plate because the PIXELS changed",
      ).toContain("one-element");
    }
  });

  it("H — ABSTAINS when the caller supplies no count, and an abstention is not a pass", () => {
    // Every other case in this file omits `contentElements`, so if this clause
    // fired on an absent count it would fire on all of them. The abstention is
    // load-bearing and is therefore asserted rather than assumed.
    const noCount = checkInterestFloor(metrics(), passingSlideProbe(3), "interior", { slide: 3 });
    expect(noCount.findings.map((f) => f.kind)).not.toContain("one-element");
    // And the thing that makes the abstention safe: the caller that matters
    // always supplies it. `checkSlidesInterestFloor` reads
    // `contentElementsBySlide`, and the workflow builds that from the RENDERED
    // document — see its call site.
    expect(checkInterestFloor(metrics(), passingSlideProbe(3), "interior", { slide: 3, contentElements: 1 }).ok).toBe(false);
  });

  it("H — every role gets the same floor, because \"is there more than one thing here\" is the same question everywhere", () => {
    // The other floors in this file are per-role because a cover and an interior
    // carry different amounts of furniture. This one is not, deliberately: three
    // answers to one question would be three places to drift. A cover's EXTRA
    // requirement — a photograph or a device — is clause E's job, and the two
    // are asserted together here so the division of labour is visible.
    for (const role of ["cover", "interior", "closer"] as const) {
      expect(checkInterestFloor(metrics(), passingSlideProbe(1), role, { slide: 1, contentElements: 1 }).findings.map((f) => f.kind), role).toContain(
        "one-element",
      );
      expect(checkInterestFloor(metrics(), passingSlideProbe(1), role, { slide: 1, contentElements: 2 }).findings.map((f) => f.kind), role).not.toContain(
        "one-element",
      );
    }
  });

  it("C — a hole that SPANS the frame is never waived, however strong the subject", () => {
    const band = { largestEmptyRect: { x: 0, y: 320, w: 1080, h: 800 }, largestEmptyRectShare: 0.5556 };
    // A full-frame photograph is the strongest subject there is, and it still
    // does not buy this plate the hole.
    const withHero = checkInterestFloor(
      metrics({ ...band, imageryShare: 0.6, imageryOrDeviceShare: 0.6 }),
      { ...passingSlideProbe(7), displayTypeScale: 0.2 },
      "closer",
      { slide: 7 },
    );
    expect(withHero.findings.map((f) => f.kind)).toContain("dead-space");
    expect(withHero.waived.map((f) => f.kind)).not.toContain("dead-space");
    // A band on the OTHER axis spans too — a plate cut left from right is cut
    // just the same as one cut top from bottom.
    const column = { largestEmptyRect: { x: 0, y: 0, w: 560, h: 1440 }, largestEmptyRectShare: 0.52 };
    expect(check(metrics(column), "cover", 1).findings.map((f) => f.kind)).toContain("dead-space");
    // And the corner shape is still waived, so this case is measuring POSITION
    // rather than having quietly switched the waiver off.
    const corner = { largestEmptyRect: { x: 0, y: 640, w: 720, h: 800 }, largestEmptyRectShare: 0.37 };
    expect(check(metrics(corner), "cover", 1).waived.map((f) => f.kind)).toContain("dead-space");
  });

  /**
   * THE ONE PLATE THIS WHOLE SYSTEM EXISTS FOR, re-asserted after clause D was
   * demoted. `boringSlideMetrics` is the owner's grey screen as MEASURED off
   * the 2026-09-08 Karos Labs renders, and demoting an occupancy gate must not
   * let it through.
   */
  it("THE GREY SCREEN IS STILL REFUSED, with clause D reporting rather than gating", () => {
    // ONE ELEMENT — the grey screen is a headline and nothing else, which is
    // what RFC-21 Part 2's clause H counts. It is supplied at every role because
    // the plate is the same plate at every role.
    for (const role of ["cover", "interior", "closer"] as const) {
      const verdict = checkInterestFloor(boringSlideMetrics(), passingSlideProbe(3), role, { slide: 3, contentElements: 1 });
      expect(verdict.ok, `the grey screen passed at ${role}`).toBe(false);
      // Clause C still gates at cover and closer; at the interior role it
      // reports and clause H refuses. The plate is refused everywhere either
      // way, and WHICH clause speaks is named so a later change has to come past
      // this line rather than quietly swapping one refusal for none.
      expect(verdict.findings.map((f) => f.kind), `at ${role}`).toContain(role === "interior" ? "one-element" : "dead-space");
    }
    // And the demoted measurement is still REPORTED, so the number a reader
    // goes looking for is present rather than missing.
    const warned = check(boringSlideMetrics(), "interior").warnings.map((w) => w.kind);
    expect(warned).toContain("low-occupancy");
  });

  it("D — DEMOTED: flat AND idle now REPORTS instead of failing, and the number is unchanged", () => {
    // This case used to read "flat AND idle FAILS". It reports. The conjunction
    // itself is untouched — the same two limbs, the same constants — so a
    // reader comparing an old gate payload to a new one sees the same numbers
    // under a different heading. See the clause-D block in `interest-floor.ts`
    // for the two measurements that demoted it.
    const flatAndIdle = metrics({ flatBackgroundShare: 0.93, occupiedShare: 0.08, imageryOrDeviceShare: 0.2 });
    const verdict = check(flatAndIdle, "interior", 5);
    expect(kinds(verdict)).toEqual([]);
    expect(verdict.ok).toBe(true);
    const low = verdict.warnings.find((w) => w.kind === "low-occupancy");
    expect(low, "the demoted measurement stopped being reported — that is a deletion, not a demotion").toBeDefined();
    expect(low?.measured).toMatchObject({ flatBackgroundShare: 0.93, occupiedShare: 0.08, formerFloor: OCCUPIED_SHARE_FLOOR.interior });

    // Neither limb alone ever reported, and that is unchanged.
    expect(check(metrics({ flatBackgroundShare: 0.93, occupiedShare: 0.52 }), "interior").warnings.map((w) => w.kind)).not.toContain("low-occupancy");
    expect(check(metrics({ flatBackgroundShare: 0.2, occupiedShare: 0.08 }), "interior").warnings.map((w) => w.kind)).not.toContain("low-occupancy");
  });

  it("D — the sentence still carries both numbers, and now says it gates nothing", () => {
    const verdict = check(metrics({ flatBackgroundShare: 0.93, occupiedShare: 0.08, imageryOrDeviceShare: 0.2 }), "interior", 5);
    const low = verdict.warnings.find((w) => w.kind === "low-occupancy");
    expect(low?.sentence).toBe(
      "slide 5 — 93% of the pixels were the background colour and only 8% of the frame was occupied (the floor this used to fail at was 30% for an interior slide); reported since 2026-09-14, gates nothing.",
    );
    // A warning carries no steer: there is nothing for a redraft to fix.
    expect(low).not.toHaveProperty("steer");
  });

  it("D — boundary: both halves are still exact to 0.001, on the WARNING rather than on a refusal", () => {
    // The conjunction and both constants are untouched by the demotion, so the
    // boundary case is kept verbatim and only the assertion moves from `ok` to
    // the warning list. That is the point of demoting rather than deleting: the
    // number still has to be right, because the next phase calibrates on it.
    const idle = (flat: number, occupied: number) => metrics({ flatBackgroundShare: flat, occupiedShare: occupied, imageryOrDeviceShare: 0.2 });
    const warnedAt = (m: SlideMetrics) => check(m, "interior").warnings.some((w) => w.kind === "low-occupancy");
    expect(warnedAt(idle(FLAT_BACKGROUND_CEILING + EPS, OCCUPIED_SHARE_FLOOR.interior - EPS))).toBe(true);
    expect(warnedAt(idle(FLAT_BACKGROUND_CEILING - EPS, OCCUPIED_SHARE_FLOOR.interior - EPS))).toBe(false);
    expect(warnedAt(idle(FLAT_BACKGROUND_CEILING + EPS, OCCUPIED_SHARE_FLOOR.interior + EPS))).toBe(false);
    // And none of the three refuses anything any more.
    expect(check(idle(FLAT_BACKGROUND_CEILING + EPS, OCCUPIED_SHARE_FLOOR.interior - EPS), "interior").ok).toBe(true);
    // ── THE ROLES ARE NOT ORDERED THE WAY EDITORIAL INTENT WOULD ORDER THEM,
    //    AND THAT IS THE MEASUREMENT TALKING. ──
    //
    // This case used to read "the cover's floor is higher, so the SAME slide
    // fails there and passes mid-carousel". After the RFC-20 sweep it is not:
    // cover 0.18 sits BELOW interior 0.19, because each floor is the midpoint
    // of its own role's measured band and a cover's populated band really is
    // lower than an interior's (0.2690-0.3517 against 0.2895-0.6364 — a cover
    // is a bounded ramp and a lockup, an interior can be a filled panel).
    //
    // Nothing is lost by that. The editorial "the thumbnail and the save
    // moment are judged harder" lives in `LARGEST_EMPTY_RECT_CEILING`, which
    // is 0.22 for a cover against 0.28 for an interior and did not move. So
    // the case now pins the ordering it can defend — that the two floors are
    // distinct and that a plate between them is separated by role — written
    // against the constants rather than a literal, and with `min`/`max` so it
    // keeps meaning "between" whichever way a re-sweep puts them.
    const lo = Math.min(OCCUPIED_SHARE_FLOOR.interior, OCCUPIED_SHARE_FLOOR.cover);
    const hi = Math.max(OCCUPIED_SHARE_FLOOR.interior, OCCUPIED_SHARE_FLOOR.cover);
    expect(lo, "the two floors must stay distinct or this case asserts nothing").toBeLessThan(hi);
    const stricterRole = OCCUPIED_SHARE_FLOOR.cover > OCCUPIED_SHARE_FLOOR.interior ? ("cover" as const) : ("interior" as const);
    const looserRole = stricterRole === "cover" ? ("interior" as const) : ("cover" as const);
    const between = idle(0.8, (lo + hi) / 2);
    expect(between.occupiedShare).toBeGreaterThan(lo);
    expect(between.occupiedShare).toBeLessThan(hi);
    expect(check(between, looserRole, looserRole === "cover" ? 1 : 3).ok).toBe(true);
    // Separated by ROLE on the warning now, not on a refusal: the two floors are
    // still distinct and a plate between them is still told apart by role, which
    // is the property this case pins. It is worth keeping precisely because the
    // next phase calibrates on these two constants.
    const warnedAtRole = (role: SlideRole) =>
      check(between, role, role === "cover" ? 1 : 3).warnings.some((w) => w.kind === "low-occupancy");
    expect(warnedAtRole(looserRole)).toBe(false);
    expect(warnedAtRole(stricterRole)).toBe(true);
    expect(kinds(check(between, stricterRole, stricterRole === "cover" ? 1 : 3))).toEqual([]);
    expect(check(idle(0.8, OCCUPIED_SHARE_FLOOR.closer + EPS), "closer", 6).ok).toBe(true);
  });

  it("E — a cover or a closer must carry something other than type; an interior slide is EXEMPT", () => {
    const typeOnly = metrics({ imageryShare: 0, graphicShare: 0.01, imageryOrDeviceShare: 0.01 });
    expect(kinds(check(typeOnly, "cover", 1))).toEqual(["no-device"]);
    expect(kinds(check(typeOnly, "closer", 6))).toEqual(["no-device"]);
    // One quiet all-type turn mid-carousel is good design.
    expect(check(typeOnly, "interior", 3).ok).toBe(true);
  });

  it("E — boundary: exact to 0.001, and the closer's steer names the closer's own remedies", () => {
    // THE COVER'S BAR IS UNTOUCHED, and asserting it here is the point: the
    // closer's floor was re-derived on the de-decorated tree and the cover's
    // was not, because `default:cover-carries-device` rests on it.
    expect(check(metrics({ imageryOrDeviceShare: IMAGERY_OR_DEVICE_FLOOR + EPS }), "cover", 1).ok).toBe(true);
    expect(kinds(check(metrics({ imageryOrDeviceShare: IMAGERY_OR_DEVICE_FLOOR - EPS }), "cover", 1))).toContain("no-device");
    // The closer reads its own floor, and a plate between the two is a defect
    // on a cover and a legitimate closer.
    expect(kinds(check(metrics({ imageryOrDeviceShare: CLOSER_IMAGERY_OR_DEVICE_FLOOR + EPS }), "closer", 6))).toEqual([]);
    const verdict = check(metrics({ imageryOrDeviceShare: CLOSER_IMAGERY_OR_DEVICE_FLOOR - EPS }), "closer", 6);
    expect(kinds(verdict)).toEqual(["no-device"]);
    expect(verdict.findings[0]?.steer).toMatch(/recap this post's own figures as a strip/);
    expect(verdict.findings[0]?.steer).toMatch(/question the reader can answer/);
  });

  it("F — wall of text: the opposite failure, caught on its own number", () => {
    const verdict = check(metrics({ textShare: TEXT_SHARE_CEILING + EPS }), "interior", 2);
    expect(kinds(verdict)).toEqual(["text-wall"]);
    expect(verdict.findings[0]?.sentence).toMatch(/55% of the frame is glyph-bearing \(ceiling 55%\)/);
    expect(verdict.findings[0]?.steer).toMatch(/move the body's last sentence to the caption/);
    expect(check(metrics({ textShare: TEXT_SHARE_CEILING - EPS }), "interior").ok).toBe(true);
  });
});

describe("checkInterestFloor: the bold type poster", () => {
  // The whole argument for splitting clause C from clause D. A confident
  // Swiss type poster is 82% ground by construction; the audit slide is 93%
  // ground AND idle. One ceiling cannot separate them.
  const poster = metrics({
    flatBackgroundShare: 0.82,
    occupiedShare: 0.46,
    // Type on ground with one small graphic: almost everything that painted
    // IS content, so the two masks nearly agree. A poster is the opposite of
    // a decorated empty plate.
    contentOccupiedShare: 0.42,
    largestEmptyContentRectShare: 0.21,
    imageryShare: 0,
    graphicShare: 0.01,
    imageryOrDeviceShare: 0.01,
    largestEmptyRectShare: 0.2,
    largestEmptyRect: { x: 64, y: 64, w: 952, h: 328 },
    textShare: 0.34,
    inkShare: 0.11,
  });

  it("PASSES mid-carousel, at 82% flat background", () => {
    const verdict = check(poster, "interior", 3);
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it("fails clause E and ONLY clause E at the cover role, with the identical metrics", () => {
    const verdict = check(poster, "cover", 1);
    expect(kinds(verdict)).toEqual(["no-device"]);
  });

  /**
   * THE AUDIT SLIDE IS STILL REFUSED, AND RFC-20 CHANGED WHICH CLAUSE DOES IT.
   *
   * `boringSlideMetrics` is the 2026-09-08 prep render as numbers: 93% ground,
   * 18% occupied, a hole over half the plate, nothing but type. It used to
   * fail C, D and E. At `OCCUPIED_SHARE_FLOOR.cover = 0.18` it no longer fails
   * D — 0.18 is not under 0.18 — and this case says so out loud rather than
   * letting the loss go unrecorded.
   *
   * **That is the re-calibration's price and it is the price RFC-20 §5.6's
   * decision rule 3 named in advance.** The occupancy limb was never what
   * separated this plate from a good one: on the tree these numbers came from,
   * a full-bleed hatch took a GOOD plate to 0.6688 and the owner's grey screen
   * to 0.6324, and both passed. The rectangle is the instrument that can tell
   * them apart, it refuses this plate at 55.6% against a 22% cover ceiling —
   * 2.5x over — and `ok === false` is what the pipeline actually reads.
   *
   * ── THE COINCIDENCE, NAMED SO NOBODY HAS TO REDISCOVER IT. ──
   *
   * `OCCUPIED_SHARE_FLOOR.cover` and `boringSlideMetrics().occupiedShare` are
   * both 0.18, exactly, and that is why the `>=` below reads the way it does.
   * It is a coincidence and not a calibration: 0.18 came from the cover band
   * (POPULATED 0.2690-0.3517, NEGLECTED 0.0006) and the audit slide's 0.18
   * came from a prep render eleven months earlier. Two numbers landing on each
   * other is worth knowing about because it means **the cover floor has no
   * margin against the canonical bad plate at all**, so nothing here may ever
   * be allowed to rest on clause D at the cover role. It does not: the
   * `dead-space` assertion above is the refusal, at 2.5x. At the INTERIOR role
   * the plate is under 0.19 and clause D speaks again — see the double-report
   * case below, which pins that.
   */
  it("still fails the audit slide, which is holed and carries nothing but type", () => {
    const verdict = check(boringSlideMetrics(), "cover", 1);
    expect(verdict.ok).toBe(false);
    expect(kinds(verdict).sort()).toEqual(["dead-space", "no-device"]);
    // Both findings name slide 1 and carry their own measured numbers.
    expect(verdict.findings.every((f) => f.slide === 1)).toBe(true);
    expect(verdict.findings.every((f) => Object.keys(f.measured).length > 0)).toBe(true);
    // The clause that speaks for it, and by how much — stated as an assertion
    // so the day somebody proposes moving 0.22, this file says what it costs.
    expect(boringSlideMetrics().largestEmptyRectShare).toBeGreaterThan(LARGEST_EMPTY_RECT_CEILING.cover * 2);
    // And the limb that stopped speaking, also as an assertion: 0.18 is the
    // exact cover floor, so this plate sits ON the line rather than under it.
    expect(boringSlideMetrics().occupiedShare).toBeGreaterThanOrEqual(OCCUPIED_SHARE_FLOOR.cover);
  });
});

/**
 * RFC-20 §5.6 — THE ONE RE-CALIBRATION, PINNED TO THE BAND IT CAME FROM.
 *
 * Three constants moved and every other threshold in the module held. A value
 * pinned without its band is a value nobody can argue with later, so each row
 * here carries the two measurements either side of it and the case below
 * drives the rule with them.
 */
describe("OCCUPIED_SHARE_FLOOR: the RFC-20 re-calibration", () => {
  it("is 0.18 / 0.30 / 0.42 — one constant moved, and every other threshold this phase touched held", () => {
    expect(OCCUPIED_SHARE_FLOOR).toEqual({ cover: 0.18, interior: 0.3, closer: 0.42 });
    // The siblings RFC-20 §5.6 lists as NOT moving, each with the measurement
    // that keeps it: the plinth alone is iod 0.2383 against 0.10; the cover's
    // 0.2361 rectangle is a hole at a named rectangle, not a tight ceiling;
    // the 0.6132 textShare reading was decoration scored as type.
    expect(IMAGERY_OR_DEVICE_FLOOR).toBe(0.1);
    expect(LARGEST_EMPTY_RECT_CEILING).toEqual({ cover: 0.22, interior: 0.28, closer: 0.22 });
    expect(CONTENT_OCCUPIED_SHARE_FLOOR).toEqual({ cover: 0.09, interior: 0.06, closer: 0.09 });
    expect(TEXT_SHARE_CEILING).toBe(0.55);
    expect(FLAT_BACKGROUND_CEILING).toBe(0.7);
  });

  /**
   * The two plates the whole phase is about, AT THEIR REAL RENDERED NUMBERS.
   *
   * These used to be hand-painted synthetics (composed 0.2620 / grey screen
   * 0.0311) and one field of the composed row was not even that — it carried
   * `largestEmptyRectShare: 0.2` three lines under a comment claiming every
   * field but `inkShare` was the measurement, while the band table beside the
   * constant recorded 0.3611. Both are replaced here by MEASURED-EDGE rows off
   * the real pipeline (`assembleSlidesData` -> real
   * `createRenderCarousel({probe,measure})` -> real `measureSlidePng`), on a
   * document carrying all four production head sheets including the ground
   * material, `headline_focus` on the grid ground at the `m` type scale:
   *
   *   composed, short copy    occ 0.2928  flat 0.7163  LER 0.2778  iod 0.2739
   *   the owner's grey screen occ 0.0372  flat 0.9712  LER 0.3917  iod 0.0226
   *
   * The grey-screen row is what it is BECAUSE of `headline-focus.html`'s guard
   * fix. With the plinth guarded on the headline alone the same plate measured
   * occ 0.2791-0.3004 and `iod` 0.2763-0.3152 — inside the composed band on
   * both, i.e. the two plates were once again indistinguishable and the grey
   * screen was reporting a drawn device it had not earned. **A fixture that
   * kept the old numbers would be asserting the defect.**
   *
   * `contentOccupiedShare` is set equal to `occupiedShare`: with no sub-covered
   * full-bleed paint left there is nothing to separate them, which is RFC-20
   * §5.0's whole claim and what the material ground buys.
   */
  //
  // `inkShare` is left at the passing fixture's default on both, deliberately:
  // clause A is render integrity and short-circuits everything, so pinning it
  // to each plate's real ink would make these cases about whether the render
  // worked instead of about the band. Every other field is the measurement.
  // -- NINTH PASS: THESE ROWS ARE CI RENDERS, NOT EDGE, AND `composed` IS GONE. --
  //
  // `composed()` was a `headline_focus` plate at occ 0.2928 wearing `.hf-plate`.
  // CI (34800700580) measured that card at `imageryOrDeviceShare` 32.0-51.4% on
  // a plate with no imagery and no device -- it was `covered && distinct <= 3`,
  // which is the literal definition of `graphicShare`, so **a decoration was
  // being counted as the drawn device whose absence clause E exists to detect**,
  // and `headline_focus` was accepted as a COVER at every type scale. The card
  // is gone and the archetype is out of scope, so 0.2928 is not a number this
  // tree produces and a fixture carrying it would be asserting the defect.
  //
  // What replaces it is the WORST row of each shipped role's band, off the
  // 160-row gate-zero sweep on CI (34802291959) -- the plate closest to its own
  // floor, so these cases are the band clearing the constant and not one
  // comfortable plate.
  const composedCover = () =>
    metrics({ flatBackgroundShare: 0.6776, occupiedShare: 0.267, contentOccupiedShare: 0.211, largestEmptyRectShare: 0.1469, imageryOrDeviceShare: 0.2739, textShare: 0.0237 });
  const composedCloser = () =>
    metrics({ flatBackgroundShare: 0.4285, occupiedShare: 0.5722, contentOccupiedShare: 0.5692, largestEmptyRectShare: 0.2028, imageryOrDeviceShare: 0.3863, textShare: 0.1 });
  // The NEGLECTED ceiling: the worst (highest-occupancy) of the sweep's eight
  // controls, the owner's grey screen on the glyph ground.
  const greyScreen = () =>
    metrics({ flatBackgroundShare: 0.9614, occupiedShare: 0.0562, contentOccupiedShare: 0.0515, largestEmptyRectShare: 0.3833, imageryOrDeviceShare: 0.0226, textShare: 0.01 });
  // A COMPOSED statement plate with its decoration removed and nothing put in
  // its place -- the sweep's lowest populated interior row, heroless
  // `slide.html`. It is here to be compared with `greyScreen()` above, and the
  // comparison is the reason `interior` did not move.
  const strippedStatement = () =>
    metrics({ flatBackgroundShare: 0.9726, occupiedShare: 0.0383, contentOccupiedShare: 0.037, largestEmptyRectShare: 0.3667, imageryOrDeviceShare: 0.0226, textShare: 0.02 });

  it("admits the worst row of each shipped band at 1.15x -- and the closer at the rule's own literal", () => {
    // The two roles RFC-20 actually re-calibrated. `interior` is not here
    // because it did not move; see `strippedStatement` and the case below.
    expect(kinds(check(composedCover(), "cover", 1)).filter((k) => k === "empty")).toEqual([]);
    expect(composedCover().occupiedShare / OCCUPIED_SHARE_FLOOR.cover).toBeGreaterThan(1.15);
    // The closer's own worst row is kept as a RECORD, not as a gate on a
    // constant: `closer.html` reverted with RFC-20 Part 11 and its floor went
    // back to 0.42, so this line asserts only that the band which WOULD have
    // justified 0.31 also clears the floor that stayed. It is what §11.4
    // re-derives from.
    expect(composedCloser().occupiedShare / OCCUPIED_SHARE_FLOOR.closer).toBeGreaterThan(1.15);
  });

  /**
   * WHY `interior` DID NOT MOVE, PINNED AS AN ASSERTION RATHER THAN A COMMENT.
   *
   * RFC-20 5.6's decision rule 1 sets a constant from the midpoint of a gap
   * between the populated band's floor and the neglected band's ceiling. On CI
   * there is no gap at the interior role: the lowest populated row (heroless
   * `slide.html`, 0.0383) is BELOW the highest neglected control (the owner's
   * grey screen, 0.0562). **A composed statement plate stripped of its
   * decoration measures as a neglected one, because that is what it is** --
   * type on ground and nothing else.
   *
   * That is not a reason to pick a number between them; there is nothing
   * between them. It is the measurement that says `headline_focus` and heroless
   * `slide.html` need a real bounded object from their own copy (RFC-20 Part
   * 11), and until they have one they keep their existing paint and their
   * existing floor.
   *
   * BREAK IT: if a future pass makes `strippedStatement().occupiedShare` clear
   * `greyScreen().occupiedShare`, this case goes red and the interior
   * re-calibration is back on the table -- with a band behind it.
   */
  it("has NO interior band to calibrate from: the stripped statement plate sits under the neglected ceiling", () => {
    expect(strippedStatement().occupiedShare).toBeLessThan(greyScreen().occupiedShare);
    // And both are refused, which is the half that matters: whatever the
    // interior floor is set to, it cannot admit one without admitting the
    // other.
    for (const plate of [strippedStatement, greyScreen]) {
      // ONE ELEMENT, which is what both of these plates are: a stripped
      // statement and the grey screen. Clause H is what refuses them since
      // RFC-21 Part 2, and it refuses them identically on every palette —
      // which is the property clause C could not offer.
      const verdict = checkInterestFloor(plate(), passingSlideProbe(3), "interior", { slide: 3, contentElements: 1 });
      expect(verdict.ok).toBe(false);
      // `dead-space` rather than `empty`, since 2026-09-15. Clause G asks the
      // DOM whether any type painted, and on BOTH of these plates it did —
      // the grey screen is one real headline in a real display face. That is
      // the honest answer and it is not a weakening: what refuses these two
      // is clause C, a hole with no subject in frame, which is the clause
      // that can actually see the difference between them and a composed
      // plate. A clause G that fired here was firing on `contentOccupiedShare`
      // — a number that swings 0.032 with the client's brand palette, on a
      // floor of 0.06.
      // `one-element`, not `dead-space`: RFC-21 Part 2 moved the refusal off the
      // rectangle and onto the element count, which is the only one of the two a
      // brand palette cannot move. The property this case pins — **whatever the
      // interior floor is, it cannot admit one of these without admitting the
      // other** — is unchanged and is what the title is about.
      expect(kinds(verdict)).toContain("one-element");
    }
    // The interior floor is therefore the value the tree shipped with, not a
    // midpoint. Pinned so a later edit has to come past this case.
    expect(OCCUPIED_SHARE_FLOOR.interior).toBe(0.3);
  });

  it("refuses the owner's grey screen at every role — on clause C, and at cover and closer on clause E too", () => {
    // WHICH CLAUSES, named rather than left to `ok`. The plate is one short
    // headline on flat ground and it has to be refused everywhere; the point
    // of naming the clause is that a later change which swaps one refusal for
    // another has to come past this line and say so.
    //
    // It was `empty` AND `dead-space` until 2026-09-15. Clause G now asks the
    // DOM whether any type painted at all, and on this plate it did — so
    // clause G is silent here, correctly, and clause C carries it. See clause
    // G's own comment for why the pixel limb it used to fire on cannot be a
    // gate: `contentOccupiedShare` spreads 0.032 across brand palettes
    // against a floor of 0.06.
    for (const role of ["cover", "interior", "closer"] as const) {
      const verdict = checkInterestFloor(greyScreen(), passingSlideProbe(1), role, { slide: role === "interior" ? 3 : 1, contentElements: 1 });
      expect(verdict.ok, role).toBe(false);
      // At COVER and CLOSER clause C still gates and still speaks. At INTERIOR it
      // reports and clause H refuses — see clause C's own comment for the
      // measurement that moved it. The plate is refused at every role either way,
      // which is what the title claims.
      expect(kinds(verdict), role).toContain(role === "interior" ? "one-element" : "dead-space");
      if (role !== "interior") expect(kinds(verdict), role).toContain("no-device");
    }
  });

  /**
   * THE GUARD, BROKEN ON PURPOSE. Put the old floors back and BOTH halves of
   * the band go wrong at once, which is the property that makes this a
   * re-calibration rather than a relaxation: the new numbers are not merely
   * looser, they are the ones that separate the two plates.
   */
  it("the OLD cover floor falsely refuses the whole measured cover band, and 0.42 admits nothing it should", () => {
    const old: Record<SlideRole, number> = { cover: 0.42, interior: 0.3, closer: 0.42 };
    // The cover is the one role where 0.42 was a FALSE REFUSAL on real pixels:
    // all 19 rendered cover rows sit at 0.2670-0.3517, i.e. entirely under it.
    expect(composedCover().occupiedShare).toBeLessThan(old.cover);
    expect(composedCover().occupiedShare).toBeGreaterThan(OCCUPIED_SHARE_FLOOR.cover * 1.15);
    // The closer's own plate clears the OLD floor too (0.5722 vs 0.42), which
    // is why `closer` in the end did NOT move: 0.42 never refused a real closer
    // row, and the plate the 0.31 band was measured on reverted with RFC-20
    // Part 11. A constant re-derived from a plate this PR no longer changes has
    // no business moving.
    expect(composedCloser().occupiedShare).toBeGreaterThan(old.closer);
    // The grey screen is refused at every role by BOTH sets -- which is why
    // the old floor's failure on this mask is a false-POSITIVE problem. What
    // the old floor could not do is the SHIPPED-hatch case below.
    for (const role of ["cover", "interior", "closer"] as const) {
      expect(greyScreen().occupiedShare, role).toBeLessThan(OCCUPIED_SHARE_FLOOR[role]);
      expect(greyScreen().occupiedShare, role).toBeLessThan(old[role]);
    }
  });

  /**
   * THE FALSE NEGATIVE, WHICH IS THE DEFECT RFC-20 EXISTS FOR. On the shipped
   * painted ground the same two plates measure 0.6688 and 0.6324 — the old
   * floors admit BOTH, and so would the new ones. **No occupancy floor can
   * work on that mask**, which is why the phase changes the GROUND and not the
   * number, and why this case asserts the failure rather than a fix.
   */
  it("no floor, old or new, can refuse the grey screen while the painted ground is counted as occupancy", () => {
    const onShippedHatch = metrics({ flatBackgroundShare: 0.7712, occupiedShare: 0.6324, largestEmptyRectShare: 0, contentOccupiedShare: 0.3128 });
    for (const role of ["cover", "interior", "closer"] as const) {
      expect(onShippedHatch.occupiedShare, role).toBeGreaterThan(0.42);
      expect(onShippedHatch.occupiedShare, role).toBeGreaterThan(OCCUPIED_SHARE_FLOOR[role]);
      // Clause C cannot see it either: the hatch marks a cell everywhere, so
      // the largest all-ground rectangle is 0.0000 on a plate with one line
      // on it. Both of the floor's instruments are disarmed by the decoration.
      expect(onShippedHatch.largestEmptyRectShare, role).toBeLessThan(LARGEST_EMPTY_RECT_CEILING[role]);
    }
  });
});

describe("checkInterestFloor: clause G — a decorated empty plate", () => {
  /**
   * The measured numbers of item M.3's ground field painted over the brand
   * ground with NO content on the plate at all, straight out of the real
   * `measureSlidePng` (`packages/tools/karos-publish/__tests__/slide-metrics.test.ts`
   * builds and asserts this exact PNG). This is the case that showed the
   * floor could not tell a full slide from a blank one.
   */
  const plate = decoratedEmptySlideMetrics();

  it("passes clauses A, C, D and F on its own numbers — which is exactly the defect", () => {
    // Stated as assertions rather than prose so the day one of these
    // thresholds moves, this file says whether the defect is still reachable.
    expect(plate.inkShare).toBeGreaterThan(INK_SHARE_FLOOR);
    expect(plate.largestEmptyRectShare).toBeLessThan(LARGEST_EMPTY_RECT_CEILING.cover);
    expect(plate.flatBackgroundShare).toBeGreaterThan(FLAT_BACKGROUND_CEILING);
    expect(plate.occupiedShare).toBeGreaterThan(OCCUPIED_SHARE_FLOOR.cover);
    expect(plate.textShare).toBeLessThan(TEXT_SHARE_CEILING);
  });

  it("FAILS clause G at every role, because none of what painted is content", () => {
    for (const role of ["interior", "cover", "closer"] as const) {
      const verdict = checkInterestFloor(plate, undefined, role, { slide: role === "interior" ? 3 : 1 });
      expect(kinds(verdict), role).toContain("empty");
      expect(verdict.ok, role).toBe(false);
      const finding = verdict.findings.find((f) => f.kind === "empty")!;
      // The sentence has to carry BOTH numbers, or a reviewer cannot see that
      // the gap between them is the ground treatment.
      expect(finding.sentence).toContain("0%");
      expect(finding.sentence).toContain("42%");
      expect(finding.measured["contentOccupiedShare"]).toBe(0);
      expect(finding.measured["occupiedShare"]).toBeCloseTo(0.4217, 3);
      expect(finding.threshold).toBe(CONTENT_OCCUPIED_SHARE_FLOOR[role]);
    }
  });

  it("boundary, PIXEL limb: exact to 0.001 at each role's own content floor — and only with no probe", () => {
    // The pixel limb is the fallback for a caller with no DOM probe, and this
    // is the case that keeps it honest at its own boundary. `undefined` for
    // the probe is not a convenience here, it is the CONDITION: with a probe
    // present this limb does not run at all, which the second half asserts.
    for (const role of ["interior", "cover", "closer"] as const) {
      const floor = CONTENT_OCCUPIED_SHARE_FLOOR[role];
      const at = (v: number) => kinds(checkInterestFloor(metrics({ contentOccupiedShare: v }), undefined, role, { slide: 3 }));
      expect(at(floor), role).toEqual([]);
      expect(at(floor - EPS), role).toEqual(["empty"]);
      // WITH a probe, the same pixel value says nothing. This is the whole
      // change of 2026-09-15 in one line: on the production path, where a
      // probe always exists, a palette-dependent share stopped gating.
      expect(kinds(check(metrics({ contentOccupiedShare: floor - EPS }), role)), role).toEqual([]);
    }
  });

  it("boundary, DOM limb: exact at PROBE_TEXT_BOX_SHARE_FLOOR, and the same at every role", () => {
    // ONE number for all three roles, deliberately. The pixel floor is
    // per-role because a cover and an interior carry different amounts of
    // furniture; "did any type paint at all" is the same question everywhere,
    // and giving it three answers would be three places to drift.
    for (const role of ["interior", "cover", "closer"] as const) {
      const at = (v: number) => kinds(checkInterestFloor(metrics(), passingSlideProbe(3, { textBoxShare: v }), role, { slide: 3 }));
      expect(at(PROBE_TEXT_BOX_SHARE_FLOOR), role).toEqual([]);
      expect(at(PROBE_TEXT_BOX_SHARE_FLOOR - EPS), role).toEqual(["empty"]);
    }
  });

  it("the cover role's SECOND limb is the probe: a cover whose unconditional ground block is 29% of the frame still fails when no type painted", () => {
    // `cover.html` paints its accent ground block whatever the slots contain,
    // so a cover with every slot empty measures ~29% of CONTENT in pixels and
    // clears the pixel limb. The DOM is the only witness left, and the
    // templates hide every empty slot, so a render whose copy never arrived
    // has no text leaf at all.
    const blankCover = metrics({ contentOccupiedShare: 0.29, graphicShare: 0.29, imageryShare: 0, imageryOrDeviceShare: 0.29 });
    expect(kinds(checkInterestFloor(blankCover, passingSlideProbe(1), "cover", { slide: 1 }))).toEqual([]);
    const verdict = checkInterestFloor(blankCover, passingSlideProbe(1, { textBoxShare: 0 }), "cover", { slide: 1 });
    expect(kinds(verdict)).toEqual(["empty"]);
    expect(verdict.findings[0]!.sentence).toContain("no text box at all");
    expect(verdict.findings[0]!.threshold).toBe(PROBE_TEXT_BOX_SHARE_FLOOR);
  });

  it("the probe limb produces false passes, never false failures: a slide whose only text is ground furniture is left alone", () => {
    // `headline-focus.html`'s glyph ground sets `{{slideIndex}}` as a 760px
    // numeral, so its text box share is never zero. The limb is calibrated to
    // miss that rather than to fail a populated slide, which is why the floor
    // is 1% and not `> 0`.
    expect(kinds(check(metrics({}), "interior"))).toEqual([]);
    expect(kinds(checkInterestFloor(metrics({}), passingSlideProbe(3, { textBoxShare: PROBE_TEXT_BOX_SHARE_FLOOR }), "interior", { slide: 3 }))).toEqual([]);
  });

  it("does not double-report: clauses D and G never both speak for the same plate", () => {
    // `boringSlideMetrics` carries no ground treatment, so every mark on it
    // is content and clause G has nothing to say. Clause D DOES speak for it
    // at the interior role — 18% occupied is under the measured 0.19 floor, on
    // a plate that is 93% flat — so the property this case pins is the one it
    // was always about: at most ONE `empty` finding per plate, whichever limb
    // produced it. An intermediate revision of this phase put the interior
    // floor at 0.12, which took clause D off this plate entirely; that is the
    // check that said the number was wrong.
    // Clause D was demoted on 2026-09-14, so the grey screen now produces ONE
    // finding rather than two: `dead-space` from clause C. The
    // never-double-report property it was written for is stronger than before
    // — there is only one clause left that can say `empty` — and the case is
    // kept because the day a second one appears this line is where it shows.
    expect(kinds(check(boringSlideMetrics(), "interior", 3)).filter((k) => k === "empty")).toHaveLength(0);
    // At the interior role clause C now REPORTS (RFC-21 Part 2), so this plate
    // produces nothing from the pixels at all — and that is the point of the
    // case rather than a hole in it: the never-double-report property is
    // strongest when only one clause can speak. Clause H refuses this plate on
    // its element count, which the case below supplies; here the assertion is
    // that the PIXEL clauses stay silent and do not pile up.
    expect(kinds(check(boringSlideMetrics(), "interior", 3)).sort()).toEqual([]);
    expect(
      checkInterestFloor(boringSlideMetrics(), passingSlideProbe(3), "interior", { slide: 3, contentElements: 1 }).findings.map((f) => f.kind),
      "nothing refuses the grey screen at the interior role",
    ).toEqual(["one-element"]);
    // And the demoted measurement still fires on it, as a report.
    expect(check(boringSlideMetrics(), "interior", 3).warnings.map((w) => w.kind)).toContain("low-occupancy");
    // A plate that is genuinely idle AND has nothing to read used to trip D and
    // G on two different masks and get one finding from each. Clause D was
    // demoted on 2026-09-14, so it now gets ONE finding (clause G) and one
    // WARNING (the demoted occupancy measurement) — and the invariant this case
    // was written for is stronger rather than weaker: with one clause left that
    // can say `empty`, a second occurrence means a clause fired twice.
    // Unreadable is now stated on the DOM, which is where clause G reads it.
    // The pixel numbers are kept exactly as they were so the plate is the same
    // plate: idle, 97% flat, 3% occupied, carrying a device — and with no type
    // box on it.
    const idleAndUnreadable = metrics({ flatBackgroundShare: 0.97, occupiedShare: 0.03, contentOccupiedShare: 0.03, imageryOrDeviceShare: 0.2 });
    const verdict = checkInterestFloor(idleAndUnreadable, passingSlideProbe(3, { textBoxShare: 0.004 }), "interior", { slide: 3 });
    expect(kinds(verdict).filter((k) => k === "empty"), "a clause fired twice for one plate").toHaveLength(1);
    // Both masks are still SPOKEN FOR — one refuses, one reports — so nothing
    // about this plate became invisible when the gate moved.
    expect(verdict.warnings.map((w) => w.kind)).toContain("low-occupancy");
    const sentences = new Set([...verdict.findings, ...verdict.warnings].filter((f) => f.sentence.includes("%")).map((f) => f.sentence));
    expect(sentences.size, "the occupancy report and the content refusal must be two different sentences").toBeGreaterThanOrEqual(2);
  });
});

describe("checkInterestFloor: warnings are facts, never verdicts", () => {
  it("an accent that did not paint warns and does not fail", () => {
    const verdict = check(metrics({ accentShare: ACCENT_MIN_SHARE / 2 }), "interior");
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toEqual([]);
    expect(verdict.warnings.map((w) => w.kind)).toEqual(["accent-out-of-band"]);
    expect(verdict.warnings[0]?.sentence).toMatch(/may not have painted/);
  });

  it("an accent that became the ground warns and does not fail", () => {
    const verdict = check(metrics({ accentShare: ACCENT_MAX_SHARE + 0.1 }), "interior");
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.map((w) => w.kind)).toEqual(["accent-out-of-band"]);
  });

  it("a background that is not the brand ground warns — on a full-bleed photograph that is normal", () => {
    const verdict = check(metrics({ backgroundMatchesBrandGround: false, backgroundHex: "#7b6a55" }), "interior");
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.map((w) => w.kind)).toEqual(["background-not-brand-ground"]);
    expect(verdict.warnings[0]?.sentence).toMatch(/#7b6a55/);
  });

  it("too few colours, and a solid wash, both warn and neither fails", () => {
    expect(check(metrics({ quantisedColourCount: 2, imageryShare: 0.02 }), "interior").warnings.map((w) => w.kind)).toEqual(["low-colour-count"]);
    const wash = check(metrics({ edgeDensity: 0.01 }), "interior");
    expect(wash.ok).toBe(true);
    expect(wash.warnings.map((w) => w.kind)).toEqual(["low-edge-density"]);
  });

  it("does NOT warn about a low colour count on a photo slide, because a photograph legitimately counts zero", () => {
    // `measureSlidePng` counts 5-bit colours holding >= 0.5% of the frame,
    // and a photograph spreads its pixels so thinly that none clears the
    // floor. Warning here would fire on every good photo slide.
    const photo = check(metrics({ quantisedColourCount: 0, imageryShare: 0.62 }), "interior");
    expect(photo.ok).toBe(true);
    expect(photo.warnings).toEqual([]);
  });

  it("no warning kind can ever appear as a finding", () => {
    const verdict = check(
      metrics({ accentShare: 0, backgroundMatchesBrandGround: false, quantisedColourCount: 1, imageryShare: 0.01, edgeDensity: 0.001 }),
      "cover",
      1,
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toHaveLength(4);
  });
});

describe("checkInterestFloor: the one waiver", () => {
  const typeOnly = metrics({ imageryShare: 0, graphicShare: 0, imageryOrDeviceShare: 0 });

  it("waives clause E on a slide this attempt downgraded for want of a picture, and says so", () => {
    const verdict = check(typeOnly, "cover", 1, { downgradedForImages: new Set([1]) });
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toEqual([]);
    expect(verdict.waived.map((f) => f.kind)).toEqual(["no-device"]);
    expect(verdict.waived[0]?.waivedReason).toMatch(/lost its photograph to image sourcing/);
    // Still reported in full — the judge and the reviewer see the number.
    expect(verdict.waived[0]?.measured["imageryOrDeviceShare"]).toBe(0);
  });

  it("does not waive a DIFFERENT slide, and never waives any other clause", () => {
    expect(kinds(check(typeOnly, "cover", 1, { downgradedForImages: new Set([4]) }))).toEqual(["no-device"]);
    // `bare`: a plate carrying imagery earns its hole since 2026-09-14, so a
    // dead-space case has to be a plate with no subject on it.
    const holed = bare({ largestEmptyRectShare: 0.5 });
    expect(kinds(check(holed, "cover", 1, { downgradedForImages: new Set([1]) })).sort()).toEqual(["dead-space"]);
  });
});

describe("the steer the writer receives", () => {
  /** One finding of every kind, each on its own slide, at a role where that kind can fire. */
  function oneOfEveryKind(): InterestFinding[] {
    return [
      ...check(metrics({ inkShare: 0.004 }), "interior", 2).findings,
      ...checkInterestFloor(metrics(), passingSlideProbe(3, { overflow: true, overflowing: [".headline"] }), "interior", { slide: 3 }).findings,
      // `bare` since 2026-09-14: clause C waives a plate that carries a
      // subject, so a dead-space specimen has to be a plate with none.
      ...check(bare({ largestEmptyRectShare: 0.42 }), "cover", 1).findings.filter((f) => f.kind === "dead-space"),
      // Clause D is reporting-only, so the `empty` specimen comes from clause
      // G — nothing to READ — which was always the substantive limb, and since
      // 2026-09-15 it reads the DOM rather than the pixels.
      ...checkInterestFloor(metrics(), passingSlideProbe(5, { textBoxShare: 0.004 }), "interior", { slide: 5 }).findings,
      ...check(metrics({ imageryOrDeviceShare: 0 }), "closer", 6).findings,
      ...check(metrics({ textShare: 0.61 }), "interior", 4).findings,
    ];
  }

  it("carries the measured percentage, the threshold and the slide number for every kind", () => {
    const findings = oneOfEveryKind();
    expect(findings.map((f) => f.kind).sort()).toEqual(["clipped", "dead-space", "empty", "no-device", "render-integrity", "text-wall"]);
    for (const finding of findings) {
      const steer = interestSteerFor(finding);
      expect(steer, finding.kind).toMatch(new RegExp(`slide ${finding.slide}\\b`));
      // At least two percentages in the sentence: what was measured, and the
      // line it was measured against.
      expect(steer.match(/\d+(?:\.\d+)?%/gu)?.length ?? 0, finding.kind).toBeGreaterThanOrEqual(2);
      expect(Object.keys(finding.measured).length, finding.kind).toBeGreaterThan(0);
      expect(typeof finding.threshold, finding.kind).toBe("number");
    }
  });

  it("names a mechanism the writer controls in every steer, and never an aesthetic", () => {
    const mechanisms = /device|visualNeed|fontScale|merge it|Re-render|caption|split the slide|archetype|recap|question/i;
    for (const finding of oneOfEveryKind()) {
      expect(finding.steer, finding.kind).toMatch(mechanisms);
      // The vocabulary a steer must not reach for: taste words a writer
      // cannot act on. `checkInterestFloor` measures, it does not opine.
      expect(finding.steer, finding.kind).not.toMatch(/beautiful|elegant|more interesting|nicer|striking|premium/i);
    }
  });

  it("joins every failing slide into one steer, so a redraft is told about all of them at once", () => {
    const findings = oneOfEveryKind();
    const steer = interestSteerFor(findings);
    for (const slide of [1, 2, 3, 4, 5, 6]) expect(steer).toMatch(new RegExp(`slide ${slide}\\b`));
    expect(steer.split("\n")).toHaveLength(findings.length);
  });

  it("formatInterestFailures is what returnToCopyWith receives: the failing slides, then the numbers, then the remedies", () => {
    const findings = oneOfEveryKind();
    const body = formatInterestFailures(findings);
    expect(body).toMatch(/^the rendered slides failed the visual-interest floor on slide\(s\) 1, 2, 3, 4, 5, 6 /);
    expect(body).toMatch(/no model call spent/);
    expect(body).toContain(findings[0]!.sentence);
    expect(formatInterestFailures([])).toBe("");
  });

  it("summarizeInterestFindings is the compact ledger line, shaped like the default-render-rule one", () => {
    const findings = check(boringSlideMetrics(), "cover", 1).findings;
    const line = summarizeInterestFindings(findings);
    expect(line).toMatch(/interest:dead-space \(slide 1\)/);
    expect(line).toMatch(/interest:no-device \(slide 1\)/);
    // One segment per finding — and the separator is ` | ` precisely because
    // these sentences carry their own semicolons.
    expect(line.split(INTEREST_FINDING_SEPARATOR)).toHaveLength(findings.length);
    expect(line.split(INTEREST_FINDING_SEPARATOR).every((s) => s.startsWith("interest:"))).toBe(true);
  });

  it("the degraded reason says whether the run stopped redrafting because it ran out of attempts or out of budget", () => {
    const findings = check(boringSlideMetrics(), "cover", 1).findings;
    expect(interestDegradedReason(findings)).toMatch(/after the last drafting attempt/);
    expect(interestDegradedReason(findings, { pastHardMax: true })).toMatch(/over the run's hard max, shipped with the finding recorded rather than redrafted/);
  });
});

describe("checkSlidesInterestFloor: the whole attempt", () => {
  const six = () => [1, 2, 3, 4, 5, 6].map((n) => ({ n, metrics: metrics(), probe: passingSlideProbe(n) }));

  it("assigns cover/interior/closer by position and passes a clean carousel", () => {
    const report = checkSlidesInterestFloor(six());
    expect(report.ok).toBe(true);
    expect(report.perSlide.map((v) => v.role)).toEqual(["cover", "interior", "interior", "interior", "interior", "closer"]);
    expect(report.findings).toEqual([]);
    expect(report.notMeasured).toEqual([]);
  });

  it("collects every failing slide's findings in slide order", () => {
    const slides = six();
    slides[0] = { ...slides[0]!, metrics: boringSlideMetrics() };
    slides[4] = { ...slides[4]!, metrics: metrics({ textShare: 0.7 }) };
    const report = checkSlidesInterestFloor(slides);
    expect(report.ok).toBe(false);
    // Two for slide 1 (clause C's hole and clause E's missing device — clause
    // D stopped speaking for this plate when RFC-20 re-calibrated the floor;
    // see "still fails the audit slide" above) and one for slide 5.
    expect(report.findings.map((f) => f.slide)).toEqual([1, 1, 5]);
  });

  it("an UNMEASURED slide is a fact, never a verdict — it cannot make the attempt fail", () => {
    const slides = six().map((s, i) => (i === 2 ? { n: s.n, probe: s.probe, measureFailure: "measureSlidePng: interlaced PNG" } : s));
    const report = checkSlidesInterestFloor(slides);
    expect(report.ok).toBe(true);
    expect(report.perSlide).toHaveLength(5);
    expect(report.notMeasured).toEqual([{ slide: 3, reason: "measureSlidePng: interlaced PNG" }]);
  });

  it("names the archetype in the finding when the caller knows it, so item O's custom layouts are identifiable", () => {
    const slides = six();
    slides[0] = { ...slides[0]!, metrics: boringSlideMetrics() };
    const report = checkSlidesInterestFloor(slides, { archetypeBySlide: new Map([[1, "custom-pull_rail"]]) });
    expect(report.findings[0]?.sentence).toMatch(/slide 1 \("custom-pull_rail"\)/);
  });

  it("threads the image-sourcing waiver through, so a downgraded cover does not fail clause E", () => {
    const slides = six();
    slides[0] = { ...slides[0]!, metrics: metrics({ imageryOrDeviceShare: 0 }) };
    expect(checkSlidesInterestFloor(slides).findings.map((f) => f.kind)).toEqual(["no-device"]);
    const waived = checkSlidesInterestFloor(slides, { downgradedForImages: new Set([1]) });
    expect(waived.ok).toBe(true);
    expect(waived.waived.map((f) => f.kind)).toEqual(["no-device"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The free re-layout
// ─────────────────────────────────────────────────────────────────────────

/** A finding of `kind` on `slide` at `role`, built through the real rule so the fixture cannot drift from what the gate actually produces. */
function findingFor(kind: InterestFinding["kind"], slide: number, role: SlideRole): InterestFinding {
  const byKind: Record<InterestFinding["kind"], Partial<SlideMetrics>> = {
    "render-integrity": { inkShare: 0.004 },
    // NOT a photo-bearing plate, since Phase 5.5: the full-bleed exemption
    // starts at `imageryOrDeviceShare` 0.28 (the live photo band is
    // 0.329-0.593), and the baseline fixture sits at 0.34 — so a `clipped`
    // specimen has to be a plate that carries no photograph, which is what
    // the pixel limb is about.
    clipped: { clippedEdgeShare: 0.02, imageryShare: 0, graphicShare: 0.05, imageryOrDeviceShare: 0.05 },
    // `imageryOrDeviceShare: 0` since 2026-09-14: clause C abstains on a plate
    // that carries a subject, so a dead-space fixture has to be a BARE plate or
    // it is exercising the waiver instead of the clause.
    "dead-space": { largestEmptyRectShare: 0.45, imageryShare: 0, graphicShare: 0, imageryOrDeviceShare: 0 },
    // Clause D was demoted to reporting-only on 2026-09-14, so an `empty`
    // finding comes from clause G — nothing to READ on the plate — which is
    // the limb that was always the substantive one.
    //
    // 2026-09-15: and clause G reads the DOM now, so this row carries NO
    // pixel override at all — see `EMPTY_PROBE` below. A fixture that
    // produced this finding from `contentOccupiedShare` alone was describing
    // a plate measured on the DECORATED tree, where the number it moved was
    // the texture's rather than the copy's.
    empty: {},
    "no-device": { imageryShare: 0, graphicShare: 0, imageryOrDeviceShare: 0 },
    "text-wall": { textShare: 0.7 },
    // Clause H reads no metrics at all — it reads `opts.contentElements`, which
    // `byKindOpts` below supplies. The empty object is the honest entry.
    "one-element": {},
    // Unreachable through this helper, and that is the clause's whole point:
    // `marks-missing` is DOM-anchored (it reads the probe's `markRuns` /
    // `markRunsPainted`), and `passingSlideProbe` declares no mark runs, so no
    // metrics object can produce it. Its cases live in
    // `interest-floor-marks.test.ts`.
    "marks-missing": {},
    // Phase 5.5's clause I reads no metrics either: it reads
    // `probe.subjectBoxes`, laid-out boxes rather than pixels, which
    // `byKindProbe` below supplies. The real-Chromium cases are in
    // `cover-subject.test.ts`. The empty row is the honest entry.
    "cover-subject": {},
    // Phase 5.5's type-discipline clause reads `probe.typeSteps` /
    // `probe.alignmentColumns` and no metrics at all — and it can only ever
    // produce a FINDING when one of the three `*_ARMED` flags in
    // `interest-floor.ts` is `true`, which none of them is. So this helper
    // cannot build a specimen of it today, by design, and the empty row is
    // both the honest entry and the reason `typeDisciplineLimbs` is exported
    // as a pure function: its own cases test the routing directly, with the
    // flags passed in.
    "type-discipline": {},
  };
  // The DOM side of the same table, and `empty` is the only row that needs
  // one: clause G's refusal is `probe.textBoxShare` below
  // `PROBE_TEXT_BOX_SHARE_FLOOR`, which is what "this plate carries nothing
  // to read" means once the question is asked of the document rather than of
  // the pixels. Every other clause still reads metrics.
  const byKindProbe: Partial<Record<InterestFinding["kind"], Parameters<typeof passingSlideProbe>[1]>> = {
    empty: { textBoxShare: 0.004 },
    // The gradient cover, as boxes: no photograph, a rule and a badge under
    // 1% of the canvas between them, nothing that reaches the object floor.
    "cover-subject": { subjectBoxes: { hero: 0, device: 0.004, graphic: 0.01 } },
  };
  // Clause H abstains unless the caller supplies a count, so only its own row
  // sets one — every other kind keeps the abstention, which is what stops this
  // helper from producing two findings where the case wants one.
  const byKindElements: Partial<Record<InterestFinding["kind"], number>> = { "one-element": 1 };
  // `dead-space` gates at COVER and CLOSER only since RFC-21 Part 2: clause C
  // reports at the interior role and clause H carries the refusal there. Asked
  // at `interior` this helper would come back empty, so it asks at the role the
  // clause still speaks at rather than silently producing nothing.
  // CLOSER rather than cover: the cover role has its own limb in
  // `planInterestRelayout` (`.cov-field`'s empty device slot), so a specimen
  // built at the cover role would exercise that limb instead of the ladder
  // these cases are about. The closer gates on clause C identically and has
  // no such limb.
  const roleFor = kind === "dead-space" && role === "interior" ? "closer" : role;
  const verdict = checkInterestFloor(metrics(byKind[kind]), passingSlideProbe(slide, byKindProbe[kind]), roleFor, { slide, ...(byKindElements[kind] !== undefined ? { contentElements: byKindElements[kind] } : {}) });
  const finding = verdict.findings.find((f) => f.kind === kind);
  if (finding === undefined) throw new Error(`fixture did not produce a "${kind}" finding at role ${role}`);
  return finding;
}

function copyWithLayouts(layouts: Partial<Record<number, InstagramCopyOutput["slides"][number]["layout"]>>): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return { ...copy, slides: copy.slides.map((s) => ({ ...s, layout: layouts[s.n] ?? s.layout })) };
}

/**
 * A `dead-space` finding on slide 1 at the cover role whose rectangle is the
 * one given — built through the REAL rule, so the four scalars the cover limb
 * reads are the ones `checkInterestFloor` actually emits rather than a shape
 * this file invented. A hand-written `measured` map would pass whatever the
 * clause did.
 */
function coverDeadSpace(rect: { x: number; y: number; w: number; h: number }, share: number): InterestFinding {
  const verdict = checkInterestFloor(bare({ largestEmptyRect: rect, largestEmptyRectShare: share }), passingSlideProbe(1), "cover", { slide: 1 });
  const finding = verdict.findings.find((f) => f.kind === "dead-space");
  if (finding === undefined) throw new Error(`a ${share} rectangle produced no dead-space finding at the cover role`);
  return finding;
}

/**
 * Slide 1 as a `cover` whose own headline and body carry NO figure.
 *
 * Load-bearing for the cover-limb cases: with a figure in its own text the
 * `dead-space` ladder's own step 1 would build a device too, and a test that
 * cannot tell the limb's device from the ladder's proves nothing about which
 * one ran. Stripped, the only device in reach is `coverRemedy`'s — from the
 * post's strongest sourced fact card — so the two are distinguishable by the
 * value they carry.
 */
function coverCopyWithoutItsOwnFigure(): InstagramCopyOutput {
  const copy = copyWithLayouts({ 1: "cover" });
  return {
    ...copy,
    slides: copy.slides.map((s) => (s.n === 1 ? { ...s, headline: "What changed this quarter", body: "The team reworked its intake process end to end." } : s)),
  };
}

function unusableSelections(): ImageSelection[] {
  return goodImageVettingOutput().selections.map((s) => ({ ...s, imagePath: null, reason: "no candidate qualified" }));
}

describe("figuresInText / deviceFromText", () => {
  it("captures a figure verbatim, strongest first: a unit beats a bare count", () => {
    expect(figuresInText("We cut 5 rounds to 2, a 60% drop.").map((f) => f.value)).toEqual(["60%", "5", "2"]);
  });

  it("skips a bare year, because a date is not a statistic", () => {
    expect(figuresInText("2026 was the year agencies stopped discounting.").map((f) => f.value)).toEqual([]);
    // With a unit it IS a figure again.
    expect(figuresInText("Revenue hit 2026k last quarter.").map((f) => f.value)).toEqual(["2026k"]);
  });

  it("drops a token too long to be a figure rather than truncating it — half a number is worse than no device", () => {
    expect(figuresInText("The reference is 1,234,567,890,123 exactly.").map((f) => f.value)).toEqual([]);
  });

  it("builds a device only when the figure, a label and a source all exist", () => {
    const device = deviceFromText("Support resolved 30% more tickets after the new triage flow.", "support dashboard export");
    expect(device).toEqual({ kind: "figure", value: "30%", label: "Support resolved more tickets after the new triage flow", source: "support dashboard export" });
    // No figure, no device — never a manufactured one.
    expect(deviceFromText("The team reworked its process end to end.", "retro notes")).toBeUndefined();
    // No source, no device: item M's rule is that every figure names its source.
    expect(deviceFromText("Support resolved 30% more tickets.", "  ")).toBeUndefined();
  });

  it("cuts the figure out of its label by POSITION, so a year elsewhere in the sentence survives intact", () => {
    // `replace(value, …)` looked equivalent and was not: on this sentence the
    // figure is `4`, and replacing the first "4" turns 2024 into 202 and
    // leaves the real figure in the label.
    expect(deviceFromText("In 2024 we saved 4 hours a week.", "internal survey")).toEqual({
      kind: "figure",
      value: "4",
      label: "In 2024 we saved hours a week",
      source: "internal survey",
    });
  });

  it("labels a figure from its OWN sentence, not from the whole body", () => {
    const device = deviceFromText("The rollout took a quarter. Onboarding then dropped to 7 days.", "cohort analysis");
    expect(device?.value).toBe("7");
    // "…dropped to" — the figure completes the clause, so the label stops
    // where the clause starts reaching for it. This used to read "Onboarding
    // then dropped to days.", which is the milder form of what shipped on
    // slide 3 of the Karos carousel: "dropping accuracy to ."
    expect(device?.label).toBe("Onboarding then dropped");
  });

  it("refuses rather than printing a clause with its value cut out of the middle", () => {
    // The shipped defect, exactly. The figure is the last thing in the
    // sentence and the full stop survives the splice, so the plate printed a
    // sentence whose value was the one thing missing from it — directly
    // under that value, set at display size.
    const shipped = deviceFromText("Error stacks at every step, dropping accuracy to 77%.", "MLDeep Blog");
    expect(shipped?.label).toBe("Error stacks at every step, dropping accuracy");
    expect(shipped?.label).not.toContain(" .");

    // And when nothing readable is left, no device at all: a big number over
    // a one-word fragment is the "technically correct and empty" this
    // extractor exists to refuse.
    expect(deviceFromText("Down to 12%.", "a source")).toBeUndefined();
  });
});

describe("planInterestRelayout: the fixed table", () => {
  const facts = SIX_RESEARCH_FACTS;

  it("render-integrity re-renders once and changes nothing about the copy", () => {
    const plan = planInterestRelayout(goodCopyOutput(), goodImageVettingOutput().selections, facts, [findingFor("render-integrity", 3, "interior")]);
    expect(plan?.changes).toEqual([
      { kind: "re-render", slide: 3, reason: "slide 3 measured almost no ink; re-rendering once before treating it as a tooling failure" },
    ]);
  });

  it("clipped drops the slide's fontScale one step, and has no remedy left at the smallest step", () => {
    const plan = planInterestRelayout(goodCopyOutput(), goodImageVettingOutput().selections, facts, [findingFor("clipped", 4, "interior")]);
    expect(plan?.changes[0]).toMatchObject({ kind: "font-scale", slide: 4, from: "m", to: "s" });

    const atFloor = planInterestRelayout(goodCopyOutput(), goodImageVettingOutput().selections, facts, [findingFor("clipped", 4, "interior")], {
      styleOverrides: new Map([[4, { fontScale: "s" as const }]]),
    });
    expect(atFloor).toBeUndefined();
  });

  it("no-device on the cover promotes a vetted image no slide is rendering, best claim match first", () => {
    // Slides 3-6 shipped typographic, so their vetted images are going nowhere.
    const copy = copyWithLayouts({ 3: "text_only", 4: "text_only", 5: "text_only", 6: "text_only" });
    const selections = goodImageVettingOutput().selections.map((s) => (s.n === 4 ? { ...s, claimMatch: 5 } : { ...s, claimMatch: 3 }));
    const plan = planInterestRelayout(copy, selections, facts, [findingFor("no-device", 1, "cover")]);
    expect(plan?.changes[0]).toMatchObject({ kind: "promote-image-to-cover", slide: 1, fromSlide: 4, archetype: "cover" });
    expect(plan?.changes[0]?.reason).toMatch(/claimMatch 5\/5/);
  });

  it("...and never promotes an image that failed rights, watermark or claim-match, however badly the cover needs one", () => {
    const copy = copyWithLayouts({ 3: "text_only" });
    const selections = goodImageVettingOutput().selections.map((s) => (s.n === 3 ? { ...s, rightsUsable: false } : s));
    const plan = planInterestRelayout(copy, selections, facts, [findingFor("no-device", 1, "cover")]);
    expect(plan?.changes[0]?.kind).not.toBe("promote-image-to-cover");
  });

  /**
   * ── THE COVER'S FACT-CARD DEVICE LIMB IS DELETED (Phase 5.5 §4.7). ──
   *
   * It read: build a figure device from the strongest sourced `kind: "stat"`
   * card in the post. On 2026-09-16 that shipped
   *
   *     7.2%   Only of organizations respond to inbound leads within five
   *            minutes, meaning
   *
   * on the cover of a post about generative-engine optimisation — a figure
   * from a card the post's own angle does not rest on, labelled with the
   * middle of that card's sentence, **and the identical figure appeared on a
   * second post about a different subject**, because "the strongest stat card"
   * is a property of the research and not of the argument.
   *
   * A cover's subject is the one thing this module may not invent. What is
   * left is a real picture and the archetype's own ground.
   */
  it("...and NEVER builds a cover device from a fact card the post's own angle did not rest on", () => {
    const plan = planInterestRelayout(goodCopyOutput(), unusableSelections(), facts, [findingFor("no-device", 1, "cover")]);
    expect(plan?.changes[0]?.kind).not.toBe("attach-device");
    expect(plan?.changes[0]).toMatchObject({ kind: "colour-block-ground", slide: 1, archetype: "cover" });
    // Not one change in the plan carries a figure the cover's own copy does
    // not state — which is the property, stated as the property.
    expect(JSON.stringify(plan)).not.toContain("device");
  });

  it("...else falls back to the cover archetype's colour-block ground, which cannot be a headline on flat ground", () => {
    const plan = planInterestRelayout(goodCopyOutput(), unusableSelections(), [], [findingFor("no-device", 1, "cover")]);
    expect(plan?.changes[0]).toMatchObject({ kind: "colour-block-ground", slide: 1, archetype: "cover" });
  });

  it("no-device on the closer builds a recap strip from the post's own earlier points", () => {
    const plan = planInterestRelayout(goodCopyOutput(), unusableSelections(), facts, [findingFor("no-device", 6, "closer")]);
    const change = plan?.changes[0] as Extract<InterestRelayoutChange, { kind: "build-recap" }> | undefined;
    expect(change?.kind).toBe("build-recap");
    expect(change?.archetype).toBe("closer");
    // 2-4 plates, from the slides BEFORE the closer, in the order the post made its points.
    expect(change?.rows.map((r) => r.fromSlide)).toEqual([2, 3, 4, 5]);
    expect(change?.rows.every((r) => r.label.length > 0)).toBe(true);
  });

  it("...and with too few earlier points, promotes a question the post ALREADY asks rather than inventing one", () => {
    const copy = goodCopyOutput();
    const twoSlides: InstagramCopyOutput = {
      ...copy,
      slides: [copy.slides[0]!, { ...copy.slides[1]!, body: "So what would you change on Monday?" }],
    };
    const plan = planInterestRelayout(twoSlides, unusableSelections().slice(0, 2), facts, [findingFor("no-device", 2, "closer")]);
    expect(plan?.changes[0]).toMatchObject({ kind: "add-question-block", slide: 2, question: "So what would you change on Monday?", from: "body" });
  });

  it("...and with no question anywhere in the post, there is no free remedy — authoring is the redraft's job", () => {
    const copy = goodCopyOutput();
    const twoSlides: InstagramCopyOutput = {
      ...copy,
      caption: "A quick look at the process changes that moved the needle.",
      slides: [copy.slides[0]!, { ...copy.slides[1]!, headline: "What we changed", body: "The team reworked its process end to end." }],
    };
    const plan = planInterestRelayout(twoSlides, unusableSelections().slice(0, 2), facts, [findingFor("no-device", 2, "closer")]);
    expect(plan).toBeUndefined();
  });

  /**
   * RFC-20 §5.5 — THE COVER'S HOLE, AND THE REMEDY THAT ALREADY EXISTED.
   *
   * With the full-bleed screen deleted, `cover.html` fails clause C at 23.61%
   * against a 22% ceiling and the failing rectangle is `{x: 0, y: 236, w: 1080,
   * h: 376}` — `.cov-device`'s slot standing empty, between the ramp's foot and
   * the lockup's head. A device closes the band to 228px and the plate passes
   * at 15.83%. The remedy is `deviceFromText` over a `kind: "stat"` fact card:
   * deterministic regex, $0.00, no model call.
   *
   * Before this limb that path was reachable only from a `no-device` finding,
   * which a cover on its bounded ramp (iod 16-19% against a 10% floor) never
   * produces. So the plate had a free remedy sitting behind a clause it could
   * not trip, and the ladder's answers to a 376px band — a switch away from
   * the one archetype built for the case, or one step of `fontScale` — cannot
   * close it.
   *
   * The EXTENT test is what makes the limb a limb rather than a widening, and
   * both sides of it are driven below: a hole inside the field takes the
   * device, a hole over the lockup does not.
   */
  it("a dead-space hole INSIDE .cov-field takes the cover's PICTURE remedy, ahead of the ladder", () => {
    // The measured rectangle, verbatim: y 236, h 376, inside the field.
    const finding = coverDeadSpace({ x: 0, y: 236, w: 1080, h: 376 }, 0.2361);
    // Slides 3-6 shipped typographic, so their vetted pictures are going
    // nowhere and one of them can close the band.
    const copy = copyWithLayouts({ 1: "cover", 3: "text_only", 4: "text_only" });
    const withoutOwnFigure: InstagramCopyOutput = {
      ...copy,
      slides: copy.slides.map((s) => (s.n === 1 ? { ...s, headline: "What changed this quarter", body: "The team reworked its intake process end to end." } : s)),
    };
    const plan = planInterestRelayout(withoutOwnFigure, goodImageVettingOutput().selections, SIX_RESEARCH_FACTS, [finding]);
    expect(plan?.changes[0]).toMatchObject({ kind: "promote-image-to-cover", slide: 1, archetype: "cover" });
  });

  it("...and with no picture to promote it fabricates NOTHING: the cover limb declines and the ladder answers", () => {
    // Phase 5.5: this is the case that used to produce the `7.2% / "Only of
    // organizations respond… meaning"` cover. The limb's device rung is gone,
    // so a cover with a hole and no picture goes back to the writer with
    // clause C's steer — at most one more copy attempt.
    const finding = coverDeadSpace({ x: 0, y: 236, w: 1080, h: 376 }, 0.2361);
    const plan = planInterestRelayout(coverCopyWithoutItsOwnFigure(), unusableSelections(), SIX_RESEARCH_FACTS, [finding]);
    expect(plan?.changes[0]?.kind).not.toBe("attach-device");
    expect(plan?.changes[0]).toMatchObject({ kind: "font-scale", slide: 1 });
  });

  /**
   * ── CLAUSE I's REMEDY IS A PICTURE OR NOTHING. ──
   *
   * A cover with no subject has exactly one free remedy, and if it is not
   * available the finding goes back to `05`. That is the whole design: the two
   * live attempts at inventing a cover subject produced a digit cut out of the
   * word `B2B` and a figure from another post's argument.
   */
  it("cover-subject promotes a vetted picture, and has no second rung", () => {
    const withPicture = planInterestRelayout(
      copyWithLayouts({ 1: "cover", 3: "text_only" }),
      goodImageVettingOutput().selections,
      facts,
      [findingFor("cover-subject", 1, "cover")],
    );
    expect(withPicture?.changes[0]).toMatchObject({ kind: "promote-image-to-cover", slide: 1, archetype: "cover" });

    const withNone = planInterestRelayout(goodCopyOutput(), unusableSelections(), facts, [findingFor("cover-subject", 1, "cover")]);
    expect(withNone).toBeUndefined();
  });

  it("...and a hole over the LOCKUP does not: that is too little copy, and it gets the ladder", () => {
    // Same share, a rectangle in the lower third — past `.cov-field`'s foot.
    const finding = coverDeadSpace({ x: 0, y: 1000, w: 1080, h: 376 }, 0.2361);
    const plan = planInterestRelayout(coverCopyWithoutItsOwnFigure(), unusableSelections(), SIX_RESEARCH_FACTS, [finding]);
    // `cover` is not one of the two shapeless archetypes the ladder switches,
    // and the slide carries no figure of its own, so what is left is the type
    // size — the ladder's own answer, unchanged by this phase.
    expect(plan?.changes[0]).toMatchObject({ kind: "font-scale", slide: 1, from: "m", to: "l" });
  });

  it("...and a finding carrying no rectangle at all falls through to the ladder rather than guessing", () => {
    // An older gate payload replayed, or a hand-built fixture: the four
    // scalars are absent, so the limb declines. It can only ever OFFER a
    // remedy a plate did not have, never take one away.
    const bare: InterestFinding = { ...coverDeadSpace({ x: 0, y: 236, w: 1080, h: 376 }, 0.2361), measured: { largestEmptyRectShare: 0.2361 } };
    const plan = planInterestRelayout(coverCopyWithoutItsOwnFigure(), unusableSelections(), SIX_RESEARCH_FACTS, [bare]);
    expect(plan?.changes[0]?.kind).toBe("font-scale");
  });

  it("the cover limb withholds the colour-block ground, because that change cannot move a pixel on a slide already on cover", () => {
    // No usable image and no fact cards, so `coverRemedy` runs out at step 3.
    // From a `no-device` finding it returns `colour-block-ground`, which moves
    // a non-cover slide onto the cover archetype and genuinely repaints. From
    // this limb the slide is ALREADY on `cover`, so the same change would
    // re-render byte-identically and spend the attempt's one free chance — the
    // defect this module's header names. It declines and the ladder answers.
    const finding = coverDeadSpace({ x: 0, y: 236, w: 1080, h: 376 }, 0.2361);
    const plan = planInterestRelayout(coverCopyWithoutItsOwnFigure(), unusableSelections(), [], [finding]);
    expect(plan?.changes[0]?.kind).not.toBe("colour-block-ground");
    expect(plan?.changes[0]?.kind).toBe("font-scale");
    // And the `no-device` path is untouched: it still reaches the fallback.
    const noDevice = planInterestRelayout(goodCopyOutput(), unusableSelections(), [], [findingFor("no-device", 1, "cover")]);
    expect(noDevice?.changes[0]).toMatchObject({ kind: "colour-block-ground", slide: 1, archetype: "cover" });
  });

  /**
   * ── THE DEVICE IS THE LAST RUNG NOW, NOT THE FIRST (Phase 5.5 §4.7). ──
   *
   * The ladder is: merge the slide away, promote a picture onto it, render the
   * content it already has through the archetype that shows it, raise the type
   * step, and only then set a figure as a device. Every rung above the device
   * shows the reader something that already exists; the device rung re-sets a
   * number that is already on the plate, and it is the rung that fabricated
   * the digit `2` out of the word `B2B`.
   *
   * So this case asserts BOTH halves: the device is not reached while a rung
   * above it can act, and it still fires when nothing above it can.
   */
  it("dead-space and empty set a figure from the slide's own text as a device — LAST, after the rungs that add real content", () => {
    // `headline_focus` on a slide whose copy also fills a `stat` block: the
    // archetype rung can act, so it does, and the device does not.
    const copy = copyWithLayouts({ 2: "headline_focus" });
    for (const kind of ["dead-space", "empty"] as const) {
      const plan = planInterestRelayout(copy, goodImageVettingOutput().selections, facts, [findingFor(kind, 2, "interior")]);
      expect(plan?.changes[0]?.kind, kind).toBe("switch-archetype");
      // `photo`: slide 2 has a vetted picture of its OWN that the typographic
      // archetype was not rendering, and showing it is worth more than
      // re-setting a number the plate already prints.
      expect(plan?.changes[0], kind).toMatchObject({ from: "headline_focus", to: "photo" });
    }

    // Strip the structured block and the picture, and the device rung is what
    // is left — from the slide's OWN body ("30%"), with its own source.
    const plain = copyWithLayouts({ 2: "headline_focus" });
    const noBlocks: InstagramCopyOutput = {
      ...plain,
      slides: plain.slides.map((s) => (s.n === 2 ? { ...s, stat: undefined, items: undefined, quote: undefined, comparison: undefined } : s)),
    };
    for (const kind of ["dead-space", "empty"] as const) {
      const plan = planInterestRelayout(noBlocks, unusableSelections(), facts, [findingFor(kind, 2, "interior")], {
        // At the top of the type ladder, so the font-scale rung cannot act
        // either and the device rung is genuinely last.
        styleOverrides: new Map([[2, { fontScale: "l" as const }]]),
      });
      const change = plan?.changes[0] as Extract<InterestRelayoutChange, { kind: "attach-device" }> | undefined;
      expect(change?.kind, kind).toBe("attach-device");
      expect(change?.device.value, kind).toBe("30%");
      expect(change?.device.source, kind).toBe("support dashboard export");
      // Already on a device-slot archetype, so no switch rides along.
      expect(change?.archetype, kind).toBeUndefined();
    }
  });

  /**
   * ── THE `B2B` CASE, REPLAYED. ──
   *
   * `interest-floor.ts` records it in its own comment: on run
   * `pubsub-21839432908803804` the `attach-device` remedy fabricated the digit
   * `2` out of the middle of the word `B2B`, labelled it with the claim minus
   * that digit, and sourced it to a real company. `figuresInText`'s
   * word-boundary guard closed that hole; `verbatimDeviceFor` is the second,
   * independent reading of the same property, and this case is the control
   * that says both are still there.
   */
  it("never fabricates a figure out of the middle of a word, and never labels one with a fragment", () => {
    const copy = copyWithLayouts({ 2: "headline_focus" });
    const b2b: InstagramCopyOutput = {
      ...copy,
      slides: copy.slides.map((s) =>
        s.n === 2
          ? {
              ...s,
              headline: "B2B buyers changed where they look",
              body: "Discovery moved, and the funnel followed it.",
              stat: undefined,
              items: undefined,
              quote: undefined,
              comparison: undefined,
            }
          : s,
      ),
    };
    const plan = planInterestRelayout(b2b, unusableSelections(), facts, [findingFor("empty", 2, "interior")], {
      styleOverrides: new Map([[2, { fontScale: "l" as const }]]),
    });
    // No figure in the slide's own words, so no device — and no plan at all,
    // because every other rung has already declined. The redraft is what this
    // case is for.
    expect(plan).toBeUndefined();
  });

  /**
   * A REMEDY MUST BE ABLE TO TAKE EFFECT.
   *
   * `contentFor` emits `htmlFragments.device` only for `cover` and
   * `headline_focus` (and for a `closer` whose middle is not already a recap
   * strip) — `if (!DEVICE_SLOT_LAYOUTS.has(layout)) return result;`. An
   * `attach-device` on any other archetype therefore re-rendered
   * byte-identically at `08a1c`, failed `08a1d` on the same numbers, and
   * spent the attempt's one free chance for nothing, on the two commonest
   * failure kinds. A remedy that cannot move a pixel is worse than no
   * remedy: it looks like one in the trace.
   */
  it("never sets a device on an archetype that paints none — it carries the switch that makes it paint, or it does not offer one", () => {
    // `text_only`: no device slot, and no structured content block either.
    // The ladder's floor is `headline_focus`, which CAN paint, so the switch
    // and the device travel as one change.
    const shapeless = copyWithLayouts({ 2: "text_only" });
    const withDevice = planInterestRelayout(shapeless, unusableSelections(), facts, [findingFor("empty", 2, "interior")]);
    const change = withDevice?.changes[0] as Extract<InterestRelayoutChange, { kind: "attach-device" }> | undefined;
    expect(change?.kind).toBe("attach-device");
    expect(change?.archetype).toBe("headline_focus");
    expect(change?.device.value).toBe("30%");
    expect(change?.reason).toContain("paints no device");

    // `list_takeaway`: a designed plate of its own, which a free re-layout
    // must not throw away to fix its empty half — and no device is offered,
    // because none would render.
    const listCopy = copyWithLayouts({ 2: "list_takeaway" });
    const listed = planInterestRelayout(listCopy, goodImageVettingOutput().selections, facts, [findingFor("empty", 2, "interior")]);
    expect(listed?.changes[0]?.kind).not.toBe("attach-device");
  });

  it("...else switches a shapeless archetype to the one the slide's own content blocks call for", () => {
    const copy = copyWithLayouts({ 2: "text_only" });
    const slides = copy.slides.map((s) =>
      s.n === 2
        ? { ...s, headline: "What changed", body: "The team reworked its process end to end.", stat: { figure: "30%", subLabel: "more tickets resolved", source: "support dashboard export" } }
        : s,
    );
    const plan = planInterestRelayout({ ...copy, slides }, goodImageVettingOutput().selections, facts, [findingFor("empty", 2, "interior")]);
    expect(plan?.changes[0]).toMatchObject({ kind: "switch-archetype", slide: 2, from: "text_only", to: "stat_callout" });
  });

  it("...but never into an archetype another slide has already claimed, because resolveLayout would degrade it straight back", () => {
    const copy = copyWithLayouts({ 2: "text_only", 5: "stat_callout" });
    const slides = copy.slides.map((s) =>
      s.n === 2
        ? { ...s, headline: "What changed", body: "The team reworked its process end to end.", stat: { figure: "30%", subLabel: "more tickets resolved", source: "support dashboard export" } }
        : s,
    );
    const plan = planInterestRelayout({ ...copy, slides }, unusableSelections(), facts, [findingFor("empty", 2, "interior")]);
    // `stat_callout` is taken, so the ladder walks past it to its floor
    // rather than proposing a switch `resolveLayout` would undo.
    const change = plan?.changes[0] as Extract<InterestRelayoutChange, { kind: "attach-device" | "switch-archetype" }> | undefined;
    expect(JSON.stringify(change)).not.toContain("stat_callout");
    expect(change).toMatchObject({ kind: "switch-archetype", slide: 2, from: "text_only", to: "headline_focus" });
  });

  it("...else raises the fontScale one step, and runs out at the largest step", () => {
    // Already at the ladder's floor (`headline_focus`), no usable picture to
    // switch to, and no figure in its own text — so the only thing left is
    // the type size.
    const copy = copyWithLayouts({ 2: "headline_focus" });
    const slides = copy.slides.map((s) => (s.n === 2 ? { ...s, headline: "What changed", body: "The team reworked its process end to end." } : s));
    const plan = planInterestRelayout({ ...copy, slides }, unusableSelections(), facts, [findingFor("dead-space", 2, "interior")]);
    expect(plan?.changes[0]).toMatchObject({ kind: "font-scale", slide: 2, from: "m", to: "l" });

    const atCeiling = planInterestRelayout({ ...copy, slides }, unusableSelections(), facts, [findingFor("dead-space", 2, "interior")], {
      styleOverrides: new Map([[2, { fontScale: "l" as const }]]),
    });
    expect(atCeiling).toBeUndefined();
  });

  it("text-wall drops the type, then moves the body's last sentence to the caption", () => {
    const plan = planInterestRelayout(goodCopyOutput(), goodImageVettingOutput().selections, facts, [findingFor("text-wall", 4, "interior")]);
    expect(plan?.changes[0]).toMatchObject({ kind: "font-scale", slide: 4, from: "m", to: "s" });

    const copy = goodCopyOutput();
    const slides = copy.slides.map((s) => (s.n === 4 ? { ...s, body: "The first point stands alone. The second point can live in the caption." } : s));
    const atFloor = planInterestRelayout({ ...copy, slides }, goodImageVettingOutput().selections, facts, [findingFor("text-wall", 4, "interior")], {
      styleOverrides: new Map([[4, { fontScale: "s" as const }]]),
    });
    expect(atFloor?.changes[0]).toMatchObject({ kind: "move-sentence-to-caption", slide: 4, sentence: "The second point can live in the caption." });
  });
});

describe("planInterestRelayout: the bounds", () => {
  const facts = SIX_RESEARCH_FACTS;

  it("makes AT MOST one change per failing slide, even when the slide failed several clauses", () => {
    const cover = checkInterestFloor(boringSlideMetrics(), passingSlideProbe(1), "cover", { slide: 1 });
    expect(cover.findings.length).toBeGreaterThan(1);
    const plan = planInterestRelayout(goodCopyOutput(), unusableSelections(), facts, cover.findings);
    expect(plan?.changes).toHaveLength(1);
    // The highest-priority failing kind for the slide wins: `no-device`
    // before `dead-space`, because fixing the missing device fixes the hole.
    // With no picture to promote and the fact-card device limb deleted, what
    // `no-device` has left on a cover is the archetype's own ground.
    expect(plan?.changes[0]?.kind).toBe("colour-block-ground");
  });

  it("plans one change per slide across several failing slides, in slide order", () => {
    const findings = [findingFor("no-device", 6, "closer"), findingFor("clipped", 2, "interior"), findingFor("text-wall", 4, "interior")];
    const plan = planInterestRelayout(goodCopyOutput(), goodImageVettingOutput().selections, facts, findings);
    expect(plan?.changes.map((c) => c.slide)).toEqual([2, 4, 6]);
    expect(plan?.changes.map((c) => c.kind)).toEqual(["font-scale", "font-scale", "build-recap"]);
  });

  it("returns NOTHING when the table has no free remedy for anything — the redraft is what that case is for", () => {
    const copy = copyWithLayouts({ 2: "headline_focus" });
    const slides = copy.slides.map((s) => (s.n === 2 ? { ...s, headline: "What changed", body: "The team reworked its process end to end." } : s));
    const plan = planInterestRelayout({ ...copy, slides }, unusableSelections(), SIX_RESEARCH_FACTS, [findingFor("empty", 2, "interior")], {
      styleOverrides: new Map([[2, { fontScale: "l" as const }]]),
    });
    expect(plan).toBeUndefined();
  });

  it("records the slides it could not remedy alongside the ones it could, so 'nothing to try' reads differently from 'tried nothing'", () => {
    const copy = copyWithLayouts({ 2: "headline_focus" });
    const slides = copy.slides.map((s) => (s.n === 2 ? { ...s, headline: "What changed", body: "The team reworked its process end to end." } : s));
    const plan = planInterestRelayout({ ...copy, slides }, unusableSelections(), SIX_RESEARCH_FACTS, [
      findingFor("empty", 2, "interior"),
      findingFor("clipped", 4, "interior"),
    ], { styleOverrides: new Map([[2, { fontScale: "l" as const }]]) });
    expect(plan?.changes.map((c) => c.slide)).toEqual([4]);
    expect(plan?.unremedied).toEqual([
      {
        slide: 2,
        kind: "empty",
        reason:
          "no free remedy: slide 2's empty needs content this attempt does not have (no figure in its own text, no unclaimed content-shaped archetype, and its type is already at the largest scale)",
      },
    ]);
  });

  it("carries one reviewer-readable note per change, so the gate shows that CODE fixed the writer's slide", () => {
    const plan = planInterestRelayout(goodCopyOutput(), unusableSelections(), SIX_RESEARCH_FACTS, [findingFor("no-device", 1, "cover")]);
    expect(plan?.notes).toHaveLength(1);
    expect(plan?.notes[0]).toMatch(/^colour-block-ground \(slide 1\): /);
  });

  it("reports a finding for a slide the copy does not contain as unremedied rather than guessing", () => {
    const copy = goodCopyOutput();
    const plan = planInterestRelayout(copy, goodImageVettingOutput().selections, SIX_RESEARCH_FACTS, [
      findingFor("clipped", 4, "interior"),
      findingFor("empty", 99, "interior"),
    ]);
    expect(plan?.unremedied).toEqual([{ slide: 99, kind: "empty", reason: "slide 99 is not in this attempt's copy" }]);
  });
});
