import { describe, expect, it } from "vitest";
import { MAX_RUN_COST_USD, TARGET_RUN_SPEND_USD, planPlateBudget } from "../src/workflow/types.js";

/**
 * The plate budget as a unit.
 *
 * Its end-to-end behaviour — a plan whose plates do not fit losing the ones it
 * cannot afford and still delivering — is pinned in `workflow-e2e.test.ts`.
 * What is pinned here is the arithmetic, at the boundaries an integration test
 * cannot reach cheaply: a run's real spend is a few tenths of a cent, so the
 * only way to exercise the wall there is a contrived dispatcher budget.
 */
const PLATE = 0.067;

describe("planPlateBudget", () => {
  const base = { platePriceUsd: PLATE, targetUsd: TARGET_RUN_SPEND_USD, maxUsd: MAX_RUN_COST_USD };

  it("buys every plate on an ordinary plan, and says so with `undefined` rather than a number", () => {
    // `undefined` means "buy them all" and is deliberately distinct from `0`,
    // which means "buy none". A caller that conflated them would silently drop
    // every plate on every clean run.
    const budget = planPlateBudget({ ...base, plateCount: 3, spentSoFarUsd: 0.2 });
    expect(budget.maxPlates).toBeUndefined();
    expect(budget.note).toBeUndefined();
    expect(budget.estimatedTotalUsd).toBeCloseTo(0.2 + 3 * PLATE, 6);
  });

  it("stays out of the way of a plan that is over the target but under the wall", () => {
    // The gap between $1.80 and $2.00 exists so an ambitious short can spend
    // it rather than be trimmed into an ordinary one.
    const budget = planPlateBudget({ ...base, plateCount: 2, spentSoFarUsd: 1.75 });
    expect(budget.estimatedTotalUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);
    expect(budget.estimatedTotalUsd).toBeLessThanOrEqual(MAX_RUN_COST_USD);
    expect(budget.maxPlates).toBeUndefined();
  });

  it("keeps the plates it can afford and drops the rest, never the whole run", () => {
    const budget = planPlateBudget({ ...base, plateCount: 5, spentSoFarUsd: 1.8 });
    // $0.20 of headroom buys two plates at $0.067.
    expect(budget.maxPlates).toBe(2);
    expect(budget.estimatedTotalUsd).toBeLessThanOrEqual(MAX_RUN_COST_USD);
    expect(budget.note).toContain("3 were dropped");
    expect(budget.note).toContain("burst");
  });

  it("buys none, rather than going a fraction over, when even one will not fit", () => {
    const budget = planPlateBudget({ ...base, plateCount: 2, spentSoFarUsd: 1.99 });
    expect(budget.maxPlates).toBe(0);
    expect(budget.estimatedTotalUsd).toBeLessThanOrEqual(MAX_RUN_COST_USD);
  });

  it("never returns a negative allowance for a run already past its ceiling", () => {
    // `Math.floor` of a negative quotient is not 0, and a negative `maxPlates`
    // would make the `filter` below it keep nothing while reading like a bug.
    const budget = planPlateBudget({ ...base, plateCount: 3, spentSoFarUsd: 2.5 });
    expect(budget.maxPlates).toBe(0);
  });

  it("has nothing to say about a plan with no plates at all", () => {
    // A plan of pure bursts is free: the stills are the client's own and
    // already on disk. It must never be trimmed, whatever the run has spent.
    const budget = planPlateBudget({ ...base, plateCount: 0, spentSoFarUsd: 5 });
    expect(budget.maxPlates).toBeUndefined();
    expect(budget.note).toBeUndefined();
  });
});
