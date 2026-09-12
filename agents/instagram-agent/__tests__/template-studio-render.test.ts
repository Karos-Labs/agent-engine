import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import * as templates from "@agent-engine/tool-karos-templates";
import { buildScriptFontHeadForLanguage } from "../src/workflow/script-fonts.js";
import {
  STUDIO_INTEREST_MARGIN,
  StudioTemplateDraftSchema,
  buildStudioSampleContent,
  composeStudioDocument,
  interestHeadroom,
  studioSampleSeedFromBrief,
  type StudioInterestThresholds,
  type StudioSlideMetrics,
  type StudioSlideProbe,
  type StudioTemplateDraft,
} from "../src/workflow/template-studio.js";
import { goodClientBrief, isChromiumInstalled } from "./test-helpers.js";

/**
 * Phase 2, item N, gate 5 + gate 6 END TO END, with a real Chromium: a
 * fixture designer output goes through the code-owned document shell, the
 * real `publish.renderCarousel` at `canvas.scale: 2`, the real per-pixel
 * measurement, and the interest floor's own thresholds — LTR and RTL —
 * clearing the floor with the studio's >= 0.05 calibration margin.
 *
 * This is the only test in the studio's set that can prove the central claim
 * rather than assert it: that a template which measures well is a template
 * that LOOKS like something. Everything else in `template-studio-validation`
 * runs on injected metrics, which proves the policy and not the pixels.
 *
 * Two capability gates, both of which SKIP rather than fail:
 *
 *  - **Chromium.** `describe.skipIf(!isChromiumInstalled())`, the same guard
 *    `default-template-render.test.ts` and `workflow-e2e.test.ts` use. CI's
 *    image has the browser, so this is real verification there.
 *  - **The measurement.** `publish.renderCarousel` only attaches `metrics`
 *    and `probe` when it was built with item L's measurement (WP-C1). Until
 *    the tool package is rebuilt with it, the render still runs and still
 *    proves the document renders — the measurement assertions skip with a
 *    printed reason instead of failing a suite over a sibling work package's
 *    build state.
 *
 * The interest thresholds come from `interest-floor.ts` when it is present
 * (item L, WP-C2) and from this file's spec-faithful copy otherwise; which
 * one was used is printed, so a run of this file always says what it proved.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * The SPEC's table, transcribed when this file was written. No longer used to
 * grade anything — `resolveThresholds` reads the shipped module — it is kept
 * as the second opinion `assertSpecAndModuleAgree` checks the module against.
 * `imageryOrDeviceFloor` is left at the spec's 0.03 on purpose: the shipped
 * constant moved to 0.10 on measurements (see `interest-floor.ts`), and
 * silently editing this copy to match would delete the record of that.
 */
const SPEC_THRESHOLDS: StudioInterestThresholds = {
  largestEmptyRectCeiling: { cover: 0.22, interior: 0.28, closer: 0.22 },
  occupiedShareFloor: { cover: 0.42, interior: 0.3, closer: 0.42 },
  flatBackgroundCeiling: 0.7,
  imageryOrDeviceFloor: 0.03,
  textShareCeiling: 0.55,
};

/**
 * ── 2026-09-11: THIS FUNCTION NEVER ONCE READ `interest-floor.ts`. ──
 *
 * It looked up `LARGEST_EMPTY_RECT_CEILING_INTERIOR`,
 * `OCCUPIED_SHARE_FLOOR_COVER` and two more per-role scalars by name. Item L
 * shipped them as per-role RECORDS — `LARGEST_EMPTY_RECT_CEILING.interior`,
 * `OCCUPIED_SHARE_FLOOR.cover` — so every lookup returned `undefined`, the
 * `every(...)` guard failed, and the function silently fell through to
 * `SPEC_THRESHOLDS` on every run since the module landed. The fallback was
 * written for the window before item L existed and was supposed to close
 * itself; instead it became the only path, and the printed source line said
 * so to a log nobody reads.
 *
 * That mattered: `SPEC_THRESHOLDS.imageryOrDeviceFloor` is the spec's
 * original 0.03, and the real constant is now 0.10. The interior role does
 * not weigh that clause (`interestHeadroom` only adds `no-device` for cover
 * and closer), so no assertion in this file moved — but a studio row judged
 * at a positional role would have been calibrated against a floor a third of
 * the real one, and this is the file whose job is to prove the studio uses
 * the run's own thresholds.
 *
 * So the records are read as records, and a missing export is now a FAILURE
 * rather than a shrug: `interest-floor.ts` is a sibling module in this
 * package, not an optional dependency, and a test that quietly grades
 * against its own copy of the numbers is not testing the policy at all.
 */
