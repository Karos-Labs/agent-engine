import { describe, expect, it } from "vitest";
import {
  ALIGNMENT_COLUMN_CEILING,
  ALIGNMENT_COLUMN_CEILING_ARMED,
  FIT_STEP_CEILING_ARMED,
  checkInterestFloor,
  TYPE_CONTRAST_FLOOR,
  TYPE_CONTRAST_FLOOR_ARMED,
  TYPE_STEP_CEILING,
  TYPE_STEP_CEILING_ARMED,
  typeDisciplineLimbs,
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
  it("all four ship disarmed", () => {
    expect(TYPE_STEP_CEILING_ARMED).toBe(false);
    expect(TYPE_CONTRAST_FLOOR_ARMED).toBe(false);
    expect(ALIGNMENT_COLUMN_CEILING_ARMED).toBe(false);
    expect(FIT_STEP_CEILING_ARMED).toBe(false);
    expect(verdict({ typeSteps: [132, 124, 104, 96, 46, 22], alignmentColumns: 6, fitStep: 2 }).ok).toBe(true);
  });

  /**
   * The plate the owner read on 2026-09-19 reached the ladder's floor, and
   * before `render-carousel` 1.9.0 nothing in this system could have said so.
   */
  it("a plate at the ladder's floor is reported, and a plate that fitted is not", () => {
    const atFloor = verdict({ fitStep: 2 });
    expect(atFloor.warnings.some((w) => w.kind === "type-discipline" && /shrunk 2 step/u.test(w.sentence))).toBe(true);
    expect(verdict({ fitStep: 0 }).warnings.some((w) => w.kind === "type-discipline")).toBe(false);
    expect(verdict({ fitStep: 1 }).warnings.some((w) => w.kind === "type-discipline")).toBe(false);
  });

  it("a template with no ladder abstains rather than reporting a perfect fit", () => {
    // Absent is not 0. A Template Studio plate runs no ladder at all, and
    // reading its silence as "fitted" would be a guard that cannot fail.
    expect(verdict({}).warnings.some((w) => w.kind === "type-discipline")).toBe(false);
  });

  /**
   * ── AND THE SWITCH IS REAL, WHICH FOR ONE REVISION IT WAS NOT. ──
   *
   * The three flags shipped read in exactly one place — `armed: A || B || C ?
   * 1 : 0` inside a `warnings.push(...)`, on a clause whose every path led to
   * `warnings` — so flipping one changed a reported integer and gated nothing,
   * while the constants' own comment told the next integrator that flipping
   * one is how the clause is armed.
   *
   * The cases above can assert that nothing gates TODAY. They cannot assert
   * that anything WOULD gate if a flag were thrown, because the flags are
   * module constants. That is why `typeDisciplineLimbs` takes `armed` as an
   * argument: the routing is a pure function, so both halves of the promise
   * are testable with no mocking — and this is the half that was untrue.
   */
  describe("the arming switch routes per limb, and each limb answers for itself", () => {
    const measured = { distinct: 6, contrast: 1.1, columns: 4, measuredSteps: true, comparableSteps: true, fitStep: 2 };
    const none = { steps: false, contrast: false, columns: false, fit: false };

    it("disarmed: every out-of-band limb is out of band and none of them gates", () => {
      const limbs = typeDisciplineLimbs(measured, none);
      expect(limbs.map((l) => l.out)).toEqual([true, true, true, true]);
      expect(limbs.filter((l) => l.out && l.armed)).toEqual([]);
    });

    it("arming ONE limb gates that limb and only that limb", () => {
      const limbs = typeDisciplineLimbs(measured, { ...none, contrast: true });
      expect(limbs.filter((l) => l.out && l.armed).map((l) => l.clause)).toEqual([`largest/second 1.10x (floor ${TYPE_CONTRAST_FLOOR}x)`]);
      expect(limbs.filter((l) => l.out && !l.armed)).toHaveLength(3);
    });

    it("the fit limb arms on its own, and says what a redraft would have to change", () => {
      const limbs = typeDisciplineLimbs(measured, { ...none, fit: true });
      const gating = limbs.filter((l) => l.out && l.armed);
      expect(gating).toHaveLength(1);
      expect(gating[0]?.clause).toContain("shrunk 2 step");
      expect(gating[0]?.clause).toContain("longer than the plate holds");
    });

    it("an armed limb that is IN band still gates nothing — the flag arms a clause, it does not assert one", () => {
      const clean = { distinct: 2, contrast: 2.7, columns: 1, measuredSteps: true, comparableSteps: true, fitStep: 1 };
      expect(typeDisciplineLimbs(clean, { steps: true, contrast: true, columns: true, fit: true }).filter((l) => l.out)).toEqual([]);
    });

    it("a limb the probe did not measure is never out of band, armed or not", () => {
      const unmeasured = { distinct: 0, contrast: 1, columns: undefined, measuredSteps: false, comparableSteps: false };
      expect(typeDisciplineLimbs(unmeasured, { steps: true, contrast: true, columns: true, fit: true }).filter((l) => l.out)).toEqual([]);
    });
  });
});
