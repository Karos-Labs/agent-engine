/**
 * Did a generated scene keep the client's product as it is? (2026-09-23,
 * stage 2 of the reference-looks plan.)
 *
 * The riverflow reference is one bottle in nine scenes, and on two of them the
 * small print on the label is smeared: the model kept the bottle and lost the
 * words. For a client's real product that is a misrepresentation, not a style.
 *
 * This compares what `media.inspectImages` READ on the reference
 * (`textInImage`) with what it read on the generated frame. It is
 * deterministic on purpose: the vision model reads, code decides, the same
 * split every gate in this pipeline keeps. Two findings:
 *
 * - `missing`: label words the generated frame does not carry. Small print may
 *   legitimately be too small to read at scene scale, so only words of three
 *   or more letters count and the bar is a SHARE, not all of them.
 * - `invented`: words on the frame that are on no reference. The brief forbids
 *   any text but the product's own, so a new word is the model re-lettering the
 *   label, the exact defect this exists to catch.
 */
export interface ReferenceFidelity {
  ok: boolean;
  /** Share of the reference's label words found on the generated frame. */
  kept: number;
  missing: string[];
  invented: string[];
  reason: string;
}

/** At least this share of the label's words must survive. */
export const MIN_LABEL_WORDS_KEPT = 0.6;

function words(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const raw of line.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
      // Three LETTERS, not three characters: "33l" from a "0.33L" volume is
      // small print, the part a scene may legitimately fail to resolve.
      if ((raw.match(/\p{L}/gu) ?? []).length >= 3) out.push(raw);
    }
  }
  return [...new Set(out)];
}

export function assessReferenceFidelity(referenceText: readonly string[], generatedText: readonly string[]): ReferenceFidelity {
  const label = words(referenceText);
  const seen = words(generatedText);
  const seenSet = new Set(seen);
  const labelSet = new Set(label);
  const missing = label.filter((w) => !seenSet.has(w));
  const invented = seen.filter((w) => !labelSet.has(w));
  const kept = label.length === 0 ? 1 : (label.length - missing.length) / label.length;

  if (label.length === 0) {
    return {
      ok: invented.length === 0,
      kept,
      missing,
      invented,
      reason: invented.length === 0 ? "the reference carries no readable text, and none was added" : `the reference carries no text and the frame added some: ${invented.join(", ")}`,
    };
  }
  const problems: string[] = [];
  if (kept < MIN_LABEL_WORDS_KEPT) problems.push(`only ${Math.round(kept * 100)}% of the label's words survived (missing: ${missing.join(", ")})`);
  if (invented.length > 0) problems.push(`words appear that are on no reference: ${invented.join(", ")}`);
  return {
    ok: problems.length === 0,
    kept,
    missing,
    invented,
    reason: problems.length === 0 ? `the label survived (${Math.round(kept * 100)}% of its words read back, nothing added)` : problems.join("; "),
  };
}