async function resolveThresholds(): Promise<{ thresholds: StudioInterestThresholds; source: string }> {
  const mod = (await import("../src/workflow/interest-floor.js")) as unknown as Record<string, unknown>;
  const num = (key: string): number => {
    const value = mod[key];
    if (typeof value !== "number") throw new Error(`interest-floor.ts no longer exports a numeric ${key} — update this test with it, never around it`);
    return value;
  };
  const record = (key: string): Record<"cover" | "interior" | "closer", number> => {
    const value = mod[key];
    const roles = ["cover", "interior", "closer"] as const;
    if (typeof value !== "object" || value === null || roles.some((r) => typeof (value as Record<string, unknown>)[r] !== "number")) {
      throw new Error(`interest-floor.ts no longer exports a per-role ${key} — update this test with it, never around it`);
    }
    return value as Record<"cover" | "interior" | "closer", number>;
  };
  return {
    source: "interest-floor.ts",
    thresholds: {
      largestEmptyRectCeiling: record("LARGEST_EMPTY_RECT_CEILING"),
      occupiedShareFloor: record("OCCUPIED_SHARE_FLOOR"),
      flatBackgroundCeiling: num("FLAT_BACKGROUND_CEILING"),
      imageryOrDeviceFloor: num("IMAGERY_OR_DEVICE_FLOOR"),
      textShareCeiling: num("TEXT_SHARE_CEILING"),
    },
  };
}

/**
 * Kept as the pin that the two agree. `SPEC_THRESHOLDS` is the spec's own
 * table, transcribed by hand when this file was written; `resolveThresholds`
 * reads the shipped module. Where they differ, the module is the policy and
 * the difference is deliberate — `imageryOrDeviceFloor` moved 0.03 -> 0.10
 * on measurements — so this asserts only the clauses an INTERIOR row is
 * actually judged on, which are the ones this file's two cases use.
 */
function assertSpecAndModuleAgree(thresholds: StudioInterestThresholds): void {
  expect(thresholds.largestEmptyRectCeiling.interior).toBe(SPEC_THRESHOLDS.largestEmptyRectCeiling.interior);
  expect(thresholds.occupiedShareFloor.interior).toBe(SPEC_THRESHOLDS.occupiedShareFloor.interior);
  expect(thresholds.flatBackgroundCeiling).toBe(SPEC_THRESHOLDS.flatBackgroundCeiling);
  expect(thresholds.textShareCeiling).toBe(SPEC_THRESHOLDS.textShareCeiling);
}

/** The document shell code owns. `buildStudioTemplateDocument` once it exists; its byte-identical sibling until then. */
function shellBuilder(): (bodyHtml: string) => string {
  const mod = templates as unknown as Record<string, unknown>;
  const studio = mod["buildStudioTemplateDocument"];
  if (typeof studio === "function") return studio as (bodyHtml: string) => string;
  return templates.buildCustomArchetypeDocument;
}

