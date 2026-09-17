/**
 * Repair of ONE observed model artifact: two JSON array elements merged into
 * one because the model wrote an unescaped `"` inside a string.
 *
 * Seen on prep run `pubsub-21214555443299035` (karoslabs, 2026-09-17), in
 * `brandVoiceSpec.bannedTerms`. The model meant to write two banned terms and
 * quoted the first one for emphasis:
 *
 * ```
 *   "AI-powered" (without a specific business outcome attached),
 *   "cutting-edge",
 * ```
 *
 * That is not valid JSON — the `"` after `AI-powered` closes the string — and
 * what the lenient parser handed back was a single element:
 *
 * ```
 *   'AI-powered" (without a specific business outcome attached),\n      "cutting-edge'
 * ```
 *
 * So the banned-terms list every publishing agent reads contained one
 * meaningless entry and had silently LOST `cutting-edge`, a term the brand
 * actually bans. One occurrence in 82,427 characters of real output.
 *
 * WHY THIS IS REPAIRED RATHER THAN REJECTED. The turn is otherwise excellent
 * and cost real money; throwing it away over a stray quote is the failure mode
 * the owner ruled against on 2026-09-16 ("the tool-error restrictions should be
 * much less strict — it just wrecks the output"). `clampOversizeValues` already
 * applies the same principle to `too_big`. This is the same class: a
 * house-style slip in the serialization, not bad research.
 *
 * THE TELL, and why it is safe. A repaired entry must contain BOTH a newline
 * AND a double quote. A legitimate entry in these lists is a term, a phrase or
 * a one-line rule: it may contain a quote ("Not a tool. A system.") or, very
 * rarely, a newline — but the co-occurrence is the signature of the merge,
 * because the newline can only have come from the pretty-printed gap between
 * two array elements. That pair fired exactly once across the whole
 * deliverable, and on nothing that was not broken.
 */

/**
 * Strip the quoting and separator debris a merge leaves at a piece's edges,
 * then drop a single UNPAIRED quote if one is left inside.
 *
 * The unpaired quote is the artifact itself: the model wrote `"AI-powered"`
 * and the opening `"` was consumed as the array element's own opener, so the
 * closing one is left stranded mid-string. An odd quote count identifies that
 * exactly, and an even one — `"Not a tool. A system."` — is a phrase the model
 * deliberately quoted and must survive untouched.
 */
function cleanPiece(piece: string): string {
  const trimmed = piece
    .trim()
    .replace(/^[",\s]+/, "")
    .replace(/[",\s]+$/, "")
    .trim();
  const quotes = (trimmed.match(/"/g) ?? []).length;
  return quotes % 2 === 1 ? trimmed.replace('"', "").trim() : trimmed;
}

/**
 * Split any entry that carries the merge signature, leaving every other entry
 * byte-for-byte alone.
 *
 * Returns the same array instance when nothing matched, so a caller can use
 * identity to tell whether a repair happened.
 */
export function repairMergedListEntries(values: readonly string[]): string[] {
  let repaired = false;
  const out: string[] = [];
  for (const value of values) {
    if (!value.includes("\n") || !value.includes('"')) {
      out.push(value);
      continue;
    }
    const pieces = value
      .split("\n")
      .map(cleanPiece)
      .filter((p) => p.length > 0);
    // A split that yields nothing usable is left as it was: an unreadable
    // entry is better than a dropped one, and this function must never be
    // able to empty a list.
    if (pieces.length === 0) {
      out.push(value);
      continue;
    }
    repaired = true;
    out.push(...pieces);
  }
  return repaired ? out : (values as string[]);
}

/**
 * Walk a parsed report and repair every string array in it, at any depth.
 *
 * Applied to the whole object rather than to a named list of fields on
 * purpose: the artifact is a property of how the model serializes arrays, not
 * of any one field, and a field added to the schema later would otherwise be
 * unprotected by an omission nobody would notice.
 *
 * Non-arrays, arrays of objects and every other value pass through untouched.
 */
export function repairMergedEntriesDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) {
      return repairMergedListEntries(value as string[]) as unknown as T;
    }
    return value.map((v) => repairMergedEntriesDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = repairMergedEntriesDeep(v);
    }
    return out as T;
  }
  return value;
}
