import { clamp } from "./round.js";
import type { InputMeasurementData } from "./types.js";

/** `normalization_fns.boolean`: norm = 1 if measured == true else 0. */
export function normBoolean(measured: boolean): number {
  return measured ? 1 : 0;
}

/** `normalization_fns.count_with_target`: norm = min(actual / target, 1). */
export function normCountWithTarget(actual: number, target: number): number {
  if (target <= 0) return actual > 0 ? 1 : 0;
  return Math.min(actual / target, 1);
}

/** `normalization_fns.ratio_clamp`: norm = clamp(value / target, 0, 1). */
export function normRatioClamp(value: number, target: number): number {
  if (target <= 0) return 0;
  return clamp(value / target, 0, 1);
}

/** `normalization_fns.percentage`: norm = clamp(value_pct / target_pct, 0, 1). */
export function normPercentage(valuePct: number, targetPct: number): number {
  if (targetPct <= 0) return 0;
  return clamp(valuePct / targetPct, 0, 1);
}

/** A `lower_is_better_stepped` band: `[bound, score]`; `bound === null` is the catch-all/floor band. */
export type SteppedBand = readonly [number | null, number];

/**
 * `normalization_fns.lower_is_better_stepped`: evaluate bands ascending,
 * return the score of the first band whose bound is >= value; a `null`
 * bound is the catch-all/floor, matched only once every earlier bound fails.
 */
export function normLowerIsBetterStepped(value: number, bands: readonly SteppedBand[]): number {
  for (const [bound, score] of bands) {
    if (bound === null) return score;
    if (value <= bound) return score;
  }
  // Config always terminates bands with a `null` catch-all; this is unreachable for well-formed config data.
  return 0;
}

/** `normalization_fns.multi_bool`: norm = (# sub-bools passing) / (# sub-bools). */
export function normMultiBool(subBools: readonly boolean[]): number {
  if (subBools.length === 0) return 0;
  const passing = subBools.filter(Boolean).length;
  return passing / subBools.length;
}

/**
 * Whether a config-declared gate was verified. `unverified` is a distinct
 * third state from `pass`/`failed`: the gate field was never measured at
 * all, so nothing is known about it.
 */
export type GateState = "pass" | "failed" | "unverified";

export function gateStateFor(gatePass: boolean | undefined): GateState {
  if (gatePass === true) return "pass";
  if (gatePass === false) return "failed";
  return "unverified";
}

/**
 * `normalization_fns.gate_rule`: if `gate.field` is false, norm is forced to
 * `gate.on_fail_norm` (e.g. GEO-18 anti-stuffing forces 0); otherwise the
 * normally-computed norm passes through unchanged.
 *
 * FAIL-CLOSED ON `unverified`. GEO-18's own `measure` states the rule as a
 * ternary — `norm = anti_stuffing_pass ? min(actual/15,1) : 0` — and
 * `grade_data_only_rule` decides what an unmeasured condition is worth:
 * inputs that do not trace to real measured data are "excluded and shown as
 * pending, never guessed". An absent `gatePass` is an unmeasured condition,
 * so it is forced to `on_fail_norm` exactly like an explicit failure.
 *
 * This previously passed the norm through untouched when `gatePass` was
 * `undefined`, which left the gate structurally incapable of failing for
 * any caller that simply never supplied the field: `false` was the only one
 * of its three input states that could fire it, and the commonest state
 * (absent) silently granted full credit for an anti-stuffing check nobody
 * ran. The caller distinguishes "verified pass" from "never checked" by
 * supplying `gatePass` explicitly; `gateStateFor` reports which happened.
 */
export function applyGate(norm: number, gatePass: boolean | undefined, onFailNorm: number): number {
  return gateStateFor(gatePass) === "pass" ? norm : onFailNorm;
}

