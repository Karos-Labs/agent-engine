import { describe, expect, it } from "vitest";
import { evaluateDoctrineGate } from "../src/doctrine/doctrine-gate.js";
import { DoctrineGateInputSchema, DoctrineVerdictSetError } from "../src/doctrine/types.js";
import type { DoctrineVerdict } from "../src/doctrine/types.js";

function allPassVerdicts(overrides: Partial<Record<DoctrineVerdict["constraint"], Partial<DoctrineVerdict>>> = {}): DoctrineVerdict[] {
  const base: DoctrineVerdict[] = [
    { constraint: "no_fault_concession", verdict: "pass", quote: "", rationale: "no admission of fault found" },
    { constraint: "no_blame", verdict: "pass", quote: "", rationale: "no blame directed at the reviewer" },
    { constraint: "no_financial_promises", verdict: "pass", quote: "", rationale: "no compensation offered" },
    { constraint: "facts_grounded", verdict: "pass", quote: "", rationale: "no unsourced factual claims" },
  ];
  return base.map((v) => ({ ...v, ...overrides[v.constraint] }));
}

describe("evaluateDoctrineGate (RFC-08 step 09 — independent from the draft turn, any single fail hard-stops the gate)", () => {
  it("passes overall when all 4 model verdicts pass and no mechanical backstop fires", () => {
    const result = evaluateDoctrineGate({
      draftText: "Thanks for the feedback, we'd like to hear more details at hello@example.com.",
      factsBase: [],
      modelVerdicts: allPassVerdicts(),
    });
    expect(result.overallPass).toBe(true);
    expect(result.mechanicalOverrides).toEqual([]);
  });

  it("fails overall when any single model verdict fails, even if the other three pass", () => {
    const result = evaluateDoctrineGate({
      draftText: "We are sorry.",
      factsBase: [],
      modelVerdicts: allPassVerdicts({ no_blame: { verdict: "fail", quote: "you must have misused it", rationale: "blames the reviewer" } }),
    });
    expect(result.overallPass).toBe(false);
  });

  it("mechanically overrides a model 'pass' on no_financial_promises when a bright-line phrase is present", () => {
    const result = evaluateDoctrineGate({
      draftText: "As a token of our apology, your next visit is on us.",
      factsBase: [],
      modelVerdicts: allPassVerdicts(), // the model (incorrectly) said this passes
    });
    expect(result.overallPass).toBe(false);
    expect(result.mechanicalOverrides).toHaveLength(1);
    expect(result.mechanicalOverrides[0]!.constraint).toBe("no_financial_promises");
    const overridden = result.verdicts.find((v) => v.constraint === "no_financial_promises")!;
    expect(overridden.verdict).toBe("fail");
  });

  it("mechanically overrides a model 'pass' on no_fault_concession when a bright-line admission phrase is present", () => {
    const result = evaluateDoctrineGate({
      draftText: "This was our error and we take full responsibility.",
      factsBase: [],
      modelVerdicts: allPassVerdicts(),
    });
    expect(result.overallPass).toBe(false);
    expect(result.mechanicalOverrides.map((o) => o.constraint)).toContain("no_fault_concession");
  });

  it("flags facts_grounded when the draft states a numeric claim absent from the facts base — gate.numbersSourced's own pattern, reused", () => {
    const result = evaluateDoctrineGate({
      draftText: "We resolve 95% of cases within 24 hours.",
      factsBase: ["We aim to respond to every review within one business day."],
      modelVerdicts: allPassVerdicts(),
    });
    expect(result.overallPass).toBe(false);
    const factsVerdict = result.verdicts.find((v) => v.constraint === "facts_grounded")!;
    expect(factsVerdict.verdict).toBe("fail");
    expect(factsVerdict.quote).toBe("95%");
  });

  it("does not flag a numeric claim that appears verbatim in the facts base", () => {
    const result = evaluateDoctrineGate({
      draftText: "We're open 7 days a week, and we close at 8pm on weekdays.",
      factsBase: ["Business hours: open 7 days a week, closing at 8pm on weekdays."],
      modelVerdicts: allPassVerdicts(),
    });
    // "8pm" is not matched by the numeric-claim pattern (no currency/%/x/magnitude-word), so this should pass cleanly.
    expect(result.overallPass).toBe(true);
  });

  it("fails the gate on an unfilled {{template}} token regardless of the 4 model verdicts", () => {
    const result = evaluateDoctrineGate({
      draftText: "Hi {{first_name}}, thanks for the feedback.",
      factsBase: [],
      modelVerdicts: allPassVerdicts(),
    });
    expect(result.unfilledTemplateDetected).toBe(true);
    expect(result.overallPass).toBe(false);
  });

  /**
   * The gate NEVER softens a model verdict — the mechanical layer is a
   * one-way ratchet. It can turn a `pass` into a `fail` (every override test
   * above); nothing in it may turn a `fail` into a `pass`, no matter how
   * clean the bright-line scan comes back.
   */
  it("never softens a model 'fail' into a pass, even when every mechanical check is clean", () => {
    const draftText = "Thanks for taking the time to write. We'd like to hear more at hello@example.com.";
    // Sanity: this text passes every mechanical check on its own.
    expect(evaluateDoctrineGate({ draftText, factsBase: [], modelVerdicts: allPassVerdicts() }).overallPass).toBe(true);

    const result = evaluateDoctrineGate({
      draftText,
      factsBase: [],
      modelVerdicts: allPassVerdicts({
        no_fault_concession: { verdict: "fail", quote: "we let you down", rationale: "reads as accepting fault for an unverified incident" },
      }),
    });
    expect(result.overallPass).toBe(false);
    expect(result.mechanicalOverrides).toEqual([]);
    expect(result.verdicts.find((v) => v.constraint === "no_fault_concession")!.verdict).toBe("fail");
  });
});

