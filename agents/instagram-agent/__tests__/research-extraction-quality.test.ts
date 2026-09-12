import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentContext, BaseAgentRuntime } from "@agent-engine/core";
import type { ResearchCandidateDocument } from "@agent-engine/workflow";
import { InstagramResearchAgent } from "../src/agent/instagram-research-agent.js";
import { ResearchOutputSchema, type ResearchFact } from "../src/workflow/types.js";
import { dedupeFactCards, factCardsForPrompt } from "../src/workflow/fact-cards.js";
import { orderDocumentsPrimaryFirst } from "../src/workflow/research-lanes.js";
import { fakeRouterSequence, finalTurn, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";

/**
 * THE EXTRACTION QUALITY FLOOR (RFC-13 §J).
 *
 * `instagram-research` runs on Gemini 2.5 Flash: ≈ $0.014 per run against
 * ≈ $0.11 on Sonnet, on a $1.00-per-run target. That choice is only defensible
 * while Flash actually clears the bar the deep-research lanes were built to
 * feed, so the bar lives here rather than in a comment:
 *
 *   from a 12-document payload — at least 10 cards, at least 3 kinds, no
 *   duplicates left after `dedupeFactCards`, and a URL on every card whose
 *   document had one.
 *
 * The turn below is a stand-in shaped the way a competent extraction reads
 * this payload, so what the test pins is the CONTRACT (schema, dedupe, the
 * floor function) rather than a model's mood. When a prep sample fails
 * `assertExtractionQuality`, that is the signal to move this step to Sonnet —
 * and this test is where the replacement sample goes.
 */

const CTX: AgentContext = { runId: "run_extract", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

/**
 * Twelve documents shaped like a real merged pull: two primary sources (a PDF
 * report and the client's own page) first, then coverage of them, then
 * unrelated field news. One document deliberately has no URL (a client
 * knowledge asset) and one deliberately has no body (a PDF whose text did not
 * extract) — both are cases the prompt has an explicit rule for.
 */
const DOCUMENTS: Array<ResearchCandidateDocument & { primary?: boolean }> = [
  {
    title: "State of Operations Reporting 2026",
    url: "https://research.example.org/state-of-ops-2026.pdf",
    content: "Of the 1,240 operations leads surveyed, 42% of teams that automated weekly reporting saved four hours a week. Median time-to-first-report fell from 9 days to 3.",
    publishedAt: "2026-08-14T00:00:00.000Z",
    primary: true,
  },
  {
    title: "Karos Labs — pricing",
    url: "https://karoslabs.com/pricing",
    content: "The Starter plan covers one channel and four posts a month at $490. First-time buyers get the first month at half price until the end of Q4.",
    publishedAt: "2026-09-01T00:00:00.000Z",
    primary: true,
  },
  {
    title: "Internal onboarding cohort analysis",
    content: "Clients who onboarded with the new checklist reached first value 2 days faster than the previous cohort.",
    primary: true,
  },
  {
    title: "Benchmark: automation gave ops teams back half a day",
    url: "https://news.example.com/ops-benchmark-coverage",
    content: "A new benchmark reports that weekly reporting automation gave teams back four hours, with 42% of them reporting the gain.",
    publishedAt: "2026-08-15T00:00:00.000Z",
  },
  {
    title: "Vendor ships AI triage on every support plan",
    url: "https://news.example.com/vendor-ai-triage",
    content: "The vendor announced on 8 September 2026 that AI triage is now included on all plans, replacing the paid add-on.",
    publishedAt: "2026-09-08T00:00:00.000Z",
  },
  {
    title: "Interview: the queue is the model's real input",
    url: "https://news.example.com/triage-interview",
    content: '"The model is only as good as the queue it reads," said Dana Levi, CTO at Acme, on the vendor announcement.',
    publishedAt: "2026-09-09T00:00:00.000Z",
  },
  {
    title: "What 'time to first value' actually measures",
    url: "https://docs.example.com/glossary/ttfv",
    content: "Time to first value is the interval between a customer signing and the first outcome they would have paid for on its own.",
  },
  {
    title: "Agency retainer survey 2026",
    url: "https://research.example.org/retainer-survey-2026",
    content: "Agencies raised retainers 12% on average this year; 31% now include an explicit AI clause.",
    publishedAt: "2026-07-02T00:00:00.000Z",
    primary: true,
  },
  {
    title: "Retainers are up, says survey",
    url: "https://news.example.com/retainers-up",
    content: "Retainers rose about 12% across the surveyed agencies this year, according to the survey.",
    publishedAt: "2026-07-04T00:00:00.000Z",
  },
  {
    title: "Ops tooling roundup, September",
    url: "https://news.example.com/ops-roundup-september",
    content: "Three reporting tools shipped scheduled digests this month; two of them are priced per seat at $12.",
    publishedAt: "2026-09-05T00:00:00.000Z",
  },
  {
    title: "Q3 operations webinar, 24 September",
    url: "https://events.example.com/ops-webinar-q3",
    content: "The quarterly operations webinar runs on 24 September 2026 and covers reporting automation rollouts.",
    publishedAt: "2026-09-02T00:00:00.000Z",
  },
  {
    // A PDF whose text did not extract. The prompt's rule is to say so rather
    // than guess what the report probably said, so no card cites this.
    title: "Sector outlook 2027 (PDF)",
    url: "https://research.example.org/sector-outlook-2027.pdf",
    publishedAt: "2026-09-06T00:00:00.000Z",
  },
];

/** The extraction output a competent read of `DOCUMENTS` produces: 14 cards over four kinds, two of them restatements the dedupe step must collapse. */
function extractionTurnOutput() {
  const facts: ResearchFact[] = [
    {
      claim: "42% of teams that automated weekly reporting saved four hours a week.",
      kind: "stat",
      source: "State of Operations Reporting 2026",
      url: "https://research.example.org/state-of-ops-2026.pdf",
      date: "2026-08-14",
      primary: true,
    },
    {
      claim: "Median time to first report fell from 9 days to 3 across 1,240 surveyed operations leads.",
      kind: "stat",
      source: "State of Operations Reporting 2026",
      url: "https://research.example.org/state-of-ops-2026.pdf",
      date: "2026-08-14",
      primary: true,
    },
    // A restatement of the first card, from coverage: the dedupe step keeps
    // the report's own wording and drops this.
    {
      claim: "Weekly reporting automation gave teams back four hours, with 42% of them reporting the gain.",
      kind: "stat",
      source: "Example News",
      url: "https://news.example.com/ops-benchmark-coverage",
      date: "2026-08-15",
    },
    {
      claim: "Karos Labs' Starter plan covers one channel and four posts a month at $490.",
      kind: "stat",
      source: "Karos Labs pricing page",
      url: "https://karoslabs.com/pricing",
      date: "2026-09-01",
      primary: true,
    },
    {
      claim: "First-time buyers get their first month of Starter at half price until the end of Q4.",
      kind: "event",
      source: "Karos Labs pricing page",
      url: "https://karoslabs.com/pricing",
      date: "2026-09-01",
      primary: true,
    },
    {
      claim: "Clients who onboarded with the new checklist reached first value 2 days faster than the previous cohort.",
      kind: "stat",
      source: "Internal onboarding cohort analysis",
      date: "~2026-09-10",
      primary: true,
    },
    {
      claim: "A major support vendor included AI triage on every plan on 8 September 2026, replacing the paid add-on.",
      kind: "event",
      source: "Example News",
      url: "https://news.example.com/vendor-ai-triage",
      date: "2026-09-08",
    },
    {
      claim: "Acme's CTO says the triage model is only as good as the queue it reads.",
      kind: "quote",
      quote: "The model is only as good as the queue it reads.",
      source: "Dana Levi, CTO, Acme",
      url: "https://news.example.com/triage-interview",
      date: "2026-09-09",
    },
    {
      claim: "Time to first value is the interval between a customer signing and the first outcome they would have paid for on its own.",
      kind: "definition",
      source: "Example Docs glossary",
      url: "https://docs.example.com/glossary/ttfv",
      date: "~2026-09-10",
    },
    {
      claim: "Agencies raised retainers 12% on average this year.",
      kind: "stat",
      source: "Agency retainer survey 2026",
      url: "https://research.example.org/retainer-survey-2026",
      date: "2026-07-02",
      primary: true,
    },
    // Coverage of the retainer survey — the same figure, so it goes.
    {
      claim: "Retainers rose about 12% across the surveyed agencies this year.",
      kind: "stat",
      source: "Example News",
      url: "https://news.example.com/retainers-up",
      date: "2026-07-04",
    },
    {
      claim: "31% of agency retainers now include an explicit AI clause.",
      kind: "stat",
      source: "Agency retainer survey 2026",
      url: "https://research.example.org/retainer-survey-2026",
      date: "2026-07-02",
      primary: true,
    },
    {
      claim: "Two of the three reporting tools that shipped scheduled digests this month are priced at $12 per seat.",
      kind: "stat",
      source: "Example News",
      url: "https://news.example.com/ops-roundup-september",
      date: "2026-09-05",
    },
    {
      claim: "The quarterly operations webinar runs on 24 September 2026 and covers reporting automation rollouts.",
      kind: "event",
      source: "Example Events",
      url: "https://events.example.com/ops-webinar-q3",
      date: "2026-09-02",
    },
  ];
  return { topic: "what changed in operations reporting this quarter", facts, rawPayloadRef: "run-deep-1" };
}

/** The floor itself, as an assertion a prep sample can be dropped into. */
function assertExtractionQuality(facts: readonly ResearchFact[], documents: readonly ResearchCandidateDocument[]): void {
  const { facts: cards, dropped } = dedupeFactCards(facts);

  expect(cards.length).toBeGreaterThanOrEqual(10);
  expect(new Set(cards.map((c) => c.kind ?? "stat")).size).toBeGreaterThanOrEqual(3);

  // Nothing left to drop: running the deduper over its own output is a
  // no-op, which is the only honest way to say "no duplicates remain".
  expect(dedupeFactCards(cards).dropped).toEqual([]);
  expect(dropped.length).toBeGreaterThan(0);

  // Every card is traceable to a document that was actually in the payload,
  // and carries that document's URL whenever it had one.
  const urls = new Set(documents.map((d) => d.url).filter((u): u is string => typeof u === "string"));
  const titles = documents.map((d) => (d.title ?? "").toLowerCase());
  for (const card of cards) {
    if (card.url !== undefined) {
      expect(urls).toContain(card.url);
      continue;
    }
    // No URL is allowed only when the document it came from had none.
    const source = card.source.toLowerCase();
    expect(titles.some((title) => title.length > 0 && (title.includes(source) || source.includes(title)))).toBe(true);
  }
  for (const card of cards) {
    if (card.kind === "quote") expect(typeof card.quote).toBe("string");
    if (card.kind === "event") expect(card.date.length).toBeGreaterThan(0);
  }
}

describe("instagram-research@2 — the extraction quality floor", () => {
  it("clears the floor on a canned 12-document payload: >= 10 cards, >= 3 kinds, no duplicates left, URLs preserved", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(extractionTurnOutput())]);
    const agent = new InstagramResearchAgent({ router, tools: {}, promptStore } satisfies BaseAgentRuntime);

    const documents = orderDocumentsPrimaryFirst(DOCUMENTS, "karoslabs.com");
    const execution = await agent.run(CTX, {
      topic: "what changed in operations reporting this quarter",
      documents,
      clientDocuments: [],
      clientBrief: "Client brief (confidence low). What we sell: a managed AI content engine.",
      rawPayloadRef: "run-deep-1",
    });

    expect(execution.status).toBe("completed");
    const output = ResearchOutputSchema.parse(execution.finalOutput);
    expect(output.facts).toHaveLength(14);
    assertExtractionQuality(output.facts, DOCUMENTS);
  });

  it("hands the writer 14 primary-first cards out of the deduped set", () => {
    const { facts } = dedupeFactCards(ResearchOutputSchema.parse(extractionTurnOutput()).facts);
    const forPrompt = factCardsForPrompt(facts);

    expect(forPrompt.length).toBeLessThanOrEqual(14);
    // The study, not the article about the study, is what the model reads first.
    expect(forPrompt[0]!.primary).toBe(true);
    expect(forPrompt.filter((c) => c.primary === true).length).toBeGreaterThanOrEqual(5);
  });

  it("rejects an over-long extraction rather than letting it become the copy prompt's whole context", () => {
    const facts = Array.from({ length: 31 }, (_, i) => ({ claim: `Card ${i}`, source: "s", date: "2026-09-01" }));
    const parsed = ResearchOutputSchema.safeParse({ topic: "t", facts, rawPayloadRef: "r" });
    expect(parsed.success).toBe(false);
  });

  it("applies the card defaults when a model omits them", () => {
    const parsed = ResearchOutputSchema.parse({ topic: "t", facts: [{ claim: "c", source: "s", date: "2026-09-01" }], rawPayloadRef: "r" });
    expect(parsed.facts[0]).toMatchObject({ kind: "stat", primary: false });
  });
});

