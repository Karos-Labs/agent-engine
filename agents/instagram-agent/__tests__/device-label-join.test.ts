import { describe, expect, it } from "vitest";
import { deviceFromText } from "../src/workflow/bounded-object.js";

/**
 * Hanky Panky's cover, prep batch 4 (2026-09-25): the relayout attached a
 * figure device to the cover and cut its label out of "headline + deck" joined
 * by a bare space. The headline had no final period, so the two read as one
 * run-on sentence and the label printed "The lace in your drawer has been at
 * the Met since Not as inspiration" under 1879.
 */
describe("a figure device's label from a headline and its deck", () => {
  const src = "The Metropolitan Museum of Art";

  it("the run-on join is what produced the garbled label (the premise)", () => {
    const fused = deviceFromText("The lace in your drawer has been at the Met since 1879 Not as inspiration. As acquisition.", src);
    expect(fused?.label ?? "").toContain("since Not as inspiration");
  });

  it("joined as two sentences, the label is the headline's own clause, cut before 'since'", () => {
    const device = deviceFromText("The lace in your drawer has been at the Met since 1879. Not as inspiration. As acquisition.", src);
    expect(device?.value).toBe("1879");
    expect(device?.label).toBe("The lace in your drawer has been at the Met");
  });
});
