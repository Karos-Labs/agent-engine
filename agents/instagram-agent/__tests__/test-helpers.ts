import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as os from "node:os";
import type { AgentToolRegistry } from "@agent-engine/core";
import { FilePromptStore, type AgentContext, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { briefSegments, createAllKarosTools, WorkspaceStore, type ClientBrief } from "@agent-engine/tools";
import { createOfflineScraper, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { validateRenderInputs, type RenderCarouselInput, type RenderCarouselResult, type Slide } from "@agent-engine/tool-karos-publish";
import { MemoryTemplateStore, TemplateDefinitionSchema, extractSupportedFields, type TemplateDefinition, type TemplateStore } from "@agent-engine/tool-karos-templates";
import type { TrendScoutOutput } from "@agent-engine/workflow";
import type { BrandTokens, ImageCandidate, ImageVettingOutput, InstagramCopyOutput, ResearchFact, ResearchOutput, StyleConfig, VisualQaOutput } from "../src/workflow/types.js";
import type { SlideMetrics, SlideProbe } from "../src/workflow/interest-floor.js";
import { SKELETON_BELIEF_KEY, type SkeletonHistory } from "../src/workflow/skeleton-memory.js";
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

/**
 * A slide measurement that clears the interest floor at EVERY role,
 * cover and closer included — RFC-14 item L.
 *
 * The default for `fakeRenderCarousel`, and it has to be, because
 * `MINIMAL_PNG_BYTES` above is a 1×1 PNG: measured for real it is 100% flat
 * background, 0% occupied, one contiguous empty rectangle covering the whole
 * frame — the exact shape of the defect item L exists to fail. Without a
 * passing default every one of this package's ~30 workflow fixtures would
 * start failing the floor for a reason that has nothing to do with what they
 * test.
 *
 * The numbers are a realistic photo-bearing slide (roughly what
 * `photo.html`'s Chromium render measures), chosen so that no clause and no
 * WARNING fires either — a fixture that suddenly grew an accent warning
 * would be just as much churn as one that grew a failure.
 */
export function passingSlideMetrics(overrides: Partial<SlideMetrics> = {}): SlideMetrics {
  return {
    backgroundHex: "#17181c",
    backgroundMatchesBrandGround: true,
    flatBackgroundShare: 0.46,
    inkShare: 0.21,
    occupiedShare: 0.54,
    // The content mask (`render-carousel` 1.2.0): lower than `occupiedShare`
    // on any real slide, because the difference between the two IS the ground
    // treatment. 0.31 clears clause G's floor at every role with room.
    contentOccupiedShare: 0.31,
    largestEmptyRect: { x: 64, y: 96, w: 952, h: 240 },
    largestEmptyRectShare: 0.147,
    largestEmptyContentRect: { x: 64, y: 96, w: 952, h: 320 },
    largestEmptyContentRectShare: 0.196,
    imageryShare: 0.28,
    graphicShare: 0.06,
    imageryOrDeviceShare: 0.34,
    textShare: 0.2,
    accentShare: 0.012,
    accentPresent: true,
    edgeDensity: 0.19,
    quantisedColourCount: 14,
    clippedEdgeShare: 0,
    ...overrides,
  };
}

/**
 * The audit slide, as numbers: a mostly-grey plate with a headline in the
 * lower third and a large empty upper area.
 *
 * Taken from the 2026-09-08 audit's measured Karos Labs renders
 * (`gs://karoscmo-prep-media-assets/instagram/karoslabs/<runId>/slide-*.png`)
 * — 93% of the pixels are the ground colour, 18% of the frame is occupied,
 * the largest hole is over half the plate, and nothing but type is in frame.
 * Fails clauses C, D and (at cover/closer) E, which is the whole point.
 *
 * `contentOccupiedShare` equals `occupiedShare` here, and that is the audit
 * slide's own truth: it carried no ground treatment at all, so every mark on
 * it was content. The two numbers only diverge on a slide with a decorated
 * ground — which is exactly the case `decoratedEmptySlideMetrics` covers.
 */
export function boringSlideMetrics(overrides: Partial<SlideMetrics> = {}): SlideMetrics {
  return passingSlideMetrics({
    flatBackgroundShare: 0.93,
    inkShare: 0.045,
    occupiedShare: 0.18,
    contentOccupiedShare: 0.18,
    largestEmptyRect: { x: 0, y: 0, w: 1080, h: 800 },
    largestEmptyRectShare: 0.556,
    largestEmptyContentRect: { x: 0, y: 0, w: 1080, h: 800 },
    largestEmptyContentRectShare: 0.556,
    imageryShare: 0,
    graphicShare: 0.004,
    imageryOrDeviceShare: 0.004,
    textShare: 0.176,
    edgeDensity: 0.22,
    quantisedColourCount: 4,
    ...overrides,
  });
}

/**
 * THE DECORATED EMPTY PLATE, as numbers — and these are measured, not
 * invented.
 *
 * A 2160×2880 truecolour PNG painting ONLY item M.3's 45-degree hairline
 * field over `#17181C` (stripe `rgb(54,55,57)` = 14% of the foreground token,
 * 3px wide on a 36px period at scale 2, inset 32px) and nothing else: no
 * headline, no body, no kicker, no accent, no content of any kind. Run
 * through the real `measureSlidePng` with `expected.ground: "#17181C"` it
 * reports exactly this.
 *
 * Read against `interest-floor.ts`'s constants, this plate passes clause A
 * (7.9% ink is five times the 1.5% floor), clause C (a 1.5% largest empty
 * rectangle against a 22-28% ceiling), clause D (42% occupied clears every
 * `OCCUPIED_SHARE_FLOOR`, so the flat-93% limb never gets to matter) and
 * clause F. Which is the defect: an emptiness measurement that cannot tell a
 * blank slide from a full one. Clause G is what fails it, on
 * `contentOccupiedShare` — the stripe's 8.3% duty cycle at 24 units of
 * contrast moves each cell's mean by about 2, so the field is ground, not
 * content.
 */
export function decoratedEmptySlideMetrics(overrides: Partial<SlideMetrics> = {}): SlideMetrics {
  return {
    backgroundHex: "#17181C",
    backgroundMatchesBrandGround: true,
    flatBackgroundShare: 0.9209307484567901,
    inkShare: 0.07906925154320987,
    occupiedShare: 0.42169753086419753,
    contentOccupiedShare: 0,
    largestEmptyRect: { x: 0, y: 0, w: 16, h: 1440 },
    largestEmptyRectShare: 0.014814814814814815,
    largestEmptyContentRect: { x: 0, y: 0, w: 1080, h: 1440 },
    largestEmptyContentRectShare: 1,
    imageryShare: 0,
    graphicShare: 0,
    imageryOrDeviceShare: 0,
    textShare: 0.42169753086419753,
    accentShare: 0,
    accentPresent: false,
    edgeDensity: 0.6672237198957457,
    quantisedColourCount: 2,
    clippedEdgeShare: 0,
    ...overrides,
  };
}

/** A clean DOM probe: nothing overflows, nothing escapes the canvas, the brand's own faces resolved. */
export function passingSlideProbe(n: number, overrides: Partial<SlideProbe> = {}): SlideProbe {
  return {
    n,
    overflow: false,
    overflowing: [],
    offscreen: [],
    elementCount: 14,
    textBoxShare: 0.31,
    fontFamiliesUsed: ["Inter", "IBM Plex Mono"],
    ...overrides,
  };
}

/**
 * What a test wants the fake renderer to report per slide.
 *
 * Functions rather than values so one options bag can describe "slide 1 is
 * empty, the rest are fine" — the shape every interest-floor workflow test
 * needs. Returning `undefined` from `metrics` is how a test asks for the
 * `{ ok: false }` measurement path (the renderer measured nothing for that
 * slide), which must deliver rather than hold.
 */
export interface FakeRenderCarouselOptions {
  metrics?: (slide: Slide) => SlideMetrics | undefined;
  /** The renderer's own `measureFailure` reason to report alongside an absent `metrics`. Defaults to a plausible decoder refusal. */
  measureFailure?: (slide: Slide) => string;
  probe?: (slide: Slide) => SlideProbe | undefined;
  /**
   * Make one render CALL fail, by its 1-based ordinal within the run.
   *
   * The free re-layout at `08a1b` mutates the copy, the image selections and
   * the type-scale overrides and then re-renders at `08a1c`; a re-render that
   * does not succeed must leave every one of those exactly where the FIRST
   * render left them, or the shipped deliverable's text disagrees with its own
   * PNGs. `content_fail` is the reachable case: `promote-image-to-cover`
   * attaches a path that may not exist on this instance's disk.
   *
   * By call ordinal rather than by input shape because that is the only thing
   * a caller can predict: render 1 is `08`, render 2 is `08a1c`.
   */
  failRenderCall?: (callNumber: number) => { status: "content_fail" | "tooling_error"; reason: string } | undefined;
}

/**
 * One rendered slide as the fake reports it — `RenderCarouselResult`'s own
 * row widened with item L's two additive fields. Widened here rather than
 * imported so this helper compiles before/independently of
 * `packages/tools/karos-publish`'s own `TOOL_VERSION 1.1.0` change being
 * rebuilt into `dist/`; the shapes are structurally identical.
 */
type FakeRenderedSlide = RenderCarouselResult["rendered"][number] & {
  metrics?: SlideMetrics;
  measureFailure?: string;
  probe?: SlideProbe;
};

export function fakeRenderCarousel(realTool: AgentToolRegistry[string], opts: FakeRenderCarouselOptions = {}): AgentToolRegistry[string] {
  let renderCalls = 0;
  return {
    ...realTool,
    async execute(rawArgs: unknown) {
      renderCalls += 1;
      const forced = opts.failRenderCall?.(renderCalls);
      if (forced !== undefined) return forced;
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
      const rendered: FakeRenderedSlide[] = [];
      for (const slide of input.slides) {
        const outPath = path.join(validation.resolvedOutDir, `slide-${slide.n}.png`);
        await fs.writeFile(outPath, MINIMAL_PNG_BYTES);
        const metrics = opts.metrics ? opts.metrics(slide) : passingSlideMetrics();
        const probe = opts.probe ? opts.probe(slide) : passingSlideProbe(slide.n);
        rendered.push({
          n: slide.n,
          path: outPath,
          ...(metrics !== undefined
            ? { metrics }
            : { measureFailure: opts.measureFailure?.(slide) ?? "measureSlidePng: the PNG could not be decoded (interlaced)" }),
          ...(probe !== undefined ? { probe } : {}),
        });
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

/**
 * A per-client Template Studio set (RFC-14 item N) as a test can seed it.
 *
 * `archetypeIds` must be ids the layout enum can actually ROUTE to (spec
 * finding 7: `templateForLayout` maps only the fixed enum, so a row carrying
 * a novel `archetypeId` is a template nothing can ever pick). The default
 * four are all routable today and all have real fixture markup in
 * `__tests__/fixtures/templates/`, so a seeded row is a genuine template
 * rather than a stub — nothing here is placeholder markup.
 */
export interface StudioSeed {
  archetypeIds?: readonly string[];
  /** Item N stores at 65 (`DEFAULT_QUALITY_STUDIO`) — strictly below the bundled floor of 70, so a generated design never displaces a fleet-verified one. */
  qualityScore?: number;
  /** Item N stores `enabled: false` until the portal approves. The default here is APPROVED, so `00c-check-template-studio` resolves `reuse` and consumes no router turn. */
  enabled?: boolean;
  clientSlug?: string;
  /**
   * How old every seeded row is, in days. Defaults to 0 (fresh, so `00c`
   * resolves `reuse`); anything past `STUDIO_TTL_DAYS` seeds the TTL-refresh
   * path, where `00c` resolves `generate` over rows that already exist and
   * the duplicate guard must NOT refuse the archetypes being replaced.
   */
  ageDays?: number;
}

/** Which archetypes the default studio seed implements — routable ids with real fixture markup, one file each. */
const DEFAULT_STUDIO_ARCHETYPES = [
  { archetypeId: "stat_callout", file: "stat-callout.html", name: "Studio stat callout", layoutType: "typographic" as const },
  { archetypeId: "quote_card", file: "quote-card.html", name: "Studio quote card", layoutType: "typographic" as const },
  { archetypeId: "list_takeaway", file: "list-takeaway.html", name: "Studio list takeaway", layoutType: "typographic" as const },
  { archetypeId: "headline_focus", file: "headline-focus.html", name: "Studio headline focus", layoutType: "typographic" as const },
] as const;

async function buildStudioStore(repoRoot: string, seed: StudioSeed, nowMs: number): Promise<MemoryTemplateStore> {
  const now = nowMs - Math.max(0, seed.ageDays ?? 0) * 24 * 60 * 60 * 1000;
  const wanted = seed.archetypeIds;
  const chosen = wanted === undefined ? DEFAULT_STUDIO_ARCHETYPES : DEFAULT_STUDIO_ARCHETYPES.filter((a) => wanted.includes(a.archetypeId));
  const rows: TemplateDefinition[] = [];
  for (const archetype of chosen) {
    const html = await fs.readFile(path.join(repoRoot, "fixtures", "templates", archetype.file), "utf8");
    rows.push(
      TemplateDefinitionSchema.parse({
        id: `studio_${seed.clientSlug ?? "acme"}_${archetype.archetypeId}`,
        archetypeId: archetype.archetypeId,
        name: archetype.name,
        layoutType: archetype.layoutType,
        htmlTemplate: html,
        cssStyles: "",
        supportedFields: extractSupportedFields(html),
        qualityScore: seed.qualityScore ?? 65,
        source: "ai_generated",
        clientSlug: seed.clientSlug ?? "acme",
        enabled: seed.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  return new MemoryTemplateStore(rows);
}

/**
 * ONE studio row, stored the way item N stores one: `enabled: false`,
 * awaiting a human's approval at the review gate.
 *
 * For a fixture that supplies its OWN `MemoryTemplateStore` (the
 * custom-archetype, revision-loop, cross-run-adaptation, slides-data and
 * auto-promote suites all do) rather than `env.templateStore`. Without a
 * studio row of some kind, `00c-check-template-studio` reads an empty set
 * for the client and resolves `generate` — which is correct behaviour and
 * wrong for those fixtures, whose router queues no studio turns.
 *
 * `enabled: false` is the deliberate choice over an approved row: `00c`
 * resolves `awaiting-approval` (so the paid block is skipped, exactly as
 * `reuse` would), AND `matchesQuery` filters a disabled row out of the
 * default `list()` — so `materializeTemplates` cannot see it and every one
 * of those fixtures renders byte-identically to before item N.
 *
 * Real fixture markup, never a stub: a row nothing could render would be a
 * lie in the store even if no test reads it.
 */
export function pendingStudioRow(options: { archetypeId?: string; clientSlug?: string; now?: number } = {}): TemplateDefinition {
  const archetypeId = options.archetypeId ?? "stat_callout";
  const clientSlug = options.clientSlug ?? "acme";
  const html = readFileSync(path.join(FIXTURES_ROOT, "templates", "stat-callout.html"), "utf8");
  const now = options.now ?? Date.now();
  return TemplateDefinitionSchema.parse({
    id: `studio_${clientSlug}_${archetypeId}`,
    archetypeId,
    name: `Studio ${archetypeId} (awaiting approval)`,
    layoutType: "typographic",
    htmlTemplate: html,
    cssStyles: "",
    supportedFields: extractSupportedFields(html),
    qualityScore: 65,
    source: "ai_generated",
    clientSlug,
    enabled: false,
    createdAt: now,
    updatedAt: now,
  });
}

export interface TestEnvironment {
  /** The `WorkspaceStore`'s root — client config/topics catalog/ledger live under here. */
  rootDir: string;
  /** A separate temp directory containing a copy of `__tests__/fixtures/` — passed as `options.repoRoot` so `publish.renderCarousel` has real template/image files to resolve against without ever writing test output into the tracked source tree. */
  repoRoot: string;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  /**
   * A per-client Template Studio set (RFC-14 item N), seeded per `seedStudio`.
   *
   * Handed back rather than wired in: `templateStore` is a WORKFLOW option
   * (`createInstagramAgentWorkflow({ templateStore })`), not an environment
   * one, so every existing fixture that does not pass it stays byte-identical
   * — which is exactly the property the ~30 workflow fixtures need. A test
   * that wants the studio path passes `templateStore: env.templateStore`.
   */
  templateStore: TemplateStore;
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
    /**
     * The per-client Template Studio set on `env.templateStore` (RFC-14 item
     * N). Omitted seeds a FRESH, APPROVED four-template set, for the same
     * reason `seedBrief` defaults to a fresh brief: `00c-check-template-studio`
     * then resolves `reuse` and consumes no `instagram-template-designer`
     * router turn, so a fixture that wires the store keeps its turn list.
     *
     * `false` seeds an EMPTY store: no client-scoped rows exist, `00c`
     * resolves `generate`, and the studio's design turns ARE consumed. Pass
     * `{ enabled: false }` for the awaiting-approval path (the rows exist and
     * the portal can see them, but `resolveBest` skips them, so the run uses
     * the bundled set).
     */
    seedStudio?: StudioSeed | false;
    /**
     * The shipped-skeleton history this client starts with (RFC-14 item P),
     * written verbatim into the beliefs document under `SKELETON_BELIEF_KEY`
     * — the same key `readSkeletonHistory` reads and `09b-deliver-and-log`
     * writes.
     *
     * Omitted writes NOTHING, deliberately: a first run has no history, both
     * of item P's checks are inert then, and that is what keeps every
     * existing fixture identical. A test seeds last week's signature to
     * exercise the repeat refusal.
     */
    seedSkeletons?: SkeletonHistory;
    /**
     * The stored per-client visual direction (RFC-14 item Q), written
     * verbatim into the beliefs document under `"instagramVisualDirection"`
     * (`VISUAL_DIRECTION_BELIEF_KEY`, owned by
     * `src/workflow/visual-direction.ts` in PR-D).
     *
     * Typed `unknown` on purpose: this helper's job is to put a document at
     * the right key, and the document's shape belongs to the module that
     * defines it — a mirrored interface here would be a second definition to
     * keep in sync for no benefit. Omitted writes nothing, so
     * `00d-check-visual-direction` resolves `derive`.
     */
    seedVisualDirection?: unknown;
    /** Any other beliefs keys a fixture needs (a seeded `instagramRunBudget` history, an `instagramCustomArchetypes` record). Merged with the two above into one write. */
    seedBeliefs?: Record<string, unknown>;
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

  // One write, several keys — mirroring the single merging `memory.updateBeliefs({ diff })`
  // call `09b-deliver-and-log` makes, so a seeded document has the same shape
  // a delivered run leaves behind rather than a shape only tests produce.
  const beliefs: Record<string, unknown> = { ...(opts.seedBeliefs ?? {}) };
  if (opts.seedSkeletons !== undefined) beliefs[SKELETON_BELIEF_KEY] = opts.seedSkeletons;
  if (opts.seedVisualDirection !== undefined) beliefs["instagramVisualDirection"] = opts.seedVisualDirection;
  if (Object.keys(beliefs).length > 0) await store.writeJson("acme", ["memory", "beliefs"], beliefs);

  const templateStore =
    opts.seedStudio === false
      ? new MemoryTemplateStore()
      : await buildStudioStore(repoRoot, opts.seedStudio ?? {}, Date.now());

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
    templateStore,
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
      await fs.rm(repoRoot, { recursive: true, force: true });
    },
  };
}
