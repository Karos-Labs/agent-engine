import {
  findBlamePhrase,
  findFaultConcessionPhrase,
  findFinancialPromisePhrase,
  findUnsourcedNumericClaim,
  hasUnfilledTemplateToken,
} from "./mechanical-checks.js";
import { DoctrineVerdictSetError, describeVerdictSetViolation } from "./types.js";
import type { DoctrineConstraint, DoctrineGateInput, DoctrineGateResult, DoctrineVerdict, MechanicalOverride } from "./types.js";

const MECHANICAL_CHECKS: Record<DoctrineConstraint, (draftText: string, factsBase: readonly string[]) => string | null> = {
  no_fault_concession: (text) => findFaultConcessionPhrase(text),
  no_blame: (text) => findBlamePhrase(text),
  no_financial_promises: (text) => findFinancialPromisePhrase(text),
  facts_grounded: (text, factsBase) => findUnsourcedNumericClaim(text, factsBase),
};

/**
 * `reputation.doctrineGate` (RFC-08 §5 step 09) — the mechanical half of the
 * doctrine gate. The QUALITATIVE quoted verdicts come from a separate model
 * pass upstream (never the turn that wrote the draft — "the model that
 * wrote a sentence is the worst judge of whether it conceded fault"); this
 * function's own job, matching every `gate.*` tool in this codebase, is
 * deterministic: validate that pass, compute the hard-stop overall
 * decision (any single `fail` fails the whole gate), and run independent
 * bright-line backstop checks that can override a model "pass" it
 * disagrees with — the arithmetic-backstops-judgment pattern this product
 * is named for, applied recursively to the judgment step itself.
 */
export function evaluateDoctrineGate(input: DoctrineGateInput): DoctrineGateResult {
  // The four mechanical backstops below are keyed off the verdicts the model
  // actually returned, so a verdict set that does not cover all four
  // constraints exactly once would silently skip the checks for whichever
  // constraints it omitted. Refuse loudly instead — `DoctrineGateInputSchema`
  // rejects this at the tool boundary too; this is the direct-call backstop.
  const violation = describeVerdictSetViolation(input.modelVerdicts);
  if (violation !== null) {
    throw new DoctrineVerdictSetError(violation);
  }

  const mechanicalOverrides: MechanicalOverride[] = [];

  const verdicts: DoctrineVerdict[] = input.modelVerdicts.map((verdict) => {
    const check = MECHANICAL_CHECKS[verdict.constraint];
    const hit = check(input.draftText, input.factsBase);
    if (hit && verdict.verdict === "pass") {
      mechanicalOverrides.push({ constraint: verdict.constraint, reason: `mechanical check found "${hit}" despite a model pass` });
      return { ...verdict, verdict: "fail", quote: hit, rationale: `${verdict.rationale} [mechanically overridden: found "${hit}"]` };
    }
    return verdict;
  });

  const unfilledTemplateDetected = hasUnfilledTemplateToken(input.draftText);
  const overallPass = verdicts.every((v) => v.verdict === "pass") && !unfilledTemplateDetected;

  return { overallPass, verdicts, mechanicalOverrides, unfilledTemplateDetected };
}
