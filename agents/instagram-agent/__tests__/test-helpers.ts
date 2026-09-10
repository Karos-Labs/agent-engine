import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import type { AgentToolRegistry } from "@agent-engine/core";
import { FilePromptStore, type AgentContext, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { briefSegments, createAllKarosTools, WorkspaceStore, type ClientBrief } from "@agent-engine/tools";
import { createOfflineScraper, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { validateRenderInputs, type RenderCarouselInput, type RenderCarouselResult } from "@agent-engine/tool-karos-publish";
import type { TrendScoutOutput } from "@agent-engine/workflow";
import type { BrandTokens, ImageCandidate, ImageVettingOutput, InstagramCopyOutput, ResearchFact, ResearchOutput, StyleConfig, VisualQaOutput } from "../src/workflow/types.js";
import { DEFAULT_CAROUSEL_LANE } from "../src/workflow/create-instagram-agent-workflow.js";

export { DEFAULT_CAROUSEL_LANE };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_ROOT = path.join(HERE, "..", "prompts");
export const FIXTURES_ROOT = path.join(HERE, "fixtures");

export function makePromptStore(): FilePromptStore {
  return new FilePromptStore(PROMPTS_ROOT);
}

/** A router whose `.complete()` replays a fixed sequence of turns in order (mirrors `linkedin-agent`'s test helper exactly). */
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

/**
 * The `05-write-copy-attempt-N` inputs a fake router saw, in attempt order,
 * parsed back out of the JSON prompt `BaseAgent` sends. A copy turn is the
 * one whose input carries both `facts` and `styleConfig`; no other agent in
 * this workflow receives both. Lets a test assert WHAT the redraft was told
 * (`relevanceSteer`, `selfCheckSteer`, `dedupeAvoid`), not only that a
 * second attempt happened.
 */
export function copyTurnInputs(router: ModelRouter): Array<Record<string, unknown>> {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  const inputs: Array<Record<string, unknown>> = [];
  for (const call of complete.mock.calls) {
    const promptArg = call[0];
    if (typeof promptArg !== "string") continue;
    try {
      const parsed = JSON.parse(promptArg) as { input?: Record<string, unknown> };
      if (parsed.input && typeof parsed.input === "object" && "facts" in parsed.input && "styleConfig" in parsed.input) inputs.push(parsed.input);
    } catch {
      // not a JSON prompt (never the case for BaseAgent calls, but be safe)
    }
  }
  return inputs;
}

/**
 * The `08b-visual-qa-attempt-N` inputs a fake router saw, in attempt order.
 * A QA turn is the one whose input carries `renderRules`; no other agent in
 * this workflow receives that key.
 *
 * By SHAPE rather than by call index, deliberately: every new unconditional
 * model turn (the scout at `03c`, the relevance judge at `07g`, the angle
 * proposal at `04i`) shifts every index in every fixture at once, which is
 * the churn `turns.ts` exists to stop.
 */
export function qaTurnInputs(router: ModelRouter): Array<Record<string, unknown>> {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  const inputs: Array<Record<string, unknown>> = [];
  for (const call of complete.mock.calls) {
    const promptArg = call[0];
    if (typeof promptArg !== "string") continue;
    try {
      const parsed = JSON.parse(promptArg) as { input?: Record<string, unknown> };
      if (parsed.input && typeof parsed.input === "object" && "renderRules" in parsed.input) inputs.push(parsed.input);
    } catch {
      // not a JSON prompt
    }
  }
  return inputs;
}

/** The whole prompt string of each `05-write-copy-attempt-N` call, for tests asserting on prompt TEXT rather than the parsed input. */
export function copyTurnPrompts(router: ModelRouter): string[] {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  const prompts: string[] = [];
  for (const call of complete.mock.calls) {
    const promptArg = call[0];
    if (typeof promptArg !== "string") continue;
    try {
      const parsed = JSON.parse(promptArg) as { input?: Record<string, unknown> };
      if (parsed.input && typeof parsed.input === "object" && "facts" in parsed.input && "styleConfig" in parsed.input) prompts.push(promptArg);
    } catch {
      // not a JSON prompt
    }
  }
  return prompts;
}

export function finalTurn(
  output: unknown,
  opts: { model?: string; inputTokens?: number; outputTokens?: number } = {},
): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 30,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// A Chromium-free stand-in for `publish.renderCarousel`, used by this
// package's own workflow-level tests (`workflow-e2e.test.ts`,
// `resume-idempotency.test.ts`) — matching `packages/tools/karos-publish`'s
// own package tests' explicit, documented choice to keep actually launching
// Chromium out of unit tests ("that's an integration/e2e concern",
// `render-carousel.test.ts`'s own header comment). It reuses the REAL,
// exported `validateRenderInputs` for every path-guard / missing-file check
// (so a genuine bug in this workflow's `assembleSlidesData` still fails
// these tests exactly as it would in production) and only fakes the final
// "launch Chromium and screenshot" step, writing a tiny real PNG file per
// slide instead so downstream file-existence/count assertions stay
// meaningful. The real, Chromium-backed tool is still exercised directly —
// Chromium-free failure paths in `render-outcome-mapping.test.ts`, and a
// real end-to-end render in `workflow-e2e.test.ts`'s Chromium-gated test
// below when a real browser binary happens to be installed.
// ─────────────────────────────────────────────────────────────────────────

const MINIMAL_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function fakeRenderCarousel(realTool: AgentToolRegistry[string]): AgentToolRegistry[string] {
  return {
    ...realTool,
    async execute(rawArgs: unknown) {
      const parsed = realTool.inputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return { status: "tooling_error", reason: `bad args: ${parsed.error.message}` };
      }
      const input = parsed.data as RenderCarouselInput;
      const validation = await validateRenderInputs(input);
      if (!validation.ok) {
        return validation.kind === "tooling" ? { status: "tooling_error", reason: validation.reason } : { status: "content_fail", reason: validation.reason };
      }
      await fs.mkdir(validation.resolvedOutDir, { recursive: true });
      const rendered: RenderCarouselResult["rendered"] = [];
      for (const slide of input.slides) {
        const outPath = path.join(validation.resolvedOutDir, `slide-${slide.n}.png`);
        await fs.writeFile(outPath, MINIMAL_PNG_BYTES);
        rendered.push({ n: slide.n, path: outPath });
      }
      return { status: "success", result: { rendered } };
    },
  } as AgentToolRegistry[string];
}

/** True when a real Chromium binary is actually installed for Playwright in this environment (checked via its own default cache directory layout, no `playwright` API import needed). Gates the one genuinely-real, Chromium-backed end-to-end test so `npm run test` never flakes on an environment where the browser binary hasn't been downloaded (RFC-03 §5's own documented "known gap"). */
export function isChromiumInstalled(): boolean {
  const cacheDir =
    process.env["PLAYWRIGHT_BROWSERS_PATH"] ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "ms-playwright")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
        : path.join(os.homedir(), ".cache", "ms-playwright"));

  try {
    for (const entry of readdirSync(cacheDir)) {
      if (!entry.startsWith("chromium-")) continue;
      const exePath =
        process.platform === "win32"
          ? path.join(cacheDir, entry, "chrome-win", "chrome.exe")
          : process.platform === "darwin"
            ? path.join(cacheDir, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
            : path.join(cacheDir, entry, "chrome-linux", "chrome");
      if (existsSync(exePath)) return true;
    }
  } catch {
    // cache dir doesn't exist yet -- Chromium was never installed.
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Fixture builders — a valid style config / brand tokens / image pool a
// happy-path test starts from, with `overrides` for the specific field a
// given test wants to break.
// ─────────────────────────────────────────────────────────────────────────

export function goodStyleConfig(overrides: Partial<StyleConfig> = {}): StyleConfig {
  return {
    style_config_version: 1,
    canvas: { w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 },
    rules: [{ id: "no-hype-words", check: "copy", description: "slide copy must not use hype/banned words" }],
    banned_words: ["guaranteed", "the best"],
    banned_chars: [],
    compliance: { regulated: false, required_framing: [], never_say: [] },
    ...overrides,
  };
}

export function goodBrandTokens(overrides: Partial<BrandTokens> = {}): BrandTokens {
  return {
    templateDir: "fixtures/templates",
    slideTemplate: "slide.html",
    ...overrides,
  };
}

/** Enough candidates to cover an 8-slide post — tests that want an unfillable slide pass a smaller/mismatched pool instead. */
export function goodImageCandidatePool(): ImageCandidate[] {
  return [
    { path: "fixtures/images/photo-1.png", description: "a bright modern open-plan office with people actively collaborating at a whiteboard, daytime, no visible branding" },
    { path: "fixtures/images/photo-2.png", description: "a close-up of hands typing on a laptop keyboard at a clean desk" },
    { path: "fixtures/images/photo-3.png", description: "a small team gathered around a table reviewing printed charts" },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// A canonical happy-path scenario: six sourced facts, six slides each
// tracing to one of them verbatim, and six clean image selections. Tests
// that want to break one thing (a banned word, an unfillable slide, a
// dangling sourceRef) start from these and mutate a copy.
// ─────────────────────────────────────────────────────────────────────────

export const SIX_RESEARCH_FACTS: ResearchFact[] = [
  { claim: "Teams that automated their weekly reporting saved an average of 4 hours per week.", source: "internal client survey", date: "2026-07-01" },
  { claim: "Our support team resolved 30% more tickets after switching to the new triage flow.", source: "support dashboard export", date: "2026-07-05" },
  { claim: "Clients who onboarded with the new checklist reached first value 2 days faster.", source: "onboarding cohort analysis", date: "2026-07-10" },
  { claim: "Internal surveys showed a 25% jump in team satisfaction after the process change.", source: "internal pulse survey", date: "2026-07-12" },
  { claim: "The design team cut revision cycles from 5 rounds to 2 on average.", source: "design ops retro notes", date: "2026-07-15" },
  { claim: "Onboarding time dropped from 14 days to 7 days after the rollout.", source: "onboarding cohort analysis", date: "2026-07-18" },
];

export function goodResearchOutput(topic = "process changes that actually moved the needle this quarter"): ResearchOutput {
  return { topic, facts: SIX_RESEARCH_FACTS, rawPayloadRef: "research-run-fixture" };
}

const GOOD_VISUAL_NEEDS = [
  "a bright modern open-plan office with people actively collaborating at a whiteboard, daytime",
  "a close-up of hands typing on a laptop keyboard at a clean desk",
  "a small team gathered around a table reviewing printed charts",
  "a bright modern open-plan office with people actively collaborating at a whiteboard, daytime",
  "a close-up of hands typing on a laptop keyboard at a clean desk",
  "a small team gathered around a table reviewing printed charts",
];

/** Six clean slides, one per `SIX_RESEARCH_FACTS` entry, each `sourceRef` matching a fact's `claim` verbatim. */
export function goodCopyOutput(): InstagramCopyOutput {
  return {
    format: "carousel",
    caption: "A quick look at the process changes that actually moved the needle this quarter, and what teams did differently.",
    slides: SIX_RESEARCH_FACTS.map((fact, i) => ({
      n: i + 1,
      headline: `Finding #${i + 1}`,
      body: fact.claim,
      visualNeed: GOOD_VISUAL_NEEDS[i]!,
      sourceRef: fact.claim,
      layout: "photo" as const,
    })),
  };
}

/** Vets every slide in `goodCopyOutput()` against a real fixture image — never a `null`, always rights-usable/watermark-free (Fix 4), and a full claim match (RFC-13 §F, `instagram-image-vet@3`). */
export function goodImageVettingOutput(pool: ImageCandidate[] = goodImageCandidatePool()): ImageVettingOutput {
  return {
    selections: goodCopyOutput().slides.map((slide, i) => ({
      n: slide.n,
      imagePath: pool[i % pool.length]!.path,
      reason: `candidate matches "${slide.visualNeed}" closely enough`,
      license: "CC0, test fixture",
      rightsUsable: true,
      watermarkFree: true,
      claimMatch: 5,
      claimMatchReason: "shows the claimed subject",
    })),
  };
}

/** A clean, passing post-render visual QA verdict (Fix 2) — no `check: "render"` rule findings tripped. */
export function goodVisualQaOutput(): VisualQaOutput {
  return { pass: true, findings: [] };
}

/**
 * The trend scout's answer over the offline scraper's synthetic documents
 * (RFC-13 §E: the scout runs on EVERY run since 2026-09, so every workflow
 * fixture needs one). Three candidates, one per content mode, brand fit 5/4/3
 * — so `selectTrendCandidate` has an in-mode pick whatever mode the rotation
 * lands on, and `resolveTopicClaim` records two alternatives.
 */
export function goodTrendScoutOutput(overrides: Partial<TrendScoutOutput> = {}): TrendScoutOutput {
  return {
    candidates: [
      {
        topic: "automated weekly reporting is replacing the Monday status meeting",
        headline: "Survey: teams that automated reporting reclaimed four hours a week",
        mode: "deep-value",
        brandFit: 5,
        interest: 4,
        brandFitReason: "the client sells exactly this kind of workflow automation to operations teams",
        angle: "the hours come back only when the report writes itself from the source data",
        hook: "Your Monday status meeting is a report nobody wrote down.",
        whyNow: "the survey published this week",
        sourceUrls: ["https://offline.test/reporting/0"],
        publishedAt: "2026-09-07",
        hasNumbers: true,
        mediaHint: "data",
      },
      {
        topic: "a major ticketing vendor shipped AI triage to every plan",
        headline: "Vendor adds AI triage to all support plans",
        mode: "hot-news",
        brandFit: 4,
        interest: 4,
        brandFitReason: "the client's own triage flow is the practitioner's alternative to a vendor default",
        angle: "a default triage is not a designed one",
        hook: "Every ticket now gets triaged by a model. Not every ticket should.",
        whyNow: "announced two days ago",
        sourceUrls: ["https://offline.test/triage/0"],
        publishedAt: "2026-09-08",
        hasNumbers: false,
        mediaHint: "screenshot",
      },
      {
        topic: "should onboarding checklists be owned by product or by success?",
        headline: "Debate: who owns the onboarding checklist",
        mode: "open-discussion",
        brandFit: 3,
        interest: 3,
        brandFitReason: "the client's onboarding cohort data gives it a position, though the bridge takes a sentence",
        angle: "the owner is whoever is measured on time-to-first-value",
        hook: "Who owns your onboarding checklist? Wrong answer: both.",
        whyNow: "two widely shared threads this week",
        sourceUrls: ["https://offline.test/onboarding/0"],
        hasNumbers: false,
        mediaHint: "none",
      },
    ],
    skipped: [{ headline: "Celebrity launches a productivity app", reason: "famous, not on-brand: no connection to what the client sells" }],
    ...overrides,
  };
}

/** The relevance judge's passing verdict (RFC-13 §C, `instagram-relevance-judge`): the post unmistakably reads as this client's. */
export function goodRelevanceVerdict(overrides: Partial<{ score: number; reason: string; missingBridge: string }> = {}): Record<string, unknown> {
  return { score: 5, reason: "every slide names the client's own process data and speaks to operations leads", ...overrides };
}

/**
 * A fresh, agent-written Client Brief for `acme` (Phase 1 item H) — the shape
 * `client.getBrief` serves and `02i-resolve-client-brief` reports as
 * `persisted`.
 *
 * Modelled on the client the grounding gate exists for (an AI marketing
 * agency for B2B founders), and deliberately RICHER than
 * `deriveClientBrief`'s output: a positioning line, real ICP roles and pains,
 * a current offer, reference accounts with reasons — the fields only the
 * agent writer can fill, so a test can tell a persisted brief from a derived
 * one by content as well as by `source`.
 */
export function goodClientBrief(overrides: Partial<ClientBrief> = {}): ClientBrief {
  return {
    version: 1,
    channel: "instagram",
    generatedAt: new Date().toISOString(),
    generatedBy: "agent",
    agentSkillRef: "instagram-brief@1",
    sources: [
      { kind: "profile", ref: "client.getProfile" },
      { kind: "context-doc", ref: "product-information" },
      { kind: "site", ref: "https://acme.test/about" },
    ],
    positioning: {
      oneLiner: "Acme runs the weekly content pipeline for B2B founders who have no marketing team yet.",
      whatWeSell: "A managed content service: research, drafting and publishing across LinkedIn, X and Instagram, with a human editor approving every post before it ships.",
      differentiators: ["a human editor approves every post", "one weekly cadence per channel, never a burst"],
    },
    icp: {
      summary: "Founders and heads of marketing at seed to series B B2B companies, running content themselves",
      roles: ["founder", "head of marketing"],
      pains: ["no time to write weekly", "posts that read like every other vendor's"],
      industries: ["B2B SaaS"],
      geos: ["EU", "US"],
    },
    offers: [{ name: "First month audit", summary: "A content audit and one month of published posts, fixed price, for a first-time client." }],
    coreTerms: ["content", "founders", "pipeline", "editorial", "cadence", "b2b"],
    referenceAccounts: [
      { platform: "x", handle: "lennysan", why: "the product-growth newsletter this ICP quotes in their own posts" },
      { platform: "reddit", handle: "SaaS", why: "where the ICP asks what content actually converts" },
      { platform: "instagram", handle: "marketingexamples", why: "the format vocabulary this audience already reads" },
    ],
    forbidden: { topics: ["politics"], claims: ["guaranteed results", "10x your revenue"] },
    language: { target: "English", register: "direct, practitioner, first person plural, no exclamation marks" },
    evergreenAngles: ["why a weekly cadence beats a launch burst", "what an editor catches that a model does not"],
    ownAssets: [{ title: "Q3 onboarding cohort analysis", kind: "data", summary: "Time to first value across 40 onboarded clients.", sourceRef: "client.getKnowledge/assets" }],
    confidence: "medium",
    gaps: [],
    ...overrides,
  };
}

export interface TestEnvironment {
  /** The `WorkspaceStore`'s root — client config/topics catalog/ledger live under here. */
  rootDir: string;
  /** A separate temp directory containing a copy of `__tests__/fixtures/` — passed as `options.repoRoot` so `publish.renderCarousel` has real template/image files to resolve against without ever writing test output into the tracked source tree. */
  repoRoot: string;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  cleanup: () => Promise<void>;
}

const BASE_CTX_FIELDS = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

export async function setupTestEnvironment(
  opts: {
    withConfig?: boolean;
    styleConfig?: StyleConfig;
    brandTokens?: BrandTokens;
    seedTopics?: string[];
    /**
     * Fix 1's lane-scoped tests need more than one lane seeded at once (e.g.
     * one lane sitting at the floor of 5 while another is healthy) — this
     * seeds additional lanes on top of (or instead of) `seedTopics`, which
     * always lands in `DEFAULT_CAROUSEL_LANE` (the workflow's own fallback
     * lane, matched here on purpose — see that constant's doc comment).
     */
    seedTopicsByLane?: Record<string, string[]>;
    /**
     * The scraper behind `research.pull` / `research.socialHistory`. Defaults
     * to `createOfflineScraper()`; pass `createOfflineScraper({ documentsPerQuery: 0 })`
     * for "the search answered with nothing" and `null` for "no scraper is
     * configured" (`research.pull` → `not_available`, the outage the trend
     * scout must survive on a planned run — RFC-13 §E).
     */
    scraper?: ScraperProvider | null;
    /**
     * The persisted Client Brief this client starts with (Phase 1 item H),
     * written straight to `clients/acme/brief/instagram-brief.json` — the same
     * path `client.writeBrief` writes and `client.getBrief` reads.
     *
     * Omitted seeds a FRESH agent-written brief (`goodClientBrief()`), so
     * `00b-check-client-brief` resolves to `reuse` and the fixture consumes no
     * `instagram-brief` router turn — which is what keeps the ~30 existing
     * workflow fixtures turn-for-turn identical now that `00b1`/`00b2`/`00b3`
     * are wired (Phase 1 item H; this default was flipped in the same change).
     *
     * `false` seeds nothing: no persisted brief exists, `00b` resolves to
     * `create`, the brief agent's turn IS consumed, and `02i` derives a
     * deterministic brief when the write does not land. Pass a brief with an
     * old `generatedAt` or `generatedBy: "human"` to exercise the
     * refresh/never-refresh paths.
     */
    seedBrief?: ClientBrief | false;
  } = {},
): Promise<TestEnvironment> {
  const withConfig = opts.withConfig ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-agent-workspace-"));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-agent-repo-"));
  await fs.cp(FIXTURES_ROOT, path.join(repoRoot, "fixtures"), { recursive: true });

  const store = new WorkspaceStore(rootDir);
  // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
  // reports `not_available` without a real scraper rather than returning a
  // placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
  // placeholder is what let every content agent draft from nothing for months.
  // Tests still need deterministic offline data, so they opt in here; nothing in
  // `apps/` does.
  const tools = createAllKarosTools(store, undefined, { scraper: opts.scraper === undefined ? createOfflineScraper() : opts.scraper });

  if (withConfig) {
    await store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: opts.styleConfig ?? goodStyleConfig(),
      instagramBrandTokens: opts.brandTokens ?? goodBrandTokens(),
    });
  }

  // Written directly rather than through `client.writeBrief` so a fixture can
  // seed shapes that tool deliberately refuses to produce (a 31-day-old
  // brief, a human-authored one) — the same reason `brief.test.ts` seeds the
  // read side by hand.
  const seedBrief = opts.seedBrief ?? goodClientBrief();
  if (seedBrief !== false) {
    await store.writeJson("acme", briefSegments("instagram"), seedBrief);
  }

  const seedCtx: AgentContext = { runId: "seed", ...BASE_CTX_FIELDS, metadata: {} };
  const seedTopics = opts.seedTopics ?? [
    "5 automation wins from this quarter",
    "how our team cut onboarding time in half",
    "a behind-the-scenes look at our design process",
    "customer story: scaling from 10 to 100 clients",
    "the tool stack we switched to this year",
    "lessons from our biggest product launch",
  ];
  // Seeded under the workflow's own default lane (`DEFAULT_CAROUSEL_LANE`) so
  // step 03's `topics.reserve` call (which always passes a lane, real or
  // default — Fix 1) finds these rows without a client ever having to set
  // `requestedLane` explicitly in these tests.
  await tools["topics.topUp"]!.execute({ topics: seedTopics, lane: DEFAULT_CAROUSEL_LANE }, { ctx: seedCtx });

  for (const [lane, topics] of Object.entries(opts.seedTopicsByLane ?? {})) {
    await tools["topics.topUp"]!.execute({ topics, lane }, { ctx: seedCtx });
  }

  return {
    rootDir,
    repoRoot,
    store,
    tools,
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
      await fs.rm(repoRoot, { recursive: true, force: true });
    },
  };
}
