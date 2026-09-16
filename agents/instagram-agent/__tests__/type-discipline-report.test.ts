import { describe, expect, it } from "vitest";
import {
  ALIGNMENT_COLUMN_CEILING,
  ALIGNMENT_COLUMN_CEILING_ARMED,
  checkInterestFloor,
  TYPE_CONTRAST_FLOOR,
  TYPE_CONTRAST_FLOOR_ARMED,
  TYPE_STEP_CEILING,
  TYPE_STEP_CEILING_ARMED,
} from "../src/workflow/interest-floor.js";
import { passingSlideMetrics, passingSlideProbe } from "./test-helpers.js";

/**
 * THE THREE TYPE CLAUSES THAT SHIP DISARMED, AND THE TEST THAT KEEPS THEM
 * HONEST BOTH WAYS.
 *
 * `docs/instagram-restraint-reference.md` read two professional accounts and
 * came back with three numbers: two or three type steps per plate, a real jump
 * between the largest and the next, everything ranged against one or two
 * columns. Our own eight templates use about twenty-six distinct sizes,
 * because type size is a function of which FILE the writer landed on rather
 * than of the element's role.
 *
 * They are measured and they gate nothing.
 * `instagram-floor-candidates-falsified` is the reason: three separators are
 * already dead in `interest-floor.ts`, each killed by the control that
 * measured it, and every one of them looked this obvious before the sweep ran.
 * A threshold in this file is armed from a DISTRIBUTION, never from an
 * argument.
 *
 * So this file asserts two opposite things, and both matter:
 *
 *   * the report FIRES — a warning that can never appear is worse than no
 *     warning, and it is how a "reporting-only" clause quietly becomes dead
 *     code before anybody reads a distribution;
 *   * it never REFUSES — `ok` stays true on a plate whose only complaint is
 *     type discipline, whatever the numbers say, while the flags are false.
 */

const inBand = { typeSteps: [124, 46, 22], alignmentColumns: 1 };

function verdict(probeOver: Record<string, unknown>) {
  return checkInterestFloor(passingSlideMetrics(), passingSlideProbe(3, probeOver), "interior", { slide: 3 });
}

describe("type discipline: measured, printed, and armed by nobody yet", () => {
  it("says nothing about a plate inside all three bands", () => {
    const warnings = verdict(inBand).warnings.map((w) => w.kind);
    expect(warnings).not.toContain("type-discipline");
  });

  it("reports a plate that uses too many steps, and still passes it", () => {
    // Six distinct sizes on one plate — the shape a set of eight templates
    // with twenty-six sizes between them produces.
    const out = verdict({ typeSteps: [132, 124, 104, 96, 46, 22], alignmentColumns: 1 });
    const warning = out.warnings.find((w) => w.kind === "type-discipline");
    expect(warning).toBeDefined();
    expect(warning?.measured["typeSteps"]).toBe(6);
    expect(warning?.measured["typeStepCeiling"]).toBe(TYPE_STEP_CEILING);
    expect(warning?.sentence).toContain("gates nothing this phase");
    // THE HALF THAT MATTERS: nothing failed.
    expect(out.ok).toBe(true);
    expect(out.findings).toEqual([]);
  });

  it("reports a plate with no jump between its two largest steps", () => {
    // 96 over 84 is 1.14x: two sizes a reader reads as one, which is what a
    // plate looks like when nothing on it is the subject.
    const out = verdict({ typeSteps: [96, 84, 22], alignmentColumns: 1 });
    const warning = out.warnings.find((w) => w.kind === "type-discipline");
    expect(warning?.measured["typeContrast"]).toBeCloseTo(96 / 84, 5);
    expect(warning?.measured["typeContrastFloor"]).toBe(TYPE_CONTRAST_FLOOR);
    expect(out.ok).toBe(true);
  });

  it("reports a plate ranged against too many columns", () => {
    const out = verdict({ ...inBand, alignmentColumns: 4 });
    const warning = out.warnings.find((w) => w.kind === "type-discipline");
    expect(warning?.measured["alignmentColumns"]).toBe(4);
    expect(warning?.measured["alignmentColumnCeiling"]).toBe(ALIGNMENT_COLUMN_CEILING);
    expect(out.ok).toBe(true);
  });

  it("abstains when the probe measured none of it — every other consumer of this module is unaffected", () => {
    expect(verdict({}).warnings.map((w) => w.kind)).not.toContain("type-discipline");
  });

  it("treats a one-step plate as having no contrast to fail", () => {
    // A single rendered size is a fact about the plate, not a defect: there is
    // no second step for the ratio to be measured against.
    const out = verdict({ typeSteps: [124], alignmentColumns: 1 });
    expect(out.warnings.map((w) => w.kind)).not.toContain("type-discipline");
  });

  /**
   * The flags, written down where a reviewer reads them. Arming one is a
   * one-line diff — with the sweep's distribution beside it, which is the
   * whole mechanism.
   */
  it("all three ship disarmed", () => {
    expect(TYPE_STEP_CEILING_ARMED).toBe(false);
    expect(TYPE_CONTRAST_FLOOR_ARMED).toBe(false);
    expect(ALIGNMENT_COLUMN_CEILING_ARMED).toBe(false);
    expect(verdict({ typeSteps: [132, 124, 104, 96, 46, 22], alignmentColumns: 6 }).ok).toBe(true);
  });
});
