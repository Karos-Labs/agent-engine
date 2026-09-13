import type { ResearchCandidateDocument } from "@agent-engine/workflow";
import { normalizeDomain } from "./research-lanes.js";
import type { ResearchFact, ResearchOutput } from "./types.js";

/**
 * Headline fact cards — what `04b` ships when the extraction agent's own
 * output did not clear its schema (RFC-19 §4 item 17, Phase 6, 2026-09).
 *
 * ## The defect
 *
 * `04b-research-extract-facts` asks a model to turn the merged research
 * documents into fact cards. When that model's answer failed
 * `ResearchOutputSchema`, the workflow threw `WorkflowHeld` — and the run
 * ended holding a research base it had already paid for. Every document was
 * still in hand at the throw site: the titles, the excerpts, the URLs, the
 * publication dates. The only thing missing was the model's summary of them.
 *
 * That is a QUALITY event, not a fault (RFC-19's carve-out): the client gets
 * nothing because one schema came back malformed, while sixteen real, fetched,
 * citable sources sat one line above the throw.
 *
 * ## What this does instead
 *
 * One card per fetched SOURCE — not per document record; a URL that appears twice, once as the search result
 * that found it and once as `04a3`'s full-text read of it, is one publication and gets one card. The URL is
 * claimed by whichever of the two records actually PRODUCES that card, so a titleless search result cannot
 * lock out the full-text read that carries the publication's real `<title>`; the only record refused outright
 * is one whose whole title is its own URL, which is `04a3`'s `title: p.title ?? p.url` filler. Built in code:
 *
 * - `claim`  — the document's title, word for word. Never re-worded, never
 *   summarised, never truncated, never joined with another document's: a
 *   headline is a claim its own publication already stood behind. The ONE
 *   thing that happens to it is that inner whitespace is collapsed and the
 *   ends are trimmed, because a scraped `<title>` arrives with the source
 *   file's newlines in it and `checkSlidesData` matches a slide's `sourceRef`
 *   against this string CHARACTER FOR CHARACTER — a claim carrying a line
 *   break is a claim no slide can cite.
 * - `quote`  — the first {@link HEADLINE_FALLBACK_QUOTE_CHARS} characters of
 *   the document's description/content, whitespace-collapsed. Omitted rather
 *   than emitted empty.
 * - `source` — the URL's host (`normalizeDomain`, the same parse the research
 *   lanes use), else the document's own `author`. Never invented: a document
 *   with neither is skipped, because `source` is what gets PRINTED on a slide.
 * - `date`   — `publishedAt` when the document carries one, else the run's own
 *   date, passed in rather than read from the clock so a resumed step rebuilds
 *   the identical set.
 * - `kind: "event"`, `primary: false` — a headline reports that something
 *   happened; it is not the study, and it carries no extracted figure.
 *
 * **Cost: $0.** No model call, no tool call, no re-ask. RFC-19 §7.5 priced the
 * one re-ask of `04b` at `STEP_COST_ESTIMATES_USD.extraction = 0.0135`, which
 * puts a cold Hebrew plan at `$1.0118 > $1.00` and fires the attempt rung —
 * three drafting attempts become two. Buying a retry by spending a drafting
 * attempt is the trade this whole phase exists to refuse, so this fallback is
 * deterministic string work and nothing else.
 *
 * ## What it deliberately does NOT do
 *
 * It does not manufacture a research base out of nothing.
 * `zero-held-guarantee.test.ts:49-50`'s reasoning — *"shipping unsourced copy
 * is worse than shipping nothing"* — survives intact here, and the reason it
 * survives is that **these cards are sourced**: every one names a real fetched
 * document, its publication and its URL. When no document can be named
 * (no title, or a title with no host and no author to attribute it to) this
 * produces NOTHING and the caller holds with {@link NO_READABLE_SOURCE}. That
 * hold is the carve-out's third item and is meant to stay.
 *
 * A run that ships these cards is thinner than one that shipped extracted
 * statistics, and says so twice: `research.status` is `"headline-fallback"`
 * and the reason names the schema failure. **If this status becomes common in
 * prep, the extractor is what to fix — not this fallback** (RFC-19 §11 item 2).
 */

/** `ResearchFactSchema.quote`'s own `.max(240)`. A whole paragraph is not a pull-quote. */
export const HEADLINE_FALLBACK_QUOTE_CHARS = 240;

/**
 * `ResearchOutputSchema.facts`'s own `.max(30)`.
 *
 * Three lanes over a healthy week merge past thirty documents, and a card set
 * that fails the very schema this fallback exists to satisfy would turn one
 * quality event into two. `04b2-dedupe-fact-cards` caps the SHIPPED set at 24
 * afterwards, exactly as it does for extracted cards.
 */
