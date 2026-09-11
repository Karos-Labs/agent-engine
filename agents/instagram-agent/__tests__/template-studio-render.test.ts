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

/** Item L's thresholds, used only until `interest-floor.ts` exports them. */
const SPEC_THRESHOLDS: StudioInterestThresholds = {
  largestEmptyRectCeiling: { cover: 0.22, interior: 0.28, closer: 0.22 },
  occupiedShareFloor: { cover: 0.42, interior: 0.3, closer: 0.42 },
  flatBackgroundCeiling: 0.7,
  imageryOrDeviceFloor: 0.03,
  textShareCeiling: 0.55,
};

async function resolveThresholds(): Promise<{ thresholds: StudioInterestThresholds; source: string }> {
  try {
    const mod = (await import("../src/workflow/interest-floor.js")) as unknown as Record<string, unknown>;
    const num = (key: string): number | undefined => (typeof mod[key] === "number" ? (mod[key] as number) : undefined);
    const interior = num("LARGEST_EMPTY_RECT_CEILING_INTERIOR");
    const cover = num("LARGEST_EMPTY_RECT_CEILING_COVER");
    const occupiedInterior = num("OCCUPIED_SHARE_FLOOR_INTERIOR");
    const occupiedCover = num("OCCUPIED_SHARE_FLOOR_COVER");
    const flat = num("FLAT_BACKGROUND_CEILING");
    const device = num("IMAGERY_OR_DEVICE_FLOOR");
    const text = num("TEXT_SHARE_CEILING");
    if ([interior, cover, occupiedInterior, occupiedCover, flat, device, text].every((v) => v !== undefined)) {
      return {
        source: "interest-floor.ts",
        thresholds: {
          largestEmptyRectCeiling: { cover: cover!, interior: interior!, closer: cover! },
          occupiedShareFloor: { cover: occupiedCover!, interior: occupiedInterior!, closer: occupiedCover! },
          flatBackgroundCeiling: flat!,
          imageryOrDeviceFloor: device!,
          textShareCeiling: text!,
        },
      };
    }
  } catch {
    // Not landed yet, or it names its constants differently — either way the
    // spec's own numbers are what this file was written against.
  }
  return { thresholds: SPEC_THRESHOLDS, source: "the spec's own numbers (interest-floor.ts not readable yet)" };
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
 * exercise, a GROUND that carries the frame. The oversized outlined numeral
 * and the accent rule are what take this plate from "a headline in the lower
 * third of a grey screen" to something a reader stops on, and they are also
 * what the measurement sees as occupied, non-flat frame.
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
  <div class="ground" aria-hidden="true"><span class="ghost">{{figure}}</span></div>
  <div class="band"></div>
  <div class="stack">
    <p class="eyebrow">{{kicker}}</p>
    <p class="figure">{{figure}}</p>
    <p class="sub">{{subLabel}}</p>
    <p class="lede">{{body}}</p>
    <p class="src">{{sourceLine}}</p>
  </div>
</div>`,
    css: `.plate { position: absolute; inset: 0; padding-inline: 64px; padding-block: 96px; display: flex; flex-direction: column; justify-content: flex-end; }
.ground { position: absolute; inset-block-start: -80px; inset-inline-start: -40px; inset-inline-end: 0; block-size: 720px; overflow: hidden; }
.ghost { font-family: var(--f-display); font-size: calc(560px * var(--ts, 1)); line-height: 0.8; color: color-mix(in srgb, var(--fg) 14%, transparent); }
.band { position: absolute; inset-block-start: 640px; inset-inline-start: 0; inline-size: 100%; block-size: 24px; background: var(--accent); }
.stack { position: relative; display: flex; flex-direction: column; gap: 20px; }
.eyebrow { font-family: var(--f-mono); font-size: calc(28px * var(--ts, 1)); letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); }
.figure { font-family: var(--f-display); font-size: calc(300px * var(--ts, 1)); line-height: 0.86; color: var(--fg); white-space: nowrap; }
.sub { font-family: var(--f-body); font-size: calc(52px * var(--ts, 1)); color: var(--fg); }
.lede { font-family: var(--f-body); font-size: calc(38px * var(--ts, 1)); line-height: 1.45; color: color-mix(in srgb, var(--fg) 86%, transparent); }
.src { font-family: var(--f-mono); font-size: calc(24px * var(--ts, 1)); color: color-mix(in srgb, var(--fg) 62%, transparent); }`,
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
