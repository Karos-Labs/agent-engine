import { describe, expect, it } from "vitest";
import { GEO_READINESS_BUCKETS, SEO_BUCKETS } from "@agent-engine/tool-karos-seo-geo";
import type { TechnicalSeoSnapshot } from "@agent-engine/tools";
import { buildTechnicalMeasurements, buildUnavailableMeasurements } from "../src/workflow/measurements.js";

const CLEAN_SNAPSHOT: TechnicalSeoSnapshot = {
  seedUrl: "https://acme.example",
  robots: {
    url: "https://acme.example/robots.txt",
    status: 200,
    groups: [{ userAgent: "*", disallow: [], allow: [] }],
    sitemaps: ["https://acme.example/sitemap.xml"],
  },
  sitemap: {
    url: "https://acme.example/sitemap.xml",
    status: 200,
    entries: [{ url: "https://acme.example/" }, { url: "https://acme.example/about" }],
  },
  pages: [
    { url: "https://acme.example/", status: 200, noindex: false },
    { url: "https://acme.example/about", status: 200, noindex: false },
  ],
  truncated: false,
};

describe("T-A2/SCRUM-236: buildTechnicalMeasurements derives real measurements from a crawl snapshot", () => {
  it("returns every input unavailable when there is no snapshot at all (no scraper configured)", () => {
    const measurements = buildTechnicalMeasurements(SEO_BUCKETS, undefined);
    expect(Object.values(measurements).every((m) => m.coverage === "unavailable")).toBe(true);
    expect(measurements).toEqual(buildUnavailableMeasurements(SEO_BUCKETS));
  });

  it("marks the eligibility bucket's real inputs measured, with norm 1 on an all-clean crawl", () => {
    const measurements = buildTechnicalMeasurements(SEO_BUCKETS, CLEAN_SNAPSHOT);
    expect(measurements["eligibility[0]"]).toEqual({ data: { kind: "ratio", value: 1 }, coverage: "measured" });
    expect(measurements["eligibility[1]"]).toEqual({ data: { kind: "ratio", value: 1 }, coverage: "measured" });
    expect(measurements["eligibility[2]"]).toEqual({ data: { kind: "ratio", value: 1 }, coverage: "measured" });
    expect(measurements["eligibility[3]"]).toEqual({ data: { kind: "boolean", measured: true }, coverage: "measured" });
    // GEO-01 (index 4) needs a GSC connector this environment doesn't have — still honestly unavailable.
    expect(measurements["eligibility[4]"]?.coverage).toBe("unavailable");
    // Every other bucket (technical_cwv, on_page, ...) is untouched — no real CWV/on-page tool exists yet.
    expect(measurements["technical_cwv[0]"]?.coverage).toBe("unavailable");
  });

  it("marks crawler_snippet_access's real inputs measured, including the 5-leg robots multi_bool", () => {
    const measurements = buildTechnicalMeasurements(GEO_READINESS_BUCKETS, CLEAN_SNAPSHOT);
    expect(measurements["crawler_snippet_access[0]"]).toEqual({ data: { kind: "ratio", value: 1 }, coverage: "measured" });
    expect(measurements["crawler_snippet_access[1]"]).toEqual({ data: { kind: "ratio", value: 1 }, coverage: "measured" });
    expect(measurements["crawler_snippet_access[2]"]).toEqual({
      data: { kind: "multiBool", subBools: [true, true, true, true, true] },
      coverage: "measured",
    });
  });

  it("reports a page HTTP 200 with a noindex header as NOT eligible, distinctly from a 401/403 auth-walled page", () => {
    const mixedSnapshot: TechnicalSeoSnapshot = {
      ...CLEAN_SNAPSHOT,
      pages: [
        { url: "https://acme.example/", status: 200, noindex: false },
        { url: "https://acme.example/noindexed", status: 200, noindex: true },
        { url: "https://acme.example/members", status: 401, noindex: undefined },
      ],
    };
    const measurements = buildTechnicalMeasurements(SEO_BUCKETS, mixedSnapshot);
    // Full-snippet ratio: only known-noindex pages count (2 known, 1 reachable-and-not-noindexed).
    expect(measurements["eligibility[0]"]).toEqual({ data: { kind: "ratio", value: 0.5 }, coverage: "measured" });
    // Anonymous-crawlable ratio: counts ALL 3 pages, only the 401 is auth-walled.
    expect(measurements["eligibility[1]"]).toEqual({ data: { kind: "ratio", value: 2 / 3 }, coverage: "measured" });
    // Sitemap validity boolean now fails: one of the known-noindex pages IS noindexed.
    expect(measurements["eligibility[3]"]).toEqual({ data: { kind: "boolean", measured: false }, coverage: "measured" });
  });

  it("leaves the robots-legs multi_bool unavailable when robots.txt could not be fetched at all", () => {
    // `robots` is optional (`exactOptionalPropertyTypes`), so it must be
    // OMITTED to represent "could not be fetched," never assigned `undefined`.
    const { robots: _robots, ...withoutRobots } = CLEAN_SNAPSHOT;
    const noRobots: TechnicalSeoSnapshot = withoutRobots;
    const measurements = buildTechnicalMeasurements(GEO_READINESS_BUCKETS, noRobots);
    expect(measurements["crawler_snippet_access[2]"]?.coverage).toBe("unavailable");
  });
});
