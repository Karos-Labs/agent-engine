import { describe, expect, it, afterEach } from "vitest";
import type { AgentContext, AgentToolRegistry, ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { ScraperError, createOfflineScraper, type ScrapedRecord, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import type { ClientBrief } from "@agent-engine/tools";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { dedupeFactCards } from "../src/workflow/fact-cards.js";
import type { DeepResearchResult } from "../src/workflow/research-lanes.js";
import type { ResearchFact, ResearchOutput } from "../src/workflow/types.js";
import {
  SIX_RESEARCH_FACTS,
  fakeRenderCarousel,
  fakeRouterSequence,
  goodBrandTokens,
  goodClientBrief,
  goodImageCandidatePool,
  goodStyleConfig,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns } from "./turns.js";

/**
 * Deep research through the real workflow (RFC-13 §J, Phase 1).
 *
 * `04a-research-pull` is retired: `04a2-research-pull-deep` runs the three
 * lanes, `04a3-fetch-primary-sources` reads the two most source-like pages in
 * full, `04b` extracts fact cards from the merged set ordered primary-first,
 * and `04b2-dedupe-fact-cards` is what everything downstream consumes.
 *
 * Step ids are the spec's; these tests need the integrator's wiring of
 * 04a2/04a3/04b2 (WP1-3's integration notes).
 */

const BASE_PARAMS = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
const ctx: AgentContext = { runId: "ig_deep", ...BASE_PARAMS, metadata: {} };

/**
 * A research turn with thirteen kind-bearing cards, twelve distinct.
 *
 * The first six are `SIX_RESEARCH_FACTS` verbatim, because `goodCopyOutput()`'s
 * slides name those claims as their `sourceRef` and step 07 matches them
 * character for character — the point being that fact CARDS (kinds, urls,
 * primary flags) do not break that trace. The thirteenth restates the second
 * with the same figure from a weaker source, so `04b2` has a real duplicate to
 * drop and a real reason to keep the other one.
 */
function deepResearchOutput(): ResearchOutput {
  const kinds: Array<ResearchFact["kind"]> = ["stat", "stat", "stat", "stat", "stat", "event"];
  const cards: ResearchFact[] = SIX_RESEARCH_FACTS.map((fact, i) => ({
    ...fact,
    kind: kinds[i]!,
    url: `https://research.example.org/internal-${i}.pdf`,
    primary: true,
  }));
  cards.push(
    {
      claim: "Agencies raised retainers 12% on average this year.",
      kind: "stat",
      source: "Agency retainer survey 2026",
      url: "https://research.example.org/retainer-survey-2026",
      date: "2026-07-02",
      primary: true,
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
      claim: "Acme's head of operations says the weekly report is the meeting nobody wanted.",
      kind: "quote",
      quote: "The weekly report is the meeting nobody wanted.",
      source: "Dana Levi, head of operations, Acme",
      url: "https://news.example.com/interview",
      date: "2026-09-08",
    },
    {
      claim: "Time to first value is the interval between signing and the first outcome a customer would have paid for alone.",
      kind: "definition",
      source: "Example Docs glossary",
      url: "https://docs.example.com/glossary/ttfv",
      date: "~2026-09-10",
    },
    {
      claim: "A major support vendor added AI triage to every plan on 8 September 2026.",
      kind: "event",
      source: "Example News",
      url: "https://news.example.com/vendor-ai-triage",
      date: "2026-09-08",
    },
    {
      claim: "Two of the three reporting tools that shipped digests this month are priced at $12 per seat.",
      kind: "stat",
      source: "Example News",
      url: "https://news.example.com/ops-roundup",
      date: "2026-09-05",
    },
    // The duplicate: same figure, same subject, weaker source, no URL. `04b2`
    // keeps the internal analysis above and drops this.
    {
      claim: "After the new triage flow, the support team was resolving 30% more tickets than before.",
      kind: "stat",
      source: "a blog post about the change",
      date: "2026-07-20",
    },
  );
  return { topic: "process changes that actually moved the needle this quarter", facts: cards, rawPayloadRef: "deep-research-fixture" };
}

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/** The extraction agent's own input, parsed back out of the JSON prompt `BaseAgent` sent — the one turn carrying `documents` and `rawPayloadRef`. */
function researchTurnInput(router: ModelRouter): Record<string, unknown> | undefined {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  for (const call of complete.mock.calls) {
    if (typeof call[0] !== "string") continue;
    try {
      const parsed = JSON.parse(call[0]) as { input?: Record<string, unknown> };
      if (parsed.input && "rawPayloadRef" in parsed.input && "documents" in parsed.input) return parsed.input;
    } catch {
      // not a JSON prompt
    }
  }
  return undefined;
}

async function runWorkflow(env: TestEnvironment, runId: string, router: ModelRouter) {
  const workflowFn = createInstagramAgentWorkflow({
    tools: testTools(env),
    promptStore: makePromptStore(),
    router,
    repoRoot: env.repoRoot,
    autoApprove: true,
    imageCandidatePool: goodImageCandidatePool(),
  });
  const durableStore = new MemoryDurableStepStore();
  const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...BASE_PARAMS, runId });
  const steps = await durableStore.listSteps(runId);
  return { result, steps, stepIds: steps.map((s) => s.stepId), router };
}

