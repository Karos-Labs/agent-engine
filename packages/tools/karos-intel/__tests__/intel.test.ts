import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createWriteReport } from "../src/write-report.js";
import { createGetReport } from "../src/get-report.js";
import { createMemoryClientReportStore } from "../src/client-report-store.js";
import { computeOverallScore, gradeFor } from "../src/scoring.js";
import { DIMENSION_KEYS, type DimensionScore, type IntelReportOutput } from "../src/types.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring", metadata: {} };

function perfectDimensionScores(score: number): DimensionScore[] {
  return DIMENSION_KEYS.map((dimension) => ({ dimension, score }));
}

function baseReport(overrides: Partial<IntelReportOutput> = {}): IntelReportOutput {
  return {
    dimensionScores: perfectDimensionScores(80),
    contentAnalysis: "content analysis prose",
    conversionAnalysis: "conversion analysis prose",
    seoAnalysis: "seo analysis prose",
    geoAnalysis: "geo analysis prose",
    positioningAnalysis: "positioning analysis prose",
    brandAnalysis: "brand analysis prose",
    growthAnalysis: "growth analysis prose",
    swot: {
      strengths: ["s1", "s2", "s3", "s4"],
      weaknesses: ["w1", "w2", "w3", "w4"],
      opportunities: ["o1", "o2", "o3"],
      threats: ["t1", "t2", "t3"],
    },
    recommendations: [{ number: 1, title: "Do X", description: "", priority: 1, priorityLabel: "High", tag: "quick-win" }],
    competitorRankings: [],
    competitors: [{ company: "Acme Rival", marketTier: "Challenger", overlap: "Medium", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "report" }],
    brandSynchronizationUpdate: "brand synchronization update prose",
    ...overrides,
  };
}

describe("computeOverallScore / gradeFor (DEFAULT_INTEL_PROMPT scoring methodology, ported verbatim)", () => {
  it("weights the 8 dimensions to sum to 100 and computes the exact legacy formula", () => {
    const scores: DimensionScore[] = [
      { dimension: "contentMessaging", score: 90 }, // *15
      { dimension: "conversion", score: 80 }, // *15
      { dimension: "seo", score: 70 }, // *12
      { dimension: "geo", score: 60 }, // *8
      { dimension: "positioning", score: 85 }, // *15
      { dimension: "brand", score: 75 }, // *10
      { dimension: "growth", score: 65 }, // *10
      { dimension: "social", score: 95 }, // *15
    ];
    // (90*15+80*15+70*12+60*8+85*15+75*10+65*10+95*15)/100
    const expected = Math.round((90 * 15 + 80 * 15 + 70 * 12 + 60 * 8 + 85 * 15 + 75 * 10 + 65 * 10 + 95 * 15) / 100);
    const result = computeOverallScore(scores);
    expect(result.overallScore).toBe(expected);
  });

  it("throws rather than silently defaulting when a dimension is missing", () => {
    const scores = perfectDimensionScores(80).filter((d) => d.dimension !== "geo");
    expect(() => computeOverallScore(scores)).toThrow(/geo/);
  });

  it("grade bands: A>=85, B>=70, C>=55, D>=40, else F", () => {
    expect(gradeFor(85)).toBe("A");
    expect(gradeFor(84)).toBe("B");
    expect(gradeFor(70)).toBe("B");
    expect(gradeFor(69)).toBe("C");
    expect(gradeFor(55)).toBe("C");
    expect(gradeFor(54)).toBe("D");
    expect(gradeFor(40)).toBe("D");
    expect(gradeFor(39)).toBe("F");
    expect(gradeFor(0)).toBe("F");
  });
});

describe("intel.writeReport / intel.getReport", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: { "intel.writeReport": ReturnType<typeof createWriteReport>; "intel.getReport": ReturnType<typeof createGetReport> };

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-intel-"));
    store = new WorkspaceStore(rootDir);
    // SCRUM-267: `intel.writeReport` now requires a client-report store — the
    // portal's `clientReports/{clientId}` document is the deliverable, and the
    // tool reports `not_available` rather than degrading to a workspace-only
    // write (which is the defect the ticket names). Tests get the in-memory one.
    tools = {
      "intel.writeReport": createWriteReport(store, createMemoryClientReportStore()),
      "intel.getReport": createGetReport(store),
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("returns not_available before any report has been written", async () => {
    const outcome = await tools["intel.getReport"]!.execute({}, { ctx });
    expect(outcome.status).toBe("not_available");
  });

  it("computes and persists overallScore/overallGrade deterministically, never trusting model-supplied arithmetic", async () => {
    const outcome = await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.overallScore).toBe(80);
    expect(outcome.result.overallGrade).toBe("B");

    const read = await tools["intel.getReport"]!.execute({}, { ctx });
    expect(read.status).toBe("success");
    if (read.status !== "success") throw new Error("unreachable");
    expect(read.result.report.overallScore).toBe(80);
    expect(read.result.report.overallGrade).toBe("B");
  });

  it("is a full overwrite on re-write (legacy upsertClientReport semantics), preserving the original createdAt", async () => {
    await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    await tools["intel.writeReport"]!.execute(baseReport({ contentAnalysis: "updated prose" }), { ctx });

    const read = await tools["intel.getReport"]!.execute({}, { ctx });
    if (read.status !== "success") throw new Error("unreachable");
    expect(read.result.report.contentAnalysis).toBe("updated prose");
    expect(read.result.report.createdAt).toBe(new Date("2026-01-01T00:00:00Z").getTime());
    expect(read.result.report.updatedAt).toBe(new Date("2026-02-01T00:00:00Z").getTime());
  });

  it("replaces only source:'report' competitor rows, preserving manually-added rows across regeneration", async () => {
    await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    // Simulate a human manually adding a competitor row directly into the store, as the product allows.
    const existing = (await store.readJson<Array<{ company: string; source: string }>>("acme", ["intel", "competitors"])) ?? [];
    await store.writeJson("acme", ["intel", "competitors"], [...existing, { company: "Manual Co", marketTier: "Niche", overlap: "Low", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "manual" }]);

    await tools["intel.writeReport"]!.execute(baseReport({ competitors: [{ company: "New Rival", marketTier: "Leader", overlap: "High", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "report" }] }), { ctx });

    const read = await tools["intel.getReport"]!.execute({}, { ctx });
    if (read.status !== "success") throw new Error("unreachable");
    const companies = read.result.competitors.map((c) => c.company).sort();
    expect(companies).toEqual(["Manual Co", "New Rival"].sort());
    expect(read.result.competitors.find((c) => c.company === "Manual Co")?.source).toBe("manual");
    expect(read.result.competitors.find((c) => c.company === "New Rival")?.source).toBe("report");
  });

  it("forces source:'report' on incoming competitor rows even if the caller claims 'manual'", async () => {
    await tools["intel.writeReport"]!.execute(
      baseReport({ competitors: [{ company: "Sneaky Co", marketTier: "Other", overlap: "Low", deepDive: false, keyStrengths: [], keyWeaknesses: [], source: "manual" }] }),
      { ctx },
    );
    const read = await tools["intel.getReport"]!.execute({}, { ctx });
    if (read.status !== "success") throw new Error("unreachable");
    expect(read.result.competitors[0]!.source).toBe("report");
  });
});