/**
 * A fixture designer output for `stat_callout` — what a good
 * `instagram-template-designer` turn looks like.
 *
 * Written to the rules the prompt states and the gates enforce: a fragment
 * and a stylesheet only, logical properties throughout, every size scaled
 * off `var(--ts)`, colour only from the tokens — and, the point of the
 * exercise, a GROUND that carries the frame.
 *
 * ── 2026-09-11: THIS FIXTURE WAS THE DEFECT IT WAS WRITTEN TO DISPROVE ──
 *
 * It used to carry a `.ghost` numeral at `--fg` 14% behind a 24px accent
 * band, with the copy stacked in the lower third. On real Chromium that
 * measured 17.7% occupied against the interior floor's 30%, and the Hebrew
 * render came back at a margin of -0.178 — so the one test in the studio's
 * set that can prove "a template which measures well is a template that
 * LOOKS like something" was asserting it of a plate that measures as a grey
 * screen. A 14% hairline is invisible to the metric because it is invisible
 * to a reader; the rest of the bundled set had exactly the same bug, tuned
 * in for exactly the same reason, and item L.8's rule is that this is a
 * TEMPLATE bug and never a threshold to move.
 *
 * So the fixture now composes the way the reworked `stat_callout` archetype
 * does: the figure sits in a filled STAT SLAB — an accent-tinted gradient
 * carrying the same texture as the plate, capped with an accent rule, and
 * elastic between the kicker rail and the footnote so it fills the frame
 * instead of leaving a band of bare ground above and below it. Measured
 * through the same engine at the same canvas (`.local/studio-probe.mts`,
 * 2026-09-11, LTR / Hebrew):
 *
 *   flat 58.6/61.5%   occupied 42.8/39.2%   emptyRect 13.3/16.4%
 *   imagery+device 35.8/33.3%   text 7.1/5.9%   margin 0.128/0.092
 *
 * — against a required 0.05, with `empty` the tightest clause on both.
 *
 * Two details that are load-bearing rather than decorative, both learned on
 * the bundled set: the slab is a GRADIENT carrying the plate's own texture,
 * because `measureSlidePng` reads the slide's ground from the modal FLAT
 * cell and an untextured panel over a third of the frame wins that vote and
 * becomes "the background"; and the display figure carries a
 * `padding-block-end` in `em`, because a display face's glyph box is taller
 * than a sub-1.15 line box and the renderer's DOM probe reports the
 * difference as an overflowing element, which clause B fails on outright.
 */
function statCalloutFixture(): StudioTemplateDraft {
  return StudioTemplateDraftSchema.parse({
    archetypeId: "stat_callout",
    name: "Acme figure plate",
    role: "interior",
    layoutType: "typographic",
    ground: "colour-block",
    slots: ["figure", "subLabel", "body", "sourceLine"],
    bodyHtml: `<div class="plate">
  <div class="sc-head">
    <p class="eyebrow">{{kicker}}</p>
    <div class="sc-rail"></div>
  </div>
  <div class="num-zone">
    <p class="figure">{{figure}}</p>
    <div class="band"></div>
    <p class="sub">{{subLabel}}</p>
  </div>
  <div class="sc-foot">
    <p class="lede">{{body}}</p>
    <p class="src">{{sourceLine}}</p>
  </div>
</div>`,
    css: `.plate { position: absolute; inset: 0; padding-inline: 64px; padding-block: 96px 88px; display: flex; flex-direction: column; justify-content: space-between; }
.sc-head { flex: 0 0 auto; }
.eyebrow { display: inline-block; font-family: var(--f-mono); font-size: calc(22px * var(--ts, 1)); letter-spacing: 0.22em; text-transform: uppercase; color: var(--accent); }
.sc-rail { block-size: 2px; background: color-mix(in srgb, var(--fg) 48%, transparent); margin-block-start: calc(24px * var(--ts, 1)); }
.num-zone { flex: 1 1 auto; min-block-size: 0; max-block-size: calc(660px * var(--ts, 1)); display: flex; flex-direction: column; justify-content: center; margin-block: calc(40px * var(--ts, 1)); padding: calc(52px * var(--ts, 1)) calc(48px * var(--ts, 1)); }
.num-zone:has(.figure:not(:empty)) { background-image: repeating-linear-gradient(45deg, color-mix(in srgb, var(--fg) 14%, transparent) 0 2px, transparent 2px 11px), linear-gradient(158deg, color-mix(in srgb, var(--accent) 32%, var(--bg)) 0%, color-mix(in srgb, var(--accent) 17%, var(--bg)) 100%); border-block-start: calc(8px * var(--ts, 1)) solid var(--accent); }
.figure { font-family: var(--f-display); font-weight: 600; font-size: calc(240px * var(--ts, 1)); line-height: 1; letter-spacing: -0.025em; white-space: nowrap; padding-block-end: 0.28em; color: var(--fg); }
.band { inline-size: calc(200px * var(--ts, 1)); block-size: calc(14px * var(--ts, 1)); background: var(--accent); }
.sub { font-family: var(--f-display); font-weight: 500; font-size: calc(54px * var(--ts, 1)); line-height: 1.28; margin-block-start: calc(38px * var(--ts, 1)); max-inline-size: 820px; padding-block-end: 0.14em; color: var(--fg); }
.sc-foot { flex: 0 0 auto; }
.lede { font-family: var(--f-body); font-size: calc(31px * var(--ts, 1)); line-height: 1.55; color: color-mix(in srgb, var(--fg) 90%, transparent); max-inline-size: 880px; border-inline-start: calc(4px * var(--ts, 1)) solid color-mix(in srgb, var(--accent) 80%, transparent); padding-inline-start: calc(28px * var(--ts, 1)); }
.src { font-family: var(--f-body); font-size: calc(17px * var(--ts, 1)); color: color-mix(in srgb, var(--fg) 58%, transparent); line-height: 1.6; margin-block-start: calc(30px * var(--ts, 1)); }`,
    sample: { figure: "63%", subLabel: "still onboard by hand", body: "Two sentences of body copy that wrap once at this size.", sourceLine: "internal data, 2026" },
    derivedFrom: {
      formatLabel: "stat-led",
      accounts: ["instagram/@peer"],
      postCount: 6,
      signalsAvailable: ["likes"],
      signalsAbsent: ["views absent for 1 of 1 accounts"],
      exampleUrls: [],
      why: "the best-performing posts on the peer account open on a single figure with the claim beneath it",
    },
  });
}

