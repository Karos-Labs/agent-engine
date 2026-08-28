import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosIntelTools } from "../src/index.js";
import { createMemoryClientReportStore, createFirestoreClientReportStore } from "../src/client-report-store.js";
import { assertPortalClientReportShape, buildClientReport } from "../src/build-client-report.js";
import { CLIENT_REPORTS_COLLECTION, DIMENSION_KEYS, type IntelReportOutput } from "../src/types.js";

/**
 * SCRUM-267 (T-A18) — "Structured intel output".
 *
 * The ticket in one line: `intel.writeReport` wrote to the WORKSPACE and not to
 * Firestore, and `ClientReportRecord` was not the portal's `ClientReport` (no
 * `reportHtml`). Tomer's 2026-08-28 decision 5 makes both halves load-bearing:
 * the new agent-based onboarding is built from this agent, so "the output must
 * be written in EXACTLY the same shape, to EXACTLY the same Firestore location
 * the system already reads from. The wrapper and every existing query stay
 * identical."
 *
 * THE PORTAL FACTS THESE ASSERTIONS ARE PINNED TO, read from the checked-out
 * karosCMO source, not from the ticket text:
 *   - `ClientReport`               src/lib/types.ts       lines 1572-1613
 *   - `col.clientReports()`        src/lib/data.ts        line  105
 *   - `getClientReport(clientId)`  src/lib/data.ts        line  1369
 *   - `upsertClientReport`         src/lib/data.ts        lines 1374-1376
 *       `col.clientReports().doc(data.clientId).set({ id: data.clientId, ...data })`
 */

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring", metadata: {} };

/** Exactly the required key list from the portal's `ClientReport` interface. */
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

/** Every key the portal's `ClientReport` declares — required plus optional. */
const PORTAL_ALL_KEYS = new Set([
  ...PORTAL_REQUIRED_KEYS,
  "url",
  "businessType",
  "founded",
  "authorization",
  "cnpj",
  "minInvestment",
  "techStack",
  "reportStatus",
  "brandVoiceRows",
  "brandVoiceArchetypes",
  "brandVoiceTerritory",
  "customerSentiment",
  "whitespaceOpportunities",
  "reportHtml",
  "pdfUrl",
]);

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

