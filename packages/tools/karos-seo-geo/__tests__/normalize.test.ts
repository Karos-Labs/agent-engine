import { describe, expect, it } from "vitest";
import {
  normBoolean,
  normCountWithTarget,
  normRatioClamp,
  normPercentage,
  normLowerIsBetterStepped,
  normMultiBool,
  normCombine,
  applyGate,
  gateStateFor,
  evaluateNorm,
} from "../src/normalize.js";

describe("normalization primitives (seo-geo-scoring-config.json normalization_fns, ported verbatim)", () => {
  it("boolean: 1 if true else 0", () => {
    expect(normBoolean(true)).toBe(1);
    expect(normBoolean(false)).toBe(0);
  });

  it("count_with_target: min(actual/target, 1)", () => {
    expect(normCountWithTarget(1.5, 3)).toBeCloseTo(0.5);
    expect(normCountWithTarget(3, 3)).toBe(1);
    expect(normCountWithTarget(10, 3)).toBe(1); // clamped at 1, never exceeds
  });

  it("ratio_clamp: clamp(value/target, 0, 1)", () => {
    expect(normRatioClamp(0.45, 0.9)).toBeCloseTo(0.5);
    expect(normRatioClamp(-1, 0.9)).toBe(0); // clamps below 0
    expect(normRatioClamp(2, 0.9)).toBe(1); // clamps above 1
  });

  it("percentage: clamp(value_pct/target_pct, 0, 1)", () => {
    expect(normPercentage(50, 100)).toBe(0.5);
  });

  it("lower_is_better_stepped: first band whose bound >= value, ascending; null bound is the catch-all floor", () => {
    const bands = [
      [2.5, 1.0],
      [4.0, 0.5],
      [null, 0.0],
    ] as const;
    expect(normLowerIsBetterStepped(1.0, bands)).toBe(1.0); // under first bound
    expect(normLowerIsBetterStepped(2.5, bands)).toBe(1.0); // exactly at first bound
    expect(normLowerIsBetterStepped(3.0, bands)).toBe(0.5); // between bound 1 and 2
    expect(normLowerIsBetterStepped(10, bands)).toBe(0.0); // falls to the null catch-all
  });

  it("multi_bool: fraction of sub-bools passing", () => {
    expect(normMultiBool([true, true, false, false])).toBe(0.5);
    expect(normMultiBool([true, true, true])).toBe(1);
    expect(normMultiBool([])).toBe(0);
  });

  it("combine: mean and product of leg norms, each leg its own primitive", () => {
    const legs = [
      { fn: "boolean" as const, field: "a" },
      { fn: "count_with_target" as const, field: "b", target: 2 },
    ];
    // a=true (norm 1), b=1 of target 2 (norm 0.5) -> mean 0.75, product 0.5
    expect(normCombine(legs, { a: true, b: 1 }, "mean")).toBeCloseTo(0.75);
    expect(normCombine(legs, { a: true, b: 1 }, "product")).toBeCloseTo(0.5);
  });

  it("gate_rule: forces norm to on_fail_norm when gate.field measurement is false, e.g. GEO-18 anti-stuffing", () => {
    expect(applyGate(0.9, false, 0)).toBe(0);
    expect(applyGate(0.9, true, 0)).toBe(0.9);
    // CHANGED (SCRUM-318): this line previously asserted `.toBe(0.9)` — "no gate
    // measurement supplied -> pass through". That assertion locked in a gate that was
    // structurally incapable of failing: of `gatePass`'s three states only `false` could
    // fire it, and the commonest state (never measured) silently granted full credit for
    // an anti-stuffing check nobody ran. GEO-18's `measure` states the rule as a ternary
    // on `anti_stuffing_pass`, and `grade_data_only_rule` says an unmeasured input is
    // "never guessed" — so an unverified gate fails closed, exactly like an explicit
    // failure. `gateStateFor` keeps the two distinguishable in the breakdown.
    expect(applyGate(0.9, undefined, 0)).toBe(0);
  });

  it("gateStateFor distinguishes a verified pass from a failure from a gate nobody checked", () => {
    expect(gateStateFor(true)).toBe("pass");
    expect(gateStateFor(false)).toBe("failed");
    expect(gateStateFor(undefined)).toBe("unverified");
  });

  it("evaluateNorm dispatches to the right primitive by the config's declared normalization", () => {
    expect(evaluateNorm({ normalization: "boolean" }, { kind: "boolean", measured: true })).toBe(1);
    expect(evaluateNorm({ normalization: "ratio_clamp", target: 1.0 }, { kind: "ratio", value: 0.5 })).toBe(0.5);
    expect(() => evaluateNorm({ normalization: "boolean" }, { kind: "count", actual: 1 })).toThrow();
  });
});
