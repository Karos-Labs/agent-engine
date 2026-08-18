import { describe, expect, it } from "vitest";
import { evaluateRecommendations, groupInputsByRecId, type RecInputInstance } from "../src/recommend.js";

describe("evaluateRecommendations (seo-geo-routing-config.json trigger.fires_when / priority_formula)", () => {
  it("a rec with norm >= 1.0 across all its instances passes and never fires", () => {
    const fired = evaluateRecommendations({ "SEO-02": [{ norm: 1.0, weight: 5, normalization: "ratio_clamp" }] });
    expect(fired.find((f) => f.recId === "SEO-02")).toBeUndefined();
  });

  it("a continuous-typed rec with 0.75 <= worst norm < 1.0 fires as 'approaching', not 'fail'", () => {
    const fired = evaluateRecommendations({ "SEO-02": [{ norm: 0.8, weight: 5, normalization: "ratio_clamp" }] });
    const rec = fired.find((f) => f.recId === "SEO-02")!;
    expect(rec.fireState).toBe("approaching");
  });

  it("a continuous-typed rec with worst norm < 0.75 fires as 'fail'", () => {
    const fired = evaluateRecommendations({ "SEO-02": [{ norm: 0.2, weight: 5, normalization: "ratio_clamp" }] });
    const rec = fired.find((f) => f.recId === "SEO-02")!;
    expect(rec.fireState).toBe("fail");
  });

  describe("boolean/multi_bool override (trigger.fires_when's explicit exception: norm==1 pass else fail, no 'approaching' tier)", () => {
    it("a boolean-typed rec at norm 0.8 fires as 'fail', not 'approaching' — the continuous bands do not apply to it", () => {
      const fired = evaluateRecommendations({ "SEO-02": [{ norm: 0.8, weight: 5, normalization: "boolean" }] });
      const rec = fired.find((f) => f.recId === "SEO-02")!;
      expect(rec.fireState).toBe("fail");
    });

    it("a multi_bool-typed rec at norm 0.75 (e.g. 3-of-4 legs passing) fires as 'fail', not 'approaching'", () => {
      const fired = evaluateRecommendations({ "SEO-02": [{ norm: 0.75, weight: 5, normalization: "multi_bool" }] });
      const rec = fired.find((f) => f.recId === "SEO-02")!;
      expect(rec.fireState).toBe("fail");
    });

    it("a boolean-typed rec at exactly norm 1 still passes", () => {
      const fired = evaluateRecommendations({ "SEO-02": [{ norm: 1, weight: 5, normalization: "boolean" }] });
      expect(fired.find((f) => f.recId === "SEO-02")).toBeUndefined();
    });

    it("classifies the worst instance by ITS OWN normalization type when a rec mixes boolean and continuous instances", () => {
      // Continuous instance at 0.8 would be "approaching" alone, but the boolean instance (norm 0) is worse and forces "fail".
      const fired = evaluateRecommendations({
        "BOTH-01": [
          { norm: 0.8, weight: 10, normalization: "ratio_clamp" },
          { norm: 0, weight: 5, normalization: "boolean" },
        ],
      });
      const rec = fired.find((f) => f.recId === "BOTH-01")!;
      expect(rec.worstNorm).toBe(0);
      expect(rec.fireState).toBe("fail");
    });
  });

  it("rolls a rec_id up to the WORST norm across its multiple weighted instances (e.g. BOTH-01 appears twice in eligibility)", () => {
    const fired = evaluateRecommendations({
      "BOTH-01": [
        { norm: 0.9, weight: 10, normalization: "ratio_clamp" },
        { norm: 0.3, weight: 7, normalization: "ratio_clamp" },
      ],
    });
    const rec = fired.find((f) => f.recId === "BOTH-01")!;
    expect(rec.worstNorm).toBe(0.3);
    expect(rec.fireState).toBe("fail"); // driven by the worse of the two instances
  });

  it("score_lift = (1 - worst_norm) * the worst instance's own weight", () => {
    const fired = evaluateRecommendations({ "SEO-02": [{ norm: 0.5, weight: 8, normalization: "ratio_clamp" }] });
    const rec = fired.find((f) => f.recId === "SEO-02")!;
    expect(rec.scoreLift).toBeCloseTo(4); // (1-0.5)*8
  });

  it("failing a critical-eligibility rec (BOTH-01, BOTH-02, GEO-01, GEO-08, GEO-10) jumps the queue via the hard override", () => {
    const fired = evaluateRecommendations({
      "BOTH-01": [{ norm: 0.1, weight: 10, normalization: "ratio_clamp" }], // critical-eligibility, fails -> hard override
      "SEO-02": [{ norm: 0.1, weight: 5, normalization: "ratio_clamp" }], // high-impact quick-effort, normally near the top of the ranking
    });
    expect(fired[0]!.recId).toBe("BOTH-01");
    expect(fired[0]!.hardOverride).toBe(true);
  });

  it("a rec with no scored instances in this run is silently absent from the fired list, never fabricated", () => {
    const fired = evaluateRecommendations({});
    expect(fired.length).toBe(0);
  });

  it("higher-impact recs generally outrank lower-impact ones at the same fire severity", () => {
    // SEO-01 is impact=critical/effort=heavy; find a medium-impact rec to compare against.
    const fired = evaluateRecommendations({
      "SEO-01": [{ norm: 0.5, weight: 10, normalization: "ratio_clamp" }],
      "SEO-05": [{ norm: 0.5, weight: 5, normalization: "ratio_clamp" }],
    });
    const seo01Index = fired.findIndex((f) => f.recId === "SEO-01");
    const seo05Index = fired.findIndex((f) => f.recId === "SEO-05");
    expect(seo01Index).toBeLessThan(seo05Index);
  });
});

describe("groupInputsByRecId", () => {
  it("groups a flat evaluated-input list by recId, preserving every instance", () => {
    const grouped = groupInputsByRecId([
      { recId: "BOTH-01", norm: 0.9, weight: 10, normalization: "ratio_clamp" },
      { recId: "BOTH-01", norm: 0.3, weight: 7, normalization: "ratio_clamp" },
      { recId: "SEO-02", norm: 1.0, weight: 5, normalization: "ratio_clamp" },
    ]);
    expect(grouped["BOTH-01"]).toHaveLength(2);
    expect(grouped["SEO-02"]).toHaveLength(1);
    const both01: RecInputInstance[] = grouped["BOTH-01"]!;
    expect(both01.map((i) => i.norm).sort()).toEqual([0.3, 0.9]);
  });
});
