import type { ReputationExtractionAnswer } from "./types.js";

/**
 * `references/scoring.md` §2: "a boolean with no span is treated as false."
 * Applied here rather than trusted from the model directly — an
 * evidence-free `true`, or a `true` whose quoted span is not even a real
 * substring of the review text, is exactly the "vibe with extra steps" this
 * rule exists to catch, one level more paranoid than the doc's own literal
 * wording (which only requires a non-empty span, not that the span is real).
 */
export function evidencedBoolean(answer: ReputationExtractionAnswer, reviewText: string): boolean {
  if (!answer.value) return false;
  const span = answer.evidenceSpan.trim();
  if (span.length === 0) return false;
  return reviewText.includes(span);
}
