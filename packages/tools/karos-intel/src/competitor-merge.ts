import type { ClientCompetitor, PersistedClientCompetitor } from "./types.js";
import { competitorBrandKeys, looksLikeUrlInput } from "./competitor-keys.js";

/**
 * Ports legacy `replaceReportCompetitors` (`karosCMO/src/lib/data.ts` lines
 * 1575-1660) — the REAL merge behavior, not just `competitorBrandKeys` in
 * isolation. `incoming` is this run's freshly-generated competitor rows
 * (the caller, `write-report.ts`, has already forced `source: "report"` on
 * every one of them — same security property as before this fix).
 *
 * Exact precedence ported from legacy, field by field (documented here
 * because the task calling for this fix explicitly asked the exact
 * precedence be written down):
 *
 * 1. MANUAL MATCH (an existing row, `source: "manual"`, matches an incoming
 *    row by `competitorBrandKeys(company, url)`): the manual row is ENRICHED
 *    in place — it is never deleted, never duplicated into a second "report"
 *    twin, and it stays `source: "manual"`.
 *      - `marketTier`, `overlap`: the INCOMING (report) value always wins —
 *        legacy overwrites these two fields unconditionally.
 *      - `positioning`, `keyStrengths`, `keyWeaknesses`, `threatLevel`: the
 *        incoming value wins ONLY when it is non-empty/truthy; otherwise the
 *        manual row's existing value is left untouched. A human's
 *        hand-entered detail is never blanked out by a report run that
 *        simply didn't have anything to say about that field.
 *      - `company`: the manual row's stored name wins, UNLESS that stored
 *        name is itself a raw pasted URL placeholder (`looksLikeUrlInput`)
 *        AND the incoming row supplies a real company name — then the
 *        incoming name replaces the placeholder.
 *      - `url`: the manual row's url wins if it has one; only filled in
 *        from the incoming row when the manual row had none.
 *      - `founded`, `scale`, `minInvestment`, `deepDive`: NEVER touched by
 *        an enrichment (confirmed directly from legacy's patch object at
 *        `data.ts` lines 1611-1626, which does not mention any of these
 *        four fields) — whatever a human set (or left unset) on the manual
 *        row survives untouched.
 *      - `llmMentions`/`llmMentionsAt`: untouched by this path too (legacy
 *        only ever carries these forward on the OLD-REPORT-MATCH path
 *        below, never on the manual-enrichment path).
 *
 * 2. OLD-REPORT MATCH (no manual match, but an existing `source: "report"`
 *    row matches by the same composite key): the incoming row's data wins
 *    almost entirely (full overwrite) — EXCEPT:
 *      - `url` falls back to the old row's url when the incoming row has
 *        none.
 *      - `llmMentions`/`llmMentionsAt` are carried forward from the old row
 *        when it had a measured value, since a fresh report-parse never
 *        supplies these (they come only from the separate SEO/GEO
 *        visibility sync, out of scope for this package).
 *    The old row is then considered "carried" — it does not survive as a
 *    separate entry.
 *
 * 3. NO MATCH AT ALL: the incoming row is appended as a genuinely new row.
 *
 * 4. SURVIVORS: any old `source: "report"` row that (a) was NOT matched by
 *    any incoming row this run, AND (b) has real measured `llmMentions > 0`,
 *    AND (c) is not now covered by a manual row — survives unchanged. This
 *    is legacy's guard against silently losing a real AI-visibility
 *    measurement just because this run's fresh parse didn't happen to
 *    re-surface that competitor. Every other unmatched old report row is
 *    dropped (every `source: "report"` row is replaced on each
 *    regeneration — legacy deletes them all up front and only the merged +
 *    survivor sets get re-inserted).
 */
export function mergeCompetitors(
  existing: PersistedClientCompetitor[],
  incoming: ClientCompetitor[],
): PersistedClientCompetitor[] {
  const manualRows: PersistedClientCompetitor[] = existing.filter((c) => c.source === "manual").map((c) => ({ ...c }));
  const oldReportRows: PersistedClientCompetitor[] = existing.filter((c) => c.source === "report");

  // key -> old report row, first-wins across all of that row's keys (mirrors legacy's oldByKey).
  const oldByKey = new Map<string, PersistedClientCompetitor>();
  for (const r of oldReportRows) {
    for (const k of competitorBrandKeys(r.company, r.url)) {
      if (!oldByKey.has(k)) oldByKey.set(k, r);
    }
  }

  // key -> index into manualRows, computed ONCE from the original manual rows (mirrors legacy's
  // manualByKey, built from the manual docs fetched at the start of the run — later enrichments
  // in this same loop must not shift which key maps to which row).
  const manualIndexByKey = new Map<string, number>();
  manualRows.forEach((m, i) => {
    for (const k of competitorBrandKeys(m.company, m.url)) {
      if (!manualIndexByKey.has(k)) manualIndexByKey.set(k, i);
    }
  });
  const manualIndexOf = (name: string, url?: string): number | undefined => {
    for (const k of competitorBrandKeys(name, url)) {
      const idx = manualIndexByKey.get(k);
      if (idx !== undefined) return idx;
    }
    return undefined;
  };

  const carriedOld = new Set<PersistedClientCompetitor>();
  const mergedNew: PersistedClientCompetitor[] = [];

  for (const row of incoming) {
    const manualIdx = manualIndexOf(row.company, row.url);
    if (manualIdx !== undefined) {
      const m = manualRows[manualIdx]!;
      manualRows[manualIdx] = {
        ...m,
        company: looksLikeUrlInput(m.company) && row.company ? row.company : m.company,
        ...(m.url || !row.url ? {} : { url: row.url }),
        ...(row.positioning ? { positioning: row.positioning } : {}),
        ...(row.keyStrengths?.length ? { keyStrengths: row.keyStrengths } : {}),
        ...(row.keyWeaknesses?.length ? { keyWeaknesses: row.keyWeaknesses } : {}),
        ...(row.threatLevel ? { threatLevel: row.threatLevel } : {}),
        marketTier: row.marketTier,
        overlap: row.overlap,
      };
      continue;
    }

    let old: PersistedClientCompetitor | undefined;
    for (const k of competitorBrandKeys(row.company, row.url)) {
      const candidate = oldByKey.get(k);
      if (candidate) {
        old = candidate;
        break;
      }
    }
    if (!old) {
      mergedNew.push({ ...row });
      continue;
    }
    carriedOld.add(old);
    mergedNew.push({
      ...row,
      ...(!row.url && old.url ? { url: old.url } : {}),
      ...(old.llmMentions !== undefined
        ? { llmMentions: old.llmMentions, ...(old.llmMentionsAt !== undefined ? { llmMentionsAt: old.llmMentionsAt } : {}) }
        : {}),
    });
  }

  const survivors = oldReportRows.filter(
    (r) => !carriedOld.has(r) && (r.llmMentions ?? 0) > 0 && manualIndexOf(r.company, r.url) === undefined,
  );

  return [...manualRows, ...mergedNew, ...survivors];
}
