import { describe, expect, it } from "vitest";
import { computeGeoScoreModel } from "../src/geo-score-model.js";

describe("computeGeoScoreModel (the PROPOSED geo-score-v3 diagnostic, pending Ines's sign-off — never the canonical GEO number)", () => {
  it("a perfect engine (10/10 appearance, all components 1.0) scores 100", () => {
    const result = computeGeoScoreModel([
      { engine: "chatgpt", appearanceCount: 10, citation: 1, position: 1, shareOfVoice: 1, sentiment: 1 },
    ]);
    expect(result.overall).toBe(100);
    expect(result.perEngine[0]!.score).toBe(100);
  });

  it("weights the 5 components 0.40/0.20/0.15/0.15/0.10 exactly as the config specifies", () => {
    // appearance 5/10=0.5, all else 0 -> engine_score = 100*0.40*0.5 = 20
    const result = computeGeoScoreModel([
      { engine: "claude", appearanceCount: 5, citation: 0, position: 0, shareOfVoice: 0, sentiment: 0 },
    ]);
    expect(result.perEngine[0]!.score).toBe(20);
  });

  it("overall is the unweighted mean across every engine passed in", () => {
    const result = computeGeoScoreModel([
      { engine: "chatgpt", appearanceCount: 10, citation: 1, position: 1, shareOfVoice: 1, sentiment: 1 },
      { engine: "claude", appearanceCount: 0, citation: 0, position: 0, shareOfVoice: 0, sentiment: 0 },
    ]);
    expect(result.overall).toBe(50);
  });

  it("surfaces weights_status so callers can tell this formula is proposed, not confirmed", () => {
    const result = computeGeoScoreModel([]);
    expect(result.weightsStatus.toLowerCase()).toContain("proposed");
    expect(result.overall).toBe(0);
  });
});