/**
 * `evaluateDoctrineGate` runs each mechanical backstop keyed off the verdicts
 * the model ACTUALLY returned. Cardinality alone (`.length(4)`) therefore is
 * not enough: four verdicts naming the same constraint would silently skip
 * the other three bright-line scans, and `overallPass` could come back `true`
 * for a draft promising a refund. That is the arithmetic-backstops-judgment
 * invariant disabling itself.
 */
describe("evaluateDoctrineGate verdict-set validation (the 4 verdicts must cover the 4 constraints exactly once)", () => {
  const REFUND_DRAFT = "As a token of our apology, your next visit is on us.";

  function verdictFor(constraint: DoctrineVerdict["constraint"]): DoctrineVerdict {
    return { constraint, verdict: "pass", quote: "", rationale: "nothing found" };
  }

  it("fails loudly when all 4 verdicts name the same constraint, instead of skipping the other 3 backstops", () => {
    const modelVerdicts = [
      verdictFor("no_fault_concession"),
      verdictFor("no_fault_concession"),
      verdictFor("no_fault_concession"),
      verdictFor("no_fault_concession"),
    ];
    // Proof this is not merely cosmetic: without the guard, the
    // `no_financial_promises` backstop never runs on a draft that plainly
    // trips it, and the gate would answer `overallPass: true`.
    expect(() => evaluateDoctrineGate({ draftText: REFUND_DRAFT, factsBase: [], modelVerdicts })).toThrow(DoctrineVerdictSetError);
    expect(() => evaluateDoctrineGate({ draftText: REFUND_DRAFT, factsBase: [], modelVerdicts })).toThrow(/duplicate verdicts for: no_fault_concession/);
  });

  it("fails loudly when one constraint is missing and another duplicated (still exactly 4 verdicts)", () => {
    const modelVerdicts = [verdictFor("no_fault_concession"), verdictFor("no_blame"), verdictFor("no_blame"), verdictFor("facts_grounded")];
    expect(() => evaluateDoctrineGate({ draftText: REFUND_DRAFT, factsBase: [], modelVerdicts })).toThrow(
      /missing a verdict for: no_financial_promises; duplicate verdicts for: no_blame/,
    );
  });

  it("is rejected at the tool boundary too, as a validation error rather than a quiet overallPass: false", () => {
    const parsed = DoctrineGateInputSchema.safeParse({
      draftText: REFUND_DRAFT,
      factsBase: [],
      modelVerdicts: [verdictFor("no_blame"), verdictFor("no_blame"), verdictFor("no_blame"), verdictFor("no_blame")],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/exactly once/);
  });

  it("accepts the correct shape unchanged — the well-formed case still behaves exactly as before", () => {
    const parsed = DoctrineGateInputSchema.safeParse({
      draftText: "Thanks for the feedback.",
      factsBase: [],
      modelVerdicts: allPassVerdicts(),
    });
    expect(parsed.success).toBe(true);
    expect(evaluateDoctrineGate({ draftText: "Thanks for the feedback.", factsBase: [], modelVerdicts: allPassVerdicts() }).overallPass).toBe(true);
  });
});
