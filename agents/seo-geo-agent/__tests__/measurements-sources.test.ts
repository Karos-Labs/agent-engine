import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { GEO_READINESS_BUCKETS, SEO_BUCKETS, evaluateScoreFamily, listInputKeys } from "@agent-engine/tool-karos-seo-geo";
import { WorkspaceStore, createAuditOnPage, type CoreWebVitalsSnapshot, type EntitySnapshot, type OnPageAuditSnapshot, type TechnicalSeoSnapshot } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { buildTechnicalMeasurements, describeMeasuredFacts } from "../src/workflow/measurements.js";

const ctx: AgentContext = { runId: "run_m", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring", metadata: {} };
const NOW = Date.parse("2026-02-01T00:00:00Z");

const TECHNICAL: TechnicalSeoSnapshot = {
  seedUrl: "https://acme.example",
  robots: { url: "https://acme.example/robots.txt", status: 200, groups: [{ userAgent: "*", disallow: [], allow: [] }], sitemaps: ["https://acme.example/sitemap.xml"] },
  sitemap: { url: "https://acme.example/sitemap.xml", status: 200, entries: [{ url: "https://acme.example/" }, { url: "https://acme.example/about" }] },
  pages: [
    { url: "https://acme.example/", status: 200, noindex: false },
    { url: "https://acme.example/about", status: 200, noindex: false },
  ],
  truncated: false,
};

const CWV: CoreWebVitalsSnapshot = {
  url: "https://acme.example",
  strategy: "mobile",
  fetchedAt: "2026-02-01T00:00:00.000Z",
  field: { source: "origin", overallCategory: "FAST", lcpP75Ms: 1900, inpP75Ms: 120, clsP75: 0.04 },
  lab: { performanceScore: 88, audits: { viewport: true } },
  anonymous: false,
};

const ENTITY: EntitySnapshot = {
  brandName: "Acme Corp",
  fetchedAt: "2026-02-01T00:00:00.000Z",
  match: "official-website",
  wikidata: { qid: "Q1", officialWebsite: "https://acme.example", officialWebsiteMatchesClient: true, referencedStatementCount: 7, statementCount: 12, wikipediaLanguages: ["en"], candidatesConsidered: 1 },
  wikipedia: { language: "en", title: "Acme Corp", extractLength: 900, nonStub: true },
};

async function offlineAudit(): Promise<OnPageAuditSnapshot> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-geo-measure-"));
  try {
    const outcome = await createAuditOnPage(new WorkspaceStore(rootDir), createOfflineScraper({ documentsPerQuery: 4 })).execute({ seedUrl: "https://acme.example", limit: 4 }, { ctx });
    if (outcome.status !== "success") throw new Error(`audit failed: ${outcome.status}`);
    return outcome.result.snapshot;
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const measuredKeys = (m: Record<string, { coverage: string }>) => Object.entries(m).filter(([, v]) => v.coverage === "measured").map(([k]) => k).sort();

describe("buildTechnicalMeasurements with every real read wired (on-page, Core Web Vitals, entity)", () => {
  it("measures most of the SEO weight instead of the 30% the technical crawl alone covered", async () => {
    const onPage = await offlineAudit();
    const before = evaluateScoreFamily(SEO_BUCKETS, buildTechnicalMeasurements(SEO_BUCKETS, TECHNICAL));
    const after = evaluateScoreFamily(SEO_BUCKETS, buildTechnicalMeasurements(SEO_BUCKETS, { technical: TECHNICAL, onPage, coreWebVitals: CWV, entity: ENTITY, now: NOW }));
    expect(Math.round(before.dataCoveragePct)).toBe(30);
    expect(after.dataCoveragePct).toBeGreaterThanOrEqual(85);
    // Only inputs no read can honestly answer stay unavailable: the GSC opt-out half of GEO-01, the top-10 shingle
    // comparison, and two zero-weight reserve checks that need a status-chain crawl and a rendered DOM.
    const unavailable = after.inputs.filter((i) => i.coverage === "unavailable").map((i) => i.inputKey);
    expect(unavailable).toEqual(["eligibility[4]", "on_page[0]", "hygiene_and_reserve[3]", "hygiene_and_reserve[5]"]);
    expect(after.measuredBasisScore).not.toBeNull();
    expect(after.measuredBasisScore!).toBeGreaterThanOrEqual(after.score);
  });

  it("scores the Core Web Vitals inputs from CrUX p75 field data only, in the units the config's bands expect", () => {
    const m = buildTechnicalMeasurements(SEO_BUCKETS, { coreWebVitals: CWV });
    expect(m["technical_cwv[0]"]).toEqual({ data: { kind: "stepped", value: 1.9 }, coverage: "measured" });
    expect(m["technical_cwv[1]"]).toEqual({ data: { kind: "stepped", value: 120 }, coverage: "measured" });
    expect(m["technical_cwv[2]"]).toEqual({ data: { kind: "stepped", value: 0.04 }, coverage: "measured" });
    // BOTH-19 needs both the pages' viewport meta and the Lighthouse audit — with no pages it stays unavailable.
    expect(m["technical_cwv[3]"]?.coverage).toBe("unavailable");
    // A lab-only run (no field data) measures none of the p75 inputs.
    const { field: _field, ...labOnly } = CWV;
    const lab = buildTechnicalMeasurements(SEO_BUCKETS, { coreWebVitals: labOnly });
    expect(lab["technical_cwv[0]"]?.coverage).toBe("unavailable");
  });

  it("measures the GEO-Readiness structure, evidence, freshness, multimodal and off-site inputs from the fixture pages", async () => {
    const onPage = await offlineAudit();
    const m = buildTechnicalMeasurements(GEO_READINESS_BUCKETS, { technical: TECHNICAL, onPage, coreWebVitals: CWV, entity: ENTITY, now: NOW });
    const keys = measuredKeys(m);
    for (const key of [
      "crawler_snippet_access[0]",
      "crawler_snippet_access[1]",
      "crawler_snippet_access[2]",
      "crawler_snippet_access[4]",
      "extractability_capsule[0]",
      "extractability_capsule[2]",
      "extractability_capsule[3]",
      "extractability_capsule[4]",
      "extractability_capsule[5]",
      "evidence_density[0]",
      "evidence_density[1]",
      "evidence_density[2]",
      "freshness[1]",
      "freshness[2]",
      "multimodal[0]",
      "per_engine_index_reach[3]",
      "offsite_entity_capped[0]",
      "offsite_entity_capped[2]",
      "hygiene[0]",
      "hygiene[1]",
      "hygiene[2]",
    ]) {
      expect(keys, `${key} should be measured`).toContain(key);
    }
    // Honestly still unavailable: NER (GEO-18), the shingle comparison (BOTH-03), Bing/Brave/Google indexation, backlinks, reviews,
    // and GEO-20's body-change leg on a FIRST audit (no previous snapshot to compare against).
    for (const key of ["crawler_snippet_access[3]", "extractability_capsule[1]", "extractability_capsule[6]", "freshness[0]", "per_engine_index_reach[0]", "offsite_entity_capped[1]", "offsite_entity_capped[3]"]) {
      expect(m[key]?.coverage, `${key} should stay unavailable`).toBe("unavailable");
    }
    // The fixture's Organization JSON-LD lists the client's site and Wikidata carries 7 referenced statements: GEO-07 passes, GEO-25 both legs pass.
    expect(m["offsite_entity_capped[2]"]).toEqual({ data: { kind: "boolean", measured: true }, coverage: "measured" });
    expect(m["offsite_entity_capped[0]"]).toEqual({ data: { kind: "multiBool", subBools: [true, true] }, coverage: "measured" });
    // The fixture's pages declare a dateModified of 2026-01-01; measured a month later, entity pages are within 90 days.
    expect(m["freshness[1]"]).toEqual({ data: { kind: "boolean", measured: true }, coverage: "measured" });
  });

  it("measures GEO-20's freshness combine only once a previous audit exists to tell whether the body changed", async () => {
    const onPage = await offlineAudit();
    const first = buildTechnicalMeasurements(GEO_READINESS_BUCKETS, { onPage, now: NOW });
    expect(first["freshness[0]"]?.coverage).toBe("unavailable");
    const second = buildTechnicalMeasurements(GEO_READINESS_BUCKETS, { onPage: { ...onPage, changedSince: { previousAt: "2026-01-15T00:00:00.000Z", pagesCompared: 4, pagesChanged: 1 } }, now: NOW });
    expect(second["freshness[0]"]).toEqual({ data: { kind: "combine", fields: { datemodified_age_days: 31, date_consistent: true, body_changed: true } }, coverage: "measured" });
  });

  it("reports a brand with no matching Wikidata item as a measured failure of the off-site legs, not as unknown", () => {
    const none: EntitySnapshot = { brandName: "Nobody", fetchedAt: "2026-02-01T00:00:00.000Z", match: "none" };
    const m = buildTechnicalMeasurements(GEO_READINESS_BUCKETS, { entity: none });
    expect(m["offsite_entity_capped[0]"]).toEqual({ data: { kind: "multiBool", subBools: [false, false] }, coverage: "measured" });
    expect(m["offsite_entity_capped[2]"]).toEqual({ data: { kind: "boolean", measured: false }, coverage: "measured" });
  });

  it("still accepts the legacy single-snapshot call shape and keeps every input key the config declares", async () => {
    const legacy = buildTechnicalMeasurements(SEO_BUCKETS, TECHNICAL);
    const modern = buildTechnicalMeasurements(SEO_BUCKETS, { technical: TECHNICAL });
    expect(legacy).toEqual(modern);
    const onPage = await offlineAudit();
    const all = buildTechnicalMeasurements(GEO_READINESS_BUCKETS, { technical: TECHNICAL, onPage, coreWebVitals: CWV, entity: ENTITY, now: NOW });
    expect(Object.keys(all).sort()).toEqual(listInputKeys(GEO_READINESS_BUCKETS).map((k) => k.inputKey).sort());
  });

  it("describeMeasuredFacts states what each read saw, in the words a narrative may quote", async () => {
    const onPage = await offlineAudit();
    const facts = describeMeasuredFacts({ technical: TECHNICAL, onPage, coreWebVitals: CWV, entity: ENTITY, now: NOW });
    expect(facts.some((f) => f.startsWith("Technical crawl: 2 of 2"))).toBe(true);
    expect(facts.some((f) => f.includes("robots.txt allows"))).toBe(true);
    expect(facts.some((f) => f.startsWith("On-page audit: 4 pages fetched"))).toBe(true);
    expect(facts.some((f) => f.includes("Core Web Vitals (real users, mobile, p75, site-wide): LCP 1.9s, INP 120ms, CLS 0.04"))).toBe(true);
    expect(facts.some((f) => f.includes("Wikidata item Q1"))).toBe(true);
    expect(describeMeasuredFacts({})).toEqual([]);
  });
});
