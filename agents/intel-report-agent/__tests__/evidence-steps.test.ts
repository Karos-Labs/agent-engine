import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { OnPageAuditSnapshot, TechnicalSeoSnapshot } from "@agent-engine/tools";
import { createIntelReportAgentWorkflow, summariseSiteAudit } from "../src/workflow/create-intel-report-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "intel_evidence", clientSlug: "acme", productId: "intel-report-agent", runKind: "setup" as const };

/** The turn prompt the first `router.complete` call received (its first argument) — the agent's INPUT, not the system prompt, which names every evidence field regardless of what this run had. */
function promptOfFirstCall(router: ReturnType<typeof fakeRouterSequence>): string {
  const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return typeof calls[0]![0] === "string" ? (calls[0]![0] as string) : JSON.stringify(calls[0]![0]);
}

describe("the four evidence steps (01f-01i): the client's site, the client by name, competitor sites, the SEO & GEO snapshot", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("with a website on the profile, audits the site and competitor homepages and hands both to the drafting prompt", async () => {
    await env.store.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS", website: "https://acme.example" });
    const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);
    expect(result.status).toBe("completed");

    const steps = await durableStore.listSteps(params.runId);
    const output = (id: string) => steps.find((s) => s.stepId === id)?.output as Record<string, unknown> | null | undefined;
    const siteAudit = output("01f-audit-client-site");
    expect(siteAudit).not.toBeNull();
    expect(siteAudit).toMatchObject({ seedUrl: "https://acme.example", pagesAudited: expect.any(Number) });
    expect((siteAudit!["pages"] as unknown[]).length).toBeGreaterThan(0);
    expect((siteAudit!["facts"] as string[]).some((f) => f.includes("crawled URLs answered HTTP 200"))).toBe(true);
    // The curated competitor has a website, so its homepage was read too.
    const competitorSites = output("01h-audit-competitor-sites") as Array<{ name: string; page: { url: string } }> | null;
    expect(competitorSites?.[0]?.name).toBe("Rival Corp");
    expect(competitorSites?.[0]?.page.url).toContain("rivalcorp.example.com");
    // The client scan asked about the client by name, not the category.
    const clientResearch = output("01g-research-client") as { query: string } | null;
    expect(clientResearch?.query).toContain('"Acme Corp"');
    // No SEO & GEO run has ever written its snapshot for this client.
    expect(output("01i-load-seo-geo-snapshot")).toBeNull();

    const prompt = promptOfFirstCall(router);
    expect(prompt).toContain("siteAudit");
    expect(prompt).toContain("competitorSites");
    expect(prompt).toContain("clientResearch");
    expect(prompt).not.toContain("seoGeoSnapshot");
  });

  it("reads the sibling SEO & GEO agent's snapshot from client memory and hands it to the prompt", async () => {
    await env.store.writeJson("acme", ["memory", "beliefs"], {
      seoGeoLatestSnapshot: { seoScore: 62, seoDataCoveragePct: 90, seoMeasuredBasisScore: 69, geoReadinessScore: 41, visibilityIndex: 23, measuredFacts: ["robots.txt allows every AI crawler at the root."] },
    });
    const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);
    expect(result.status).toBe("completed");
    const snapshot = (await durableStore.listSteps(params.runId)).find((s) => s.stepId === "01i-load-seo-geo-snapshot")?.output as Record<string, unknown>;
    expect(snapshot["seoScore"]).toBe(62);
    expect(promptOfFirstCall(router)).toContain("seoGeoSnapshot");
    // Without a website, there is no site to audit — the step records null rather than skipping.
    expect((await durableStore.listSteps(params.runId)).find((s) => s.stepId === "01f-audit-client-site")?.output).toBeNull();
  });

  it("summariseSiteAudit compacts the pages and states the site facts from the two reads", () => {
    const onPage: OnPageAuditSnapshot = {
      seedUrl: "https://acme.example",
      fetchedAt: "2026-09-07T00:00:00.000Z",
      skipped: [],
      llmsTxt: { status: 404, present: false },
      sitemap: { entryCount: 120, truncated: false, entriesWithLastmod: 100, newestLastmod: "2026-09-01T00:00:00.000Z", maxGapDaysTrailing6mo: 12, entriesTrailing6mo: 40, lastmodByUrl: {} },
      pages: [
        {
          url: "https://acme.example",
          finalUrl: "https://acme.example/",
          status: 200,
          https: true,
          script: "latin",
          title: "Acme — the platform",
          titleLength: 19,
          metaDescription: "Acme helps teams ship.",
          metaDescriptionLength: 22,
          metaRobots: { noindex: false, nosnippet: false, maxSnippetZero: false },
          viewportMeta: true,
          hreflangCount: 0,
          headings: [
            { level: 1, text: "Ship faster with Acme", isQuestion: false, sectionWordCount: 50, firstParagraphWordCount: 50, bodyOffsetRatio: 0, externalLinkCount: 0, numericStatCount: 0 },
            { level: 2, text: "How does it work?", isQuestion: true, sectionWordCount: 80, firstParagraphWordCount: 45, bodyOffsetRatio: 0.3, externalLinkCount: 1, numericStatCount: 2 },
          ],
          h1Count: 1,
          headingSkips: 0,
          wordCount: 130,
          sectionWordCounts: [50, 80],
          openingCapsule: { wordCount: 50, bodyOffsetRatio: 0 },
          internalLinkCount: 4,
          externalLinkCount: 1,
          externalDomains: ["example.org"],
          images: { total: 2, withAlt: 2 },
          hasVideo: false,
          jsonLd: { blocks: 1, parseErrors: 0, types: ["Organization"], organization: { sameAsCount: 2, hasId: true } },
          dateModified: "2026-09-01T00:00:00.000Z",
          authorByline: false,
          numericStatCount: 2,
          attributedQuoteCount: 0,
          firstPersonMarkerCount: 3,
          definitionalSentence: true,
          keyword: { topTokenShare: 0.02, maxExactPhraseRepeats: 1 },
          fleschReadingEase: 61,
          mixedContentCount: 0,
          contentHash: "abc",
          excerpt: "Acme helps teams ship faster.",
        },
      ],
    };
    const technical: TechnicalSeoSnapshot = {
      seedUrl: "https://acme.example",
      robots: { url: "https://acme.example/robots.txt", status: 200, groups: [{ userAgent: "ClaudeBot", disallow: ["/"], allow: [] }], sitemaps: [] },
      pages: [
        { url: "https://acme.example/", status: 200, noindex: false },
        { url: "https://acme.example/old", status: 404, noindex: undefined },
      ],
      truncated: false,
    };
    const audit = summariseSiteAudit("https://acme.example", onPage, technical);
    expect(audit).not.toBeNull();
    expect(audit!.pages[0]).toMatchObject({ url: "https://acme.example/", title: "Acme — the platform", h1: "Ship faster with Acme", headings: ["How does it work?"], schemaTypes: ["Organization"], excerpt: "Acme helps teams ship faster." });
    expect(audit!.site).toMatchObject({ https: true, llmsTxtPresent: false, jsonLdTypes: ["Organization"], pagesWithDateModified: 1, pagesWithSingleH1: 1, reachable: { ok: 1, checked: 2 }, robotsBlocks: ["ClaudeBot"], sitemapEntries: 120, longestPublishingGapDays: 12 });
    expect(audit!.facts).toContain("1 of 2 crawled URLs answered HTTP 200.");
    expect(audit!.facts).toContain("robots.txt disallows ClaudeBot at the root.");
    expect(audit!.facts.some((f) => f.startsWith("The sitemap lists 120 URLs"))).toBe(true);
    expect(summariseSiteAudit("https://acme.example", undefined, undefined)).toBeNull();
  });
});
