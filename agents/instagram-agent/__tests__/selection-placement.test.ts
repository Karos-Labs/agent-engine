import { describe, expect, it } from "vitest";
import {
  MIN_CLAIM_MATCH,
  MIN_SUBJECT_MATCH,
  selectionPasses,
  selectionPlacement,
  type ImageSelection,
} from "../src/workflow/types.js";

/**
 * The selection floor was a pass/fail, so a miss meant the slide got nothing.
 *
 * Geektime's prep slide 6 of 2026-09-18 asked for a conference stage and was
 * offered one — `subjectMatch 3, claimMatch 2` — refused as *"an anonymous
 * crowd rather than a picture of the specific entity"*. That slide shipped
 * with no picture and the carousel shipped with none at all.
 *
 * Both owner rulings are in force and they are about different PLACEMENTS.
 * 2026-09-16, on a generic photograph filling a plate: that is not a picture.
 * 2026-09-18: *"not every image has to be a background... it really adds when
 * there is an image inside."*
 */

const sel = (over: Partial<ImageSelection>): Pick<ImageSelection, "rightsUsable" | "watermarkFree" | "claimMatch" | "subjectMatch"> => ({
  rightsUsable: true,
  watermarkFree: true,
  claimMatch: 4,
  subjectMatch: 4,
  ...over,
});

describe("selectionPlacement", () => {
  it("does not move the ground floor at all — anything that passed still passes, as full-bleed", () => {
    for (const candidate of [
      sel({ subjectMatch: MIN_SUBJECT_MATCH }),
      sel({ subjectMatch: 5, claimMatch: 3 }),
      sel({ subjectMatch: MIN_CLAIM_MATCH, claimMatch: 4 }),
    ]) {
      expect(selectionPasses(candidate).passes).toBe(true);
      expect(selectionPlacement(candidate).placement).toBe("full-bleed");
    }
  });

  it("places Geektime's refused conference stage INSIDE a plate instead of nowhere", () => {
    const shipped = sel({ subjectMatch: 3, claimMatch: 2 });
    // Under the ground floor, as it was and should be…
    expect(selectionPasses(shipped).passes).toBe(false);
    // …but `claimMatch 2` is under the contradiction floor, so this exact
    // candidate is still refused. The one a step up is the one that lands.
    expect(selectionPlacement(shipped).placement).toBe("refuse");

    const compatible = sel({ subjectMatch: 3, claimMatch: MIN_CLAIM_MATCH });
    expect(selectionPasses(compatible).passes).toBe(false);
    expect(selectionPlacement(compatible).placement).toBe("bounded");
    expect(selectionPlacement(compatible).reason).toContain("INSIDE the plate");
  });

  it("refuses a CONTRADICTION at every placement, because a band is as published as a ground", () => {
    for (const subject of [1, 2, 3, 4, 5]) {
      const contradicting = sel({ subjectMatch: subject, claimMatch: MIN_CLAIM_MATCH - 1 });
      // A high subjectMatch does not rescue it: a picture of the right thing
      // saying the wrong thing is the fabricated-figure incident's shape.
      if (!selectionPasses(contradicting).passes) {
        expect(selectionPlacement(contradicting).placement, `subjectMatch ${subject}`).toBe("refuse");
      }
    }
  });

  it("refuses on rights and watermark at every placement", () => {
    expect(selectionPlacement(sel({ rightsUsable: false })).placement).toBe("refuse");
    expect(selectionPlacement(sel({ watermarkFree: false })).placement).toBe("refuse");
    // Even when the picture is otherwise perfect.
    expect(selectionPlacement(sel({ rightsUsable: false, subjectMatch: 5, claimMatch: 5 })).placement).toBe("refuse");
  });

  it("carries the ground floor's own sentence into the bounded verdict, so a reviewer reads why it is not the plate", () => {
    const verdict = selectionPlacement(sel({ subjectMatch: 3, claimMatch: 3 }));
    expect(verdict.reason).toContain("under the");
    expect(verdict.reason).toContain("claimMatch 3/5");
  });

  it("is total: every combination gets one of the three answers", () => {
    for (const rights of [true, false]) {
      for (const mark of [true, false]) {
        for (let claim = 1; claim <= 5; claim++) {
          for (const subject of [undefined, 1, 2, 3, 4, 5]) {
            const verdict = selectionPlacement(sel({ rightsUsable: rights, watermarkFree: mark, claimMatch: claim, subjectMatch: subject }));
            expect(["full-bleed", "bounded", "refuse"], `${rights}/${mark}/${claim}/${subject}`).toContain(verdict.placement);
            expect(verdict.reason.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("never returns `bounded` for something the ground floor already accepted — the rungs do not overlap", () => {
    for (let claim = 1; claim <= 5; claim++) {
      for (const subject of [undefined, 1, 2, 3, 4, 5]) {
        const candidate = sel({ claimMatch: claim, subjectMatch: subject });
        const placement = selectionPlacement(candidate).placement;
        expect(placement === "full-bleed", `${claim}/${subject}`).toBe(selectionPasses(candidate).passes);
      }
    }
  });
});
