import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosIntelTools } from "../src/index.js";
import { DIMENSION_KEYS, type IntelReportOutput } from "../src/types.js";

/**
 * SCRUM-267 (T-A18) — the regression test, written against the PORTAL's
 * contract only.
 *
 * This file deliberately imports nothing that SCRUM-267 added, so it runs
 * unchanged against the code before the fix and after it. Before: every
 * assertion below fails, because `intel.writeReport` wrote a
 * `ClientReportRecord` (the model's structured output plus four bookkeeping
 * fields) to the workspace and nowhere else. After: they pass, because it
 * writes the portal's `ClientReport` to the portal's `clientReports` document.
 *
 * The expected shape is `ClientReport` in `karosCMO/src/lib/types.ts` lines
 * 1572-1613, read from the checked-out portal source.
 */

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring", metadata: {} };

const PORTAL_REQUIRED_KEYS = [
  "id",
  "clientId",
  "reportDate",
  "overallScore",
  "overallGrade",
  "dimensionScores",
  "competitorRankings",
  "contentAnalysis",
  "conversionAnalysis",
  "seoAnalysis",
  "geoAnalysis",
  "positioningAnalysis",
  "brandAnalysis",
  "growthAnalysis",
  "swot",
  "recommendations",
  "rawMarkdown",
  "createdAt",
  "updatedAt",
];

function baseReport(overrides: Partial<IntelReportOutput> = {}): IntelReportOutput {
  return {
    dimensionScores: DIMENSION_KEYS.map((dimension) => ({ dimension, score: 80 })),
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
    competitors: [],
    brandSynchronizationUpdate: "brand synchronization update prose",
    ...overrides,
  } as IntelReportOutput;
}

/**
 * A client-report store with no dependency on this package's own types — it is
 * the second constructor argument on the fixed code and simply an ignored extra
 * argument on the broken code, which is what lets one file run against both.
 */
function fakeClientReportStore() {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    name: "fake",
    async read(clientId: string) {
      return docs.get(clientId);
    },
    async write(report: Record<string, unknown>) {
      docs.set(String(report["clientId"]), report);
    },
  };
}

describe("SCRUM-267 regression — a written Intel Report is a portal ClientReport, in the portal's collection", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let clientReports: ReturnType<typeof fakeClientReportStore>;
  let tools: ReturnType<typeof createKarosIntelTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-intel-contract-"));
    store = new WorkspaceStore(rootDir);
    clientReports = fakeClientReportStore();
    tools = createKarosIntelTools(store, clientReports as unknown as Parameters<typeof createKarosIntelTools>[1]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("reaches the portal's client-report store at all (defect 1: it wrote to the WORKSPACE and not to Firestore)", async () => {
    const outcome = await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    expect(outcome.status).toBe("success");
    expect([...clientReports.docs.keys()]).toEqual(["acme"]);
  });

  it("carries every field the portal's ClientReport requires, including reportHtml (defect 2)", async () => {
    await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    const read = await tools["intel.getReport"]!.execute({}, { ctx });
    expect(read.status).toBe("success");
    if (read.status !== "success") throw new Error("unreachable");
    const doc = (read.result as { report: Record<string, unknown> }).report;

    const missing = PORTAL_REQUIRED_KEYS.filter((k) => doc[k] === undefined);
    expect(missing).toEqual([]);
    expect(typeof doc["reportHtml"]).toBe("string");
    expect(doc["clientId"]).toBe("acme");
    expect(doc["id"]).toBe("acme");
  });

  it("gives every dimension score the portal's third field, `weight`, from the fixed methodology", async () => {
    await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    const read = await tools["intel.getReport"]!.execute({}, { ctx });
    if (read.status !== "success") throw new Error("unreachable");
    const dims = (read.result as { report: Record<string, unknown> }).report["dimensionScores"] as Array<Record<string, unknown>>;
    expect(dims.filter((d) => d["weight"] === undefined)).toEqual([]);
    expect(dims.find((d) => d["dimension"] === "seo")?.["weight"]).toBe(12);
    expect(dims.reduce((sum, d) => sum + Number(d["weight"]), 0)).toBe(100);
  });

  it("does not put a field on the document that the portal's ClientReport never declares", async () => {
    await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    const doc = clientReports.docs.get("acme") ?? {};
    expect(Object.keys(doc)).not.toContain("brandSynchronizationUpdate");
    expect(String(doc["rawMarkdown"] ?? "")).toContain("Brand Synchronization Update");
  });
});