export const HEADLINE_FALLBACK_CARD_CAP = 30;

/** The hold reason when no fetched document can be named. RFC-19 §6 item 6 — the one exit this file keeps. */
export const NO_READABLE_SOURCE = "research found no readable source";

/** A document that produced no card, and why. The honest counterpart to `facts` — a silent drop would make a thin base look like a thin week. */
export interface SkippedDocument {
  /** The document's title, or `""` when the title is what was missing. */
  title: string;
  reason: string;
}

export interface HeadlineFactCardSet {
  /** One card per usable SOURCE, in merge order. Possibly empty — that is the caller's hold. */
  facts: ResearchFact[];
  /** How many document RECORDS were looked at, including duplicates of one URL and the ones that produced nothing. */
  documentsConsidered: number;
  skipped: SkippedDocument[];
  /** How many usable documents the {@link HEADLINE_FALLBACK_CARD_CAP} removed. */
  truncated: number;
}

/** Collapse inner whitespace and trim — a title printed across two lines of HTML is one claim, not two. */
function tidy(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

/**
 * The body text to quote from.
 *
 * `description` is not on `ResearchCandidateDocument` — the shared type
 * declares `title`/`url`/`content`/`publishedAt`/`author` — but
 * `research.pull`'s real payload carries it for most providers, and it is the
 * better quote when present because it is the publication's own summary rather
 * than the first 240 characters of a nav bar. Read by hand for that reason,
 * exactly as `research-lanes.ts` hand-narrows `visualPatterns`.
 */
function bodyText(document: ResearchCandidateDocument): string {
  const described = tidy((document as Record<string, unknown>)["description"]);
  return described.length > 0 ? described : tidy(document.content);
}

/** The human-readable attribution printed ON a slide: the URL's host, else the document's own author. Never invented. */
function attribution(document: ResearchCandidateDocument): string | undefined {
  const host = typeof document.url === "string" ? normalizeDomain(document.url) : undefined;
  if (host !== undefined) return host;
  const author = tidy(document.author);
  return author.length > 0 ? author : undefined;
}

/**
 * One card per fetched document. Pure, deterministic and free.
 *
 * `runDate` is the date a document with no `publishedAt` is dated to — passed
 * in rather than read from the clock so a resumed step rebuilds the identical
 * set, the same rule `buildResearchLanes` follows for its `year`.
 */
export function headlineFactCards(documents: readonly ResearchCandidateDocument[], runDate: string): HeadlineFactCardSet {
  const facts: ResearchFact[] = [];
  const skipped: SkippedDocument[] = [];
  const seenUrls = new Set<string>();
  let truncated = 0;

  for (const document of documents) {
    // ── ONE CARD PER SOURCE, NOT PER DOCUMENT RECORD ──
    //
    // The list this reads is `[...deepResearch.merged.documents, ...fetchedPages]`, and `04a3` fetches its
    // pages FROM urls it picked out of that same merged set — so a primary source appears TWICE: once as the
    // search result that found it, and once as the full-text read of it. They are one publication.
    //
    // Two cards would be worse than redundant. `04a3` labels a fetched page `title: p.title ?? p.url`, so the
    // second record's "headline" is whatever the fetcher had to hand — frequently the bare URL. Claiming that
    // as a headline would print a URL on a slide as a statement of fact, and cite it to itself: precisely the
    // unsourced copy this module's own header refuses, arriving by the one door that looked like a document.
    //
    // Keeping the FIRST occurrence that CARDS keeps the search result, which is the one with the publication's
    // own headline. That is structural, not lucky: `orderDocumentsPrimaryFirst` ranks both records the same
    // (the page is `primary`, its search result `looksPrimary`) and breaks the tie on original index, and the
    // page is appended after the merged set it was derived from — so the record carrying the real headline is
    // normally the earlier one.
    //
    // The dedupe is on the SOURCE HAVING BEEN CARDED, not on the URL having been SEEN, and the difference is
    // load-bearing. `pickPrimarySourceUrls` draws `04a3`'s URLs out of the merged set, so every fetched page's
    // URL is in this list twice BY CONSTRUCTION. Burning the key on a record that produced no card therefore
    // made the 8000-character full-text reads structurally unable to ever contribute: a search result with a
    // thin or absent title killed the source, and the fetched page carrying the publication's real `<title>`
    // arrived to find the door already shut. On a provider whose titles are thin that turns a quality event
    // into `NO_READABLE_SOURCE` — a hold, for a reason that is not the carve-out's.
    //
    // The anti-filler rule it was defending is KEPT, just stated directly instead of by proxy: `04a3` labels a
    // fetched page `title: p.title ?? p.url`, so when the fetcher had no `<title>` the label IS the bare URL,
    // and claiming that as a headline would print a URL on a slide as a statement of fact and cite it to
    // itself. That exact shape — and only that shape — is refused below.
    const url = typeof document.url === "string" ? document.url.trim() : "";
    const claim = tidy(document.title);
    if (url.length > 0 && seenUrls.has(url)) {
      skipped.push({ title: claim, reason: `${url} already has a card — a full-text fetch of a document is the same source, not a second one` });
      continue;
    }
    if (url.length > 0 && claim === url) {
      // `title: p.title ?? p.url` with no `<title>` to hand. Not a headline, and not a substitute for one.
      skipped.push({ title: "", reason: `the record's only title is its own URL (${url}), which is the fetcher's filler rather than a headline` });
      continue;
    }
    if (claim.length === 0) {
      skipped.push({ title: "", reason: "the document has no title to quote as a claim" });
      continue;
    }
    const source = attribution(document);
    if (source === undefined) {
      // `source` is what a slide PRINTS as the attribution. A card that names
      // no publication and no author is the unsourced copy this fallback
      // exists not to ship, so the document is recorded and dropped.
      skipped.push({ title: claim, reason: "no URL host and no author, so there is nothing to attribute the headline to" });
      continue;
    }
    if (facts.length === HEADLINE_FALLBACK_CARD_CAP) {
      truncated++;
      continue;
    }
    const quote = bodyText(document).slice(0, HEADLINE_FALLBACK_QUOTE_CHARS).trim();
    const publishedAt = tidy(document.publishedAt);
    // Claimed HERE, not at the top of the body: the key is burned by the record that actually cards the
    // source, so a record that contributed nothing cannot lock a later one out.
    if (url.length > 0) seenUrls.add(url);
    facts.push({
      claim,
      source,
      date: publishedAt.length > 0 ? publishedAt : runDate,
      ...(typeof document.url === "string" && document.url.trim().length > 0 ? { url: document.url.trim() } : {}),
      // A headline reports that something happened. It is not the study behind
      // it (`primary: false`) and it carries no extracted figure (`stat`).
      kind: "event" as const,
      // Omitted, never present-and-empty: a `quote: ""` key in the persisted
      // step output reads as "we looked and the publication said nothing",
      // which is a different claim from "this document carried no body text".
      ...(quote.length > 0 ? { quote } : {}),
      primary: false,
    });
  }

  return { facts, documentsConsidered: documents.length, skipped, truncated };
}

export interface HeadlineFallbackResearch {
  /** Schema-valid against `ResearchOutputSchema` — the drop-in for the extraction agent's own output. */
  output: ResearchOutput;
  /** The marker the deliverable and the gate payload carry, so a reviewer knows this post rests on headlines. */
  research: { status: "headline-fallback"; reason: string };
  cards: HeadlineFactCardSet;
}

/**
 * The whole `04b` fallback in one call: cards, a schema-valid
 * `ResearchOutput` around them, and the degrade marker.
 *
 * Returns `undefined` when no document could be named — the caller holds with
 * {@link NO_READABLE_SOURCE}, which is the one exit RFC-19 §6 item 6 keeps
 * here. It is `undefined` rather than an empty set on purpose:
 * `ResearchOutputSchema.facts` is `.min(1)`, so "no cards" is not a research
 * output at all and must not be constructible as one.
 *
 * `reason` is the extraction failure in the workflow's own words, carried
 * verbatim rather than re-worded — the same rule RFC-19 §5.1 sets for every
 * `SelfCheckFinding.detail`.
 */
export function headlineFallbackResearch(
  documents: readonly ResearchCandidateDocument[],
  runDate: string,
  options: { topic: string; rawPayloadRef: string; reason: string },
): HeadlineFallbackResearch | undefined {
  const cards = headlineFactCards(documents, runDate);
  if (cards.facts.length === 0) return undefined;
  const truncatedNote = cards.truncated > 0 ? `, ${cards.truncated} past the ${HEADLINE_FALLBACK_CARD_CAP}-card ceiling` : "";
  return {
    output: { topic: options.topic, facts: cards.facts, rawPayloadRef: options.rawPayloadRef },
    research: {
      status: "headline-fallback",
      reason:
        `${options.reason} — this post rests on ${cards.facts.length} fetched headline(s) out of ${cards.documentsConsidered} document(s)` +
        `${truncatedNote}, each quoted verbatim from its own publication rather than extracted`,
    },
    cards,
  };
}
