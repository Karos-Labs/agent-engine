/**
 * Competitor identity-key normalization, ported verbatim (same regexes, same
 * fallback order) from legacy `karosCMO/src/lib/seo-geo.ts` (`normalizeBrandKey`
 * lines 157-164, `brandKeys` lines 173-178, `rootDomain` lines 207-215,
 * `brandLabelFromDomain` lines 119-125, `GENERIC_DOMAIN_LABELS` lines 108-110)
 * and `karosCMO/src/lib/competitor-input.ts` (`looksLikeUrlInput` lines 17-23,
 * `parseCompetitorInput` lines 31-43, `competitorBrandKeys` lines 52-58).
 *
 * This is the exact "is this the same competitor" test `replaceReportCompetitors`
 * (`karosCMO/src/lib/data.ts` lines 1575-1660) runs before deciding whether an
 * incoming report row enriches an existing row or becomes a new one — see
 * `competitor-merge.ts` for the port of that merge logic itself.
 */

/** Domain labels too generic to identify a brand on their own (legacy: `GENERIC_DOMAIN_LABELS`). */
const GENERIC_DOMAIN_LABELS = new Set([
  "www", "com", "net", "org", "co", "app", "web", "site", "shop", "store", "blog", "news", "en", "he", "il",
]);

/** Registrable-ish hostname (lowercase, `www.` stripped) from a URL or bare domain. Legacy: `rootDomain`. */
export function rootDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Best-effort brand label from a registrable domain: the LAST meaningful label
 * before the public-suffix tail — "tech.walla.co.il" -> "walla" (not "tech"),
 * "calcalistech.com" -> "calcalistech". Legacy: `brandLabelFromDomain`.
 */
function brandLabelFromDomain(domain: string | null): string | null {
  if (!domain) return null;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length === 0) return null;
  const candidates = labels.slice(0, -1).filter((l) => l.length >= 3 && !GENERIC_DOMAIN_LABELS.has(l));
  return (candidates.length ? candidates[candidates.length - 1] : labels[0]) ?? null;
}

/**
 * Collapse a brand to a comparison key so near-duplicate roster rows merge
 * instead of competing against each other. The registrable domain root is the
 * strongest identity; otherwise the name stripped of generic agency suffixes +
 * punctuation. Legacy: `normalizeBrandKey`.
 */
export function normalizeBrandKey(name: string, url?: string): string {
  const domainRoot = brandLabelFromDomain(rootDomain(url));
  if (domainRoot && domainRoot.length >= 3) return domainRoot;
  return name
    .toLowerCase()
    .replace(/\b(ai|agency|consulting|labs?|studio|inc|llc|ltd|co|group|the|and|&)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Every identity key for a brand: the name-derived key plus the url-derived
 * key when they differ. Legacy: `brandKeys`.
 */
export function brandKeys(name: string, url?: string): string[] {
  const nameKey = normalizeBrandKey(name);
  if (!url) return [nameKey];
  const urlKey = normalizeBrandKey(name, url);
  return urlKey === nameKey ? [nameKey] : [nameKey, urlKey];
}

/** True when a raw string looks like a URL/bare-domain rather than a company name. Legacy: `looksLikeUrlInput`. */
export function looksLikeUrlInput(raw: string): boolean {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  return /^([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(s);
}

/** Resolve a raw quick-add input into { company, url }. Legacy: `parseCompetitorInput`. */
export function parseCompetitorInput(raw: string): { company: string; url?: string } {
  const s = raw.trim();
  if (!looksLikeUrlInput(s)) return { company: s };
  try {
    const host = new URL(s.includes("://") ? s : `https://${s}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
    if (!host.includes(".")) return { company: s };
    return { company: host, url: host };
  } catch {
    return { company: s };
  }
}

/**
 * Identity keys for a stored competitor row, tolerating legacy rows whose
 * `company` is a raw pasted URL with no `url` field (pre-parse quick-adds).
 * Use this — not `brandKeys` directly — anywhere competitor ROWS are matched
 * against each other. Legacy: `competitorBrandKeys`.
 */
export function competitorBrandKeys(company: string, url?: string): string[] {
  if (!url && looksLikeUrlInput(company)) {
    const parsed = parseCompetitorInput(company);
    return brandKeys(parsed.company, parsed.url);
  }
  return brandKeys(company, url);
}
