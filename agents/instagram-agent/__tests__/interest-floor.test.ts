import { describe, expect, it } from "vitest";
import {
  ACCENT_MAX_SHARE,
  ACCENT_MIN_SHARE,
  CLIPPED_EDGE_SHARE_CEILING,
  CONTENT_OCCUPIED_SHARE_FLOOR,
  FLAT_BACKGROUND_CEILING,
  FULL_BLEED_IMAGERY_SHARE,
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

  it("B — clipped: ink inside the bleed band fails on its own", () => {
    const verdict = check(metrics({ clippedEdgeShare: CLIPPED_EDGE_SHARE_CEILING + EPS }), "interior", 4);
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
  // attempt. The exemption is deliberately narrow in two ways, and both are
  // asserted here: it applies only to the PIXEL limb, and only above
  // `FULL_BLEED_IMAGERY_SHARE` — so a scrimmed photo panel (the default
  // fixture's 0.34) is still held to the ceiling.
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

  it("C — dead space: one contiguous hole over the role's ceiling, with the rectangle's own corners in the sentence", () => {
    const verdict = check(
      metrics({ largestEmptyRect: { x: 0, y: 0, w: 1080, h: 590 }, largestEmptyRectShare: 0.41 }),
      "cover",
      1,
    );
    expect(kinds(verdict)).toEqual(["dead-space"]);
    expect(verdict.findings[0]?.sentence).toBe(
      "slide 1 — an empty rectangle covered 41% of the plate (0,0 to 1080,590); the ceiling is 22% for a cover.",
    );
    expect(verdict.findings[0]?.threshold).toBe(LARGEST_EMPTY_RECT_CEILING.cover);
  });

  it("C — boundary: the interior ceiling is looser than the cover's, and each is exact to 0.001", () => {
    expect(check(metrics({ largestEmptyRectShare: LARGEST_EMPTY_RECT_CEILING.interior - EPS }), "interior").ok).toBe(true);
    expect(kinds(check(metrics({ largestEmptyRectShare: LARGEST_EMPTY_RECT_CEILING.interior + EPS }), "interior"))).toEqual(["dead-space"]);
    expect(check(metrics({ largestEmptyRectShare: LARGEST_EMPTY_RECT_CEILING.cover - EPS }), "cover").ok).toBe(true);
    expect(kinds(check(metrics({ largestEmptyRectShare: LARGEST_EMPTY_RECT_CEILING.cover + EPS }), "cover"))).toEqual(["dead-space"]);
    // 0.25 sits between the two: legitimate mid-carousel, a defect on a cover.
    expect(check(metrics({ largestEmptyRectShare: 0.25 }), "interior").ok).toBe(true);
    expect(kinds(check(metrics({ largestEmptyRectShare: 0.25 }), "cover"))).toEqual(["dead-space"]);
  });

  it("D — substance: flat AND idle fails; flat alone does NOT, and idle alone does not either", () => {
    const flatAndIdle = metrics({ flatBackgroundShare: 0.93, occupiedShare: 0.18, imageryOrDeviceShare: 0.2 });
    expect(kinds(check(flatAndIdle, "interior", 5))).toEqual(["empty"]);

    // Flat alone: a bold type poster. This is the case a single
    // flat-background ceiling would kill, and it must pass.
    expect(check(metrics({ flatBackgroundShare: 0.93, occupiedShare: 0.52 }), "interior").ok).toBe(true);
    // Idle alone: a photograph with a lot of quiet sky. Nothing is flat
    // against the brand ground, so there is no emptiness to fail.
    expect(check(metrics({ flatBackgroundShare: 0.2, occupiedShare: 0.18 }), "interior").ok).toBe(true);
  });

  it("D — the sentence is the one the spec wrote, numbers included", () => {
    const verdict = check(metrics({ flatBackgroundShare: 0.93, occupiedShare: 0.18, imageryOrDeviceShare: 0.2 }), "interior", 5);
    expect(verdict.findings[0]?.sentence).toBe(
      "slide 5 — 93% of the pixels were the background colour and only 18% of the frame was occupied (floor 30% for an interior slide).",
    );
    expect(verdict.findings[0]?.steer).toBe(
      "Either give slide 5 a device (figure, bars, before/after, timeline, versus) or merge it into slide 4 and let the carousel be one slide shorter.",
    );
  });

  it("D — boundary: both halves are exact to 0.001, on both the flat ceiling and each role's occupancy floor", () => {
    const idle = (flat: number, occupied: number) => metrics({ flatBackgroundShare: flat, occupiedShare: occupied, imageryOrDeviceShare: 0.2 });
    expect(check(idle(FLAT_BACKGROUND_CEILING + EPS, OCCUPIED_SHARE_FLOOR.interior - EPS), "interior").ok).toBe(false);
    expect(check(idle(FLAT_BACKGROUND_CEILING - EPS, OCCUPIED_SHARE_FLOOR.interior - EPS), "interior").ok).toBe(true);
    expect(check(idle(FLAT_BACKGROUND_CEILING + EPS, OCCUPIED_SHARE_FLOOR.interior + EPS), "interior").ok).toBe(true);
    // The cover's floor is higher, so the SAME slide fails there and passes mid-carousel.
    const between = idle(0.8, 0.35);
    expect(check(between, "interior").ok).toBe(true);
    expect(kinds(check(between, "cover", 1))).toEqual(["empty"]);
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
    expect(check(metrics({ imageryOrDeviceShare: IMAGERY_OR_DEVICE_FLOOR + EPS }), "cover", 1).ok).toBe(true);
    const verdict = check(metrics({ imageryOrDeviceShare: IMAGERY_OR_DEVICE_FLOOR - EPS }), "closer", 6);
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

  it("still fails the audit slide, which is flat AND idle AND holed", () => {
    const verdict = check(boringSlideMetrics(), "cover", 1);
    expect(kinds(verdict).sort()).toEqual(["dead-space", "empty", "no-device"]);
    // All three findings name slide 1 and carry their own measured numbers.
    expect(verdict.findings.every((f) => f.slide === 1)).toBe(true);
    expect(verdict.findings.every((f) => Object.keys(f.measured).length > 0)).toBe(true);
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

  it("boundary: exact to 0.001 at each role's own content floor", () => {
    for (const role of ["interior", "cover", "closer"] as const) {
      const floor = CONTENT_OCCUPIED_SHARE_FLOOR[role];
      expect(kinds(check(metrics({ contentOccupiedShare: floor }), role)), role).toEqual([]);
      expect(kinds(check(metrics({ contentOccupiedShare: floor - EPS }), role)), role).toEqual(["empty"]);
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

  it("does not double-report: the audit slide's bare-ground emptiness is clause D's, not clause G's", () => {
    // `boringSlideMetrics` carries no ground treatment, so every mark on it
    // is content and clause G has nothing to say. One defect, one finding.
    const verdict = check(boringSlideMetrics(), "interior", 3);
    expect(kinds(verdict).filter((k) => k === "empty")).toHaveLength(1);
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
    const holed = metrics({ largestEmptyRectShare: 0.5 });
    expect(kinds(check(holed, "cover", 1, { downgradedForImages: new Set([1]) }))).toEqual(["dead-space"]);
  });
});

describe("the steer the writer receives", () => {
  /** One finding of every kind, each on its own slide, at a role where that kind can fire. */
  function oneOfEveryKind(): InterestFinding[] {
    return [
      ...check(metrics({ inkShare: 0.004 }), "interior", 2).findings,
      ...checkInterestFloor(metrics(), passingSlideProbe(3, { overflow: true, overflowing: [".headline"] }), "interior", { slide: 3 }).findings,
      ...check(metrics({ largestEmptyRectShare: 0.42 }), "cover", 1).findings,
      ...check(metrics({ flatBackgroundShare: 0.93, occupiedShare: 0.18, imageryOrDeviceShare: 0.2 }), "interior", 5).findings,
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
    const line = summarizeInterestFindings(check(boringSlideMetrics(), "cover", 1).findings);
    expect(line).toMatch(/interest:dead-space \(slide 1\)/);
    expect(line).toMatch(/interest:empty \(slide 1\)/);
    // One segment per finding — and the separator is ` | ` precisely because
    // these sentences carry their own semicolons.
    expect(line.split(INTEREST_FINDING_SEPARATOR)).toHaveLength(3);
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
    expect(report.findings.map((f) => f.slide)).toEqual([1, 1, 1, 5]);
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
    clipped: { clippedEdgeShare: 0.02 },
    "dead-space": { largestEmptyRectShare: 0.45 },
    empty: { flatBackgroundShare: 0.93, occupiedShare: 0.18, imageryOrDeviceShare: 0.2 },
    "no-device": { imageryShare: 0, graphicShare: 0, imageryOrDeviceShare: 0 },
    "text-wall": { textShare: 0.7 },
  };
  const verdict = checkInterestFloor(metrics(byKind[kind]), passingSlideProbe(slide), role, { slide });
  const finding = verdict.findings.find((f) => f.kind === kind);
  if (finding === undefined) throw new Error(`fixture did not produce a "${kind}" finding at role ${role}`);
  return finding;
}

function copyWithLayouts(layouts: Partial<Record<number, InstagramCopyOutput["slides"][number]["layout"]>>): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return { ...copy, slides: copy.slides.map((s) => ({ ...s, layout: layouts[s.n] ?? s.layout })) };
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
    expect(device).toEqual({ kind: "figure", value: "30%", label: "Support resolved more tickets after the new triage flow.", source: "support dashboard export" });
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
      label: "In 2024 we saved hours a week.",
      source: "internal survey",
    });
  });

  it("labels a figure from its OWN sentence, not from the whole body", () => {
    const device = deviceFromText("The rollout took a quarter. Onboarding then dropped to 7 days.", "cohort analysis");
    expect(device?.value).toBe("7");
    expect(device?.label).toBe("Onboarding then dropped to days.");
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

  it("...else builds a figure device from the strongest sourced statistic in the post", () => {
    const plan = planInterestRelayout(goodCopyOutput(), unusableSelections(), facts, [findingFor("no-device", 1, "cover")]);
    const change = plan?.changes[0] as Extract<InterestRelayoutChange, { kind: "attach-device" }> | undefined;
    expect(change?.kind).toBe("attach-device");
    expect(change?.device.value).toBe("4");
    expect(change?.device.source).toBe("internal client survey");
    expect(change?.device.label.length).toBeGreaterThan(0);
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

  it("dead-space and empty both set a figure already in the slide's own text as a device", () => {
    // On an archetype that PAINTS one. `headline_focus` declares
    // `{{html:device}}`, so the fragment reaches the pixels and the re-render
    // can actually differ.
    const copy = copyWithLayouts({ 2: "headline_focus" });
    for (const kind of ["dead-space", "empty"] as const) {
      const plan = planInterestRelayout(copy, goodImageVettingOutput().selections, facts, [findingFor(kind, 2, "interior")]);
      const change = plan?.changes[0] as Extract<InterestRelayoutChange, { kind: "attach-device" }> | undefined;
      expect(change?.kind, kind).toBe("attach-device");
      // Slide 2's own body says 30%, and its fact card names the source.
      expect(change?.device.value, kind).toBe("30%");
      expect(change?.device.source, kind).toBe("support dashboard export");
      // Already on a device-slot archetype, so no switch rides along.
      expect(change?.archetype, kind).toBeUndefined();
    }
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

  it("makes AT MOST one change per failing slide, even when the slide failed three clauses", () => {
    const cover = checkInterestFloor(boringSlideMetrics(), passingSlideProbe(1), "cover", { slide: 1 });
    expect(cover.findings).toHaveLength(3);
    const plan = planInterestRelayout(goodCopyOutput(), unusableSelections(), facts, cover.findings);
    expect(plan?.changes).toHaveLength(1);
    // The highest-priority failing kind for the slide wins: `no-device`
    // before `dead-space`, because fixing the missing device fixes the hole.
    expect(plan?.changes[0]?.kind).toBe("attach-device");
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
    expect(plan?.notes[0]).toMatch(/^attach-device \(slide 1\): /);
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
