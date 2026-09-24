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
import { enforceImageryBand } from "../src/workflow/imagery-floor.js";
import { composeBoundedObjects } from "../src/workflow/bounded-object.js";
import { rolesForSlideCount, skeletonSignature } from "../src/workflow/skeleton-memory.js";
import { FULL_BLEED_IMAGE_LAYOUTS, assembleSlidesData } from "../src/workflow/slides-data.js";
import type { TrendScoutOutput } from "@agent-engine/workflow";
import type { BrandTokens, ImageCandidate, ImageSelection, ImageVettingOutput, InstagramCopyOutput, ResearchFact, ResearchOutput, StyleConfig, VisualQaOutput } from "../src/workflow/types.js";
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
/**
 * Does this prompt belong to `05r-revise-copy`?
 *
 * By the prompt's own `stepId`, for the reason `copyTurnInputs` states two
 * functions down: a fixture keyed on call INDEX breaks every time an
 * unconditional turn is added anywhere in the workflow, and that churn is what
 * `turns.ts` exists to stop. `stepId` is what `BaseAgent` puts at the top of
 * every prompt it sends, so this cannot drift with an input's shape.
 */
function isReviseTurn(promptArg: unknown): boolean {
  if (typeof promptArg !== "string") return false;
  try {
    const parsed = JSON.parse(promptArg) as { stepId?: string };
    return parsed.stepId === "instagram-copy-revise";
  } catch {
    return false;
  }
}

