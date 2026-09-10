import { describe, expect, it } from "vitest";
import { similarity } from "@agent-engine/core";
import {
  DUPLICATE_CLAIM_SIMILARITY,
  FACT_CARD_CAP,
  FACT_CARDS_FOR_PROMPT,
  claimFigures,
  dedupeFactCards,
  factCardsForPrompt,
  normalizeClaim,
} from "../src/workflow/fact-cards.js";
import { ANGLE_FACTS_IN_PROMPT, factsForAnglePrompt } from "../src/workflow/angle-selection.js";
import type { ResearchFact } from "../src/workflow/types.js";

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
