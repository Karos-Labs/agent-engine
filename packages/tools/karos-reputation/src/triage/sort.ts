/**
 * `sorted(reviews, key=lambda r: r["review_id"])` (triage.py): Python's
 * default string ordering is by code point — `"B" < "a"` because `0x42 <
 * 0x61`. `String.prototype.localeCompare` is ICU COLLATION, which orders
 * case-insensitively-then-by-case (`"a" < "B"`) and ignores/reweights
 * punctuation like `-` and `_` entirely. Review ids are
 * `<platform>:<listing_id>:<platform_review_id>` and platform review ids are
 * routinely mixed-case, base64-ish tokens (`AbFvOq1…` from GBP), so the two
 * orderings genuinely disagree on real data — and `results[]` order, plus
 * the `crisis_keywords` trigger's own member order and signature, are
 * derived from this sort.
 *
 * JS's default `Array.prototype.sort()` comparator (and `<`/`>` on strings)
 * compares UTF-16 code UNITS, which agrees with Python's code-POINT order
 * for everything in the Basic Multilingual Plane and only diverges when a
 * supplementary-plane character (surrogate pair) is compared against
 * U+E000–U+FFFF. Review ids are platform-issued identifiers, never emoji, so
 * this is the same order Python produces — and it matches the plain `.sort()`
 * calls `bursts.ts` already uses for review-id lists, which is the point:
 * one ordering rule everywhere, no latent inconsistency.
 */
export function compareReviewIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
