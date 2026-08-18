import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { DIMENSION_KEYS, type DimensionScore, type IntelReportOutput } from "@agent-engine/tool-karos-intel";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_ROOT = path.join(HERE, "..", "prompts");

export function makePromptStore(): FilePromptStore {
  return new FilePromptStore(PROMPTS_ROOT);
}

/** A router whose `.complete()` replays a fixed sequence of turns in order. */
export function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouterSequence: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeRouterSequence: completeAlias not used in these tests");
    }),
  } as unknown as ModelRouter;
}

export function finalTurn(output: unknown, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 30,
  });
}

/** Every dimension scored identically — handy when a test only cares about the report shape, not the weighted arithmetic. */
export function flatDimensionScores(score: number): DimensionScore[] {
  return DIMENSION_KEYS.map((dimension) => ({ dimension, score }));
}

/**
 * A fully valid `IntelReportOutput` with no numeric claims anywhere in its
 * analysis prose (so `gate.numbersSourced` trivially passes with "no
 * numeric claims found") — the happy-path fixture. Tests that want to
 * exercise the numbers-sourced gate build their own variant with a
 * deliberately unsourced figure injected into one analysis field.
 */
export function goodIntelReport(overrides: Partial<IntelReportOutput> = {}): IntelReportOutput {
  return {
    dimensionScores: [
      { dimension: "contentMessaging", score: 78 },
      { dimension: "conversion", score: 70 },
      { dimension: "seo", score: 60 },
      { dimension: "geo", score: 50 },
      { dimension: "positioning", score: 85 },
      { dimension: "brand", score: 80 },
      { dimension: "growth", score: 65 },
      { dimension: "social", score: 88 },
    ],
    contentAnalysis: "Acme's blog leans heavily on product-announcement posts and rarely publishes practitioner-voiced content, which reads as less credible to the technical buyers named in the client profile than Rival Corp's engineering-led series.",
    conversionAnalysis: "The signup flow buries the pricing page behind two extra clicks compared to Rival Corp's single-click path called out in the research pull, a meaningful friction point for a self-serve buyer.",
    seoAnalysis: "Acme ranks for its own brand terms but not for the category terms Rival Corp owns, based on the competitive landscape query results.",
    geoAnalysis: "Acme has no visible presence in AI-assistant-cited answers for its category, unlike Rival Corp which the research pull flagged as already appearing in generative answer engines.",
    positioningAnalysis: "Acme positions itself as the affordable option, a lane already crowded by two of the three tracked competitors, leaving little differentiated territory.",
    brandAnalysis: "Acme's brand voice matches its stated brand kit tone consistently across channels, a genuine strength relative to competitors whose voice shifts noticeably between blog and social.",
    growthAnalysis: "Acme's growth motion depends heavily on outbound sales rather than the product-led signals the research pull surfaced for its faster-growing competitors.",
    swot: {
      strengths: [
        "Consistent brand voice across every channel, matching the client's own stated brand kit.",
        "Self-serve pricing is transparent while Rival Corp requires a sales call to see numbers.",
        "Founder-led content on the blog reads as authentic versus competitors' agency-written posts.",
        "No tracked competitor currently contests the client's category-definition claim.",
      ],
      weaknesses: [
        "Signup flow adds unnecessary friction versus the category leader's single-click path.",
        "No visible presence in AI-assistant-cited answers for the category.",
        "Blog leans on product-announcement posts rather than practitioner-voiced content.",
        "Organic search ownership of category terms trails Rival Corp.",
      ],
      opportunities: [
        "No competitor tracked currently owns the GEO / AI-answer-engine presence lane.",
        "Rival Corp's sales-gated pricing leaves a transparent-pricing position open.",
        "Practitioner-voiced content is an unclaimed content lane in this category.",
      ],
      threats: [
        "Two of three tracked competitors already occupy the 'affordable option' positioning lane.",
        "Rival Corp's recent funding round can fund further category-term SEO investment.",
        "Rival Corp's single-click signup path could become the category's default expectation.",
      ],
    },
    recommendations: [
      { number: 1, title: "Cut signup flow to one click", description: "Match the category leader's conversion path directly.", priority: 1, priorityLabel: "High", tag: "quick-win" },
      { number: 2, title: "Build a GEO presence plan", description: "No tracked competitor currently owns this lane.", priority: 2, priorityLabel: "Medium", tag: "strategic" },
    ],
    competitorRankings: [
      { company: "Rival Corp", score: 78, grade: "B", rank: 1, bestDimension: "conversion", weakestDimension: "brand" },
    ],
    competitors: [
      {
        company: "Rival Corp",
        marketTier: "Leader",
        overlap: "High",
        deepDive: true,
        positioning: "Same target segment, same core self-serve product",
        keyStrengths: ["Sales-gated pricing signals enterprise-readiness", "Established category-term SEO footprint"],
        keyWeaknesses: ["Inconsistent brand voice across channels", "Multi-step signup flow"],
        source: "report",
      },
    ],
    brandSynchronizationUpdate:
      "The competitive scan validates the client's confident, no-jargon brand voice as a genuine differentiator against Rival Corp's inconsistent tone across channels — no brand guideline change is needed here. The open GEO/AI-answer-engine lane is a brand-extension opportunity: the existing voice should carry directly into that surface rather than adopting a different register for it.",
    ...overrides,
  };
}

export interface TestEnvironment {
  rootDir: string;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  cleanup: () => Promise<void>;
}

export async function setupTestEnvironment(opts: { withProfile?: boolean } = {}): Promise<TestEnvironment> {
  const withProfile = opts.withProfile ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "intel-report-agent-test-"));
  const store = new WorkspaceStore(rootDir);
  const tools = createAllKarosTools(store);

  if (withProfile) {
    await store.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  }
  await store.writeJson("acme", ["client", "brand"], { voice: "confident, no jargon", forbiddenTerms: ["guaranteed", "the best", "#1"] });
  await store.writeJson("acme", ["client", "competitors"], [{ name: "Rival Corp", website: "https://rivalcorp.example.com" }]);

  return {
    rootDir,
    store,
    tools,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}
