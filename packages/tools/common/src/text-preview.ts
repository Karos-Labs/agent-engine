/**
 * The mechanical "how would this actually look" math every per-platform
 * `render.preview` tool (`agents/*-agent/src/tools/render-preview.ts`) was
 * separately reimplementing: a character-count-against-a-ceiling check, a
 * fold-truncation, and a limit-truncation. Each agent's own limits (X's 280
 * characters, Reddit's 10,000-character comment cap, blog's per-field
 * ceilings, …), its own extra fields (newsletter's `previewText`, blog's
 * `wordCount` floor/ceiling), and its own `AgentTool` registration all stay
 * put in that agent's `render-preview.ts` — this only lifts the literal
 * duplicate arithmetic those five files shared byte-for-byte, not the
 * platform-specific tool itself (deliberately not a general Layer 3
 * capability every agent needs — see each `render-preview.ts`'s own doc
 * comment).
 */

/** A `characterCount`/`withinLimit` pair against a hard ceiling. */
export interface LengthCheck {
  characterCount: number;
  withinLimit: boolean;
}

/** Counts `text` against `limit` and reports whether it clears that ceiling. */
export function checkLength(text: string, limit: number): LengthCheck {
  const characterCount = text.length;
  return { characterCount, withinLimit: characterCount <= limit };
}

/**
 * The full `text`, truncated with a trailing ellipsis so the *total* length
 * never exceeds `limit` — never invents content, just a mechanical preview
 * of what a platform would actually accept.
 */
export function truncateToLimit(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * What a scrolling/inbox reader sees before a platform's own "fold" (see
 * more / read more / scroll) hides the rest of `text` — keeps the first
 * `foldCharacters` verbatim and appends an ellipsis once `text` runs past
 * it. Distinct from `truncateToLimit`: a fold preview is allowed to run one
 * character past `foldCharacters` (the ellipsis itself), since it previews
 * where a reader stops scrolling, not a hard platform ceiling.
 */
export function truncateAtFold(text: string, foldCharacters: number): string {
  return text.length <= foldCharacters ? text : `${text.slice(0, foldCharacters)}…`;
}
