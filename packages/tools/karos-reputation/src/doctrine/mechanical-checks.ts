/** Fault/blame/financial-promise denylists — a deliberately narrow, high-precision set of bright-line phrases (never a semantic guess) that back-stop the model's own judgment pass, matching this codebase's `gate.*` convention of mechanical checks that can only ever ADD scrutiny, never replace it. */

const FAULT_CONCESSION_PHRASES = [
  "our fault",
  "our mistake",
  "we were wrong",
  "this was our error",
  "we admit",
  "we take full responsibility",
  "we caused this",
];

const BLAME_PHRASES = [
  "you must have",
  "you misunderstood",
  "that's not how it works",
  "you should have",
  "user error",
  "you didn't",
];

const FINANCIAL_PROMISE_PHRASES = [
  "refund",
  "compensation",
  "reimburse",
  "free of charge",
  "on the house",
  "credit your account",
  "money back",
  "waive the fee",
  "your next visit is on us",
  "as a token of our apology",
];

function findPhrase(text: string, phrases: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

export function findFaultConcessionPhrase(text: string): string | null {
  return findPhrase(text, FAULT_CONCESSION_PHRASES);
}

export function findBlamePhrase(text: string): string | null {
  return findPhrase(text, BLAME_PHRASES);
}

export function findFinancialPromisePhrase(text: string): string | null {
  return findPhrase(text, FINANCIAL_PROMISE_PHRASES);
}

/** `publish.py`'s `guard_text`: an unfilled `{{template}}` token must never ship — checked here too so it is caught at the gate, not only at the publish rail. */
export function hasUnfilledTemplateToken(text: string): boolean {
  return text.includes("{{") || text.includes("}}");
}

/** Numeric-claim scan, same pattern as `gate.numbersSourced` (percentages, currency, "Nx" multipliers, magnitude words) — reused here per RFC-08 §9's explicit "gate.numbersSourced-style pattern for step 09's doctrine gate" guidance. */
const NUMERIC_CLAIM_PATTERN = /(\d[\d,]*(?:\.\d+)?\s?%)|([$€£]\s?\d[\d,]*(?:\.\d+)?)|(\b\d+(?:\.\d+)?x\b)|(\b\d+(?:\.\d+)?\s?(?:million|billion|thousand)\b)/gi;

/** A numeric claim in the draft with no verbatim match anywhere in the facts base is a `facts_grounded` violation, mirroring `gate.numbersSourced`'s "a citation marker proves nothing about whether the number itself is real" rule. */
export function findUnsourcedNumericClaim(draftText: string, factsBase: readonly string[]): string | null {
  const claims = Array.from(draftText.matchAll(NUMERIC_CLAIM_PATTERN)).map((m) => m[0]);
  if (claims.length === 0) return null;
  const factsBlob = factsBase.join(" ");
  for (const claim of claims) {
    if (!factsBlob.includes(claim)) return claim;
  }
  return null;
}