/** One slide, rendered for real, with the measurement asked for. */
async function renderOnce(input: {
  document: string;
  content: { fields: Record<string, string>; htmlFragments: Record<string, string>; imagePaths: Record<string, string> };
  outDir: string;
  label: string;
}): Promise<{ ok: boolean; reason?: string; metrics?: StudioSlideMetrics; probe?: StudioSlideProbe }> {
  const templateDir = path.join(input.outDir, "templates");
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(path.join(templateDir, "studio-sample.html"), input.document, "utf8");

  const tool = createRenderCarousel();
  const outcome = await tool.execute(
    {
      client: "studio-smoke",
      postId: input.label,
      templateDir: path.relative(REPO_ROOT, templateDir).split(path.sep).join("/"),
      outDir: path.relative(REPO_ROOT, input.outDir).split(path.sep).join("/"),
      repoRoot: REPO_ROOT,
      slides: [{ n: 1, template: "studio-sample.html", fields: input.content.fields, images: input.content.imagePaths, htmlFragments: input.content.htmlFragments }],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      readyFlag: "__CAROUSEL_READY__",
      // Item L (WP-C1). Extra keys are ignored by a build that predates it,
      // which is exactly why the measurement assertions probe rather than
      // assume.
      measure: true,
      probe: true,
    } as never,
    { ctx: { runId: "studio_render", clientSlug: "studio-smoke", productId: "instagram-agent", runKind: "setup", metadata: {} } },
  );

  if (outcome.status !== "success") return { ok: false, reason: JSON.stringify(outcome) };
  const rendered = (outcome.result as unknown as { rendered?: Array<Record<string, unknown>> }).rendered ?? [];
  const first = rendered[0] ?? {};
  return {
    ok: true,
    ...(first["metrics"] !== undefined ? { metrics: first["metrics"] as StudioSlideMetrics } : {}),
    ...(first["probe"] !== undefined ? { probe: first["probe"] as StudioSlideProbe } : {}),
  };
}

