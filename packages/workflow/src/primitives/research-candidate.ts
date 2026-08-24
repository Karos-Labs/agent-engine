/**
 * Turning a `research.pull` payload into a drafting candidate.
 *
 * ## Why this is shared rather than written per agent
 *
 * Five agents (x, linkedin, blog, newsletter, reddit) each had their own copy
 * of this step, and all five carried the same comment:
 *
 *   "Phase 1's research.pull is a stand-in with no real external search
 *   backend yet ... so there is no real numeric insight to extract. This
 *   derives a low-confidence, clearly-labeled fallback candidate from the query
 *   itself, never a fabricated statistic."
 *
 * That was true when written. It stopped being true the moment `research.pull`
 * grew a real scraper, and nothing failed, because a post about nothing in
 * particular is still a valid post. prep run pubsub-20272693789971486 measured
 * the cost: four real current sources fetched in 5.9 billed seconds, then a
 * draft that mentioned none of them.
 *
 * Five copies is how one stale assumption became five. One implementation is
 * the fix for the recurrence, not just for the instance.
 */

/** One live source out of a `research.pull` payload. Mirrors karos-research's `ResearchDocument`. */
export interface ResearchCandidateDocument {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
  readonly publishedAt?: string;
  readonly author?: string;
}

/**
 * What a workflow's research step should keep from `research.pull`.
 *
 * `result` is the payload itself, not just its identity. Every agent used to
 * return only `{runId, query, fromCache}`, which left the extraction step with
 * nothing to extract from even after the search became real.
 */
export interface ResearchPullResult {
  readonly runId: string;
  readonly query: string;
  readonly fromCache: boolean;
  readonly result?: {
    readonly provider?: string;
    readonly documents?: readonly ResearchCandidateDocument[];
    readonly history?: {
      readonly priorTopics?: readonly string[];
    };
  };
}

/** The shape every agent's `*CandidateSummary` already has. */
export interface ResearchCandidate {
  /** A real source's headline when the search returned one; the query itself only when it returned nothing. */
  candidateTopic?: string;
  /** True when the chosen source's own text carries a figure a claim could cite. */
  hasNumericInsight: boolean;
  /** The source URL a downstream claim can be traced to, or a labelled run id when there was no source. */
  sourceLabel: string;
}

export interface ExtractOptions {
  /**
   * Topics this client has already covered. A source whose headline repeats one
   * is skipped in favour of the next, which is what makes the history half of
   * the payload do something rather than merely travel.
   */
  readonly avoidTopics?: readonly string[];
}

/**
 * Does this text carry a figure a draft could actually cite?
 *
 * Deliberately not `/\d/`. That was the first version and it was wrong in a
 * way a test caught immediately: the linkedin fixture's client industry is
 * "B2B SaaS", so the `2` inside "B2B" flipped `hasNumericInsight` true on every
 * run and pushed the whole archetype rotation onto its numeric ordering. The
 * same would have happened in production for any client in B2B, Web3, or
 * Industry 4.0 — a permanent silent skew from a character inside a word.
 *
 * So a digit only counts when it reads like a statistic:
 *   - a percentage: "76%", "76 percent"
 *   - a magnitude: "3 million", "12k", "5x"
 *   - any multi-digit run: "31 countries", "2026"
 *
 * A single digit welded between letters never counts.
 */
const CITABLE_FIGURE =
  /(?<![A-Za-z0-9])\d[\d,.]*\s?(?:%|percent\b|million\b|billion\b|bn\b|k\b|x\b)|(?<![A-Za-z0-9])\d{2,}(?![A-Za-z])/i;

/** True when the text carries something a sourced claim could quote. */
export function hasCitableFigure(text: string | undefined): boolean {
  return CITABLE_FIGURE.test(text ?? "");
}

/** Cheap containment check, both sides normalised, so "AI Overviews" matches "ai overviews". */
function overlaps(headline: string, avoid: readonly string[]): boolean {
  const h = headline.trim().toLowerCase();
  if (h.length === 0) return false;
  return avoid.some((a) => {
    const t = a.trim().toLowerCase();
    return t.length > 0 && (h.includes(t) || t.includes(h));
  });
}

/**
 * Picks the candidate a draft should be built from.
 *
 * Preference order, and each step of it earns its place:
 *
 *  1. A source not already covered, whose text carries a citable figure. That is
 *     what `gate.numbersSourced` downstream rewards, and a headline with nothing
 *     behind it cannot support a sourced claim.
 *  2. Any source not already covered.
 *  3. Any source at all, if avoiding repeats would mean having nothing.
 *  4. The query, clearly labelled as having no source behind it.
 *
 * Nothing here invents a subject. The topic is always either a real headline or
 * the caller's own query, and `sourceLabel` is either a URL a reader can open
 * or an explicit admission that there was no source.
 */
export function extractResearchCandidate(pull: ResearchPullResult, options: ExtractOptions = {}): ResearchCandidate {
  const documents = (pull.result?.documents ?? []).filter((d) => (d.title ?? "").trim().length > 0);

  // The caller's explicit list, plus whatever the payload's own history half
  // reported — so an agent gets deduplication even if it did not assemble the
  // list itself.
  const avoid = [...(options.avoidTopics ?? []), ...(pull.result?.history?.priorTopics ?? [])];

  const fresh = avoid.length > 0 ? documents.filter((d) => !overlaps(d.title!, avoid)) : documents;
  const pool = fresh.length > 0 ? fresh : documents;

  const withNumbers = pool.find((d) => hasCitableFigure(d.content));
  const chosen = withNumbers ?? pool[0];

  if (chosen === undefined) {
    // An honestly empty search. Same conservative behaviour as before a scraper
    // existed, and it says so rather than looking like a real source.
    return {
      candidateTopic: pull.query,
      hasNumericInsight: false,
      sourceLabel: `research run ${pull.runId} (no external sources returned)`,
    };
  }

  return {
    candidateTopic: chosen.title!.trim(),
    hasNumericInsight: hasCitableFigure(chosen.content),
    sourceLabel: (chosen.url ?? "").trim().length > 0 ? chosen.url!.trim() : `research run ${pull.runId}`,
  };
}