describe("instagram-research@2 — the prompt", () => {
  it("resolves, is byte-identical to latest.md, says v2 in its H1, and keeps v1's extract-don't-invent rule", async () => {
    const promptStore = makePromptStore();
    const v2 = await promptStore.getPrompt("instagram-research", "2");
    const latest = await promptStore.getPrompt("instagram-research");

    expect(v2).toBe(latest);
    // `/\r?\n/`, not `"\n"`: the prompts on disk are CRLF, so splitting on the
    // bare newline leaves a trailing `\r` on the H1 and this assertion failed
    // on every Windows checkout while passing in CI. The prompt file is
    // untouched — the test was reading it wrong. The assertion is unchanged in
    // strength: still exact equality against the full H1.
    expect(v2.split(/\r?\n/)[0]).toBe("# Instagram Research Craft Guide — v2");
    expect(v2).toContain("Extract, don't invent");
    // v1 stays on disk, frozen.
    expect((await promptStore.getPrompt("instagram-research", "1")).split(/\r?\n/)[0]).toContain("v1");
  });

  it("states every rule §J requires of it", async () => {
    const v2 = await makePromptStore().getPrompt("instagram-research", "2");
    for (const rule of [
      "12-24 fact cards",
      "One claim per card",
      "Never merge two sources into one number",
      "the card cites the report",
      "VERBATIM",
      "An `event` card needs a date",
      "`~2026-09-10`",
      "A PDF's text may be absent",
    ]) {
      expect(v2).toContain(rule);
    }
  });

  it("is the prompt the agent actually sends", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(extractionTurnOutput())]);
    const agent = new InstagramResearchAgent({ router, tools: {}, promptStore } satisfies BaseAgentRuntime);

    await agent.run(CTX, { topic: "t", documents: [], rawPayloadRef: "r1" });

    const expected = readFileSync(path.join(PROMPTS_ROOT, "instagram-research", "2.md"), "utf8");
    const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const opts = call[3] as { system?: string };
    expect(opts.system?.startsWith(`${expected}\n\n`)).toBe(true);
  });
});
