import { describe, expect, it } from "vitest";
import { nullSelectionContradictsItsScores, selectionPlacement } from "../src/workflow/types.js";

/**
 * ── THE REFUSAL THAT SHIPPED TWO CAROUSELS WITH NO PICTURES. ──
 *
 * `pubsub-21902648165262839`, 2026-09-20, slides 1 and 6. The subject was
 * ChatGPT, the pool held pictures of ChatGPT, and the vet returned
 * `imagePath: null` on both with `subjectMatch 3, claimMatch 3` — the one cell
 * of the matrix that fails, reached by marking the slide's unprovable
 * PROPOSITION ("sponsored ads beneath organic responses") against the picture
 * on both axes.
 *
 * The owner: *"demanding forensic evidence for a future claim instead of
 * accepting a high subjectMatch is unacceptable... a picture relevant to the
 * subject is far better than leaving a slide completely empty."*
 *
 * These numbers are not invented for the test. They are the ones in the run
 * record.
 */

const usable = { rightsUsable: true, watermarkFree: true } as const;

describe("a null the vet's own scores do not support", () => {
  it("catches the exact refusal that shipped: null at subjectMatch 3, claimMatch 3", () => {
    const shipped = { imagePath: null, subjectMatch: 3, claimMatch: 3, ...usable };
    // The premise first: those scores are the placement ladder's MIDDLE rung,
    // a picture set inside the plate. Asserting the verdict without asserting
    // the premise would leave this test green if the ladder ever changed.
    expect(selectionPlacement(shipped).placement).toBe("bounded");
    expect(nullSelectionContradictsItsScores(shipped)).toBe(true);
  });

  it("catches a null over a picture that would have been the whole plate", () => {
    // The worse version of the same mistake: a selection that clears the
    // ground floor outright, refused anyway.
    const strong = { imagePath: null, subjectMatch: 5, claimMatch: 2, ...usable };
    expect(selectionPlacement(strong).placement).toBe("full-bleed");
    expect(nullSelectionContradictsItsScores(strong)).toBe(true);
  });

  it("stays silent on a null the scores DO support — an empty pool is not a bug", () => {
    // `claimMatch` under the floor is a contradiction: a picture that says
    // something the slide does not. Refusing that is correct at every
    // placement, and this guard must never call it a mistake.
    const contradiction = { imagePath: null, subjectMatch: 1, claimMatch: 1, ...usable };
    expect(selectionPlacement(contradiction).placement).toBe("refuse");
    expect(nullSelectionContradictsItsScores(contradiction)).toBe(false);
  });

  it("stays silent on a selection that actually carries a picture", () => {
    expect(nullSelectionContradictsItsScores({ imagePath: "a.jpg", subjectMatch: 3, claimMatch: 3, ...usable })).toBe(false);
  });

  it("abstains when the vet reported no subjectMatch at all", () => {
    // Pre-5.5 vets did not report one. A missing number is not evidence of a
    // contradiction, and reading it as one would make every old record a bug.
    expect(nullSelectionContradictsItsScores({ imagePath: null, claimMatch: 3, ...usable })).toBe(false);
  });

  it("stays silent on an unusable candidate, whatever it scored", () => {
    // Rights and watermarks refuse at every placement and are nothing to do
    // with the vet's judgement of the picture.
    for (const bad of [
      { imagePath: null, subjectMatch: 5, claimMatch: 5, rightsUsable: false, watermarkFree: true },
      { imagePath: null, subjectMatch: 5, claimMatch: 5, rightsUsable: true, watermarkFree: false },
    ]) {
      expect(nullSelectionContradictsItsScores(bad)).toBe(false);
    }
  });
});
