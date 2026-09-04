/**
 * Shared, honest text/citation analysis every real engine adapter delegates
 * to (T-A3/SCRUM-237). Every one of the 5 engines differs only in HOW its raw
 * answer text and citation URLs are obtained (a different HTTP call, a
 * different response shape) — none of them differ in how a brand mention, a
 * competitor mention, or a citation domain is recognized once you have plain
 * text and a list of cited URLs. One analyzer here means one place to get
 * that logic right, rather than five near-identical copies drifting apart.
 *
 * No sentiment classifier exists in this environment (RFC-04 §5/§4's
 * `classifier_model_id` — one of `reproducibility.hash_inputs`' honestly
 * `missing` fields, see `create-seo-geo-agent-workflow.ts` step 09's own
 * comment) — `sentimentPerMention` is therefore always `[]` here, never a
 * fabricated label. The day a real classifier lands, this is the one place
 * that needs to start filling it in.
 */

export interface AnalyzeAnswerInput {
  text: string;
  /** Citation URLs in the order the engine returned/cited them — ordinal is derived from this order, 1-based. */
  citationUrls: readonly string[];
  /** The client's own domains — used for CITATION matching, and as a last-resort mention token when no brand name is supplied. */
  clientDomains: readonly string[];
  /**
   * The client's brand as a person writes it: "Karos Labs", not "karoslabs".
   *
   * WITHOUT THIS, A MULTI-WORD BRAND CAN NEVER BE DETECTED. Mention matching
   * is a literal case-insensitive substring test, and the only token this
   * analyzer used to have was `brandTokenFromDomain(clientDomains[0])` — which
   * turns `karoslabs.com` into `karoslabs`, a string that does not appear in
   * the answer "Karos Labs is an AI marketing agency". Every measured cell for
   * every such client reported `brandMentioned: false` regardless of what the
   * engine actually said, and the client was shown 0% visibility.
   *
   * Competitors were never affected: `competitorRoster` has always been
   * display names. The client was the only entity in this analyzer matched by
   * a mangled domain.
   *
   * Optional because the tool's own contract cannot guarantee a name for every
   * caller; absent, the domain token remains the fallback it always was.
   */
  clientBrandName?: string;
  /** Competitor DISPLAY NAMES (`competitorRoster`) — matched as literal case-insensitive substrings, same convention `prompt-set.ts`'s dedupe and the rest of this migration already use for "no NLP tool, so match on what the text actually says." */
  competitorRoster: readonly string[];
}

export interface AnalyzedMention {
  brandMentioned: boolean;
  brandFirstMentionCharOffset?: number;
  brandCited: boolean;
  brandFirstCitationOrdinal?: number;
  competitorsNamed: Array<{ brandId: string; charOffset: number }>;
  citations: Array<{ domain: string; ordinal: number }>;
  mentionCounts: Record<string, number>;
  sentimentPerMention: Array<{ mentionIndex: number; label: "pos" | "neg" | "neutral" }>;
}

/** `acme.example` -> `acme`, `www.acme.co.uk` -> `acme` — the best brand TOKEN this analyzer can honestly derive from a bare domain (no display name is carried by this tool's own contract). Mirrors `create-seo-geo-agent-workflow.ts`'s `deriveClientDomain` in spirit: an imperfect but never-fabricated heuristic. */
function brandTokenFromDomain(domain: string): string {
  const host = domain.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  return (host.split(".")[0] ?? host).trim();
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function domainMatchesAny(domain: string, roster: readonly string[]): boolean {
  return roster.some((d) => {
    const rosterHost = d.replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase();
    return domain.toLowerCase() === rosterHost || domain.toLowerCase().endsWith(`.${rosterHost}`);
  });
}

/** First case-insensitive char offset of `needle` in `haystack`, or `undefined` when absent. Also returns the total count of (non-overlapping) occurrences. */
function findAll(haystack: string, needle: string): { firstOffset?: number; count: number } {
  if (needle.trim().length === 0) return { count: 0 };
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let count = 0;
  let firstOffset: number | undefined;
  let from = 0;
  for (;;) {
    const idx = lowerHay.indexOf(lowerNeedle, from);
    if (idx === -1) break;
    if (firstOffset === undefined) firstOffset = idx;
    count += 1;
    from = idx + lowerNeedle.length;
  }
  return { count, ...(firstOffset !== undefined ? { firstOffset } : {}) };
}

/**
 * Builds the mention/citation facts every `CaptureCell` needs, from plain
 * answer text and a citation-URL list — the one piece of analysis logic
 * every real engine adapter shares. Never invents a sentiment, never claims
 * a mention that isn't a literal case-insensitive substring match.
 */
export function analyzeAnswer(input: AnalyzeAnswerInput): AnalyzedMention {
  const { text, citationUrls, clientDomains, competitorRoster, clientBrandName } = input;

  // Every spelling of the client worth looking for, best first. The display
  // name is the one an engine actually writes; the domain token stays as the
  // fallback for a caller that supplies no name, and also catches the times an
  // answer writes the bare domain instead of the brand.
  const brandAliases = [clientBrandName?.trim(), clientDomains.length > 0 ? brandTokenFromDomain(clientDomains[0]!) : ""].filter(
    (alias): alias is string => Boolean(alias),
  );

  // The FIRST alias that appears wins the offset, but the count is the best
  // single alias's — not a sum, which would double-count an answer that writes
  // "Karos Labs (karoslabs.com)".
  const brandMatch = brandAliases
    .map((alias) => findAll(text, alias))
    .reduce<{ firstOffset?: number; count: number }>(
      (best, match) => {
        const firstOffset = [best.firstOffset, match.firstOffset].filter((o): o is number => o !== undefined).sort((a, b) => a - b)[0];
        return { count: Math.max(best.count, match.count), ...(firstOffset !== undefined ? { firstOffset } : {}) };
      },
      { count: 0 },
    );
  const mentionCounts: Record<string, number> = { client: brandMatch.count };
  const competitorsNamed: Array<{ brandId: string; charOffset: number }> = [];
  for (const name of competitorRoster) {
    const match = findAll(text, name);
    mentionCounts[name] = match.count;
    if (match.firstOffset !== undefined) competitorsNamed.push({ brandId: name, charOffset: match.firstOffset });
  }
  competitorsNamed.sort((a, b) => a.charOffset - b.charOffset);

  const citations = citationUrls.map((url, i) => ({ domain: domainOf(url), ordinal: i + 1 }));
  const firstClientCitationIndex = citations.findIndex((c) => domainMatchesAny(c.domain, clientDomains));

  return {
    brandMentioned: brandMatch.count > 0,
    ...(brandMatch.firstOffset !== undefined ? { brandFirstMentionCharOffset: brandMatch.firstOffset } : {}),
    brandCited: firstClientCitationIndex !== -1,
    ...(firstClientCitationIndex !== -1 ? { brandFirstCitationOrdinal: citations[firstClientCitationIndex]!.ordinal } : {}),
    competitorsNamed,
    citations,
    mentionCounts,
    // No real sentiment classifier is wired in this environment — see this
    // file's own header comment. Always empty, never fabricated.
    sentimentPerMention: [],
  };
}
