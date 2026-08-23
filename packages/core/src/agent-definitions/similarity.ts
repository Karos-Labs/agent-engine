/**
 * Output de-duplication — the scoring half.
 *
 * Ported verbatim from agent-service's runner (its own
 * docs/dynamic-agent-guardrails.md describes the feature). Copied rather than
 * rewritten on purpose: the calibration below is empirical, the Unicode
 * handling is a bug someone already found, and a fresh implementation would
 * have re-derived both or, more likely, neither.
 *
 * // DECISION: deterministic n-gram overlap, not embeddings. An embedding
 * comparison would need an external service, an API key, and network access
 * from a runner that is otherwise deliberately offline unless a step was
 * granted egress — three new failure modes and a new secret, to answer a
 * question ("is this the same post again?") that lexical overlap answers well.
 * It is also a PURE function, so its behaviour is pinned by unit tests rather
 * than by a provider's model version silently changing under us.
 *
 * The measure is Jaccard overlap over word trigrams: |A ∩ B| / |A ∪ B| where A
 * and B are the sets of 3-word sequences in each text. Trigrams rather than
 * single words because word-level overlap is dominated by function words —
 * two entirely unrelated marketing posts share "of the", "for your", "we are"
 * and score misleadingly high. A trigram survives paraphrase poorly and
 * reordering not at all, which is exactly the signal wanted: "did this agent
 * emit substantially the same sentences again".
 */

/** Word trigrams — long enough to survive function-word noise, short enough to catch a lightly-reworded paragraph. */
const SHINGLE_SIZE = 3;

/**
 * Flags at 40% trigram overlap.
 *
 * Calibration, from the measure's own behaviour: a re-emitted draft with light
 * edits lands above 0.8; the same brief written afresh in a different order
 * lands well under 0.2; two posts on the same topic sharing stock phrasing sit
 * around 0.2-0.3. 0.40 is comfortably above the "same subject, honestly
 * rewritten" band and well below "this is the old one again", so the common
 * false positive (a recurring agent that legitimately reuses a sign-off or a
 * boilerplate CTA) does not trip it.
 *
 * Exported so the report can state the threshold it was judged against rather
 * than the reader having to know it.
 */
export const DEDUPE_SIMILARITY_THRESHOLD = 0.4;

/**
 * Lowercase, strip everything that is not a letter/digit/space, collapse runs
 * of whitespace.
 *
 * Deliberately Unicode-aware (`\p{L}\p{N}` with the `u` flag) rather than
 * `[a-z0-9]`: this platform's deliverables are not always English, and an
 * ASCII-only strip would reduce a Hebrew or accented-Latin draft to a handful
 * of digits and score every pair of them as identical.
 */
export function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The set of word trigrams in `text`.
 *
 * A text shorter than SHINGLE_SIZE words yields the single whole-text shingle
 * rather than an empty set, so two identical one-word outputs still compare as
 * identical instead of as "no overlap".
 */
export function shingles(text: string): Set<string> {
  const words = normalizeForSimilarity(text).split(" ").filter(Boolean);
  if (words.length === 0) return new Set();
  if (words.length < SHINGLE_SIZE) return new Set([words.join(" ")]);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    out.add(words.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return out;
}

/**
 * Jaccard similarity of two texts' trigram sets, in [0, 1].
 *
 * Two empty texts score 0, not 1: "both produced nothing" is not evidence of
 * repetition, and returning 1 there would flag every run whose deliverable
 * failed to serialize.
 */
export function similarity(a: string, b: string): number {
  const setA = shingles(a);
  const setB = shingles(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const shingle of setA) if (setB.has(shingle)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface SimilarityMatch {
  jobId: string;
  score: number;
}

/**
 * Scores `candidate` against every prior excerpt and returns the closest match.
 *
 * Returns null when there is nothing to compare against, which the caller
 * reports as `status: "no_history"` — distinct from "compared and found
 * nothing similar", because an agent's first run for a client has not passed
 * a check, it has skipped one.
 */
export function closestMatch(
  candidate: string,
  history: Array<{ jobId: string; excerpt: string }>,
): SimilarityMatch | null {
  let best: SimilarityMatch | null = null;
  for (const item of history) {
    const score = similarity(candidate, item.excerpt);
    if (!best || score > best.score) best = { jobId: item.jobId, score };
  }
  return best;
}