/** One `combine.legs[]` entry, generalized over every non-`combine` primitive so `combine` can nest any of them. */
export type CombineLeg =
  | { fn: "boolean"; field: string }
  | { fn: "count_with_target"; field: string; target: number }
  | { fn: "ratio_clamp"; field: string; target: number }
  | { fn: "percentage"; field: string; target: number }
  | { fn: "lower_is_better_stepped"; field: string; bands: readonly SteppedBand[] };

function evaluateLeg(leg: CombineLeg, fields: Record<string, number | boolean>): number {
  const raw = fields[leg.field];
  switch (leg.fn) {
    case "boolean":
      return normBoolean(Boolean(raw));
    case "count_with_target":
      return normCountWithTarget(typeof raw === "number" ? raw : 0, leg.target);
    case "ratio_clamp":
      return normRatioClamp(typeof raw === "number" ? raw : 0, leg.target);
    case "percentage":
      return normPercentage(typeof raw === "number" ? raw : 0, leg.target);
    case "lower_is_better_stepped":
      return normLowerIsBetterStepped(typeof raw === "number" ? raw : Number.POSITIVE_INFINITY, leg.bands);
  }
}

/**
 * `normalization_fns.combine`: norm = clamp(combinator(leg_norms), 0, 1)
 * where each leg is one primitive; combinator is `mean` or `product`.
 */
export function normCombine(legs: readonly CombineLeg[], fields: Record<string, number | boolean>, combinator: "mean" | "product"): number {
  if (legs.length === 0) return 0;
  const legNorms = legs.map((leg) => evaluateLeg(leg, fields));
  const combined =
    combinator === "mean"
      ? legNorms.reduce((sum, n) => sum + n, 0) / legNorms.length
      : legNorms.reduce((product, n) => product * n, 1);
  return clamp(combined, 0, 1);
}

/** Dispatches a raw `InputMeasurementData` to its matching primitive, given the config input's own normalization params. */
export interface NormalizationParams {
  normalization: "boolean" | "count_with_target" | "ratio_clamp" | "percentage" | "lower_is_better_stepped" | "multi_bool" | "combine";
  target?: number | undefined;
  bands?: readonly SteppedBand[] | undefined;
  combine?: ("mean" | "product") | undefined;
  legs?: readonly CombineLeg[] | undefined;
}

export function evaluateNorm(params: NormalizationParams, data: InputMeasurementData): number {
  switch (params.normalization) {
    case "boolean": {
      if (data.kind !== "boolean") throw new Error(`evaluateNorm: expected boolean measurement, got "${data.kind}"`);
      return normBoolean(data.measured);
    }
    case "count_with_target": {
      if (data.kind !== "count") throw new Error(`evaluateNorm: expected count measurement, got "${data.kind}"`);
      return normCountWithTarget(data.actual, params.target ?? 0);
    }
    case "ratio_clamp": {
      if (data.kind !== "ratio") throw new Error(`evaluateNorm: expected ratio measurement, got "${data.kind}"`);
      return normRatioClamp(data.value, params.target ?? 0);
    }
    case "percentage": {
      if (data.kind !== "percentage") throw new Error(`evaluateNorm: expected percentage measurement, got "${data.kind}"`);
      return normPercentage(data.valuePct, params.target ?? 0);
    }
    case "lower_is_better_stepped": {
      if (data.kind !== "stepped") throw new Error(`evaluateNorm: expected stepped measurement, got "${data.kind}"`);
      return normLowerIsBetterStepped(data.value, params.bands ?? []);
    }
    case "multi_bool": {
      if (data.kind !== "multiBool") throw new Error(`evaluateNorm: expected multiBool measurement, got "${data.kind}"`);
      return normMultiBool(data.subBools);
    }
    case "combine": {
      if (data.kind !== "combine") throw new Error(`evaluateNorm: expected combine measurement, got "${data.kind}"`);
      return normCombine(params.legs ?? [], data.fields, params.combine ?? "mean");
    }
  }
}