describe("SCRUM-267 — intel.writeReport persists the PORTAL's ClientReport, to the portal's location", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let clientReports: ReturnType<typeof createMemoryClientReportStore>;
  let tools: ReturnType<typeof createKarosIntelTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-intel-portal-"));
    store = new WorkspaceStore(rootDir);
    clientReports = createMemoryClientReportStore();
    tools = createKarosIntelTools(store, clientReports);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("writes a document to the client-report store, not only to the workspace", async () => {
    const outcome = await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    expect(outcome.status).toBe("success");
    // The portal reads by clientId; the engine's tenant key is that clientId.
    expect([...clientReports.docs.keys()]).toEqual(["acme"]);
  });

  it("the persisted document IS the portal's ClientReport — every required field present, reportHtml included", async () => {
    await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    const doc = clientReports.docs.get("acme") as unknown as Record<string, unknown>;
    expect(doc).toBeDefined();

    for (const key of PORTAL_REQUIRED_KEYS) {
      expect(`${key}=${doc[key] === undefined ? "MISSING" : "present"}`).toBe(`${key}=present`);
    }
    // The two the ticket names by hand.
    expect(typeof doc["reportHtml"]).toBe("string");
    expect(doc["clientId"]).toBe("acme");
    expect(doc["id"]).toBe("acme");
    // `DimensionScore` on the portal is { dimension, weight, score } — three
    // fields. `weight` comes from the fixed methodology, never the model.
    const dims = doc["dimensionScores"] as Array<Record<string, unknown>>;
    expect(dims.map((d) => d["weight"])).not.toContain(undefined);
    expect(dims.find((d) => d["dimension"] === "seo")?.["weight"]).toBe(12);
    // rawMarkdown is REQUIRED on the portal's interface (line 1609) and carries
    // the sections the interface has no field for.
    expect(String(doc["rawMarkdown"])).toContain("Brand Synchronization Update");
  });

  it("invents no field the portal's ClientReport does not declare", async () => {
    await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    const doc = clientReports.docs.get("acme") as unknown as Record<string, unknown>;
    const undeclared = Object.keys(doc).filter((k) => !PORTAL_ALL_KEYS.has(k));
    expect(undeclared).toEqual([]);
  });

  it("preserves createdAt across a regeneration and refreshes updatedAt (legacy upsert semantics)", async () => {
    await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
    const first = clientReports.docs.get("acme")!;
    vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
    await tools["intel.writeReport"]!.execute(baseReport({ contentAnalysis: "fresher prose" }), { ctx });
    const second = clientReports.docs.get("acme")!;
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(second.contentAnalysis).toBe("fresher prose");
  });

  it("escapes model-authored prose in reportHtml — it is served to clients inline", async () => {
    await tools["intel.writeReport"]!.execute(baseReport({ contentAnalysis: '<script>alert("x")</script>' }), { ctx });
    const html = String(clientReports.docs.get("acme")!.reportHtml);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("SCRUM-267 — the Firestore location, byte for byte against karosCMO's upsertClientReport", () => {
  it("writes clientReports/{clientId} with id = clientId, no merge", async () => {
    const calls: Array<{ collection: string; doc: string; data: Record<string, unknown>; options: unknown }> = [];
    const db = {
      collection(name: string) {
        return {
          doc(id: string) {
            return {
              async get() {
                return { exists: false, data: () => undefined };
              },
              async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
                calls.push({ collection: name, doc: id, data, options });
                return undefined;
              },
            };
          },
        };
      },
    };
    const fsStore = createFirestoreClientReportStore(db);
    const report = buildClientReport(baseReport(), {
      clientId: "client_abc",
      overallScore: 80,
      overallGrade: "B",
      createdAt: 1,
      updatedAt: 2,
    });
    await fsStore.write(report);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.collection).toBe(CLIENT_REPORTS_COLLECTION);
    expect(CLIENT_REPORTS_COLLECTION).toBe("clientReports");
    expect(calls[0]!.doc).toBe("client_abc");
    expect(calls[0]!.data["id"]).toBe("client_abc");
    // Legacy `set()` takes no options — a full replace, not a merge. A merge
    // would leave last month's sections alive underneath this month's report.
    expect(calls[0]!.options).toBeUndefined();
  });
});

describe("SCRUM-267 — the guards, shown failing", () => {
  it("intel.writeReport reports not_available when no client-report store is wired (never a silent workspace-only write)", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-intel-unwired-"));
    try {
      const tools = createKarosIntelTools(new WorkspaceStore(rootDir));
      const outcome = await tools["intel.writeReport"]!.execute(baseReport(), { ctx });
      expect(outcome.status).toBe("not_available");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("the shape guard fails on a MISSING required portal field", () => {
    const doc = buildClientReport(baseReport(), { clientId: "acme", overallScore: 80, overallGrade: "B", createdAt: 1, updatedAt: 2 }) as unknown as Record<string, unknown>;
    delete doc["rawMarkdown"];
    expect(() => assertPortalClientReportShape(doc)).toThrow(/missing required portal field\(s\): rawMarkdown/);
  });

  it("the shape guard fails on a field the portal does not declare — the exact drift that produced this ticket", () => {
    const doc = buildClientReport(baseReport(), { clientId: "acme", overallScore: 80, overallGrade: "B", createdAt: 1, updatedAt: 2 }) as unknown as Record<string, unknown>;
    doc["brandSynchronizationUpdate"] = "prose the portal has no field for";
    expect(() => assertPortalClientReportShape(doc)).toThrow(/does not declare: brandSynchronizationUpdate/);
  });

  it("the shape guard fails on an explicit undefined optional — Firestore rejects undefined values", () => {
    const doc = buildClientReport(baseReport(), { clientId: "acme", overallScore: 80, overallGrade: "B", createdAt: 1, updatedAt: 2 }) as unknown as Record<string, unknown>;
    doc["pdfUrl"] = undefined;
    expect(() => assertPortalClientReportShape(doc)).toThrow(/explicit undefined/);
  });

  it("the guard PASSES on the document the builder actually produces (so the three failures above are real, not vacuous)", () => {
    const doc = buildClientReport(baseReport(), { clientId: "acme", overallScore: 80, overallGrade: "B", createdAt: 1, updatedAt: 2 }) as unknown as Record<string, unknown>;
    expect(() => assertPortalClientReportShape(doc)).not.toThrow();
  });
});
