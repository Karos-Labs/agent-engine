import { describe, expect, it, vi } from "vitest";
import type { AgentContext, AgentTool, AgentToolRegistry, CompletionResult, ModelRouter, PromptStore } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "../src/index.js";
import {
  TrendCandidateSchema,
  buildTrendQueries,
  buildTrendScoutSystemPrompt,
  candidateEngine,
  hasTopicSignalMaterial,
  mergeResearchPulls,
  parseContentModeFromSummary,
  resolveSocialMedia,
  analyzeAttachedMedia,
  runTrendScout,
  selectContentMode,
  selectTrendCandidate,
  trendCandidateForDrafting,
  type TopicSignalsForScout,
  type TrendCandidate,
  type TrendScoutInput,
  type ResearchPullResult,
} from "../src/index.js";

/**
 * The shared social primitives (2026-09): trend queries, the merged pull, the
 * content-mode rotation, brand-fit selection, and the media resolver's tier
 * order. The agents' own suites prove these are wired; this file proves the
 * rules themselves.
 */

const pull = (query: string, documents: unknown[]): ResearchPullResult =>
  ({ runId: `r-${query}`, query, fromCache: false, result: { provider: "stub", documents } }) as ResearchPullResult;

describe("buildTrendQueries", () => {
  it("asks the strategist's questions, most specific first, de-duplicated and capped", () => {
    const queries = buildTrendQueries({
      industry: "B2B SaaS",
      companyName: "Acme",
      configuredQueries: ["OpenAI new model", "Israeli startup exit", "openai new model"],
      requestedTopic: "four-day weeks",
    });
    expect(queries[0]).toBe("four-day weeks");
    expect(queries).toContain("OpenAI new model");
    expect(queries).not.toContain("openai new model");
    expect(queries).toHaveLength(4);
  });

  it("falls back to the industry defaults, and to nothing when there is nothing to ask about", () => {
    expect(buildTrendQueries({ industry: "fintech" })).toEqual(["fintech news this week", "fintech launch announcement funding acquisition report"]);
    expect(buildTrendQueries({})).toEqual([]);
  });
});

describe("mergeResearchPulls", () => {
  it("de-duplicates documents by URL, keeps the first query as the fallback topic, and unions prior topics", () => {
    const merged = mergeResearchPulls([
      pull("a", [{ title: "One", url: "https://x/1", content: "c" }, { title: "Two", url: "https://x/2" }]),
      pull("b", [{ title: "One again", url: "https://X/1" }, { title: "Three", url: "https://x/3" }]),
    ]);
    expect(merged.query).toBe("a");
    expect(merged.result?.documents?.map((d) => d.title)).toEqual(["One", "Two", "Three"]);
  });
});

describe("selectContentMode", () => {
  it("never repeats the prior mode, prefers the least used, breaks ties by weight, and honours a request", () => {
    expect(selectContentMode([])).toBe("deep-value");
    expect(selectContentMode(["deep-value"])).toBe("hot-news");
    expect(selectContentMode(["deep-value", "hot-news"])).toBe("open-discussion");
    expect(selectContentMode(["deep-value", "hot-news", "open-discussion"])).toBe("deep-value");
    expect(selectContentMode(["deep-value"], "deep-value")).toBe("deep-value");
    expect(selectContentMode(["deep-value"], "not-a-mode")).toBe("hot-news");
  });

  it("parses the mode back out of a decision summary wherever it sits in the parenthesis", () => {
    expect(parseContentModeFromSummary('Posted about "x" (lane: knowledge, angle: data-point, mode: hot-news)')).toBe("hot-news");
    expect(parseContentModeFromSummary('Posted about "x" (archetype: teardown-framework)')).toBeUndefined();
  });
});