/** The client the lanes are built for: a website, so there is a client domain for the primary lane and for `04a3` to fetch from. */
async function writeClient(env: TestEnvironment): Promise<void> {
  await env.store.writeJson("acme", ["client", "config"], { instagramStyleConfig: goodStyleConfig(), instagramBrandTokens: goodBrandTokens() });
  await env.store.writeJson("acme", ["client", "profile"], {
    name: "Acme",
    industry: "B2B SaaS",
    // `offline.test` is the offline scraper's own host, so the merged
    // documents genuinely look like the client's own material and `04a3` has
    // primary URLs to pick.
    website: "https://offline.test",
    description: "Acme sells an operations reporting platform to B2B software teams.",
  });
}

describe("04a2 / 04a3 / 04b2 — deep research in the instagram workflow", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("runs the lanes, reaches the document floor, and hands the writer deduped fact cards", async () => {
    env = await setupTestEnvironment({ scraper: createOfflineScraper({ documentsPerQuery: 6 }) });
    await writeClient(env);

    const { result, steps, stepIds, router } = await runWorkflow(
      env,
      "ig_deep_happy",
      fakeRouterSequence(happyTurns({ research: deepResearchOutput() })),
    );

    expect(result.status).toBe("completed");

    // The retired id is gone; the new ones are present.
    expect(stepIds).not.toContain("04a-research-pull");
    expect(stepIds).toContain("04a2-research-pull-deep");
    expect(stepIds).toContain("04a3-fetch-primary-sources");
    expect(stepIds).toContain("04b-research-extract-facts");
    expect(stepIds).toContain("04b2-dedupe-fact-cards");

    const deep = steps.find((s) => s.stepId === "04a2-research-pull-deep")?.output as DeepResearchResult;
    expect(deep.lanes.map((l) => l.lane)).toEqual(expect.arrayContaining(["news", "insight"]));
    // The whole point of the reshape: 4 documents became a real base.
    expect(deep.documentCount).toBeGreaterThanOrEqual(12);
    expect(deep.lanes.flatMap((l) => l.queries).every((q) => q.status === "success")).toBe(true);

    // The extraction step reads the merged set primary-first, with the brief
    // and the client's own material alongside it.
    const extractionInput = researchTurnInput(router)!;
    expect(extractionInput).toBeDefined();
    expect(typeof extractionInput["clientBrief"]).toBe("string");
    expect(Array.isArray(extractionInput["clientDocuments"])).toBe(true);
    const documents = extractionInput["documents"] as Array<{ url?: string; primary?: boolean }>;
    expect(documents.length).toBeGreaterThanOrEqual(12);

    // `04b2` is what everything downstream consumes: one card per claim.
    const deduped = steps.find((s) => s.stepId === "04b2-dedupe-fact-cards")?.output as { facts: ResearchFact[]; dropped: Array<{ claim: string; duplicateOf: string }> };
    expect(deduped.facts.length).toBeGreaterThanOrEqual(10);
    expect(deduped.dropped).toHaveLength(1);
    expect(deduped.dropped[0]!.duplicateOf).toBe(SIX_RESEARCH_FACTS[1]!.claim);
    // Nothing left to drop — re-running the deduper over its own output is the
    // only honest way to assert "no duplicates remain".
    expect(dedupeFactCards(deduped.facts).dropped).toEqual([]);

    // And the trace still holds: every slide's `sourceRef` matched a card
    // verbatim through step 07, which is why this run delivered at all.
    for (const fact of SIX_RESEARCH_FACTS) {
      expect(deduped.facts.some((f) => f.claim === fact.claim)).toBe(true);
    }
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "ig_deep_happy", "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["instagram-carousel"]);
  }, 90000);

  it("records a lane query that failed and still succeeds — a dead query is not a dead step", async () => {
    const offline = createOfflineScraper({ documentsPerQuery: 6 });
    const flaky: ScraperProvider = {
      ...offline,
      async searchKeyword(query: string, options): Promise<ScrapedRecord[]> {
        // The insight lane's own query shape. A 502 on it must not cost the
        // run its news lane.
        if (query.includes("report OR study OR survey")) throw new ScraperError("scrappycoco web.search_web returned 502", 502);
        return offline.searchKeyword(query, options);
      },
    };
    env = await setupTestEnvironment({ scraper: flaky });
    await writeClient(env);

    const { result, steps } = await runWorkflow(env, "ig_deep_flaky", fakeRouterSequence(happyTurns({ research: deepResearchOutput() })));

    expect(result.status).toBe("completed");
    const deep = steps.find((s) => s.stepId === "04a2-research-pull-deep")?.output as DeepResearchResult;
    const insight = deep.lanes.find((l) => l.lane === "insight")!;
    expect(insight.queries.some((q) => q.status === "tooling_error")).toBe(true);
    expect(deep.note).toContain("insight");
    expect(deep.documentCount).toBeGreaterThan(0);
  }, 90000);

  it("the primary-domains lane is fed the brief's reference DOMAINS, and does not run on handles", async () => {
    /** Every `includeDomains` filter that actually reached the vendor, in call order. */
    async function domainFiltersFor(runId: string, referenceAccounts: ClientBrief["referenceAccounts"]): Promise<Array<readonly string[]>> {
      const offline = createOfflineScraper({ documentsPerQuery: 6 });
      const seen: Array<readonly string[]> = [];
      const recording: ScraperProvider = {
        ...offline,
        async searchKeyword(query: string, options): Promise<ScrapedRecord[]> {
          if (options?.includeDomains !== undefined && options.includeDomains.length > 0) seen.push([...options.includeDomains]);
          return offline.searchKeyword(query, options);
        },
      };
      env = await setupTestEnvironment({ scraper: recording, seedBrief: goodClientBrief({ referenceAccounts }) });
      await writeClient(env);
      const { result } = await runWorkflow(env, runId, fakeRouterSequence(happyTurns({ research: deepResearchOutput() })));
      expect(result.status).toBe("completed");
      // The community-question engine has its own domain filter (reddit,
      // quora, ...); this lane is the one carrying the client's own host.
      return seen.filter((domains) => domains.includes("offline.test"));
    }

    // A reference account with a real publication host: the lane runs, and
    // the filter carries the client's own domain plus that host.
    const withDomain = await domainFiltersFor("ig_deep_reference_domains", [
      { platform: "x", handle: "lennysan", why: "the newsletter this ICP quotes", domain: "https://www.lennysnewsletter.com/archive" },
    ]);
    expect(withDomain).toHaveLength(1);
    expect(withDomain[0]).toEqual(["offline.test", "lennysnewsletter.com"]);
    await env.cleanup();

    // Handles only (the shape every brief had before `domain` existed): the
    // lane is skipped rather than billing one query restricted to the
    // client's own small site — the defect this pins is that the handles used
    // to BE the domains.
    const handlesOnly = await domainFiltersFor("ig_deep_reference_handles", [
      { platform: "x", handle: "lennysan", why: "the newsletter this ICP quotes" },
      { platform: "instagram", handle: "marketingexamples", why: "the format vocabulary this audience reads" },
    ]);
    expect(handlesOnly).toEqual([]);
  }, 120000);

  it("fails as tooling when EVERY lane query fails, rather than drafting from an empty base", async () => {
    // No scraper at all: `research.pull` reports `not_available` for every
    // query. The scout already survives this (it records `unavailable` on a
    // planned run); research cannot, and must say so as tooling rather than
    // hand the extraction step nothing.
    env = await setupTestEnvironment({ scraper: null });
    await writeClient(env);

    const { result, stepIds } = await runWorkflow(env, "ig_deep_outage", fakeRouterSequence([]));

    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("unreachable");
    expect(result.failureReason).toContain("research.pull failed for every deep-research query");
    expect(stepIds).not.toContain("04b-research-extract-facts");
  }, 90000);
});

describe("the fixtures this file relies on", () => {
  it("the thirteen-card research turn is what 04b2 is meant to receive: twelve distinct claims and one real duplicate", () => {
    const output = deepResearchOutput();
    expect(output.facts).toHaveLength(13);
    const { facts, dropped } = dedupeFactCards(output.facts);
    expect(facts).toHaveLength(12);
    expect(dropped).toHaveLength(1);
    // The kept card is the internal analysis, not the blog post about it.
    expect(facts.some((f) => f.claim === SIX_RESEARCH_FACTS[1]!.claim)).toBe(true);
    expect(new Set(facts.map((f) => f.kind)).size).toBeGreaterThanOrEqual(3);
    expect(ctx.clientSlug).toBe("acme");
  });
});
