import { describe, expect, it, afterEach } from "vitest";
import { similarity } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine, type ResearchCandidateDocument } from "@agent-engine/workflow";
import { createOfflineScraper, type ScrapedRecord, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  goodBrandTokens,
  goodCopyOutput,
  goodImageCandidatePool,
  goodStyleConfig,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns } from "./turns.js";
import {
  DUPLICATE_CLAIM_SIMILARITY,
  FACT_CARD_CAP,
  FACT_CARDS_FOR_PROMPT,
  claimFigures,
  dedupeFactCards,
  factCardsForPrompt,
  normalizeClaim,
} from "../src/workflow/fact-cards.js";
import {
  HEADLINE_FALLBACK_CARD_CAP,
  HEADLINE_FALLBACK_QUOTE_CHARS,
  headlineFactCards,
  headlineFallbackResearch,
} from "../src/workflow/research-fallback.js";
import { ANGLE_FACTS_IN_PROMPT, factsForAnglePrompt } from "../src/workflow/angle-selection.js";
import { ResearchOutputSchema, type ResearchFact } from "../src/workflow/types.js";

/**
 * Fact-card dedupe (RFC-13 §J).
 *
 * The set under test is the one deep research actually produces: three lanes,
 * 14-20 merged documents, and heavy overlap by construction — a study, the
 * press release, and three articles restating the press release all carry the
 * same figure. What ships has to be one card per claim, cited to the
 * strongest source of the group.
 */

function card(overrides: Partial<ResearchFact> & { claim: string }): ResearchFact {
  return { source: "Example Weekly", date: "2026-09-01", ...overrides };
}

describe("normalizeClaim", () => {
  it("folds case, punctuation and thousands separators so one claim written twice compares equal", () => {
    expect(normalizeClaim("Revenue reached 1,200 accounts.")).toBe(normalizeClaim("revenue reached 1200 accounts"));
    expect(normalizeClaim("  Teams   saved  4 hours/week!  ")).toBe("teams saved 4 hours week");
  });

  it("folds magnitude words and currency spellings the way karos-gates' numbersSourced does", () => {
    expect(normalizeClaim("$1 billion in ARR")).toBe(normalizeClaim("USD 1bn in ARR"));
    expect(normalizeClaim("grew 4.2x")).toBe(normalizeClaim("grew 4.2×"));
  });

  it("keeps a figure's UNIT distinguishable after the strip to letters and digits", () => {
    // The strip is what makes "1,200" and "1200" equal; folding the unit into
    // a word first is what stops it from also making "$5" and "5%" equal.
    expect(normalizeClaim("up 42%")).not.toBe(normalizeClaim("up $42"));
    expect(normalizeClaim("up 42%")).toContain("42 pct");
    expect(normalizeClaim("a $42 seat")).toContain("42 usd");
    expect(normalizeClaim("₪1,200 per month")).toContain("1200 ils");
  });

  it("reads a claim's figures, and does not mistake a year for one", () => {
    expect(claimFigures(normalizeClaim("42% of 1,200 teams"))).toEqual(["1200", "42pct"]);
    // Otherwise every card about the same year looks like the same statistic.
    expect(claimFigures(normalizeClaim("2026 was the year agencies stopped discounting"))).toEqual([]);
    expect(claimFigures(normalizeClaim("in 2026, revenue grew 4.2x"))).toEqual(["4.2x"]);
  });
});

