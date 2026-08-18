function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `keyword_hits` (triage.py): word-boundary keyword scan across every
 * language set (a PT keyword in an EN review still counts). Returns sorted
 * unique hits. `(?<!\w)kw(?!\w)` in Python's `re` — Node's regex engine
 * supports the same lookaround assertions, so this ports directly.
 */
export function keywordHits(text: string, keywordSets: Readonly<Record<string, readonly string[]>>): string[] {
  const hits = new Set<string>();
  for (const keywords of Object.values(keywordSets)) {
    for (const kw of keywords) {
      const pattern = new RegExp(`(?<!\\w)${escapeRegex(kw)}(?!\\w)`, "i");
      if (pattern.test(text)) hits.add(kw);
    }
  }
  return [...hits].sort();
}
