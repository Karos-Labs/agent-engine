import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
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
import { goodCopyOutput, goodImageVettingOutput, passingSlideMetrics, passingSlideProbe, SIX_RESEARCH_FACTS } from "./test-helpers.js";

/**
 * RFC-17 §5.6 — the emphasis instruments, as POLICY.
 *
 * Pure: hand-built metrics and probes, no Chromium, no PNG. The pixel
 * definition of a mark is proved on real PNGs by
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
    const empty = { largestEmptyRectShare: LARGEST_EMPTY_RECT_CEILING.closer + 0.1, occupiedShare: 0.09 };
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
};

const PINNED_ROLE_RECORDS: Readonly<Record<string, Readonly<Record<SlideRole, number>>>> = {
  LARGEST_EMPTY_RECT_CEILING: { cover: 0.22, interior: 0.28, closer: 0.22 },
  CONTENT_OCCUPIED_SHARE_FLOOR: { cover: 0.09, interior: 0.06, closer: 0.09 },
  OCCUPIED_SHARE_FLOOR: { cover: 0.42, interior: 0.3, closer: 0.42 },
};

describe("RFC-17 Part 3: not one threshold in interest-floor.ts moved", () => {
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
