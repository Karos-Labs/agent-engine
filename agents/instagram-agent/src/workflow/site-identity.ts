/**
 * SITE IDENTITY — is this page really the client's site? (owner feedback round
 * 2026-09-24, WS-03).
 *
 * Kindly Yours' post came out about wedding design because the website on
 * record, kindlyyours.com, is a parked domain for sale; the brand lives at
 * thisiskindly.com. Every page that read as text counted as `site` grounding,
 * so a registrar's lander wrote the client's positioning.
 *
 * A pure classifier over a fetched page. A page that is parked, unavailable or
 * a bot challenge is never grounding: it is dropped with a named gap, and the
 * brief rests on the sources that are really the client's.
 */

export type SiteIdentityVerdict = "ok" | "parked" | "unavailable" | "challenge";

export interface SiteIdentityResult {
  verdict: SiteIdentityVerdict;
  /** What matched, for the gap line a reviewer reads. */
  evidence?: string;
}

const SALE_HOSTS = "(?:godaddy|afternic|sedo|dan\\.com|hugedomains|bodis|parkingcrew|undeveloped)";

/**
 * A registrar's NAME alone is not a lander ("Powered by GoDaddy" sits in the
 * footer of real sites), and "make an offer" is a shop button; each counts only
 * next to domain-sale words.
 */
const PARKED: readonly RegExp[] = [
  /\bthis domain (?:name )?(?:is|may be) for sale\b/iu,
  /\bbuy this domain\b/iu,
  /\bdomain (?:is )?parked\b/iu,
  /\bdomain\b[^.]{0,80}\bis for sale\b|\bis for sale\b[^.]{0,80}\bdomain\b/iu,
  /\bmake an offer\b[^.]{0,100}\bdomain\b|\bdomain\b[^.]{0,100}\bmake an offer\b/iu,
  new RegExp(`\\b${SALE_HOSTS}\\b[\\s\\S]{0,160}\\b(?:domain|for sale)\\b|\\b(?:domain|for sale)\\b[\\s\\S]{0,160}\\b${SALE_HOSTS}\\b`, "iu"),
];
const UNAVAILABLE: readonly RegExp[] = [
  /\b(?:this )?store (?:is )?unavailable\b/iu,
  /\bdomain (?:has )?expired\b/iu,
  /\bsite (?:is )?(?:temporarily )?unavailable\b/iu,
  /\baccount (?:has been )?suspended\b/iu,
];
/** Read on the TITLE alone when there is one: a real page can say "just a moment" in its copy. */
const CHALLENGE: readonly RegExp[] = [
  /^\s*just a moment\.{0,3}\s*$/iu,
  /\bchecking (?:if the site connection is secure|your browser)\b/iu,
  /\battention required!? \| cloudflare\b/iu,
  /\benable javascript and cookies to continue\b/iu,
];

/** Classifies one fetched page. Reads the title and the first 3,000 characters, where a lander or a challenge says what it is. */
export function classifySitePage(page: { url?: string; title?: string | undefined; text: string }): SiteIdentityResult {
  const title = (page.title ?? "").trim();
  const head = `${title}\n${page.text.slice(0, 3000)}`;
  const groups: ReadonlyArray<readonly [SiteIdentityVerdict, readonly RegExp[], string]> = [
    ["challenge", CHALLENGE, title.length > 0 ? title : head],
    ["parked", PARKED, head],
    ["unavailable", UNAVAILABLE, head],
  ];
  for (const [verdict, patterns, haystack] of groups) {
    for (const pattern of patterns) {
      const hit = pattern.exec(haystack);
      if (hit !== null) return { verdict, evidence: hit[0].trim().slice(0, 80) };
    }
  }
  return { verdict: "ok" };
}

/** The pages that really are the client's, and a gap line for each that is not. */
export function keepClientSitePages<T extends { url: string; title?: string | undefined; text: string }>(pages: readonly T[]): { kept: T[]; gaps: string[] } {
  const kept: T[] = [];
  const gaps: string[] = [];
  for (const page of pages) {
    const result = classifySitePage(page);
    if (result.verdict === "ok") kept.push(page);
    else gaps.push(`${page.url} was not used as the client's site: it reads as ${result.verdict} ("${result.evidence ?? ""}"). Check the website on file`);
  }
  return { kept, gaps };
}
