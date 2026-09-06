import { describe, expect, it } from "vitest";
import { extractResearchCandidate, hasCitableFigure, researchDigestForDrafting, researchSourceTexts, type ResearchPullResult } from "../src/index.js";

/**
 * `extractResearchCandidate` — the one implementation five publishing agents
 * share.
 *
 * It exists because all five previously carried their own copy of this step,
 * and all five carried the same comment asserting that research.pull was a
 * stand-in with nothing to extract. That was true when written and silently
 * false from the moment the scraper landed.
 */

const pull = (documents: unknown[], extra: Record<string, unknown> = {}): ResearchPullResult =>
  ({
    runId: "run-1",
    query: "acme trends this week",
    fromCache: false,
    result: { provider: "scrappycoco", documents, ...extra },
  }) as ResearchPullResult;

describe("hasCitableFigure", () => {
  // The regression that produced this function. The linkedin fixture's client
  // industry is "B2B SaaS", and a naive /\d/ read the 2 inside "B2B" as a
  // statistic — flipping the archetype rotation onto its numeric ordering on
  // every single run. Same would have hit any real B2B or Web3 client.
  it("ignores a digit welded inside a word", () => {
    expect(hasCitableFigure("B2B SaaS thought leadership trends")).toBe(false);
    expect(hasCitableFigure("Web3 marketing playbook")).toBe(false);
    expect(hasCitableFigure("a 12kb payload")).toBe(false);
  });

  it("accepts percentages, magnitudes and multi-digit runs", () => {
    for (const text of ["76% of leaders", "76 percent of leaders", "live in 31 countries", "grew 3 million users", "12k signups", "5x faster", "published 2026"]) {
      expect(hasCitableFigure(text), text).toBe(true);
    }
  });

  it("is false for prose with no figure at all, and for undefined", () => {
    expect(hasCitableFigure("purely qualitative commentary")).toBe(false);
    expect(hasCitableFigure(undefined)).toBe(false);
  });
});

describe("extractResearchCandidate", () => {
  it("takes the topic from a source headline and cites that source's URL", () => {
    const result = extractResearchCandidate(
      pull([{ title: "August spam update lands globally", url: "https://example.test/spam", content: "Rolling out now." }]),
    );

    expect(result.candidateTopic).toBe("August spam update lands globally");
    // A URL a reader can open, not an opaque run id.
    expect(result.sourceLabel).toBe("https://example.test/spam");
    expect(result.hasNumericInsight).toBe(false);
  });

  it("prefers a source carrying a citable figure, which is what the numbers gate rewards", () => {
    const result = extractResearchCandidate(
      pull([
        { title: "No figures here", url: "https://example.test/a", content: "Purely qualitative." },
        { title: "Ads reach 31 countries", url: "https://example.test/b", content: "Now live in 31 European countries." },
      ]),
    );

    expect(result.candidateTopic).toBe("Ads reach 31 countries");
    expect(result.hasNumericInsight).toBe(true);
  });

  it("skips a headline the client has already covered", () => {
    const result = extractResearchCandidate(
      pull([
        { title: "AI Overviews expand again", url: "https://example.test/old", content: "..." },
        { title: "Something genuinely new", url: "https://example.test/new", content: "..." },
      ]),
      { avoidTopics: ["ai overviews expand again"] },
    );

    expect(result.candidateTopic).toBe("Something genuinely new");
  });

  it("also honours the priorTopics the payload's own history half reports", () => {
    // So an agent gets deduplication even when it did not assemble the list.
    const result = extractResearchCandidate(
      pull(
        [
          { title: "Covered before", url: "https://example.test/1", content: "..." },
          { title: "Fresh angle", url: "https://example.test/2", content: "..." },
        ],
        { history: { priorTopics: ["Covered before"] } },
      ),
    );

    expect(result.candidateTopic).toBe("Fresh angle");
  });

  it("falls back to a covered source rather than to nothing", () => {
    // Avoiding a repeat matters less than having a subject at all.
    const result = extractResearchCandidate(pull([{ title: "Only option", url: "https://example.test/1", content: "..." }]), {
      avoidTopics: ["Only option"],
    });

    expect(result.candidateTopic).toBe("Only option");
  });

  it("falls back to the query, labelled, when the search honestly returned nothing", () => {
    const result = extractResearchCandidate(pull([]));

    // No invention: exactly the conservative behaviour that preceded the
    // scraper, and it announces that there was no source behind it.
    expect(result.candidateTopic).toBe("acme trends this week");
    expect(result.hasNumericInsight).toBe(false);
    expect(result.sourceLabel).toContain("no external sources returned");
  });

  it("ignores a document with no usable title", () => {
    const result = extractResearchCandidate(
      pull([{ url: "https://example.test/untitled", content: "..." }, { title: "Has a title", url: "https://example.test/ok" }]),
    );
    expect(result.candidateTopic).toBe("Has a title");
  });

  it("falls back to the run id when a source has a title but no URL", () => {
    const result = extractResearchCandidate(pull([{ title: "Titled but unlinked", content: "..." }]));
    expect(result.candidateTopic).toBe("Titled but unlinked");
    expect(result.sourceLabel).toBe("research run run-1");
  });

  it("handles a payload with no result envelope at all", () => {
    const bare = { runId: "r", query: "q", fromCache: false } as ResearchPullResult;
    expect(extractResearchCandidate(bare).candidateTopic).toBe("q");
  });
});

