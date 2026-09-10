import { describe, expect, it } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { WorkflowToolingFailure, type ResearchPullResult, type WorkflowContext } from "@agent-engine/workflow";
import type { ClientBrief } from "@agent-engine/tools";
import { deriveClientBrief } from "../src/workflow/client-brief.js";
import {
  DEEP_RESEARCH_DOCUMENT_FLOOR,
  MAX_LANE_DOMAINS,
  buildResearchLanes,
  looksPrimary,
  normalizeDomain,
  orderDocumentsPrimaryFirst,
  pickPrimarySourceUrls,
  pullResearchLanes,
} from "../src/workflow/research-lanes.js";

/**
 * Deep research, the pure half (RFC-13 §J).
 *
 * `04a-research-pull` asked ONE question, 4 results, 24-hour window, 4000
 * characters — four same-day articles about one subject, which is a headline
 * plus three restatements of it. These are the three lanes that replace it and
 * the primary-source picking that follows them. `deep-research.test.ts` covers
 * the same code wired into the workflow.
 */

const CTX: AgentContext = { runId: "run_lanes", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

const NOW = new Date("2026-09-10T09:00:00.000Z");

function karoslabsBrief(): ClientBrief {
  return deriveClientBrief({
    profile: {
      name: "Karos Labs",
      industry: "AI marketing",
      website: "https://karoslabs.com",
      description: "Karos Labs is an AI marketing agency for B2B founders. We run research, drafting and publishing across every channel with agents a human editor reviews.",
    },
    contextDocs: {
      productInformation: "# Product information\n\nKaros Labs sells a managed AI content engine: weekly Instagram, X and LinkedIn posts drafted by agents and approved by the client's editor.",
      targetAudience: "# Target audience\n\nFounders and heads of marketing at seed to series B B2B software companies, usually a team of one to three doing marketing part time.",
    },
    forbiddenTopics: [],
    now: NOW,
  });
}

/** A `WorkflowContext` whose `step.code` simply runs the body — enough to drive one code step. */
function fakeWorkflowContext(): WorkflowContext {
  return {
    runId: CTX.runId,
    clientSlug: CTX.clientSlug,
    productId: CTX.productId,
    runKind: CTX.runKind,
    input: {},
    step: { code: async <T,>(_id: string, fn: () => T | Promise<T>) => fn() },
  } as unknown as WorkflowContext;
}

/**
 * A `research.pull` stand-in that records the FULL argument object per call —
 * the per-lane window/size/domain options are the point of the step, so a test
 * that only counted calls would pass with every lane asking the same question.
 */
function fakePull(
  answer: (args: Record<string, unknown>, index: number) => { status: string; reason?: string; documents?: number; fromCache?: boolean },
) {
  const calls: Array<Record<string, unknown>> = [];
  const tools = {
    "research.pull": {
      async execute(rawArgs: unknown) {
        const args = rawArgs as Record<string, unknown>;
        calls.push(args);
        const outcome = answer(args, calls.length - 1);
        if (outcome.status !== "success") return { status: outcome.status, reason: outcome.reason ?? "stub failure" };
        const query = String(args["query"]);
        const result: ResearchPullResult = {
          runId: `run-${calls.length}`,
          query,
          fromCache: outcome.fromCache ?? false,
          result: {
            provider: "stub",
            documents: Array.from({ length: outcome.documents ?? 6 }, (_, i) => ({
              title: `${query} #${i}`,
              url: `https://source.example.com/${encodeURIComponent(query)}/${i}`,
              content: "body",
            })),
          },
        };
        return { status: "success", result };
      },
    },
  } as unknown as AgentToolRegistry;
  return { calls, tools };
}

describe("buildResearchLanes", () => {
  it("builds the three lanes at their own windows, breadths and depths", () => {
    const lanes = buildResearchLanes({
      groundedQuery: "the new first-month offer in the context of a managed AI content engine for B2B founders",
      subject: "the new first-month offer",
      brief: karoslabsBrief(),
      companyName: "Karos Labs",
      year: 2026,
      clientDomain: "karoslabs.com",
      referenceDomains: ["https://www.marketingbrew.com/some/path"],
    });

    expect(lanes.map((l) => l.lane)).toEqual(["news", "insight", "primary-domains"]);

    const [news, insight, primary] = lanes;
    // News is short-windowed on purpose: a "this week" claim out of a 90-day
    // window is a false present tense.
    expect(news).toMatchObject({ window: "7d", maxResults: 6, contentChars: 4000 });
    expect(news!.queries[0]).toContain("in the context of");
    expect(news!.queries).toHaveLength(3);
    expect(news!.queries[2]).toBe('"Karos Labs" the new first-month offer');

    // Insight reads FEWER documents DEEPER, over a wide window: the figure a
    // fact card needs is in a study's body, and a June study is still the best
    // evidence in September.
    expect(insight).toMatchObject({ window: "90d", maxResults: 5, contentChars: 6000 });
    expect(insight!.queries[0]).toMatch(/report OR study OR survey 2026$/);
    expect(insight!.queries[1]).toMatch(/ data$/);

    expect(primary).toMatchObject({ window: "90d", maxResults: 4, contentChars: 6000, queries: ["the new first-month offer"] });
    // Hostnames only: a scheme or a path in `includeDomains` restricts to nothing.
    expect(primary!.includeDomains).toEqual(["karoslabs.com", "marketingbrew.com"]);
  });

  it("omits the primary-domains lane entirely when there is no domain to ask about", () => {
    const lanes = buildResearchLanes({ groundedQuery: "q", subject: "s", brief: karoslabsBrief(), year: 2026 });
    // A domain lane with no filter would just be a fourth open-web query, billed.
    expect(lanes.map((l) => l.lane)).toEqual(["news", "insight"]);
  });

  it("the client's own domain alone is not a lane: without a reference publication the query is not billed", () => {
    // What this closes: the lane's second half ("the publications the brief
    // names") used to be fed social HANDLES, which resolve to no hostname at
    // all — so every run paid one execution asking the client's own small
    // site about this week's subject, and the publication filter was never
    // applied. Their own material still reaches the base through `04a3` and
    // `clientDocuments`, both cheaper.
    const clientOnly = buildResearchLanes({ groundedQuery: "q", subject: "agency retainers", brief: karoslabsBrief(), year: 2026, clientDomain: "karoslabs.com" });
    expect(clientOnly.map((l) => l.lane)).toEqual(["news", "insight"]);

    // A handle is not a domain, and neither is a reference domain that only
    // repeats the client's own host.
    const handles = buildResearchLanes({
      groundedQuery: "q",
      subject: "agency retainers",
      brief: karoslabsBrief(),
      year: 2026,
      clientDomain: "karoslabs.com",
      referenceDomains: ["lennysan", "SaaS", "marketingexamples", "www.karoslabs.com"],
    });
    expect(handles.map((l) => l.lane)).toEqual(["news", "insight"]);

    // One real publication puts the lane back, with the client's own domain
    // riding along rather than carrying it.
    const withPublication = buildResearchLanes({
      groundedQuery: "q",
      subject: "agency retainers",
      brief: karoslabsBrief(),
      year: 2026,
      clientDomain: "karoslabs.com",
      referenceDomains: ["lennysan", "https://www.lennysnewsletter.com/archive"],
    });
    const primary = withPublication.find((l) => l.lane === "primary-domains")!;
    expect(primary.includeDomains).toEqual(["karoslabs.com", "lennysnewsletter.com"]);
  });

  it("omits a query rather than emitting a half-empty one, and never asks the same question twice", () => {
    // A brand-new client with nothing on file: no company name, no core terms.
    // The failure mode being pinned is `"<subject> undefined"` reaching a
    // search index, and an insight lane whose query is the word "report".
    const bare: ClientBrief = { ...deriveClientBrief({ contextDocs: {}, forbiddenTopics: [], now: NOW }), coreTerms: [] };

    const lanes = buildResearchLanes({ groundedQuery: "agency retainers", subject: "agency retainers", brief: bare, year: 2026 });

    expect(lanes.map((l) => l.lane)).toEqual(["news"]);
    expect(lanes[0]!.queries).toEqual(["agency retainers"]);

    // A one-term brief whose term IS the subject: the `<subject> <term>` query
    // would be "widgets widgets", which asks the first question again and
    // bills for it. The lane pairs the first term the subject does NOT
    // already carry, so here there is nothing to pair.
    const oneTerm = buildResearchLanes({ groundedQuery: "widgets", subject: "widgets", brief: { ...bare, coreTerms: ["widgets", "pricing"] }, year: 2026 });
    const news = oneTerm.find((l) => l.lane === "news")!;
    expect(news.queries).toEqual(["widgets", "widgets pricing"]);
    expect(new Set(news.queries.map((q) => q.toLowerCase())).size).toBe(news.queries.length);
  });

  it("caps includeDomains at research.pull's own ceiling", () => {
    const many = Array.from({ length: 12 }, (_, i) => `ref${i}.example.com`);
    const lanes = buildResearchLanes({ groundedQuery: "q", subject: "s", brief: karoslabsBrief(), year: 2026, clientDomain: "karoslabs.com", referenceDomains: many });

    const primary = lanes.find((l) => l.lane === "primary-domains")!;
    expect(MAX_LANE_DOMAINS).toBe(8);
    expect(primary.includeDomains).toHaveLength(8);
    // The client's own domain is first in, so it is never the one squeezed out.
    expect(primary.includeDomains![0]).toBe("karoslabs.com");

    // And with no client domain, all eight rows go to the publications.
    const noClient = buildResearchLanes({ groundedQuery: "q", subject: "s", brief: karoslabsBrief(), year: 2026, referenceDomains: many });
    expect(noClient.find((l) => l.lane === "primary-domains")!.includeDomains).toEqual(many.slice(0, 8));
  });

  it("normalizes a domain to a bare hostname, and rejects what is not one", () => {
    expect(normalizeDomain("https://WWW.Example.com/pricing?x=1")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("not-a-domain")).toBeUndefined();
    expect(normalizeDomain("   ")).toBeUndefined();
  });
});

describe("pullResearchLanes", () => {
  const lanes = () =>
    buildResearchLanes({
      groundedQuery: "the new first-month offer in the context of a managed AI content engine",
      subject: "the new first-month offer",
      brief: karoslabsBrief(),
      companyName: "Karos Labs",
      year: 2026,
      clientDomain: "karoslabs.com",
      // A reference PUBLICATION's hostname, which is what puts the
      // primary-domains lane in play at all: the client's own domain alone
      // does not earn a billed query (see `buildResearchLanes`).
      referenceDomains: ["marketingbrew.com"],
    });

  it("asks every lane's every query with THAT lane's options, and merges the answers", async () => {
    const { calls, tools } = fakePull(() => ({ status: "success", documents: 6 }));

    const result = await pullResearchLanes(fakeWorkflowContext(), tools, CTX, {
      stepId: "04a2-research-pull-deep",
      lanes: lanes(),
      job: "instagram-carousel-research",
      historyAgentId: "instagram-agent",
    });

    expect(calls).toHaveLength(6);
    expect(calls[0]).toMatchObject({ job: "instagram-carousel-research", window: "7d", maxResults: 6, contentChars: 4000, historyAgentId: "instagram-agent" });
    expect(calls[0]!["includeDomains"]).toBeUndefined();
    expect(calls[3]).toMatchObject({ window: "90d", maxResults: 5, contentChars: 6000 });
    expect(calls[5]).toMatchObject({ window: "90d", maxResults: 4, contentChars: 6000, includeDomains: ["karoslabs.com", "marketingbrew.com"] });

    // Six queries x 6 documents, unique URLs per query: comfortably past the
    // floor the old single pull never got near.
    expect(result.documentCount).toBe(36);
    expect(result.documentCount).toBeGreaterThanOrEqual(DEEP_RESEARCH_DOCUMENT_FLOOR);
    expect(result.note).toBeUndefined();
    expect(result.lanes.map((l) => l.lane)).toEqual(["news", "insight", "primary-domains"]);
    expect(result.lanes[0]!.queries[0]).toMatchObject({ status: "success", documents: 6, fromCache: false });
    // Every query billed a scrape here; a cache hit is free and must not be.
    expect(result.billedPulls).toBe(6);
  });

  it("bills only the queries that actually reached the vendor", async () => {
    const { tools } = fakePull((_args, index) => ({ status: "success", documents: 6, fromCache: index % 2 === 0 }));

    const result = await pullResearchLanes(fakeWorkflowContext(), tools, CTX, {
      stepId: "04a2-research-pull-deep",
      lanes: lanes(),
      job: "instagram-carousel-research",
      historyAgentId: "instagram-agent",
    });

    expect(result.billedPulls).toBe(3);
  });

  it("records a failing query, keeps going, and notes it — a dead query is not a dead step", async () => {
    const { tools } = fakePull((args) =>
      String(args["query"]).includes("report OR study")
        ? { status: "tooling_error", reason: "scrappycoco web.search_web returned 502" }
        : { status: "success", documents: 6 },
    );

    const result = await pullResearchLanes(fakeWorkflowContext(), tools, CTX, {
      stepId: "04a2-research-pull-deep",
      lanes: lanes(),
      job: "instagram-carousel-research",
      historyAgentId: "instagram-agent",
    });

    const insight = result.lanes.find((l) => l.lane === "insight")!;
    expect(insight.queries[0]).toMatchObject({ status: "tooling_error", documents: 0 });
    expect(insight.queries[1]).toMatchObject({ status: "success" });
    expect(result.note).toContain("insight");
    expect(result.note).toContain("502");
    expect(result.documentCount).toBe(30);
  });

  it("notes a thin base rather than holding the run", async () => {
    const { tools } = fakePull(() => ({ status: "success", documents: 1 }));

    const result = await pullResearchLanes(fakeWorkflowContext(), tools, CTX, {
      stepId: "04a2-research-pull-deep",
      lanes: lanes(),
      job: "instagram-carousel-research",
      historyAgentId: "instagram-agent",
    });

    expect(result.documentCount).toBe(6);
    expect(result.note).toContain(`below the ${DEEP_RESEARCH_DOCUMENT_FLOOR}`);
  });

  it("fails as a whole only when EVERY query failed — an outage is tooling, never a thin subject", async () => {
    const { tools } = fakePull(() => ({ status: "not_available", reason: "no scraper is configured — set SCRAPPYCOCO_API_KEY" }));

    await expect(
      pullResearchLanes(fakeWorkflowContext(), tools, CTX, {
        stepId: "04a2-research-pull-deep",
        lanes: lanes(),
        job: "instagram-carousel-research",
        historyAgentId: "instagram-agent",
      }),
    ).rejects.toThrow(WorkflowToolingFailure);
  });

  it("refuses to run with no lanes at all, rather than reporting an empty research base", async () => {
    const { tools } = fakePull(() => ({ status: "success" }));

    await expect(
      pullResearchLanes(fakeWorkflowContext(), tools, CTX, { stepId: "04a2-research-pull-deep", lanes: [], job: "j", historyAgentId: "instagram-agent" }),
    ).rejects.toThrow(/no research lanes/);
  });
});

describe("primary sources", () => {
  const merged = (urls: string[]): ResearchPullResult => ({
    runId: "m",
    query: "q",
    fromCache: false,
    result: { documents: urls.map((url, i) => ({ title: `doc ${i}`, url, content: "body" })) },
  });

  it("recognises the source itself, not coverage of it", () => {
    expect(looksPrimary({ url: "https://ops.example.org/benchmark-2026.pdf" })).toBe(true);
    expect(looksPrimary({ url: "https://example.org/research/state-of-ops" })).toBe(true);
    expect(looksPrimary({ url: "https://bls.gov/news.release/ops.htm" })).toBe(true);
    expect(looksPrimary({ url: "https://cs.stanford.edu/paper" })).toBe(true);
    expect(looksPrimary({ url: "https://news.example.com/someone-read-a-report" })).toBe(false);
    // The client's own site is primary for THIS client, and only for them.
    expect(looksPrimary({ url: "https://blog.karoslabs.com/our-numbers" }, "karoslabs.com")).toBe(true);
    expect(looksPrimary({ url: "https://blog.karoslabs.com/our-numbers" }, "acme.com")).toBe(false);
    expect(looksPrimary({})).toBe(false);
  });

  it("picks at most two URLs worth a full-page fetch, in merge order, without repeats", () => {
    const urls = pickPrimarySourceUrls(
      merged([
        "https://news.example.com/coverage",
        "https://ops.example.org/benchmark.pdf",
        "https://news.example.com/more-coverage",
        "https://karoslabs.com/pricing",
        "https://other.example.org/study/two",
      ]),
      "karoslabs.com",
    );

    expect(urls).toEqual(["https://ops.example.org/benchmark.pdf", "https://karoslabs.com/pricing"]);
    expect(pickPrimarySourceUrls(merged(["https://news.example.com/a"]), "karoslabs.com")).toEqual([]);
  });

  it("orders primary sources first and is stable inside each group", () => {
    const ordered = orderDocumentsPrimaryFirst(
      [
        { title: "coverage a", url: "https://news.example.com/a" },
        { title: "client doc", primary: true },
        { title: "coverage b", url: "https://news.example.com/b" },
        { title: "study", url: "https://ops.example.org/s.pdf" },
      ],
      "karoslabs.com",
    );

    // The explicit `primary` marker (client documents, fetched primary pages)
    // and the URL-shape heuristic both count; everything else keeps its merge
    // order so a lane's own ranking survives.
    expect(ordered.map((d) => d.title)).toEqual(["client doc", "study", "coverage a", "coverage b"]);
  });
});