export function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async (prompt: unknown) => {
      // ── A FIXTURE WITH NO REVISER DECLINES, AND DOES NOT EAT A TURN. ──
      //
      // `05r-revise-copy` was added on 2026-09-18 so attempts 2 and 3 edit the
      // previous draft instead of rewriting it. This queue is POSITIONAL, so
      // the new step took the turn the next redraft was meant to get, and
      // fourteen retry fixtures started asserting against copy they never
      // configured.
      //
      // Returning an empty `edits` array is a truthful model of this fixture:
      // it has no reviser. The schema requires at least one edit, so the step
      // ends non-completed and the workflow falls through to the full redraft
      // with the queue exactly where it was. A fixture that WANTS to exercise
      // the revise path queues its own turn and asserts on the result; see
      // `copy-revision.test.ts` for the unit half and `revise-loop.test.ts`
      // for the workflow half.
      if (isReviseTurn(prompt)) {
        return finalTurn({
          // Schema-VALID and deliberately inapplicable: `applyCopyEdits`
          // resolves every path against the draft that exists, refuses this
          // one, and the workflow falls through to the full redraft with the
          // queue untouched.
          edits: [{ path: "fixture.has.no.reviser", text: "unchanged", fixes: "this fixture configured no reviser" }],
          kept: "everything: this fixture configured no reviser",
        })();
      }
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
 * row with `metrics`/`probe` REPLACED (not intersected) by the agent-side
 * shapes. Replaced rather than intersected because RFC-17 made the five
 * composition metrics (`markedShare`, `markColourCount`, `contentCentroid`,
 * `contentBBox`, `groundInkContrast`) REQUIRED on the publish-side row but
 * OPTIONAL on the agent-side `SlideMetrics`; an intersection resolves each to
 * the required form, and `passingSlideMetrics()` — which deliberately omits
 * them so `composition-evidence` abstains on hand-built fixtures — stops
 * assigning. Do NOT "fix" that by adding the five to `passingSlideMetrics`:
 * that re-breaks the seven zero-warning assertions in `interest-floor.test.ts`.
 * Widened here rather than imported so this helper compiles before/independently
 * of `packages/tools/karos-publish` being rebuilt into `dist/`.
 */
type FakeRenderedSlide = Omit<RenderCarouselResult["rendered"][number], "metrics" | "probe"> & {
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
  // A CHANNEL COUNTS AS INSTALLED. `KAROS_BROWSER_CHANNEL` tells the renderer
  // to launch a browser that is already on the machine (see render-carousel.ts
  // for why it exists). When it is set, the pinned build is beside the point:
  // skipping every render test because Playwright's own download stalled, while
  // a perfectly good Chrome sits on the same disk, is how a pixel defect became
  // a 25-minute CI round trip per guess.
  //
  // Unset in CI, so CI decides exactly as it did before.
  const channel = process.env["KAROS_BROWSER_CHANNEL"];
  if (channel !== undefined && channel.trim().length > 0) return true;

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
    { path: "fixtures/images/photo-2.png", description: "a close-up of hands sorting printed tickets on a wooden table" },
    { path: "fixtures/images/photo-3.png", description: "a small team gathered around a table reviewing printed charts" },
    // SIX, one per slide, and the last three are load-bearing. `goodImageVettingOutput`
    // cycles this pool with `pool[i % pool.length]` and the imagery band gives
    // the happy-path carousel four full-bleed slides, so with three candidates
    // slide 4 was handed slide 1's photograph. That went unnoticed until
    // `06f2-one-picture-one-slide` started asking whether one picture appears
    // twice in one post, at which point the happy path stopped being happy: the
    // duplicate was cleared and `07a` downgraded the slide to a text plate.
    //
    // Four was not enough either: the cycle runs over SIX slides, so slides 5
    // and 6 then repeated slides 1 and 2, which is invisible on a run where
    // the imagery band makes those two text plates and very visible on one
    // where it does not. Six paths, one per slide, and the fixture stops
    // having a repeat in it at all.
    //
    // The file is a byte copy of photo-1.png. The system identifies a picture
    // by its PATH, which is what a real harvested pool gives it, so a distinct
    // path is the whole fixture; identical pixels keep every render assertion
    // reading what it read before.
    { path: "fixtures/images/photo-4.png", description: "a whiteboard covered in a process diagram, mid-discussion, no visible branding" },
    { path: "fixtures/images/photo-5.png", description: "two people reading the same screen, one pointing at a chart" },
    { path: "fixtures/images/photo-6.png", description: "an empty meeting room with a long table and morning light" },
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
  "a close-up of hands sorting printed tickets on a wooden table",
  "a small team gathered around a table reviewing printed charts",
  "a bright modern open-plan office with people actively collaborating at a whiteboard, daytime",
  "a close-up of hands sorting printed tickets on a wooden table",
  "a small team gathered around a table reviewing printed charts",
];

/**
 * The headline and body for each of `SIX_RESEARCH_FACTS`, in order.
 *
 * ## Why this is not `Finding #N` plus the card's claim any more (Phase 5)
 *
 * Until RFC-18 this fixture was six slides headlined `Finding #1` ... `Finding
 * #6`, each body the fact card's `claim` copied VERBATIM. Nothing measured
 * either fact, so nothing objected. `07i-value-signals` measures both, and
 * refuses on both:
 *
 * - `checkRhythm` - six headlines opening with the same word is the cadence
 *   that makes a carousel read as one paragraph cut into six.
 * - `checkSourceProse` - a body that IS its source's sentence shares far more
 *   than eight consecutive tokens with it, which is the press-release-with-a-
 *   filter-on-it the prose ban exists to stop.
 *
 * **The gate was right and the fixture was wrong.** A file called
 * `goodCopyOutput` whose copy a value gate refuses is a lie in its own name,
 * and a human editor would have sent this draft back long before any gate
 * did. It is the same shape as PR #108's `syntheticPhotograph`: an old fixture
 * that was never what it claimed to be, exposed the moment a measurement got
 * honest. **When a new measurement fails an old fixture, suspect the fixture.**
 *
 * So these are written as copy rather than tuned to clear a threshold: a cover
 * that takes a position, one claim per slide with what follows from it for the
 * reader, and every figure kept exactly as its card states it while the
 * sentence around it is this account's own. `weakCopyOutput()` below is the
 * deliberate other side, so the suite still exercises the refusal.
 *
 * `sourceRef` stays the card's `claim` BYTE FOR BYTE on every slide: it is a
 * citation, `07-self-check` traces it verbatim, and `checkSourceProse`
 * excludes it for exactly that reason.
 */
const GOOD_SLIDE_COPY: ReadonlyArray<{ headline: string; body: string }> = [
  {
    headline: "Stop hand-building the weekly report",
    body: "Every team that handed it to the tool got about 4 hours a week back, which is most of a working morning.",
  },
  {
    headline: "Triage on arrival, not once the queue is deep",
    body: "Sorting tickets the moment they land resolved 30% more of them, so the queue stopped deciding everyone's afternoon.",
  },
  {
    headline: "A checklist is worth two working days",
    body: "Clients onboarded against one hit first value 2 days sooner, so the second invoice lands in the same month as the first.",
  },
  {
    headline: "The number that says whether a change survives",
    body: "Satisfaction inside the team went up 25%, and a process the people running it resent does not last a quarter.",
  },
  {
    headline: "Five rounds of revisions became two",
    body: "Writing the constraint into the brief took design from 5 to 2, which is three fewer meetings on every single piece of work.",
  },
  {
    headline: "Onboarding now takes a week",
    body: "It ran to 14 days and now runs to 7, which is the difference between remembering the sales call and not.",
  },
];

/**
 * Six different opening words, one per slide of a six-slide fixture.
 *
 * `07i-value-signals`' `checkRhythm` refuses three slides that open with the
 * same word, and a templated fixture headline (`` `${seed} note ${i + 1}` ``)
 * opens all six with the same one. That is the cadence the check was written
 * to catch and the fixtures were written before anything measured it.
 */
const FIXTURE_HEADLINE_OPENERS = ["First", "Then", "Next", "Also", "Finally", "Lastly"] as const;

/**
 * A slide headline for a fixture that does not care what its copy SAYS, only
 * that a run reaches the step under test.
 *
 * Two things it guarantees, both of which `07i-value-signals` now measures and
 * neither of which a templated `` `${subject} ${i + 1}` `` had:
 *
 * - a DIFFERENT opening word per slide, for `checkRhythm`;
 * - a numeral carrying a counted noun (`", 1 of 6"`), which is what
 *   `hasNamedSpecific` reads, so `checkNamedSpecifics` finds its
 *   `ceil(slides / 3)` specifics and `checkCoverTension` finds a number on the
 *   cover.
 *
 * A fixture whose copy IS the subject of the test writes its own headlines;
 * this is for the dozen that only need a run to get as far as `08` or `09`.
 */
export function fixtureHeadline(index: number, subject: string): string {
  return `${FIXTURE_HEADLINE_OPENERS[index % FIXTURE_HEADLINE_OPENERS.length]} ${subject}, ${index + 1} of 6`;
}

/** Six clean slides, one per `SIX_RESEARCH_FACTS` entry, each `sourceRef` matching a fact's `claim` verbatim. */
export function goodCopyOutput(): InstagramCopyOutput {
  return {
    format: "carousel",
    // Phase 5.6 item B2: which of the four shapes this hook is. "Four hours a
    // week came back to the team" is a figure and what it bought.
    hookPattern: "number_outcome",
    // Rewritten for Phase 5.6, items B4 and B8, and it needed both.
    //
    // It used to be one 34-word sentence — correct, sourced, and nothing like
    // a caption anyone reads on a phone. That is the shape
    // `checkCaptionRegister` now refuses, and a fixture called "good copy"
    // has to be good by the standard in force.
    //
    // It was also about "process changes" while this run's topic is
    // `automated weekly reporting is replacing the Monday status meeting` —
    // an inconsistency that predates this phase and that nothing could see
    // until a check read both. The caption names its own post's subject now.
    caption:
      [
        "We stopped hand-building the weekly report.",
        "The tool writes it now, and Monday's status meeting got shorter.",
        "Four hours a week came back to the team.",
        "Save this before your next planning week.",
      ].join("\n"),
    slides: SIX_RESEARCH_FACTS.map((fact, i) => ({
      n: i + 1,
      headline: GOOD_SLIDE_COPY[i]!.headline,
      body: GOOD_SLIDE_COPY[i]!.body,
      visualNeed: GOOD_VISUAL_NEEDS[i]!,
      sourceRef: fact.claim,
      layout: "photo" as const,
    })),
  };
}

/**
 * The deliberate other side of `goodCopyOutput()`: a draft that passes every
 * gate that existed before Phase 5 and that `07i-value-signals` refuses.
 *
 * It exists so the suite exercises the gate's REFUSAL path end to end. A
 * fixture set in which nothing can make a gate say no is a guard that cannot
 * fail, which is the failure mode this repository keeps catching in its own
 * tests. Grounded, on-brief, correctly sourced, clean typography, and
 * worthless - which is exactly the post the 2026-09-08 audit charged that
 * nothing was catching.
 *
 * It refuses on `checkSourceProse` first (every body is its card's sentence)
 * and would refuse on `checkRhythm` too (six headlines opening with the same
 * word). Both are named here so a reader knows which one moves if either
 * check's wording changes.
 */
export function weakCopyOutput(): InstagramCopyOutput {
  return {
    format: "carousel",
    caption: "A quick look at the process changes that actually moved this quarter.\nAnd at what the teams that made them did differently.",
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
 * A fresh, agent-written visual direction for `acme` (RFC-14 item Q) — the
 * document `00d-check-visual-direction` reads back out of the beliefs under
 * `VISUAL_DIRECTION_BELIEF_KEY`.
 *
 * `generatedAt` is NOW, so `00d` resolves `reuse` and no
 * `instagram-art-director` turn is consumed. That is the same reason
 * `seedBrief` defaults to a fresh brief and `seedStudio` to a fresh approved
 * set: a per-client SETUP artefact must not silently shift every fixture's
 * turn list. A test that wants the derive path passes
 * `seedVisualDirection: false` here AND an `artDirection` fixture to
 * `standardTurns`.
 *
 * Typed loosely on purpose (the shape belongs to
 * `src/workflow/visual-direction.ts`), but it is a REAL document: it parses
 * against `VisualDirectionSchema`, which `visual-direction.test.ts` asserts.
 */
export function goodVisualDirection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "instagram-art-director@1",
    subject: ["a founder at their own work, on the floor with the team, never posed"],
    light: ["one soft window source, late afternoon"],
    palette: ["#C4552F", "#17181C", "#F4F2EC"],
    treatment: ["documentary, lightly desaturated, never crushed to monochrome"],
    forbid: ["stock handshakes", "boardroom tables", "politics"],
    lines: [
      // 2026-09-23: no laptop in the shared fixture; a direction that prescribes
      // the cliché scene is re-derived (`checkVisualDirection`).
      { line: "Shoot the work, not the workplace: a whiteboard with real handwriting, hands on the product.", basis: "brief: positioning.oneLiner", confidence: "high" },
      { line: "One soft window light from the left, late afternoon, no fill.", basis: "brand kit: lighting", confidence: "medium" },
      { line: "Keep the frame inside the brand palette: #C4552F, #17181C, #F4F2EC.", basis: "brand kit: palette", confidence: "high" },
      { line: "Let the brand accent appear once as a real object, never as a colour overlay.", basis: "brand kit: accentColor", confidence: "high" },
    ],
    styleLock: { id: "documentary-warm", line: "documentary 35 mm, one soft window source, muted terracotta and bone palette, fine grain" },
    source: "brand+brief",
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
     * Typed loosely on purpose: this helper's job is to put a document at
     * the right key, and the document's shape belongs to the module that
     * defines it — a mirrored interface here would be a second definition to
     * keep in sync for no benefit.
     *
     * Omitted seeds a FRESH direction (`goodVisualDirection()`), for the same
     * reason `seedBrief` defaults to a fresh brief and `seedStudio` to a
     * fresh approved set: `00d-check-visual-direction` then resolves `reuse`
     * and consumes no `instagram-art-director` turn, so a fixture's turn list
     * is unchanged. `false` seeds NOTHING, which is the derive path — pass it
     * together with an `artDirection` fixture in `standardTurns`.
     */
    seedVisualDirection?: Record<string, unknown> | false;
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
  const seedDirection = opts.seedVisualDirection ?? goodVisualDirection();
  if (seedDirection !== false) beliefs["instagramVisualDirection"] = seedDirection;
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

/**
 * The slides of `goodCopyOutput()` that actually ASK FOR A PICTURE.
 *
 * `goodCopyOutput()` is six slides and every one of them is a `photo`, which
 * made `copy.slides.map((s) => s.n)` the right answer to "which slides does
 * image sourcing run for?" for the whole of this suite's life. The imagery band
 * ended that: six pictures on a six-slide carousel is over the ceiling
 * `ceilingFor(6)` puts in force, so `04m2` demotes the last two to `text_only`
 * before `05b` asks any harvester for anything.
 *
 * DERIVED, never a literal `[1, 2, 3, 4]`, and the distinction is the point. A
 * hard-coded list would say "four slides" where the test means "the slides that
 * wanted a photograph", and the next change to either bound would then edit the
 * number in nine files and the meaning in none of them. Every caller below
 * asserts the same sentence it always asserted.
 *
 * `seed` MUST be the test's own `runId`. Since 2026-09-20 the band varies WHICH
 * slides carry the pictures, seeded per run, so a derivation that omits the
 * seed answers for a different post than the one the workflow just rendered —
 * which is the same class of mistake as the hard-coded list this helper exists
 * to replace, one level further out.
 *
 * The fixture is deliberately left all-`photo`. It is not a model post - the
 * owner's rule is a MIX - but it is the input that gives the band something to
 * bite on, and a fixture the band cannot touch would make every test built on
 * it blind to the band's existence.
 */
export function pictureSlidesOfGoodCopy(copy: InstagramCopyOutput = goodCopyOutput(), seed?: string): number[] {
  return enforceImageryBand(copy, undefined, undefined, seed)
    .copy.slides.filter((s) => FULL_BLEED_IMAGE_LAYOUTS.has(s.layout ?? "photo"))
    .map((s) => s.n);
}

/**
 * The skeleton signature `goodCopyOutput()` ACTUALLY produces, derived the way
 * the workflow derives it rather than described.
 *
 * This used to be three lines in `skeleton-repeat-gate.test.ts`, above the
 * comment *"`goodCopyOutput()` is six `photo` slides, so every one resolves to
 * the client's own `slide.html` with a hero"*, and it hard-coded
 * `hasImage: true` on all six. Both halves of that sentence stopped being true
 * on the same day: the imagery band demotes the last two slides of a six-slide
 * all-photo carousel (`ceilingFor(6)` is 4), and a demoted slide is exactly the
 * plate the bounded object was built for, so it arrives at `07k` carrying a
 * `+figure` device in its token.
 *
 * ## Why it is derived through the real functions and not written down
 *
 * Every test that seeds "last week's post" needs THIS RUN's signature, because
 * what those tests assert is that an identical signature is refused. A literal
 * string would have to be re-measured by hand every time any of four unrelated
 * things moved — the band's two bounds, `boundedObjectFor`'s copy-length limit,
 * `MIN_QUIET_SLIDES`, or the fixture's own copy — and a stale literal does not
 * fail loudly here. It makes the repeat gate see two DIFFERENT signatures, find
 * no repeat, never buy a second attempt, and the test then fails on a missing
 * `05-write-copy-attempt-2` several assertions later, which is how this was
 * found rather than how it should have been.
 *
 * So it runs the same three stages `04m2`, assembly and `07k` run, in order,
 * and reads the token inputs off the assembled slides: the resolved template
 * and whether a hero landed, plus `fields.deviceKind`, which is the RENDERED
 * device kind rather than the copy's request for one. Same inputs, same
 * function, same string.
 */
export function signatureOfGoodCopy(copy: InstagramCopyOutput = goodCopyOutput(), seed?: string): string {
  const banded = enforceImageryBand(copy, undefined, undefined, seed).copy;
  const composed = composeBoundedObjects(
    banded,
    SIX_RESEARCH_FACTS.map((f) => ({ claim: f.claim, source: f.source })),
  ).copy;
  // A picture for every slide that still asks for one, which is what these
  // fixtures' stubbed harvesters supply.
  const selections: ImageSelection[] = composed.slides.map((slide) => ({
    n: slide.n,
    imagePath: FULL_BLEED_IMAGE_LAYOUTS.has(slide.layout ?? "photo") ? "fixtures/images/photo-1.png" : null,
    reason: "fixture",
    license: "CC0",
    rightsUsable: true,
    watermarkFree: true,
    claimMatch: 5,
    claimMatchReason: "fixture",
  }));
  const data = assembleSlidesData({
    clientSlug: "acme",
    postId: "post_sig",
    repoRoot: "/repo",
    brandTokens: goodBrandTokens(),
    copy: composed,
    selections,
    canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
  });
  return skeletonSignature(
    data.slides.map((sl) => ({ n: sl.n, template: sl.template, hasImage: sl.images?.["hero"] !== undefined })),
    rolesForSlideCount(data.slides.length),
    data.slides.map((sl) => sl.fields?.["deviceKind"] ?? ""),
  );
}