describe("dedupeFactCards", () => {
  it("keeps ONE card when two documents restate the same figure, and keeps the primary source's wording", () => {
    // The real shape of the overlap: a study and a news article about the
    // study. Trigram overlap between them is far below 0.8 (they share almost
    // no three-word run), which is exactly why the same-figure rule exists.
    const study = card({
      claim: "42% of teams that automated weekly reporting saved four hours a week.",
      source: "Ops Benchmark Report 2026",
      url: "https://research.example.org/ops-benchmark-2026.pdf",
      kind: "stat",
      primary: true,
    });
    const coverage = card({
      claim: "Weekly reporting automation gave teams back four hours, according to a new benchmark, with 42% of them reporting the gain.",
      source: "Example Weekly",
      url: "https://news.example.com/reporting-automation",
      kind: "stat",
    });

    // Order deliberately puts the weaker card FIRST: the rule has to reach
    // back and replace what it already kept, not merely refuse the second.
    const result = dedupeFactCards([coverage, study]);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.claim).toBe(study.claim);
    expect(result.dropped).toEqual([{ claim: coverage.claim, duplicateOf: study.claim, rule: "same-figure" }]);
    // The premise, asserted rather than assumed: the trigram rule alone would
    // NOT have caught this pair, which is why rule 3 exists at all.
    expect(similarity(normalizeClaim(coverage.claim), normalizeClaim(study.claim))).toBeLessThan(DUPLICATE_CLAIM_SIMILARITY);
  });

  it("keeps both cards when the figures differ, however similar the sentences are", () => {
    const a = card({ claim: "42% of teams automated their weekly reporting in 2026." });
    const b = card({ claim: "51% of teams automated their weekly reporting in 2026." });

    const result = dedupeFactCards([a, b]);

    expect(result.facts.map((f) => f.claim)).toEqual([a.claim, b.claim]);
    expect(result.dropped).toEqual([]);
  });

  it("does not merge two unrelated claims that happen to quote the same figure", () => {
    const a = card({ claim: "42% of agency retainers now include an AI clause." });
    const b = card({ claim: "Cloud storage prices fell 42% since the last generation of drives shipped." });

    expect(dedupeFactCards([a, b]).facts).toHaveLength(2);
  });

  it("drops an identical restatement and names what it was a duplicate of", () => {
    const a = card({ claim: "Onboarding time dropped from 14 days to 7 days after the rollout." });
    const b = card({ claim: "onboarding time dropped from 14 days to 7 days after the rollout" });

    const result = dedupeFactCards([a, b]);

    expect(result.facts.map((f) => f.claim)).toEqual([a.claim]);
    expect(result.dropped).toEqual([{ claim: b.claim, duplicateOf: a.claim, rule: "identical" }]);
  });

  it("prefers the traceable card when neither is primary, and the earlier one when both are equal", () => {
    const untraceable = card({ claim: "Support teams resolved 30% more tickets after the triage change." });
    const traceable = card({
      claim: "After the triage change, support teams resolved 30% more tickets.",
      url: "https://news.example.com/triage",
    });

    expect(dedupeFactCards([untraceable, traceable]).facts[0]!.url).toBe(traceable.url);

    const firstOfTwo = card({ claim: "Revision cycles fell from 5 rounds to 2.", url: "https://a.example.com/1" });
    const secondOfTwo = card({ claim: "Design revision cycles went from 5 rounds down to 2.", url: "https://b.example.com/2" });
    expect(dedupeFactCards([firstOfTwo, secondOfTwo]).facts[0]!.claim).toBe(firstOfTwo.claim);
  });

  it("keeps a replaced card in its original position, so a late primary source does not re-rank the set", () => {
    const lead = card({ claim: "Agencies raised retainers 12% on average this year.", kind: "stat" });
    const weak = card({ claim: "Teams cut 8 hours of manual reporting a month." });
    const strong = card({
      claim: "Manual reporting cost teams 8 hours every month before automation.",
      url: "https://research.example.org/report",
      primary: true,
    });

    const result = dedupeFactCards([lead, weak, strong]);

    expect(result.facts.map((f) => f.claim)).toEqual([lead.claim, strong.claim]);
  });

  it("caps the shipped set at 24 cards and says how many distinct cards the cap removed", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      card({ claim: `Signal ${i}: ${i + 3} percent of surveyed operations leads named topic ${i} their priority.` }),
    );

    const result = dedupeFactCards(many);

    expect(FACT_CARD_CAP).toBe(24);
    expect(result.facts).toHaveLength(24);
    expect(result.dropped).toEqual([]);
    expect(result.truncated).toBe(6);
  });

  it("returns an empty result for an empty input rather than throwing", () => {
    expect(dedupeFactCards([])).toEqual({ facts: [], dropped: [], truncated: 0 });
  });

  it("de-duplicates Hebrew claims too — the normaliser is Unicode-aware, not [a-z0-9]", () => {
    const a = card({ claim: "42% מהצוותים שאיפשרו דיווח אוטומטי חסכו ארבע שעות בשבוע." });
    const b = card({
      claim: "דיווח אוטומטי חסך לצוותים ארבע שעות בשבוע, כך מדווחים 42% מהצוותים שאיפשרו אותו.",
      url: "https://research.example.org/hebrew-report.pdf",
      primary: true,
    });

    const result = dedupeFactCards([a, b]);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.primary).toBe(true);
  });
});

describe("factCardsForPrompt", () => {
  it("caps at 14 cards and puts primary sources first, otherwise keeping extraction order", () => {
    const facts: ResearchFact[] = Array.from({ length: 20 }, (_, i) =>
      card({ claim: `Card ${i}`, ...(i === 17 ? { primary: true } : {}) }),
    );

    const forPrompt = factCardsForPrompt(facts);

    expect(FACT_CARDS_FOR_PROMPT).toBe(14);
    expect(forPrompt).toHaveLength(14);
    expect(forPrompt[0]).toMatchObject({ claim: "Card 17", primary: true });
    expect(forPrompt.slice(1).map((c) => c.claim)).toEqual(Array.from({ length: 13 }, (_, i) => `Card ${i}`));
  });

  it("defaults a card written before @2 to kind 'stat' and omits every empty field", () => {
    const [plain] = factCardsForPrompt([card({ claim: "A claim with no card fields at all." })]);

    // A pre-@2 fact (a ledger row, a fixture) has no `kind` — the consumer
    // defaults it rather than shipping `undefined` into a prompt.
    expect(plain).toEqual({ claim: "A claim with no card fields at all.", kind: "stat", source: "Example Weekly", date: "2026-09-01" });
    expect(Object.keys(plain!)).not.toContain("primary");
    expect(Object.keys(plain!)).not.toContain("url");
  });

  it("carries a quote card's verbatim words and its speaker through", () => {
    const [quote] = factCardsForPrompt([
      card({
        claim: "Acme's CTO says the triage model is only as good as the queue it reads.",
        kind: "quote",
        quote: "The model is only as good as the queue it reads.",
        source: "Dana Levi, CTO, Acme",
        url: "https://news.example.com/interview",
      }),
    ]);

    expect(quote).toMatchObject({ kind: "quote", quote: "The model is only as good as the queue it reads.", source: "Dana Levi, CTO, Acme" });
  });
});

