import { describe, expect, it } from "vitest";
import { assessReferenceFidelity } from "../src/index.js";

// 2026-09-23 (stage 2): a generated scene must keep the client's label. The
// riverflow reference smeared the small print on two of nine bottles.
describe("assessReferenceFidelity", () => {
  const label = ["rally", "Electrolyte Recovery Drink", "citrus ginger", "0.33L"];

  it("passes a frame that reads back the label, even when the small print is too small to read", () => {
    const out = assessReferenceFidelity(label, ["RALLY", "Electrolyte Recovery Drink"]);
    expect(out.ok).toBe(true);
    expect(out.missing).toEqual(["citrus", "ginger"]);
  });

  it("fails a re-lettered label: a word appears that is on no reference", () => {
    const out = assessReferenceFidelity(label, ["rally", "Electrolyte Recovary Drink", "citrus ginger"]);
    expect(out.ok).toBe(false);
    expect(out.invented).toEqual(["recovary"]);
    expect(out.reason).toContain("on no reference");
  });

  it("fails a frame that lost most of the label, and a text-free reference that grew words", () => {
    expect(assessReferenceFidelity(label, ["rally"]).ok).toBe(false);
    expect(assessReferenceFidelity([], ["SALE"]).ok).toBe(false);
    expect(assessReferenceFidelity([], []).ok).toBe(true);
  });
});
