import { describe, expect, it } from "vitest";
import { ILLUSTRATION_STYLES, L9_PHOTOREAL_CUES, isDeclaredIllustration } from "../src/workflow/concept-direction.js";

/**
 * # THE ILLUSTRATION PATH (owner ruling, 2026-09-15)
 *
 * Generating recognisable public figures is approved where it is relevant to
 * the slide. What stays refused is a fabricated PHOTOGRAPH of a real person.
 *
 * **The line is not about who may appear; it is about what the picture
 * CLAIMS.** A photoreal generated image of Sam Altman is a photographic record
 * of something that did not happen, and a reader cannot tell it from a real
 * one. A flat-vector portrait makes the same editorial point and claims
 * nothing — the tradition a newspaper's opinion page has used for a century.
 *
 * Every case below is about the one way this could go wrong: a concept
 * declaring `illustrationStyle` and then asking the generator for a
 * photograph. `scene` is the ONLY field that reaches the diffusion model, so
 * the declaration alone can never be enough.
 */
describe("isDeclaredIllustration", () => {
  it("accepts a style that is declared AND carried into the scene the generator is handed", () => {
    expect(isDeclaredIllustration({ illustrationStyle: "flat vector", scene: "a flat vector portrait of a founder mid-keynote, brand orange behind" })).toBe(true);
  });

  it("REFUSES a declaration the scene does not carry — the field that reaches the model is `scene`", () => {
    // The whole failure mode: an author writes the right thing in the
    // declaration and asks for something else in the brief. `conceptPrompt =
    // concept.scene`, so only the second one is real.
    expect(isDeclaredIllustration({ illustrationStyle: "flat vector", scene: "a founder mid-keynote under stage lights, shallow depth of field" })).toBe(false);
  });

  it("REFUSES a scene that asks for a photograph in the same breath", () => {
    for (const cue of L9_PHOTOREAL_CUES) {
      expect(
        isDeclaredIllustration({ illustrationStyle: "editorial cartoon", scene: `an editorial cartoon of a founder, ${cue} finish` }),
        cue,
      ).toBe(false);
    }
  });

  it("REFUSES a style outside the list, because free text would admit 'cinematic illustration'", () => {
    // Which is a photograph with a filter on it. The list is short on purpose
    // and is not extensible by the model.
    for (const style of ["cinematic illustration", "artistic", "stylised", "illustration"]) {
      expect(isDeclaredIllustration({ illustrationStyle: style, scene: `a ${style} of a founder at a desk` }), style).toBe(false);
    }
  });

  it("REFUSES an absent declaration, which is every concept that has not opted in", () => {
    expect(isDeclaredIllustration({ scene: "a flat vector portrait of a founder" })).toBe(false);
    expect(isDeclaredIllustration({ illustrationStyle: "", scene: "a flat vector portrait of a founder" })).toBe(false);
  });

  it("accepts every style on the list, so the list is the contract rather than one example", () => {
    for (const style of ILLUSTRATION_STYLES) {
      expect(isDeclaredIllustration({ illustrationStyle: style, scene: `a ${style} of a founder on a plain ground` }), style).toBe(true);
    }
  });
});
