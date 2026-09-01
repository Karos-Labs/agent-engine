import { describe, expect, it } from "vitest";
import { mergeStyleOverrides, type StyleOverrides } from "../src/workflow/types.js";

/**
 * IGSTYLE-1 — `mergeStyleOverrides`, the pure merge §2.2's architecture
 * calls as `mergeStyleOverrides(baseline.renderTokens, learned, directive)`
 * with Layer 2 (this run's directive) passed last so it wins.
 */
describe("mergeStyleOverrides (IGSTYLE-1)", () => {
  it("returns {} for no patches", () => {
    expect(mergeStyleOverrides()).toEqual({});
  });

  it("returns {} when every patch is undefined", () => {
    expect(mergeStyleOverrides(undefined, undefined)).toEqual({});
  });

  it("passes a single patch through unchanged", () => {
    const patch: StyleOverrides = { ground: "#111111", fg: "#eeeeee" };
    expect(mergeStyleOverrides(patch)).toEqual(patch);
  });

  it("later patches win on shared keys — last argument is the highest layer", () => {
    const baseline: StyleOverrides = { ground: "#000000", fg: "#ffffff" };
    const learned: StyleOverrides = { ground: "#111111" };
    const directive: StyleOverrides = { ground: "#222222", accent: "#ff7a1a" };
    expect(mergeStyleOverrides(baseline, learned, directive)).toEqual({
      ground: "#222222", // directive (last) wins over learned and baseline
      fg: "#ffffff", // untouched by learned/directive, baseline's value survives
      accent: "#ff7a1a", // only directive set this key
    });
  });

  it("a later patch's undefined key never erases an earlier patch's value", () => {
    const baseline: StyleOverrides = { ground: "#000000" };
    // A real StyleOverrides patch never carries an explicit `undefined`
    // (zod .optional() keys are simply absent), so this exercises the same
    // "key absent, not key-set-to-undefined" path a real partial patch takes.
    const directive: StyleOverrides = {};
    expect(mergeStyleOverrides(baseline, directive)).toEqual({ ground: "#000000" });
  });

  it("skips undefined patches in the middle of the argument list without breaking the merge", () => {
    const baseline: StyleOverrides = { ground: "#000000" };
    const directive: StyleOverrides = { fg: "#ffffff" };
    expect(mergeStyleOverrides(baseline, undefined, directive)).toEqual({ ground: "#000000", fg: "#ffffff" });
  });

  it("merges all seven roles independently", () => {
    const a: StyleOverrides = { ground: "#000000", surface: "#111111", fg: "#eeeeee" };
    const b: StyleOverrides = { fg2: "#dddddd", line: "#333333", accentInk: "#444444", accent: "#ff7a1a" };
    expect(mergeStyleOverrides(a, b)).toEqual({
      ground: "#000000",
      surface: "#111111",
      fg: "#eeeeee",
      fg2: "#dddddd",
      line: "#333333",
      accentInk: "#444444",
      accent: "#ff7a1a",
    });
  });
});