describe("one ordered view for both prompts (the angle proposer and the writer)", () => {
  it("the angle prompt's slice is a prefix of the copy prompt's, so an angle can only rest on a card the writer also has", () => {
    // The divergence this pins: `factCardsForPrompt` re-orders primary-first
    // and keeps 14; `factsForAnglePrompt` keeps the first 14 as given. Fed the
    // RAW deduped set, the two disagreed as soon as a primary card sat past
    // index 13 — and prompt @13 tells the writer that `chosen.restsOn` names
    // cards it must cite verbatim with their source, date and URL, which it
    // cannot do for a card that is not in its own `facts` array.
    const facts: ResearchFact[] = Array.from({ length: 20 }, (_, i) =>
      card({ claim: `Card ${i}`, ...(i === 17 ? { primary: true } : {}) }),
    );

    const promptFacts = factCardsForPrompt(facts);
    // What the workflow does: ONE ordered view, handed to both.
    const anglePrompt = factsForAnglePrompt(promptFacts);
    expect(anglePrompt.map((f) => f.claim)).toEqual(promptFacts.map((c) => c.claim));
    expect(anglePrompt.map((f) => f.claim)).toContain("Card 17");

    // What the two used to see when each sliced the raw set for itself.
    const divergent = factsForAnglePrompt(facts.map((f) => ({ claim: f.claim, kind: f.kind })));
    expect(divergent.map((f) => f.claim)).not.toContain("Card 17");
    expect(divergent.map((f) => f.claim)).not.toEqual(promptFacts.map((c) => c.claim));
  });

  it("the angle prompt never asks for more cards than the copy prompt carries", () => {
    // If these two ever diverge again, `selectAngle`'s eligibility set (the
    // list the proposer saw) stops being a subset of the writer's `facts`.
    expect(ANGLE_FACTS_IN_PROMPT).toBeLessThanOrEqual(FACT_CARDS_FOR_PROMPT);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Headline fact cards — the `04b` fallback (RFC-19 §4 item 17, Phase 6)
// ─────────────────────────────────────────────────────────────────────────

const RUN_DATE = "2026-09-13";

/** Three real-looking fetched documents, on three different hosts. */
function threeDocuments(): ResearchCandidateDocument[] {
  return [
    {
      title: "Agencies report 30% of retainers lose money by month three",
      url: "https://www.marketingbrew.com/stories/retainer-margins",
      content: "  A survey of 240 agencies found   that scope drift, not pricing, is what turns a profitable retainer negative.  ",
      publishedAt: "2026-09-09",
    },
    {
      title: "Ops teams cut status meetings by a third after automating weekly reporting",
      url: "https://news.example.com/ops/status-meetings",
      content: "The teams that automated first reported the largest drop.",
    },
    {
      title: "Onboarding checklists are back, and this time they are generated",
      url: "https://research.example.org/onboarding-2026.pdf",
      content: "A review of 1,200 onboarding flows shipped in 2026.",
      publishedAt: "2026-08-02T00:00:00.000Z",
    },
  ];
}

describe("headlineFactCards: what `04b` ships when the extractor's own output did not parse", () => {
  it("builds one card per fetched document — the title VERBATIM, the document's own URL, the host as the attribution", () => {
    const cards = headlineFactCards(threeDocuments(), RUN_DATE);

    expect(cards.facts).toHaveLength(3);
    expect(cards.documentsConsidered).toBe(3);
    expect(cards.skipped).toEqual([]);
    expect(cards.truncated).toBe(0);

    // Word for word: `checkSlidesData` matches a slide's `sourceRef` against
    // `claim` CHARACTER FOR CHARACTER, so a claim that was summarised,
    // truncated or re-worded is a claim no slide can cite.
    expect(cards.facts.map((f) => f.claim)).toEqual(threeDocuments().map((d) => d.title));
    expect(cards.facts.map((f) => f.url)).toEqual(threeDocuments().map((d) => d.url));
    expect(cards.facts.map((f) => f.source)).toEqual(["marketingbrew.com", "news.example.com", "research.example.org"]);

    // A headline reports that something happened. It is not the study behind
    // it, and it carries no extracted figure.
    expect(cards.facts.every((f) => f.kind === "event")).toBe(true);
    expect(cards.facts.every((f) => f.primary === false)).toBe(true);

    // `publishedAt` when the document has one, the run's own date when it does
    // not — never today's clock, so a resumed step rebuilds the same set.
    expect(cards.facts.map((f) => f.date)).toEqual(["2026-09-09", RUN_DATE, "2026-08-02T00:00:00.000Z"]);

    // The quote is the publication's own words, whitespace-collapsed.
    expect(cards.facts[0]!.quote).toBe("A survey of 240 agencies found that scope drift, not pricing, is what turns a profitable retainer negative.");
  });

  it("collapses a scraped title's line breaks and changes nothing else about it", () => {
    // The only edit a claim ever gets, and the reason it gets it: a scraped
    // `<title>` arrives with the source file's newlines and indentation in it,
    // and a claim carrying a line break is a claim no `sourceRef` can match.
    const messy = "Agencies report 30%\n   of retainers lose money\tby month three  ";
    const [card] = headlineFactCards([{ title: messy, url: "https://a.test/1" }], RUN_DATE).facts;

    expect(card!.claim).toBe("Agencies report 30% of retainers lose money by month three");
    // Same words, same order, same punctuation, same length in words.
    expect(card!.claim.split(" ")).toEqual(messy.split(/\s+/u).filter((w) => w.length > 0));
  });

  it("is deterministic: the same documents and the same run date rebuild the identical set", () => {
    expect(headlineFactCards(threeDocuments(), RUN_DATE)).toEqual(headlineFactCards(threeDocuments(), RUN_DATE));
    // And the run date is genuinely what dates an undated document — this is
    // the reason it is a parameter rather than `new Date()`.
    expect(headlineFactCards(threeDocuments(), "1999-01-01").facts[1]!.date).toBe("1999-01-01");
  });

  it("caps a quote at the schema's own 240 characters and omits the key entirely when there is no body text", () => {
    const long = "x".repeat(400);
    const [quoted, unquoted] = headlineFactCards(
      [
        { title: "A long one", url: "https://a.test/1", content: long },
        { title: "A bare one", url: "https://b.test/2" },
      ],
      RUN_DATE,
    ).facts;

    expect(HEADLINE_FALLBACK_QUOTE_CHARS).toBe(240);
    expect(quoted!.quote).toHaveLength(240);
    // "No body text" and "a body that said nothing" are different claims; an
    // empty string would read as the second.
    expect(unquoted!.quote).toBeUndefined();
    expect(Object.keys(unquoted!)).not.toContain("quote");
  });

  it("prefers the provider's `description` over the page body, because it is the publication's own summary", () => {
    // `description` is not on `ResearchCandidateDocument` — the shared type
    // declares five fields — but `research.pull`'s real payload carries it,
    // which is why it is read by hand.
    const withDescription = { title: "T", url: "https://a.test/1", description: "The publication's own summary.", content: "Skip to main content. Menu. Subscribe." };
    expect(headlineFactCards([withDescription as ResearchCandidateDocument], RUN_DATE).facts[0]!.quote).toBe("The publication's own summary.");
  });

  it("NEVER invents an attribution: a titled document with no host and no author is recorded and dropped", () => {
    // `source` is what gets PRINTED on a slide. This is the half of the
    // fallback that keeps `zero-held-guarantee.test.ts`'s reasoning intact —
    // "shipping unsourced copy is worse than shipping nothing" survives here
    // precisely because every card that DOES ship names a real publication.
    const cards = headlineFactCards(
      [
        { title: "Nobody stands behind this one", content: "words" },
        { title: "This one has a byline", content: "words", author: "Dana Levi" },
      ],
      RUN_DATE,
    );

    expect(cards.facts).toHaveLength(1);
    expect(cards.facts[0]).toMatchObject({ claim: "This one has a byline", source: "Dana Levi" });
    expect(cards.facts[0]!.url).toBeUndefined();
    expect(cards.skipped).toEqual([{ title: "Nobody stands behind this one", reason: "no URL host and no author, so there is nothing to attribute the headline to" }]);
  });

  it("records an untitled document rather than dropping it silently — a thin base must not look like a thin week", () => {
    const cards = headlineFactCards([{ url: "https://a.test/1", content: "body" }, ...threeDocuments()], RUN_DATE);
    expect(cards.facts).toHaveLength(3);
    expect(cards.documentsConsidered).toBe(4);
    expect(cards.skipped).toEqual([{ title: "", reason: "the document has no title to quote as a claim" }]);
  });

  it("caps the set at the schema's own 30-card ceiling and says how many it left out", () => {
    const many = Array.from({ length: 34 }, (_, i) => ({ title: `Headline number ${i}`, url: `https://a.test/${i}`, content: "body" }));
    const cards = headlineFactCards(many, RUN_DATE);

    expect(HEADLINE_FALLBACK_CARD_CAP).toBe(30);
    expect(cards.facts).toHaveLength(30);
    expect(cards.truncated).toBe(4);
    // The ceiling is not decorative: a 34-card set fails the very schema this
    // fallback exists to satisfy, which would turn one quality event into two.
    expect(() => ResearchOutputSchema.parse({ topic: "t", facts: many.map((d) => ({ claim: d.title, source: "a.test", date: RUN_DATE })), rawPayloadRef: "r" })).toThrow();
  });
});

describe("headlineFallbackResearch: a schema-valid research output, or nothing at all", () => {
  const REASON = "research extraction did not produce output that cleared its own schema";

  it("parses against `ResearchOutputSchema` — it is a drop-in for the extraction agent's own output", () => {
    const fallback = headlineFallbackResearch(threeDocuments(), RUN_DATE, { topic: "agency retainers", rawPayloadRef: "run-1+run-2", reason: REASON })!;

    expect(fallback).toBeDefined();
    const parsed = ResearchOutputSchema.parse(fallback.output);
    expect(parsed.topic).toBe("agency retainers");
    expect(parsed.rawPayloadRef).toBe("run-1+run-2");
    expect(parsed.facts).toHaveLength(3);
    expect(parsed.facts.every((f) => f.kind === "event" && f.primary === false)).toBe(true);

    // The marker the deliverable carries: the status a reviewer reads, and the
    // extractor's failure in the workflow's own words, carried verbatim.
    expect(fallback.research.status).toBe("headline-fallback");
    expect(fallback.research.reason).toContain(REASON);
    expect(fallback.research.reason).toContain("3 fetched headline(s) out of 3 document(s)");
  });

  it("returns undefined — not an empty set — when no document can be named, which is the caller's hold", () => {
    // `ResearchOutputSchema.facts` is `.min(1)`: "no cards" is not a research
    // output at all and must not be constructible as one. This is the one exit
    // RFC-19 §6 item 6 KEEPS: research found no readable source.
    const blanked = threeDocuments().map((d) => ({ ...d, title: "   " }));
    expect(headlineFallbackResearch(blanked, RUN_DATE, { topic: "t", rawPayloadRef: "r", reason: REASON })).toBeUndefined();
    expect(headlineFallbackResearch([], RUN_DATE, { topic: "t", rawPayloadRef: "r", reason: REASON })).toBeUndefined();
    // The premise: blanking the titles is what did it, not the fixture being
    // empty of documents.
    expect(headlineFactCards(blanked, RUN_DATE).documentsConsidered).toBe(3);
  });

  it("says so when the ceiling removed documents, so a reviewer is not told 30 is the whole week", () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ title: `Headline number ${i}`, url: `https://a.test/${i}` }));
    const fallback = headlineFallbackResearch(many, RUN_DATE, { topic: "t", rawPayloadRef: "r", reason: REASON })!;
    expect(fallback.research.reason).toContain("3 past the 30-card ceiling");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The same thing through the real workflow: `04b` content_fail
//
// **THIS BLOCK DEPENDS ON P1** (RFC-19 Part 3, sequencing tier 1). The
// workflow file is P1's outright, and the two lines it must change are named
// in the failure messages below. Until they land, `04b`'s own
// `throw new WorkflowHeld(...)` fires first and both cases hold on the old
// wording — which is exactly the hold RFC-19 §4 item 17 deletes.
// ─────────────────────────────────────────────────────────────────────────

const FIXTURE_HEADLINES = [
  "Agencies report 30% of retainers lose money by month three",
  "Ops teams cut status meetings by a third after automating weekly reporting",
  "Onboarding checklists are back, and this time they are generated",
] as const;

const FIXTURE_URLS = [
  "https://www.marketingbrew.com/stories/retainer-margins",
  "https://news.example.com/ops/status-meetings",
  "https://research.example.org/onboarding-2026.pdf",
] as const;

/**
 * A scraper that answers every query with the SAME three documents.
 *
 * Same URLs on every query, so `mergeResearchPulls` de-duplicates them back
 * down to three however many lane queries run — which is what makes "three
 * titled documents ship three cards" a statement about the fallback rather
 * than about how many questions the lanes asked.
 */
/**
 * `pageTitle` controls what `04a3`'s FULL-TEXT READ of a primary source is labelled, and it is a separate
 * knob from `titles` on purpose.
 *
 * `pickPrimarySourceUrls` draws its URLs out of the merged set, so one of these three publications appears
 * TWICE in the list `headlineFactCards` reads: once as the search result that found it, once as the fetched
 * page derived from it. The two records can disagree about the headline, and which one wins is the whole
 * content of the dedupe rule — so a fixture that cannot set them independently cannot test it.
 *
 * - `"offline"` (the default) keeps `createOfflineScraper`'s `extractUrl`, which carries a title: a stand-in
 *   for the real `<title>` that `research.fetchPages` returns for most real pages.
 * - `"none"` makes `extractUrl` return a record with NO title, so `04a3`'s `title: p.title ?? p.url` falls
 *   through to the bare URL — the fetcher's filler, and the one label `headlineFactCards` refuses outright.
 *
 * `extractUrl` and not `fetchRaw`: `research.fetchPages` reads a page through `scraper.extractUrl`
 * (`packages/tools/karos-research/src/fetch-pages.ts`), and overriding the wrong one is a fixture that
 * quietly does nothing.
 */
function threeDocumentScraper(titles: readonly string[], pageTitle: "offline" | "none" = "offline"): ScraperProvider {
  const offline = createOfflineScraper();
  const records = (): ScrapedRecord[] =>
    titles.map((title, i) => ({
      id: `fixture:${i}`,
      url: FIXTURE_URLS[i]!,
      title,
      text: `Body text for document ${i + 1}. A survey of 240 teams is summarised here.`,
      publishedAt: "2026-09-09T00:00:00.000Z",
      capability: "search_web",
    }));
  return {
    ...offline,
    name: "three-document-fixture",
    async searchKeyword(): Promise<ScrapedRecord[]> {
      return records();
    },
    ...(pageTitle === "none"
      ? {
          async extractUrl(url: string): Promise<ScrapedRecord | undefined> {
            const base = await offline.extractUrl(url);
            if (base === undefined) return undefined;
            const { title: _dropped, ...withoutTitle } = base;
            return { ...withoutTitle, url };
          },
        }
      : {}),
  };
}

/** The extraction agent's answer, valid JSON and invalid against `ResearchOutputSchema` — `BaseAgent.validateAndFinish` returns `content_fail`. */
const MALFORMED_EXTRACTION = { topic: "agency retainers", facts: [], rawPayloadRef: "" };

/** `goodCopyOutput()` with every slide citing one of the three headlines, so `checkSlidesData`'s verbatim `sourceRef` trace passes on its own merit. */
function copyCitingHeadlines(): ReturnType<typeof goodCopyOutput> {
  const base = goodCopyOutput();
  return { ...base, slides: base.slides.map((slide, i) => ({ ...slide, sourceRef: FIXTURE_HEADLINES[i % FIXTURE_HEADLINES.length]! })) };
}

describe("04b-research-extract-facts: a malformed extraction ships headline cards (RFC-19 §4 item 17)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  async function runWith(
    runId: string,
    titles: readonly string[],
    research: unknown = MALFORMED_EXTRACTION,
    pageTitle: "offline" | "none" = "offline",
    /**
     * Replaces the single `04b` turn with N UNREADABLE ones — a turn whose output carries no
     * `type: "final"` discriminator, the `opus-drops-type-discriminator` shape. `BaseAgent`'s
     * `maxMalformedTurns: 1` retries the first and returns `tooling_error` on the second, so TWO of these is
     * the cheapest way to buy a real `tooling_error` rather than the one-turn `content_fail` that
     * `MALFORMED_EXTRACTION` (well-formed JSON, invalid against the schema) produces.
     */
    unreadableResearchTurns = 0,
  ) {
    env = await setupTestEnvironment({ seedTopics: [], scraper: threeDocumentScraper(titles, pageTitle) });
    await env.store.writeJson("acme", ["client", "config"], { instagramStyleConfig: goodStyleConfig(), instagramBrandTokens: goodBrandTokens() });
    await env.store.writeJson("acme", ["client", "profile"], { name: "Acme", industry: "B2B SaaS", description: "Acme sells an operations reporting platform to B2B software teams." });

    const turns = happyTurns({ research, copy: copyCitingHeadlines() });
    if (unreadableResearchTurns > 0) {
      // Position 1 in `happyTurns`' order (scout, research, angle, …) — spliced rather than appended,
      // because every turn after it is consumed positionally.
      const unreadable = () => ({
        output: { output: { anything: "a turn with no `type` discriminator" } } as never,
        modelUsed: "claude-sonnet-4-6",
        inputTokens: { cached: 0, uncached: 100 },
        outputTokens: 30,
      });
      turns.splice(1, 1, ...Array.from({ length: unreadableResearchTurns }, () => unreadable));
    }
    const router = fakeRouterSequence(turns);
    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      autoApprove: true,
      imageCandidatePool: goodImageCandidatePool(),
    });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const });
    const steps = await durableStore.listSteps(runId);
    return { result, steps, stepIds: steps.map((s) => s.stepId) };
  }

  it("a carousel drafts, renders and delivers from headline cards alone — the half of the fallback that owes nothing to P1", async () => {
    // The fallback's own output, fed through the extraction turn as if the
    // model had produced it. It proves the thing the two cases below cannot
    // prove while P1's call site is missing: that a research set of three
    // headline cards is DRAFTABLE — it clears `checkSlidesData`'s verbatim
    // `sourceRef` trace, the value signals, the render rules and the QA judge,
    // and a deliverable lands. If this ever goes red, the fallback's SHAPE is
    // wrong and the two cases below would be waiting on a wiring change that
    // could never have worked.
    const documents = FIXTURE_HEADLINES.map((title, i) => ({
      title,
      url: FIXTURE_URLS[i]!,
      content: `Body text for document ${i + 1}. A survey of 240 teams is summarised here.`,
      publishedAt: "2026-09-09T00:00:00.000Z",
    }));
    const fallback = headlineFallbackResearch(documents, RUN_DATE, {
      topic: "agency retainers",
      rawPayloadRef: "fixture-pull",
      reason: "research extraction did not produce output that cleared its own schema",
    })!;

    const { result, steps } = await runWith("ig_headline_cards_draftable", FIXTURE_HEADLINES, fallback.output);

    expect(steps.find((s) => s.stepId === "04b-research-extract-facts")?.status).toBe("completed");
    expect(result.status).toBe("completed");
    const deduped = steps.find((s) => s.stepId === "04b2-dedupe-fact-cards")?.output as { facts: ResearchFact[] } | undefined;
    expect(deduped?.facts.map((f) => f.claim)).toEqual([...FIXTURE_HEADLINES]);
    expect(await env.store.listJson("acme", ["ledger", "deliverables", "ig_headline_cards_draftable", "_"])).toHaveLength(1);
  }, 120000);

  it("three titled documents become three cards, claimed verbatim and cited to their own URLs, and the run DELIVERS", async () => {
    const { result, steps } = await runWith("ig_headline_fallback", FIXTURE_HEADLINES);

    // The premise, asserted rather than assumed: the extraction really did
    // refuse. Without this the case would pass if `04b` had quietly started
    // succeeding, and the fallback would never have been exercised at all.
    const extraction = steps.find((s) => s.stepId === "04b-research-extract-facts");
    expect(extraction?.status).toBe("content_fail");

    expect(result.status, "NEEDED FROM create-instagram-agent-workflow.ts (P1): call headlineFallbackResearch at WF:3753 instead of throwing").toBe("completed");

    const deduped = steps.find((s) => s.stepId === "04b2-dedupe-fact-cards")?.output as { facts: ResearchFact[] } | undefined;
    // THREE, not four. `04a3` fetches the research.example.org PDF in full because
    // `pickPrimarySourceUrls` picks it, so that source reaches `04b` twice — once as the
    // search result carrying its real headline, once as the full-text read whose "title"
    // is `p.title ?? p.url`, i.e. the fetcher's filler. One publication, one card.
    expect(deduped?.facts).toHaveLength(3);
    // CLAIMED VERBATIM AND CITED TO THEIR OWN URLS — asserted as the claim→url PAIRING
    // rather than as two positional lists, because the pairing is the thing that must hold
    // and the ORDER legitimately is not the fixture's. `orderDocumentsPrimaryFirst` promotes
    // the primary-looking source ahead of the other two before the extractor ever sees the
    // list, and the fallback reads that same ordered list on purpose (so the cards it builds
    // are the documents the extractor was asked about). Pinning fixture order here would be
    // pinning the absence of a re-ordering nobody promised.
    expect(new Map(deduped?.facts.map((f) => [f.claim, f.url]))).toEqual(
      new Map(FIXTURE_HEADLINES.map((headline, i) => [headline, FIXTURE_URLS[i]!])),
    );
    expect(deduped?.facts.every((f) => f.kind === "event")).toBe(true);

    // And the client gets the post, with the truth attached: a carousel that
    // rests on headlines says so, twice.
    //
    // `listJson` returns the LEDGER ROW — `{ id, data }` — and the marker rides the
    // DELIVERABLE inside it, at `data.deliverable.research`, beside `selfCheck`. Reading
    // `row.research` finds `undefined` on a run that carried the marker perfectly well,
    // which is a guard that cannot fail in the other direction: it would have gone green
    // the day the marker stopped being written.
    const deliverables = await env.store.listJson<{ deliverable?: { research?: { status?: string; reason?: string } } }>(
      "acme",
      ["ledger", "deliverables", "ig_headline_fallback", "_"],
    );
    expect(deliverables.map((d) => d.id)).toEqual(["instagram-carousel"]);
    const research = deliverables[0]!.data.deliverable?.research;
    expect(research?.status).toBe("headline-fallback");
    expect(research?.reason).toMatch(/did not produce output that cleared its own schema/);
  }, 120000);

  it("a `tooling_error` at 04b DELIVERS on headlines too — two dropped `type` discriminators are a quality event, not a fault", async () => {
    // THE BLOCKER THIS FIXTURE EXISTS FOR. `AgentExecutionStatusSchema` has four members and `04b` used to
    // throw `WorkflowToolingFailure` on two of them — `tooling_error` and `budget_exceeded` — twenty-two
    // lines above a $0 fallback that already held every fetched document. Neither is a tooling fault:
    // `tooling_error` at an agent step is `loop.malformedTurns > maxMalformedTurns` (`base-agent.ts`,
    // `maxMalformedTurns: 1`), i.e. exactly two dropped `type` discriminators — the same
    // `opus-drops-type-discriminator` family that step `05` has converted since RFC-19 §4 item 13.
    //
    // THE PREMISE, asserted rather than assumed: the step really did resolve to `tooling_error`, not to the
    // `content_fail` the sibling cases buy. Without that line a fixture that silently fell back to
    // `content_fail` would go green while proving nothing about this branch.
    const { result, steps } = await runWith("ig_headline_fallback_tooling", FIXTURE_HEADLINES, MALFORMED_EXTRACTION, "offline", 2);

    expect(steps.find((s) => s.stepId === "04b-research-extract-facts")?.status).toBe("tooling_error");
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson<{ deliverable?: { research?: { status?: string; reason?: string } } }>(
      "acme",
      ["ledger", "deliverables", "ig_headline_fallback_tooling", "_"],
    );
    expect(deliverables).toHaveLength(1);
    const research = deliverables[0]!.data.deliverable?.research;
    expect(research?.status).toBe("headline-fallback");
    // Degraded AND honest, in step `05`'s own vocabulary for the identical union, so a reviewer reading
    // either surface reads one sentence rather than two dialects of one.
    expect(research?.reason).toMatch(/could not produce a turn this run could read \(a malformed model turn\)/);
  }, 120000);

  it("a blank search-result title does NOT kill the source: the fetched page's own <title> cards it and the run DELIVERS", async () => {
    // The dedupe defect this pins, stated as the run it broke. `pickPrimarySourceUrls` picks its URLs OUT OF
    // the merged set, so every fetched page's URL is in `headlineFactCards`' list twice by construction.
    // While the URL key was burned by the FIRST record that named it — card or no card — a search result
    // with a thin title locked out the 8000-character full-text read of the same page, and the full-text
    // reads became structurally unable to ever contribute a card. On a provider whose titles are thin that
    // turned a quality event into `NO_READABLE_SOURCE`: a HOLD, for a reason that is not the carve-out's.
    //
    // Here the search provider returns three blank titles and the fetcher returns a real page title for the
    // one primary-looking URL. There IS a readable source, so there is nothing to hold about.
    const { result, steps } = await runWith("ig_headline_fallback_page_title", ["", "   ", ""]);

    expect(steps.find((s) => s.stepId === "04b-research-extract-facts")?.status).toBe("content_fail");
    expect(result.status).toBe("completed");
    const deliverables = await env.store.listJson<{ deliverable?: { research?: { status?: string } } }>(
      "acme",
      ["ledger", "deliverables", "ig_headline_fallback_page_title", "_"],
    );
    expect(deliverables).toHaveLength(1);
    // Degraded, and saying so — the client gets a post AND the truth about what it rests on.
    expect(deliverables[0]!.data.deliverable?.research?.status).toBe("headline-fallback");
    // The card came from the FETCHED page, which is the record whose title was not blank.
    const cards = steps.find((s) => s.stepId === "04b1-headline-fact-cards")?.output as
      | { output?: { facts?: Array<{ claim: string }> } }
      | undefined;
    expect(cards?.output?.facts?.length).toBeGreaterThan(0);
    expect(cards?.output?.facts?.every((f) => f.claim.trim().length > 0)).toBe(true);
  }, 120000);

  it("every title blanked AND the fetcher carrying none either HOLDS — research found no readable source, and that hold is KEPT", async () => {
    // THE CARVE-OUT, and now it is actually the carve-out. Blanking only the search-result titles left the
    // fetched page's own `<title>` in play, so this fixture used to assert a hold that the fetched page
    // could have answered — the hold was the dedupe defect, wearing the carve-out's clothes. With
    // `pageTitle: "none"` the fetched page is labelled `title: p.title ?? p.url` = the bare URL, which
    // `headlineFactCards` refuses as the fetcher's filler rather than claiming a URL on a slide as a fact.
    // Now NOTHING anywhere carries a headline, which is the genuine "no output exists at all".
    const { result, steps } = await runWith("ig_headline_fallback_untitled", ["", "   ", ""], MALFORMED_EXTRACTION, "none");

    expect(steps.find((s) => s.stepId === "04b-research-extract-facts")?.status).toBe("content_fail");
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason, "NEEDED FROM create-instagram-agent-workflow.ts (P1): hold with NO_READABLE_SOURCE when no document has a title").toMatch(/no readable source/);
    // Nothing was delivered, and nothing claimed to be: the honest half.
    expect(await env.store.listJson("acme", ["ledger", "deliverables", "ig_headline_fallback_untitled", "_"])).toHaveLength(0);
  }, 120000);
});