describe("selectTrendCandidate", () => {
  const candidate = (over: Partial<TrendCandidate>): TrendCandidate => ({
    topic: "t",
    headline: "h",
    mode: "deep-value",
    brandFit: 4,
    interest: 3,
    brandFitReason: "r",
    angle: "a",
    hook: "k",
    whyNow: "w",
    sourceUrls: [],
    hasNumbers: false,
    mediaHint: "none",
    ...over,
  });

  it("refuses everything below the brand-fit floor, prefers the requested mode, then fit, then numbers", () => {
    expect(selectTrendCandidate([candidate({ brandFit: 2 }), candidate({ brandFit: 1 })], "hot-news")).toBeUndefined();
    const picked = selectTrendCandidate(
      [
        candidate({ topic: "deep-5", mode: "deep-value", brandFit: 5 }),
        candidate({ topic: "hot-3", mode: "hot-news", brandFit: 3 }),
        candidate({ topic: "hot-4-numbers", mode: "hot-news", brandFit: 4, hasNumbers: true }),
        candidate({ topic: "hot-4", mode: "hot-news", brandFit: 4 }),
      ],
      "hot-news",
    );
    expect(picked?.topic).toBe("hot-4-numbers");
    // No candidate in the requested mode: the rotation is a steer, not a wall.
    expect(selectTrendCandidate([candidate({ topic: "deep-5", brandFit: 5 })], "hot-news")?.topic).toBe("deep-5");
  });

  it("skips a candidate that overlaps a subject already covered", () => {
    const picked = selectTrendCandidate([candidate({ topic: "four-day weeks", brandFit: 5 }), candidate({ topic: "onboarding", brandFit: 4 })], "deep-value", {
      avoidTopics: ['Posted about "four-day weeks" (lane: knowledge)'],
    });
    expect(picked?.topic).toBe("onboarding");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RFC-13 §I — the topic-engine tag and the scout's new inputs, both additive:
// X and LinkedIn pass neither and must be unaffected.
// ─────────────────────────────────────────────────────────────────────────────

/** A candidate exactly as a scout answered before RFC-13 §I existed — no `engine`, no `evidenceRefs`. */
const V1_CANDIDATE = {
  topic: "automated reporting",
  headline: "Teams reclaimed four hours a week",
  mode: "deep-value",
  brandFit: 4,
  brandFitReason: "the client sells this",
  angle: "the hours come back when the report writes itself",
  hook: "Your status meeting is a report nobody wrote.",
  whyNow: "the survey published this week",
};

describe("TrendCandidateSchema: the engine tag is additive", () => {
  it("still validates a pre-Phase-1 candidate, which reads as niche-news", () => {
    const parsed = TrendCandidateSchema.parse(V1_CANDIDATE);
    expect(parsed.engine).toBeUndefined();
    expect(parsed.evidenceRefs).toBeUndefined();
    // The accessor, not the raw field, is what callers read — so an untagged
    // candidate is attributed to the only engine that could have produced it.
    expect(candidateEngine(parsed)).toBe("niche-news");
    // The other defaults still apply, unchanged.
    expect(parsed.interest).toBe(3);
    expect(parsed.mediaHint).toBe("none");
  });

  it("carries a tagged candidate's engine and evidence, and refuses an engine it does not know", () => {
    const tagged = TrendCandidateSchema.parse({ ...V1_CANDIDATE, engine: "own-assets", evidenceRefs: ["market-strategy#Northwind cut onboarding to 3 days"] });
    expect(candidateEngine(tagged)).toBe("own-assets");
    expect(tagged.evidenceRefs).toEqual(["market-strategy#Northwind cut onboarding to 3 days"]);
    expect(TrendCandidateSchema.safeParse({ ...V1_CANDIDATE, engine: "vibes" }).success).toBe(false);
  });
});

describe("buildTrendScoutSystemPrompt", () => {
  it("tells the scout about the signals, the engine tag and the brief's authority, on every channel", () => {
    for (const channel of ["x", "linkedin", "instagram"] as const) {
      const prompt = buildTrendScoutSystemPrompt(channel);
      expect(prompt).toContain("Candidates may also come from `signals`");
      expect(prompt).toContain("niche-news | reference-accounts | audience-questions | own-assets | evergreen");
      expect(prompt).toContain("`evidenceRefs`");
      expect(prompt).toContain("`clientBrief` is the authority on who the client is");
      // The four new engines cannot honestly fill a "why this week", and the
      // writer reads `whyNow` literally: an evergreen angle or a client
      // document heading dressed as this week's news is a fabrication the
      // copy step cannot catch, because it happened here.
      expect(prompt).toContain("`whyNow` is read literally by the writer");
      expect(prompt).toMatch(/never a date, never "this week"/);
      // And a candidate that rests on a signal must not put it in
      // `sourceUrls`, which the drafting step reads as citable sources.
      expect(prompt).toContain("keeps `sourceUrls` EMPTY");
    }
  });
});

describe("trendCandidateForDrafting", () => {
  it("carries the engine and the evidence refs, so a non-news candidate does not reach the writer disguised as a live story", () => {
    const ownAsset = TrendCandidateSchema.parse({
      ...V1_CANDIDATE,
      engine: "own-assets",
      evidenceRefs: ["market-strategy#Northwind cut onboarding to 3 days"],
      sourceUrls: [],
    });
    const forDrafting = trendCandidateForDrafting(ownAsset);
    expect(forDrafting["engine"]).toBe("own-assets");
    expect(forDrafting["evidenceRefs"]).toEqual(["market-strategy#Northwind cut onboarding to 3 days"]);
    // Everything the writer already read is still there.
    expect(forDrafting["whyNow"]).toBe(ownAsset.whyNow);
    expect(forDrafting["hook"]).toBe(ownAsset.hook);
  });

  it("a v1-shaped candidate reads as niche-news and grows no empty fields", () => {
    const forDrafting = trendCandidateForDrafting(TrendCandidateSchema.parse(V1_CANDIDATE));
    expect(forDrafting["engine"]).toBe("niche-news");
    expect("evidenceRefs" in forDrafting).toBe(false);
  });
});

const EMPTY_SIGNALS: TopicSignalsForScout = { referencePosts: [], audienceQuestions: [], ownAssets: [], evergreen: [] };

const SIGNALS: TopicSignalsForScout = {
  referencePosts: [{ platform: "instagram", handle: "peer", url: "https://peer.test/1", excerpt: "what landed", engagementScore: 0.9 }],
  audienceQuestions: [{ question: "How do agencies price retainers?", url: "https://reddit.com/r/agency/1", community: "reddit.com" }],
  ownAssets: [{ title: "Northwind cut onboarding to 3 days", summary: "case study", sourceRef: "market-strategy#Northwind" }],
  evergreen: ["what practitioners get wrong about retainers"],
};

/**
 * Runs one scout call and returns what reached the model. The agent's input
 * travels as JSON in the turn prompt (`BaseAgent.buildTurnPrompt`), so
 * asserting on it is how "passed through only when present" is pinned.
 */
async function runScoutCapturingInput(overrides: Partial<TrendScoutInput> = {}): Promise<{ output: unknown; inputs: Array<Record<string, unknown>>; calls: number }> {
  const inputs: Array<Record<string, unknown>> = [];
  const router = {
    complete: vi.fn(async (prompt: string): Promise<CompletionResult<unknown>> => {
      inputs.push((JSON.parse(prompt) as { input: Record<string, unknown> }).input);
      return {
        output: { type: "final", output: { candidates: [V1_CANDIDATE], skipped: [] } },
        modelUsed: "gemini-2.5-flash",
        inputTokens: { cached: 0, uncached: 100 },
        outputTokens: 40,
      };
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("completeAlias is not used by the scout");
    }),
  } as unknown as ModelRouter;

  const engine = new WorkflowEngine(new MemoryDurableStepStore());
  const result = await engine.run(
    async (wf) =>
      runTrendScout(wf, { tools: {}, promptStore: {} as unknown as PromptStore, router }, "scout", {
        research: [{ title: "A story", url: "https://example.test/a", excerpt: "text" }],
        channel: "instagram",
        clientProfile: { industry: "B2B SaaS" },
        forbiddenTopics: [],
        today: "2026-09-10",
        ...overrides,
      }),
    { runId: "run_scout", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" },
  );
  if (result.status !== "completed") throw new Error(`unexpected ${result.status}`);
  return { output: result.output, inputs, calls: (router.complete as unknown as { mock: { calls: unknown[] } }).mock.calls.length };
}

describe("runTrendScout: signals and clientBrief", () => {
  it("sends neither field when the caller passes neither — X and LinkedIn's input is byte-identical to before", async () => {
    const { inputs, output } = await runScoutCapturingInput();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty("signals");
    expect(inputs[0]).not.toHaveProperty("clientBrief");
    // The old-shaped candidate the fake model returned still validates.
    expect((output as { candidates: TrendCandidate[] }).candidates).toHaveLength(1);
  });

  it("passes both through verbatim when present", async () => {
    const { inputs } = await runScoutCapturingInput({ signals: SIGNALS, clientBrief: "Client brief (confidence high). Positioning: …" });
    expect(inputs[0]!["signals"]).toEqual(SIGNALS);
    expect(inputs[0]!["clientBrief"]).toBe("Client brief (confidence high). Positioning: …");
  });

  it("scouts on signals alone when the news pull came back empty, and still refuses a call with nothing at all", async () => {
    // A quiet news week (or a scraper outage) must not throw away four engines
    // of evidence the run already paid for.
    const withSignals = await runScoutCapturingInput({ research: [], signals: SIGNALS });
    expect(withSignals.calls).toBe(1);
    expect(withSignals.inputs[0]!["research"]).toEqual([]);

    for (const signals of [undefined, EMPTY_SIGNALS]) {
      const nothing = await runScoutCapturingInput({ research: [], ...(signals !== undefined ? { signals } : {}) });
      expect(nothing.calls).toBe(0);
      expect(nothing.output).toBeUndefined();
    }
    expect(hasTopicSignalMaterial(EMPTY_SIGNALS)).toBe(false);
    expect(hasTopicSignalMaterial(SIGNALS)).toBe(true);
    expect(hasTopicSignalMaterial(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The media resolver's tier order, driven with fake tools
// ─────────────────────────────────────────────────────────────────────────────

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", metadata: {} };

function fakeTool(name: string, calls: string[], result: unknown | ((args: unknown) => unknown)): AgentTool {
  return {
    name,
    version: "1.0.0",
    inputSchema: { parse: (v: unknown) => v } as never,
    async execute(args: unknown) {
      calls.push(name);
      const r = typeof result === "function" ? (result as (a: unknown) => unknown)(args) : result;
      return r as never;
    },
  } as unknown as AgentTool;
}

const ok = (result: unknown) => ({ status: "success", result });
const inspection = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  description: "d",
  subjects: [],
  textInImage: [],
  mood: "",
  hasPeople: false,
  looksLikeScreenshot: false,
  hasWatermark: false,
  looksAiGenerated: false,
  quality: "usable",
  qualityReason: "",
  fitsBrief: true,
  fitScore: 4,
  fitReason: "fits",
  ...over,
});

async function runResolver(tools: AgentToolRegistry, brief: unknown, attached?: unknown, extra: { clientMediaOnly?: boolean } = {}) {
  const store = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(store);
  const result = await engine.run(
    async (wf) =>
      resolveSocialMedia(wf, tools, ctx, {
        stepId: "media",
        repoRoot: "/repo",
        platform: "x",
        brief: brief as never,
        attached: attached as never,
        sources: [{ url: "https://example.test/a", title: "A" }],
        postText: "the post",
        ...extra,
      }),
    { runId: "run_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" },
  );
  if (result.status !== "completed") throw new Error(`unexpected ${result.status}`);
  return result.output as { status: string; asset?: { path: string; url?: string; requiresCredit: boolean }; attempts: string[] };
}

describe("resolveSocialMedia", () => {
  it("ships text when the draft asked for no visual, calling no media tool at all", async () => {
    const calls: string[] = [];
    const tools: AgentToolRegistry = { "media.findImages": fakeTool("media.findImages", calls, ok({ candidates: [] })) };
    const plan = await runResolver(tools, { needsVisual: false, kind: "none", rationale: "a take reads better bare" });
    expect(plan.status).toBe("none");
    expect(calls).toEqual([]);
  });

  it("walks screenshot → article → stock → generation, stopping at the first tier vision accepts, and never generates first", async () => {
    const calls: string[] = [];
    const tools: AgentToolRegistry = {
      "media.screenshotPage": fakeTool("media.screenshotPage", calls, { status: "content_fail", reason: "cookie wall" }),
      "media.harvestArticleImages": fakeTool("media.harvestArticleImages", calls, ok({ candidates: [{ path: ".media-cache/run_1/art.png", description: "lead", provider: "article-harvest", licenseConfidence: "unknown", sourceUrl: "https://example.test/a" }], unmet: [] })),
      "media.inspectImages": fakeTool("media.inspectImages", calls, (args: unknown) => {
        const refs = (args as { images: Array<{ ref: string }> }).images.map((i) => i.ref);
        // The article image contradicts the brief; stock fits.
        return ok({ inspections: refs.map((ref) => inspection(ref, ref.startsWith("article") ? { fitScore: 1, fitsBrief: false } : {})), unreadable: [], model: "m" });
      }),
      "media.findImages": fakeTool("media.findImages", calls, ok({ candidates: [{ path: ".media-cache/run_1/stock.jpg", description: "s", provider: "unsplash", licenseConfidence: "blanket" }], unmet: [], provider: "unsplash", providersUsed: ["unsplash"] })),
      "image.generate": fakeTool("image.generate", calls, ok({ candidates: [{ path: ".media-cache/run_1/gen.png", description: "g", provider: "gemini-image", licenseConfidence: "generated" }], unmet: [], model: "m" })),
      "media.stageAsset": fakeTool("media.stageAsset", calls, ok({ url: "https://signed/stock.jpg", gcsUri: "gs://b/stock.jpg", contentType: "image/jpeg", bytes: 1 })),
    };
    const plan = await runResolver(tools, { needsVisual: true, kind: "screenshot", sourceUrl: "https://example.test/a", query: "warehouse team briefing", rationale: "the page is the story" });
    expect(plan.status).toBe("stock");
    expect(plan.asset?.url).toBe("https://signed/stock.jpg");
    expect(plan.asset?.requiresCredit).toBe(false);
    expect(calls).toEqual(["media.screenshotPage", "media.harvestArticleImages", "media.inspectImages", "media.findImages", "media.inspectImages", "media.stageAsset"]);
    expect(calls).not.toContain("image.generate");
  });

  it("generates only as the last resort, with the realism notes, and only for a photo brief", async () => {
    const calls: string[] = [];
    let generateArgs: Record<string, unknown> | undefined;
    const tools: AgentToolRegistry = {
      "media.findImages": fakeTool("media.findImages", calls, { status: "content_fail", reason: "nothing" }),
      "media.harvestArticleImages": fakeTool("media.harvestArticleImages", calls, { status: "content_fail", reason: "no lead image" }),
      "image.generate": fakeTool("image.generate", calls, (args: unknown) => {
        generateArgs = args as Record<string, unknown>;
        return ok({ candidates: [{ path: ".media-cache/run_1/gen.png", description: "g", provider: "gemini-image", licenseConfidence: "generated" }], unmet: [], model: "m" });
      }),
    };
    const plan = await runResolver(tools, { needsVisual: true, kind: "photo", query: "shipping yard at dawn", rationale: "a real scene" });
    expect(plan.status).toBe("generated");
    expect(calls).toEqual(["media.harvestArticleImages", "media.findImages", "image.generate"]);
    expect(String((generateArgs?.["art"] as { notes: string }).notes)).toMatch(/Photorealistic/);
    expect((generateArgs?.["aspectRatio"] as string)).toBe("16:9");

    // A screenshot brief never reaches generation: a screenshot cannot be invented.
    const calls2: string[] = [];
    const tools2: AgentToolRegistry = { "image.generate": fakeTool("image.generate", calls2, ok({ candidates: [], unmet: [], model: "m" })) };
    const plan2 = await runResolver(tools2, { needsVisual: true, kind: "screenshot", sourceUrl: "https://example.test/a", rationale: "x" });
    expect(plan2.status).toBe("none");
    expect(calls2).toEqual([]);
  });

  it("a client-attached image wins over every tier, brief or no brief", async () => {
    const calls: string[] = [];
    const tools: AgentToolRegistry = {
      "media.findImages": fakeTool("media.findImages", calls, ok({ candidates: [] })),
      "media.stageAsset": fakeTool("media.stageAsset", calls, ok({ url: "https://signed/up.png", gcsUri: "gs://b/up.png", contentType: "image/png", bytes: 1 })),
    };
    const plan = await runResolver(
      tools,
      { needsVisual: true, kind: "photo", query: "anything", rationale: "x" },
      { analyses: [{ path: ".media-cache/run_1/n1-client0.png", description: "the client's photo", subjects: [], textInImage: [], mood: "", looksLikeScreenshot: false }] },
    );
    expect(plan.status).toBe("attached");
    expect(plan.asset?.url).toBe("https://signed/up.png");
    expect(calls).toEqual(["media.stageAsset"]);
  });

  // 2026-09-06: "Only media I upload for this job" from the portal.
  it("client media only, nothing attached: ships text and asks NO tier, even for a photo brief with every tool registered", async () => {
    const calls: string[] = [];
    const tools: AgentToolRegistry = {
      "media.screenshotPage": fakeTool("media.screenshotPage", calls, ok({ candidate: { path: ".media-cache/run_1/shot.png", description: "s", provider: "screenshot", licenseConfidence: "own" } })),
      "media.harvestArticleImages": fakeTool("media.harvestArticleImages", calls, ok({ candidates: [], unmet: [] })),
      "media.findImages": fakeTool("media.findImages", calls, ok({ candidates: [{ path: ".media-cache/run_1/stock.jpg", description: "s", provider: "unsplash", licenseConfidence: "blanket" }], unmet: [] })),
      "image.generate": fakeTool("image.generate", calls, ok({ candidates: [{ path: ".media-cache/run_1/gen.png", description: "g", provider: "gemini-image", licenseConfidence: "generated" }], unmet: [], model: "m" })),
    };
    const plan = await runResolver(tools, { needsVisual: true, kind: "photo", query: "shipping yard at dawn", rationale: "a real scene" }, undefined, { clientMediaOnly: true });
    expect(plan.status).toBe("none");
    expect(plan.attempts).toEqual([expect.stringMatching(/^client media only/)]);
    expect(calls).toEqual([]);
  });

  it("client media only, a picture attached: the attachment wins exactly as it always did", async () => {
    const calls: string[] = [];
    const tools: AgentToolRegistry = {
      "media.findImages": fakeTool("media.findImages", calls, ok({ candidates: [] })),
      "media.stageAsset": fakeTool("media.stageAsset", calls, ok({ url: "https://signed/up.png", gcsUri: "gs://b/up.png", contentType: "image/png", bytes: 1 })),
    };
    const plan = await runResolver(
      tools,
      { needsVisual: true, kind: "photo", query: "anything", rationale: "x" },
      { analyses: [{ path: ".media-cache/run_1/n1-client0.png", description: "the client's photo", subjects: [], textInImage: [], mood: "", looksLikeScreenshot: false }] },
      { clientMediaOnly: true },
    );
    expect(plan.status).toBe("attached");
    expect(calls).toEqual(["media.stageAsset"]);
  });
});

describe("analyzeAttachedMedia", () => {
  it("returns undefined with no image attachments (a video is not one), and describes uploads from labels when there is no vision backend", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const calls: string[] = [];
    const tools: AgentToolRegistry = {
      "media.ingestAssets": fakeTool("media.ingestAssets", calls, ok({ candidates: [{ path: ".media-cache/run_1/n1-client0.png", description: "upload" }], unmet: [] })),
    };
    const result = await engine.run(
      async (wf) => ({
        none: await analyzeAttachedMedia(wf, tools, ctx, { stepId: "a", repoRoot: "/repo", assets: [{ uri: "gs://b/ep.mp4", role: "source", contentType: "video/mp4" }] }),
        labelled: await analyzeAttachedMedia(wf, tools, ctx, { stepId: "b", repoRoot: "/repo", assets: [{ uri: "https://u/pic.png", role: "source", label: "our rota" }] }),
      }),
      { runId: "run_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" },
    );
    if (result.status !== "completed") throw new Error(result.status);
    const out = result.output as { none: unknown; labelled: { analyses: Array<{ description: string; label?: string }>; note?: string } };
    expect(out.none).toBeUndefined();
    expect(out.labelled.analyses[0]!.description).toBe("our rota");
    expect(out.labelled.note).toMatch(/media.inspectImages is not registered/);
  });
});