describe.skipIf(!isChromiumInstalled())("a studio template goes end to end: shell -> real render -> real interest floor", () => {
  let outDir = "";
  afterEach(async () => {
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
    outDir = "";
  });

  const kit = { cssVars: { "--bg": "#17181C", "--fg": "#F4F2EC", "--accent": "#C8FF4D" }, palette: ["#C8FF4D"] };
  const deps = { buildStudioTemplateDocument: shellBuilder(), composeDocument: templates.composeDocument };

  it("clears the interior floor with the studio's calibration margin, in LTR", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-studio-render-"));
    const draft = statCalloutFixture();
    const seed = studioSampleSeedFromBrief({ brief: goodClientBrief(), kit, clientSlug: "acme" });
    const document = composeStudioDocument(draft, deps);
    const content = buildStudioSampleContent(draft, seed);

    const render = await renderOnce({ document, content, outDir, label: "ltr" });
    // The document itself renders: that half is real whatever the tool build.
    expect(render.reason ?? "").toBe("");
    expect(render.ok).toBe(true);

    if (render.metrics === undefined) {
      console.log("[template-studio-render] publish.renderCarousel returned no metrics — item L's measurement is not in this build; the render itself passed");
      return;
    }
    const { thresholds, source } = await resolveThresholds();
    assertSpecAndModuleAgree(thresholds);
    const headroom = interestHeadroom(render.metrics, "interior", thresholds);
    console.log(
      `[template-studio-render] LTR stat_callout against ${source}: flat=${render.metrics.flatBackgroundShare.toFixed(3)} occupied=${render.metrics.occupiedShare.toFixed(3)} ` +
        `emptyRect=${render.metrics.largestEmptyRectShare.toFixed(3)} imageryOrDevice=${render.metrics.imageryOrDeviceShare.toFixed(3)} text=${render.metrics.textShare.toFixed(3)} ` +
        `margin=${headroom.margin.toFixed(3)} (tightest: ${headroom.tightest})`,
    );

    // The claim: a template designed to the studio's rules measures as
    // something, with room to spare.
    expect(render.metrics.inkShare).toBeGreaterThan(0.015);
    expect(render.metrics.occupiedShare).toBeGreaterThan(thresholds.occupiedShareFloor.interior);
    expect(render.metrics.largestEmptyRectShare).toBeLessThan(thresholds.largestEmptyRectCeiling.interior);
    expect(headroom.margin).toBeGreaterThanOrEqual(STUDIO_INTEREST_MARGIN);
    if (render.probe !== undefined) {
      expect(render.probe.overflow).toBe(false);
      expect(render.probe.fontFamiliesUsed.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("clears the same floor in Hebrew, with the script font actually loaded and glyphs painted", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-studio-render-rtl-"));
    const draft = statCalloutFixture();
    const seed = studioSampleSeedFromBrief({ brief: goodClientBrief(), kit, clientSlug: "geektime", targetLanguage: "Hebrew", dir: "rtl" });
    // The same head fragment Phase 0 splices for a non-Latin target language,
    // so this render exercises the production font path rather than a
    // hand-written stack.
    const scriptHead = buildScriptFontHeadForLanguage("Hebrew", kit.cssVars);
    expect(scriptHead).toBeDefined();
    const document = composeStudioDocument(draft, deps, { brandHeadHtml: scriptHead });
    const content = buildStudioSampleContent(draft, seed);

    const render = await renderOnce({ document, content, outDir, label: "rtl" });
    expect(render.reason ?? "").toBe("");
    expect(render.ok).toBe(true);

    if (render.metrics === undefined) {
      console.log("[template-studio-render] no metrics in this build; the Hebrew render itself passed");
      return;
    }
    const { thresholds } = await resolveThresholds();
    const headroom = interestHeadroom(render.metrics, "interior", thresholds);
    console.log(
      `[template-studio-render] RTL stat_callout: flat=${render.metrics.flatBackgroundShare.toFixed(3)} occupied=${render.metrics.occupiedShare.toFixed(3)} ` +
        `text=${render.metrics.textShare.toFixed(3)} margin=${headroom.margin.toFixed(3)} families=${render.probe?.fontFamiliesUsed.join("/") ?? "n/a"}`,
    );

    // Glyphs painted, not tofu — the prep defect that had no symptom.
    expect(render.metrics.textShare).toBeGreaterThan(0);
    expect(headroom.margin).toBeGreaterThanOrEqual(STUDIO_INTEREST_MARGIN);
    if (render.probe !== undefined) {
      expect(render.probe.overflow).toBe(false);
      expect(render.probe.fontFamiliesUsed.join(" ")).toMatch(/Heebo|Assistant|Rubik/);
    }
  }, 120_000);
});
