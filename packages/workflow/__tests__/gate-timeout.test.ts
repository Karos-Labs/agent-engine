import { describe, expect, it } from "vitest";

import {
  CLEAN_GATE_TIMEOUT,
  COMPLIANCE_GATE_TIMEOUT,
  FLAGGED_GATE_TIMEOUT,
  textGateTimeout,
} from "../src/primitives/gate-timeout.js";

/**
 * THE THREE TIERS, ASSERTED RATHER THAN DESCRIBED.
 *
 * Ten products registered a human gate with `{ duration: "1h", onTimeout:
 * "auto_approve" }` written out by hand, so a draft the run had already
 * REPAIRED got exactly the same hour as a clean one and a regulated-compliance
 * finding got no special treatment at all.
 *
 * Every case below asserts BOTH halves of the policy — the duration and what
 * happens when it expires — because a longer wait that still auto-approves and
 * a shorter wait that holds are different products, and a test that checked
 * only one of them would pass for either.
 */

describe("textGateTimeout", () => {
  it("gives a clean draft the hour it always had", () => {
    const p = textGateTimeout();
    expect(p.duration).toBe(CLEAN_GATE_TIMEOUT);
    expect(p.onTimeout).toBe("auto_approve");
    expect(p.flags).toEqual([]);
  });

  it("treats an empty repair list as clean, not as flagged", () => {
    // The common case by far: wiring this in must not turn every existing
    // clean run into a six-hour wait.
    const p = textGateTimeout({ repairs: [], flags: [] });
    expect(p.duration).toBe(CLEAN_GATE_TIMEOUT);
    expect(p.onTimeout).toBe("auto_approve");
  });

  it("gives a repaired draft six hours and still ships it", () => {
    const p = textGateTimeout({ repairs: [{ check: "numbersSourced" }] });
    expect(p.duration).toBe(FLAGGED_GATE_TIMEOUT);
    // The owner's ruling: a flag buys a reviewer TIME, not a veto.
    expect(p.onTimeout).toBe("auto_approve");
    expect(p.reason).toContain("numbersSourced");
  });

  it("names every distinct check once, in the order they were applied", () => {
    const p = textGateTimeout({
      repairs: [
        { check: "numbersSourced" },
        { check: "brandCompliance" },
        { check: "numbersSourced" },
      ],
    });
    expect(p.reason).toContain("numbersSourced, brandCompliance");
    expect(p.flags).toHaveLength(1);
  });

  it("carries an agent's own flags through", () => {
    const p = textGateTimeout({ flags: ["shipped on the third dedupe attempt"] });
    expect(p.duration).toBe(FLAGGED_GATE_TIMEOUT);
    expect(p.flags).toContain("shipped on the third dedupe attempt");
  });

  it("HOLDS on a regulated-compliance finding, and only then", () => {
    const p = textGateTimeout({ regulatedComplianceFinding: true });
    expect(p.duration).toBe(COMPLIANCE_GATE_TIMEOUT);
    expect(p.onTimeout).toBe("hold");
  });

  it("lets the compliance finding outrank repairs rather than being averaged with them", () => {
    const p = textGateTimeout({
      regulatedComplianceFinding: true,
      repairs: [{ check: "numbersSourced" }],
      flags: ["something else"],
    });
    expect(p.onTimeout).toBe("hold");
    expect(p.duration).toBe(COMPLIANCE_GATE_TIMEOUT);
  });

  it("always explains itself", () => {
    // `reason` goes on the gate payload. A gate that quietly waits six hours
    // instead of one, with nothing saying why, is the same class of defect as
    // one that quietly approves.
    for (const facts of [
      {},
      { repairs: [{ check: "leakCheck" }] },
      { regulatedComplianceFinding: true },
    ]) {
      expect(textGateTimeout(facts).reason.length).toBeGreaterThan(20);
    }
  });
});