describe("researchDigestForDrafting", () => {
  // The newsletter agent's drafting step used to receive the candidate's
  // TITLE and nothing else (prep job sp8ICAFLjKkYWb2DAh8R): four real
  // sources fetched, one headline drafted from, every link pointing at a
  // homepage. This is the material the draft was missing.
  it("hands the drafting step every document's title, url, date and text", () => {
    const digest = researchDigestForDrafting(
      pull([
        { title: "Week in review", url: "https://example.com/week", content: "ChatGPT Ads reached $1 billion.", publishedAt: "2026-09-01" },
        { title: "September trends", url: "https://example.com/sept", content: "Google migrates campaigns to AI Max." },
      ]),
    );
    expect(digest).toEqual([
      { title: "Week in review", url: "https://example.com/week", publishedAt: "2026-09-01", excerpt: "ChatGPT Ads reached $1 billion." },
      { title: "September trends", url: "https://example.com/sept", excerpt: "Google migrates campaigns to AI Max." },
    ]);
  });

  it("is undefined when the pull returned nothing, so a run without research keeps its drafting input unchanged", () => {
    expect(researchDigestForDrafting(pull([]))).toBeUndefined();
    expect(researchDigestForDrafting({ runId: "r", query: "q", fromCache: false } as ResearchPullResult)).toBeUndefined();
    expect(researchDigestForDrafting(pull([{ title: "  ", content: "" }]))).toBeUndefined();
  });

  it("caps the document count and the per-document excerpt", () => {
    const docs = Array.from({ length: 12 }, (_, i) => ({ title: `Doc ${i}`, content: "x".repeat(5_000) }));
    const digest = researchDigestForDrafting(pull(docs), { maxDocuments: 3, maxExcerptChars: 100 })!;
    expect(digest).toHaveLength(3);
    for (const entry of digest) expect(entry.excerpt).toHaveLength(100);
    expect(researchDigestForDrafting(pull(docs))).toHaveLength(8);
  });

  it("collapses runs of whitespace but keeps paragraph breaks", () => {
    const [entry] = researchDigestForDrafting(pull([{ title: "T", content: "one   two \n\n   three" }]))!;
    expect(entry!.excerpt).toBe("one two\nthree");
  });

  it("uses the url as the title when a document has text but no headline", () => {
    const [entry] = researchDigestForDrafting(pull([{ url: "https://example.com/untitled", content: "some text" }]))!;
    expect(entry!.title).toBe("https://example.com/untitled");
  });
});

describe("researchSourceTexts", () => {
  it("returns each document's full title and content, for gate.numbersSourced", () => {
    const sources = researchSourceTexts(
      pull([
        { title: "Week in review", url: "https://example.com/week", content: "ChatGPT Ads reached $1 billion." },
        { title: "No body", url: "https://example.com/empty" },
        { content: "Body only." },
        { title: "   " },
      ]),
    );
    expect(sources).toEqual(["Week in review\nChatGPT Ads reached $1 billion.", "No body", "Body only."]);
  });

  it("never truncates, unlike the drafting digest", () => {
    const long = "y".repeat(20_000);
    expect(researchSourceTexts(pull([{ title: "T", content: long }]))[0]).toBe(`T\n${long}`);
  });

  it("is empty for a payload with no documents", () => {
    expect(researchSourceTexts(pull([]))).toEqual([]);
    expect(researchSourceTexts({ runId: "r", query: "q", fromCache: false } as ResearchPullResult)).toEqual([]);
  });
});
