import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRenderCarousel, type RenderCarouselInput, type SlideMetrics, type SlideProbe } from "@agent-engine/tool-karos-publish";
import { ACCENT_MAX_SHARE, ACCENT_MIN_SHARE, checkInterestFloor, CLIPPED_EDGE_SHARE_CEILING, INK_SHARE_FLOOR, type SlideRole } from "../src/workflow/interest-floor.js";
import { buildScriptFontHeadForLanguage } from "../src/workflow/script-fonts.js";
import { deviceCssBlock } from "../src/workflow/slide-devices.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import { templateBasename } from "../src/workflow/visual-qa-pre-checks.js";
import { InstagramSlideCopySchema, type ImageSelection, type InstagramCopyOutput, type InstagramSlideCopy } from "../src/workflow/types.js";
import { syntheticPhotograph } from "./synthetic-photograph.js";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * THE NUMBER-SETTING TEST for items L and M.
 *
 * Every threshold in `interest-floor.ts` is a claim about how the bundled
 * archetypes actually measure, and a claim like that is worth exactly as much
 * as the evidence behind it. So this file renders all EIGHT archetypes
 * through the REAL `publish.renderCarousel` at `canvas.scale: 2`, measures
 * the real PNGs, and asserts each one clears its role's floors with margin.
 * It also `console.log`s the measured band table, which is the artefact the
 * constants' doc comments cite — when a threshold moves, it moves because
 * this table said so.
 *
 * The standing rule the whole file exists to serve: **a bundled archetype
 * that cannot clear its floor with margin is a template bug, never a
 * threshold to loosen.** `headline_focus` failed on day one, which is why
 * item M.3's ground rework shipped in the same PR.
 *
 * ## How "with margin" is asserted without depending on the constants
 *
 * Rather than importing the threshold values and doing arithmetic against
 * them (which would break the moment they are re-shaped, and would quietly
 * re-assert the constants against themselves), the margin is expressed
 * through the VERDICT FUNCTION: a slide passes with margin `m` when it still
 * passes after its emptiness metrics are each moved `m` in the failing
 * direction. That is the property the constants are supposed to encode, it
 * reads the same way a person would say it out loud, and it needs nothing
 * from `interest-floor.ts` but `checkInterestFloor` itself.
 *
 * Chromium-gated, and CI has Chromium — so a green run here is real
 * verification, not a skipped placeholder.
 */

/** The calibration margin item L.7 requires of every bundled archetype. */
const CALIBRATION_MARGIN = 0.08;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SOURCE_TEMPLATE_DIR = path.resolve(__dirname, "..", "assets", "templates", "default");
const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 } as const;

/** A 1x1 fully transparent PNG — the prep defect that used to have no symptom. */
const TRANSPARENT_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAABP2FU6AAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const SHORT = { headline: "Intake is the bottleneck", body: "Every queue we measured said the same thing." };
const MEDIUM = {
  headline: "Most marketing calendars fail in the second month, not the first",
  body: "The first month runs on enthusiasm. The second runs on whatever process you actually built, and for most teams that process is a spreadsheet nobody owns.",
};
const LONG = {
  headline: "Most marketing calendars fail in month two, and the reason is almost never the plan itself",
  body:
    "The first month runs on enthusiasm, so almost anything works. The second month runs on whatever process you actually built. For most teams that process is a spreadsheet nobody owns, a channel nobody checks and a review nobody scheduled, which is why the second month is where the calendar quietly stops being true.",
};

const HEBREW = {
  headline: "רוב לוחות התוכן נשברים בחודש השני",
  body: "החודש הראשון רץ על התלהבות. השני רץ על התהליך שבנית, ואצל רוב הצוותים התהליך הוא גיליון שאף אחד לא מתחזק.",
};

const FIGURE_DEVICE = { kind: "figure" as const, value: "73%", label: "of teams still file intake by hand", source: "Karos survey, 2026" };
const BARS_DEVICE = {
  kind: "bars" as const,
  rows: [
    { label: "Manual intake", value: 62, display: "62%" },
    { label: "Partly automated", value: 21, display: "21%" },
    { label: "Fully automated", value: 17, display: "17%" },
  ],
  source: "Karos survey, 2026",
};

let workDir: string;
let templateDir: string;
let outDir: string;
let heroPath: string;
let transparentHeroPath: string;

/**
 * The `--bg`/`--fg` each bundled template declares, read out of the files
 * themselves, keyed by filename.
 *
 * READ rather than written down, because a hard-coded pair is a second
 * source of truth for the one thing this whole file is anchored on: a
 * `groundHex` that does not match the document's real ground silently turns
 * `flatBackgroundShare` into a fact about nothing, and the source-pinning
 * tests forbid the literals appearing in `src/` precisely so they cannot be
 * copied around. If a template's token block is ever re-shaped, this map
 * follows it or `groundFor` throws — it does not quietly go on measuring
 * against a colour no document paints.
 */
const groundTokens = new Map<string, { ground: string; foreground: string }>();

/** The per-slide measure anchors for one template, or a throw naming the file whose token block could not be read. */
function groundFor(template: string): { ground: string; foreground: string } {
  const file = template.split(/[\\/]/u).pop() ?? template;
  const tokens = groundTokens.get(file);
  if (tokens === undefined) throw new Error(`no --bg/--fg found in ${file} — the calibration cannot anchor a measurement it cannot name`);
  return tokens;
}

/**
 * Materializes the bundled templates the way the workflow does at
 * `04c-resolve-templates`: every document gets the shared device stylesheet
 * spliced before `</head>` (the `extraHeadHtml` channel), and a non-Latin
 * run also gets the script-font sheet after it. Rendering the raw files
 * instead would measure a document no client ever receives.
 */
async function materialize(dir: string, scriptLanguage?: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const extra = [deviceCssBlock(), scriptLanguage !== undefined ? buildScriptFontHeadForLanguage(scriptLanguage, undefined) : undefined]
    .filter((fragment): fragment is string => fragment !== undefined)
    .join("\n");
  for (const file of (await fs.readdir(SOURCE_TEMPLATE_DIR)).filter((f) => f.endsWith(".html"))) {
    const html = await fs.readFile(path.join(SOURCE_TEMPLATE_DIR, file), "utf8");
    const ground = /--bg\s*:\s*(#[0-9a-fA-F]{3,8})/u.exec(html)?.[1];
    const foreground = /--fg\s*:\s*(#[0-9a-fA-F]{3,8})/u.exec(html)?.[1];
    if (ground !== undefined && foreground !== undefined) groundTokens.set(file, { ground, foreground });
    await fs.writeFile(path.join(dir, file), html.replace("</head>", `${extra}\n</head>`), "utf8");
  }
}

const slide = (over: Partial<InstagramSlideCopy> & { n: number }): InstagramSlideCopy =>
  InstagramSlideCopySchema.parse({ headline: SHORT.headline, body: SHORT.body, visualNeed: "a need", sourceRef: "a claim", ...over });

const selection = (n: number, imagePath: string | null): ImageSelection => ({
  n,
  imagePath,
  reason: "calibration fixture",
  license: "CC0",
  rightsUsable: true,
  watermarkFree: true,
  claimMatch: 5,
  claimMatchReason: "calibration fixture",
});

/**
 * Attaches the per-slide measurement anchors the workflow attaches at
 * `07c-emit-slides-data-attempt-N`, in the same shape and from the same
 * places: `accentHex` from the slide's own resolved `fields.accentColor`,
 * `groundHex`/`foregroundHex` from the brand token pair the document
 * declares.
 *
 * WITHOUT THIS THE CALIBRATION WAS MEASURING A DIFFERENT RENDER FROM
 * PRODUCTION. `measureSlidePng` takes its anchors from the caller and has no
 * other way to learn them, so an un-hinted render reports `accentShare` 0.0%
 * on every slide — the accent band warning fires on all eight archetypes and
 * the one metric that says "this slide is painted in the brand's colours" is
 * dead. `groundHex` matters for the opposite reason: the ground is otherwise
 * inferred as the modal flat colour, which is right for a typographic plate
 * and wrong for anything carrying a field or a photograph, where the modal
 * colour IS the field. Both are what `assembleForAttempt` passes, so this is
 * the harness catching up to the pipeline, not a new measurement policy.
 */
function withMeasureAnchors(assembled: RenderCarouselInput): RenderCarouselInput {
  return {
    ...assembled,
    slides: assembled.slides.map((slide) => {
      const { ground, foreground } = groundFor(slide.template);
      return {
        ...slide,
        measure: {
          ...(typeof slide.fields["accentColor"] === "string" ? { accentHex: slide.fields["accentColor"] } : {}),
          foregroundHex: foreground,
          groundHex: ground,
        },
      };
    }),
  };
}

/** Assembles one carousel through the REAL `assembleSlidesData`, so every rendered field is the one a run would produce. */
function assemble(slides: InstagramSlideCopy[], selections: ImageSelection[], over: Partial<Parameters<typeof assembleSlidesData>[0]> = {}): RenderCarouselInput {
  return withMeasureAnchors(assembleSlidesData({
    clientSlug: "calibration",
    postId: "interest-floor",
    repoRoot: REPO_ROOT,
    brandTokens: { templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"), slideTemplate: "slide.html", accentColor: "#C4552F" },
    copy: { format: "carousel", caption: "A calibration caption.", slides } as InstagramCopyOutput,
    selections,
    canvas: CANVAS,
    availableTemplates: new Set(["cover.html", "closer.html", "stat-callout.html", "quote-card.html", "comparison-card.html", "list-takeaway.html", "headline-focus.html"]),
    templateDirOverride: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
    ...over,
  }));
}

interface Measured {
  n: number;
  template: string;
  metrics: SlideMetrics;
  probe: SlideProbe;
}

/** Renders one assembled carousel with measurement and the DOM probe on, and hands back both per slide. */
async function render(input: RenderCarouselInput): Promise<Measured[]> {
  const tool = createRenderCarousel();
  const outcome = await tool.execute(
    { ...input, outDir: path.relative(REPO_ROOT, outDir).replaceAll("\\", "/"), measure: true, probe: true },
    { ctx: { runId: "calibration", clientSlug: "calibration", productId: "instagram-agent", runKind: "setup", metadata: {} } },
  );
  if (outcome.status !== "success") throw new Error(`render failed: ${JSON.stringify(outcome)}`);
  return outcome.result.rendered.map((entry, index) => {
    const metrics = entry.metrics;
    const probe = entry.probe;
    if (metrics === undefined || probe === undefined) throw new Error(`slide ${entry.n} came back without metrics/probe — measure/probe were requested`);
    return { n: entry.n, template: input.slides[index]!.template, metrics, probe };
  });
}

/**
 * The per-slide options `checkInterestFloor` needs: which slide this is, and
 * which archetype it rendered through so every finding names it. No
 * `downgradedForImages` waiver here — nothing in a calibration render lost a
 * photograph to sourcing, so a cover with no picture must be judged on its
 * ground layer rather than excused.
 */
function optsFor(measured: Measured): { slide: number; archetype: string } {
  return { slide: measured.n, archetype: templateBasename(measured.template) };
}

/**
 * Whether this slide would STILL pass its role's floor if every emptiness
 * metric moved `margin` in the failing direction. See the module header for
 * why the margin is expressed this way instead of against the constants.
 *
 * Three metrics are deliberately left alone.
 *
 * `inkShare`, because clause A is render integrity rather than a question of
 * degree. `textShare`, because its ceiling is the OPPOSITE failure — a wall
 * of text — so tightening it would fail a legitimately dense slide for being
 * dense. And `imageryOrDeviceShare`, because `IMAGERY_OR_DEVICE_FLOOR` is
 * deliberately a hair above zero: the interest floor's own reasoning puts the
 * smallest legitimate device the bundled set can make at 0.04-0.06 against a
 * 0.03 floor, so demanding 0.08 of margin there would be a stricter rule than
 * the rule, and would refuse the very devices the floor exists to require.
 * The margin is a claim about EMPTINESS, which is what the owner's defect
 * was.
 */
function findingsAtMargin(measured: Measured, role: SlideRole, margin: number): string[] {
  const tightened: SlideMetrics = {
    ...measured.metrics,
    occupiedShare: measured.metrics.occupiedShare - margin,
    largestEmptyRectShare: measured.metrics.largestEmptyRectShare + margin,
  };
  return checkInterestFloor(tightened, measured.probe, role, optsFor(measured)).findings.map((f) => `${f.kind} (${f.sentence})`);
}

/**
 * A row of the band table the constants' doc comments cite.
 *
 * The label names the CASE and `measured.template` names the FILE, and they
 * are printed separately because they are not the same claim. The labels here
 * are hand-written; the file is whatever `resolveLayout` chose. They disagreed
 * for the whole of this PR's first CI run: "cover.html no-hero" was rendering
 * `headline-focus.html`, because `resolveLayout` refused a cover with no hero
 * and no device, so the row recorded as `cover.html`'s numbers (2.7%
 * imagery-or-device) were a different template's — and the conclusion drawn
 * from them, that `cover.html` fails its own floor, was about a file the test
 * never rendered. Printing both is what makes that visible.
 */
function report(label: string, role: SlideRole, measured: Measured): void {
  const m = measured.metrics;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  console.log(
    [
      label.padEnd(30),
      `→ ${templateBasename(measured.template)}`.padEnd(20),
      role.padEnd(9),
      `flat ${pct(m.flatBackgroundShare)}`.padEnd(13),
      `occupied ${pct(m.occupiedShare)}`.padEnd(18),
      `emptyRect ${pct(m.largestEmptyRectShare)}`.padEnd(19),
      `imagery+device ${pct(m.imageryOrDeviceShare)}`.padEnd(24),
      `text ${pct(m.textShare)}`.padEnd(12),
      `accent ${pct(m.accentShare)}`.padEnd(14),
      `edges ${m.edgeDensity.toFixed(3)}`.padEnd(13),
      `colours ${m.quantisedColourCount}`,
    ].join(" "),
  );
}

describe.skipIf(!isChromiumInstalled())("interest-floor calibration: every bundled archetype clears its role's floor", () => {
  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-calibration-"));
    templateDir = path.join(workDir, "templates");
    outDir = path.join(workDir, "out");
    await materialize(templateDir);
    await fs.mkdir(outDir, { recursive: true });
    heroPath = path.join(workDir, "hero.png");
    transparentHeroPath = path.join(workDir, "transparent.png");
    await fs.writeFile(heroPath, syntheticPhotograph(CANVAS.w, CANVAS.h));
    await fs.writeFile(transparentHeroPath, TRANSPARENT_1X1);
  }, 120_000);

  afterAll(async () => {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it(
    "the six typographic archetypes pass the INTERIOR floor at short, medium and long copy",
    async () => {
      for (const [lengthLabel, copy] of [["short", SHORT], ["medium", MEDIUM], ["long", LONG]] as const) {
        const slides = [
          slide({ n: 1, layout: "photo", ...copy }),
          slide({ n: 2, layout: "stat_callout", ...copy, stat: { figure: "73%", subLabel: "of teams file intake by hand", source: "Karos survey, 2026" } }),
          slide({ n: 3, layout: "quote_card", ...copy, quote: { text: "We stopped guessing and started measuring the queue.", attribution: "Head of Ops, 2026" } }),
          slide({
            n: 4,
            layout: "comparison_card",
            ...copy,
            comparison: { leftLabel: "Before", leftBody: "Five review rounds", rightLabel: "After", rightBody: "Two review rounds" },
          }),
          slide({ n: 5, layout: "list_takeaway", ...copy, items: [{ title: "Name the owner", note: "One person, not a channel" }, { title: "Measure the queue", note: "Weekly, not monthly" }, { title: "Cut a round" }] }),
          slide({ n: 6, layout: "headline_focus", ...copy, kicker: "THE TURN" }),
        ];
        const measured = await render(assemble(slides, [selection(1, path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/")), ...[2, 3, 4, 5, 6].map((n) => selection(n, null))]));

        for (const entry of measured) {
          report(`${entry.template} (${lengthLabel})`, "interior", entry);
          expect(checkInterestFloor(entry.metrics, entry.probe, "interior", optsFor(entry)).findings, `${entry.template} @ ${lengthLabel}`).toEqual([]);
          // A bundled archetype that only just clears its floor is a
          // template bug waiting for slightly different copy.
          expect(findingsAtMargin(entry, "interior", CALIBRATION_MARGIN), `${entry.template} @ ${lengthLabel} has under ${CALIBRATION_MARGIN} margin`).toEqual([]);
          expect(entry.probe.overflow, `${entry.template} @ ${lengthLabel} overflows: ${entry.probe.overflowing.join(", ")}`).toBe(false);
        }
      }
    },
    600_000,
  );

  /**
   * THE OTHER TWO TYPE SCALES, which nothing in this file used to render.
   *
   * `SlideStyleOverride.fontScale` gives the reviewer three steps and every
   * other case here hard-codes `"m"` — so the band table, and every
   * `probe.overflow === false` assertion resting on it, described one third of
   * what a reviewer can actually set. Measured on real Chromium, that gap was
   * hiding two genuine layout overflows at `l` (content cut off, not the 2-3px
   * glyph-box artefact): `stat-callout.html`'s slab overflowed by 43px with a
   * long subLabel, and `list-takeaway.html`'s rows panel by 88px with the four
   * items `SlideListSchema` permits. Both are fixed in the templates — the
   * slab is capped and the four-row list sets its own tighter row.
   *
   * AND THAT SENTENCE USED TO END "and this is what stops the next one
   * shipping", WHICH WAS NOT TRUE OF THE INSTRUMENT IT RESTED ON. The next
   * one shipped in the same commit. `headline_focus` at `l` with the LONG
   * copy below — the case this very test renders as slide 6 — printed its
   * headline 155px above its own parent and straight on top of the kicker
   * rail, and both assertions here passed, because `scrollHeight` describes
   * the scrollable overflow region and that region only grows DOWNWARD: an
   * element pushed out of the block-start edge of its parent leaves
   * `scrollHeight === clientHeight`. `probe.overflow` could not see it, so
   * neither could this test. (A `justify-content: flex-end` block that the
   * flex algorithm was free to shrink below its content is how a layout
   * arrives in that state; `closer.html`'s middle was in the same shape.)
   *
   * `probePage` now carries a second limb that compares each in-flow
   * element's rect against its parent's, so `probe.overflow` means what the
   * assertions below have always claimed it means. That limb, not this
   * comment, is what stops the next one.
   *
   * Four items rather than three on the list, deliberately: four is the
   * schema's cap and the only row count that does not fit at `l`.
   */
  it(
    "every archetype passes at the reviewer's OTHER type scales, s and l",
    async () => {
      for (const fontScale of ["s", "l"] as const) {
        const slides = [
          slide({ n: 1, layout: "cover", ...LONG, kicker: "THE SHIFT" }),
          slide({ n: 2, layout: "stat_callout", ...MEDIUM, stat: { figure: "$25,000", subLabel: "interest-free assistance for eligible first-time buyers", source: "MassHousing press release, April 2026" } }),
          slide({ n: 3, layout: "quote_card", ...MEDIUM, quote: { text: "We stopped guessing and started measuring the queue, and the second month stopped being the one that broke.", attribution: "Head of Ops, 2026" } }),
          slide({ n: 4, layout: "comparison_card", ...LONG, comparison: { leftLabel: "Before", leftBody: "Five review rounds and a spreadsheet nobody owns", rightLabel: "After", rightBody: "Two review rounds and one named owner" } }),
          slide({
            n: 5,
            layout: "list_takeaway",
            ...LONG,
            items: [
              { title: "Name the owner", note: "One person, not a channel" },
              { title: "Measure the queue", note: "Weekly, not monthly" },
              { title: "Cut a review round", note: "Two rounds is enough for anything under a page" },
              { title: "Publish on a schedule", note: "The calendar is the process, not the plan" },
            ],
          }),
          slide({ n: 6, layout: "headline_focus", ...LONG, kicker: "THE TURN" }),
          slide({ n: 7, layout: "closer", headline: "Three things to review before your next campaign goes live", body: "Save this for your next planning session." }),
        ];
        const overrides = new Map(slides.map((s) => [s.n, { fontScale }] as const));
        const measured = await render(assemble(slides, slides.map((s) => selection(s.n, null)), { slideStyleOverrides: overrides }));
        // Position 1 is a cover and the last position a closer, exactly as
        // `checkSlidesInterestFloor` assigns roles from position.
        const roles: SlideRole[] = measured.map((_, i) => (i === 0 ? "cover" : i === measured.length - 1 ? "closer" : "interior"));

        for (const [index, entry] of measured.entries()) {
          report(`${entry.template} (fontScale ${fontScale})`, roles[index]!, entry);
          // A content archetype at a positional role may fail clause E and
          // nothing else — the same posture the position-1/last test asserts.
          expect(
            checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry)).findings.map((f) => f.kind).filter((k) => k !== "no-device"),
            `${entry.template} @ fontScale ${fontScale}`,
          ).toEqual([]);
          expect(entry.probe.overflow, `${entry.template} @ fontScale ${fontScale} overflows: ${entry.probe.overflowing.join(", ")}`).toBe(false);
        }
      }
    },
    600_000,
  );

  /**
   * THE ACCENT BAND, AT THE OTHER END OF THE RANGE THE PALETTE WALK ADMITS.
   *
   * `--accent` is a live brand-kit slot whose only gate is
   * `ACCENT_GROUND_CONTRAST_FLOOR = 3` against the ground, so a pale kit is
   * admissible and every case above renders the one dark reference hex. That
   * gap mattered: the previous `cover.html` painted a flat
   * `color-mix(accent 88%, bg)` field across half the plate, which measured
   * 40.0% accent on `#C4552F` — 4.3 points under `ACCENT_MAX_SHARE` — and
   * 45.7% on `#EFC75E`, OVER it, so every cover that client shipped would have
   * carried "the accent has become the ground". A warning that fires on every
   * slide is a warning the reviewer learns to ignore.
   */
  it(
    "the accent stays inside its band on a PALE brand accent, not only on the dark reference kit",
    async () => {
      const slides = [
        slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "MARKET SIGNAL" }),
        slide({ n: 2, layout: "stat_callout", ...MEDIUM, stat: { figure: "73%", subLabel: "of teams file intake by hand", source: "Karos survey, 2026" } }),
        slide({ n: 3, layout: "quote_card", ...MEDIUM, quote: { text: "We stopped guessing and started measuring the queue.", attribution: "Head of Ops, 2026" } }),
        slide({ n: 4, layout: "closer", headline: "That is the whole pattern", body: "Which round would you cut first?" }),
      ];
      const pale = "#EFC75E";
      const measured = await render(
        assemble(slides, slides.map((s) => selection(s.n, null)), {
          brandTokens: { templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"), slideTemplate: "slide.html", accentColor: pale },
        }),
      );
      const roles: SlideRole[] = ["cover", "interior", "interior", "closer"];
      for (const [index, entry] of measured.entries()) {
        report(`${entry.template} (pale accent ${pale})`, roles[index]!, entry);
        expect(entry.metrics.accentShare, `${entry.template}: the pale accent did not paint at all`).toBeGreaterThan(ACCENT_MIN_SHARE);
        expect(entry.metrics.accentShare, `${entry.template}: the pale accent has become the ground`).toBeLessThan(ACCENT_MAX_SHARE);
        // And the plate still passes its role's floor on the pale kit — the
        // accent's lightness must not be what carries a template over it.
        expect(checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry)).findings, `${entry.template} @ pale accent`).toEqual([]);
      }
    },
    600_000,
  );

  it(
    "cover and closer pass the tighter COVER/CLOSER floors, including a cover with no photograph at all",
    async () => {
      for (const [lengthLabel, copy] of [["short", SHORT], ["medium", MEDIUM], ["long", LONG]] as const) {
        const slides = [
          slide({ n: 1, layout: "cover", ...copy, kicker: "THE SHIFT" }),
          slide({ n: 2, layout: "stat_callout", ...copy, stat: { figure: "73%", subLabel: "of teams", source: "Karos survey, 2026" } }),
          slide({ n: 3, layout: "list_takeaway", ...copy, items: [{ title: "Name the owner" }, { title: "Measure the queue" }] }),
          slide({ n: 4, layout: "closer", headline: "That is the whole pattern", body: "Which round would you cut first?" }),
        ];
        const selections = [selection(1, null), selection(2, null), selection(3, null), selection(4, null)];
        const measured = await render(assemble(slides, selections));

        const cover = measured[0]!;
        const closer = measured[3]!;
        report(`cover no-hero (${lengthLabel})`, "cover", cover);
        report(`closer (${lengthLabel})`, "closer", closer);

        // THE PREMISE, ASSERTED BEFORE THE NUMBERS. Every claim below is
        // about `cover.html`, and for the whole of this PR's first CI run it
        // was not: `resolveLayout` degraded a hero-less, device-less cover to
        // `headline-focus.html`, and this test measured that instead while
        // calling it the cover. A band table is worth nothing if it cannot
        // say which file it measured.
        expect(templateBasename(cover.template), `the no-hero cover case did not render cover.html at ${lengthLabel}`).toBe("cover");
        expect(templateBasename(closer.template), `the closer case did not render closer.html at ${lengthLabel}`).toBe("closer");

        // THE STRUCTURAL CLAIM, ON PIXELS: with no hero and no device the
        // cover's colour-block ground plus keyline still carry the frame.
        // This is the assertion that makes `cover.html` incapable of being
        // the slide the owner complained about.
        expect(cover.metrics.imageryOrDeviceShare, `cover carried no graphic ground at ${lengthLabel}`).toBeGreaterThan(0.1);
        expect(checkInterestFloor(cover.metrics, cover.probe, "cover", optsFor(cover)).findings, `cover @ ${lengthLabel}`).toEqual([]);
        expect(findingsAtMargin(cover, "cover", CALIBRATION_MARGIN), `cover @ ${lengthLabel} margin`).toEqual([]);

        expect(checkInterestFloor(closer.metrics, closer.probe, "closer", optsFor(closer)).findings, `closer @ ${lengthLabel}`).toEqual([]);
        expect(findingsAtMargin(closer, "closer", CALIBRATION_MARGIN), `closer @ ${lengthLabel} margin`).toEqual([]);
        expect(closer.probe.overflow).toBe(false);
      }
    },
    600_000,
  );

  it(
    "a device-bearing variant of every device-slot archetype passes, and the device is in the pixels",
    async () => {
      const slides = [
        slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "THE SHIFT", device: FIGURE_DEVICE }),
        slide({ n: 2, layout: "headline_focus", ...MEDIUM, kicker: "THE TURN", device: BARS_DEVICE }),
        slide({ n: 3, layout: "closer", headline: "That is the pattern", body: "Which round would you cut?", device: FIGURE_DEVICE }),
      ];
      const measured = await render(assemble(slides, [1, 2, 3].map((n) => selection(n, null))));
      const roles: SlideRole[] = ["cover", "interior", "closer"];
      for (const [index, entry] of measured.entries()) {
        report(`${entry.template} +device`, roles[index]!, entry);
        expect(checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry)).findings, entry.template).toEqual([]);
        expect(findingsAtMargin(entry, roles[index]!, CALIBRATION_MARGIN), `${entry.template} +device margin`).toEqual([]);
        expect(entry.probe.overflow, `${entry.template} +device overflows: ${entry.probe.overflowing.join(", ")}`).toBe(false);
      }
      // A device is a graphic, so it lifts the metric the cover/closer floor
      // reads — that is the whole reason the free re-layout can fix a
      // no-device finding without a redraft.
      expect(measured[1]!.metrics.imageryOrDeviceShare).toBeGreaterThan(0.03);
    },
    600_000,
  );

  /**
   * THE GUARD THAT WAS MISSING: can a real template fail the floor at all?
   *
   * Until this test, nothing asserted that any bundled template COULD. That
   * gap is what let a ground treatment tuned above `INK_DELTA` pass review: a
   * 2160x2880 plate painting only `headline-focus.html`'s hairline field over
   * the brand ground, with no headline, no body, no kicker and no device,
   * measured `inkShare` 7.9%, `occupiedShare` 42% and a 1.5% largest empty
   * rectangle, and cleared clauses A, C, D and F. Decoration was being scored
   * as content.
   *
   * So: render each of the three ground-bearing templates with every content
   * slot EMPTY and require a finding. The render input is hand-built rather
   * than assembled, because `InstagramSlideCopySchema` requires a non-empty
   * headline and body: an empty slot is a RENDER accident (a race, a failed
   * substitution), not something the copy schema can express.
   */
  it(
    "every ground-bearing template FAILS the floor when its slots come through empty",
    async () => {
      const furniture = { dir: "ltr", fontScale: "m", textAlign: "start", accentColor: "#C4552F", groundStyle: "grid", slideIndex: "01" };
      // `client` and `repoRoot`, NOT `clientSlug`: this input is hand-built
      // rather than assembled, and the `as unknown as` cast below means the
      // compiler cannot catch a wrong field name here. Getting it wrong cost
      // a CI-only schema rejection on this PR's first push.
      const blanks: RenderCarouselInput = {
        client: "calibration",
        postId: "interest-floor-empty",
        canvas: CANVAS,
        repoRoot: REPO_ROOT,
        templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
        slides: [
          { n: 1, template: "cover.html", fields: { ...furniture }, images: {}, htmlFragments: {} },
          { n: 2, template: "headline-focus.html", fields: { ...furniture }, images: {}, htmlFragments: {} },
          { n: 3, template: "closer.html", fields: { ...furniture }, images: {}, htmlFragments: {} },
        ],
      } as unknown as RenderCarouselInput;
      // The SAME anchors every other case in this file measures against —
      // otherwise the one test whose job is to prove a decorated empty plate
      // fails would be the one measuring it differently from the rest.
      const measured = await render(withMeasureAnchors(blanks));
      const roles: SlideRole[] = ["cover", "interior", "closer"];

      for (const [index, entry] of measured.entries()) {
        report(`${entry.template} EMPTY`, roles[index]!, entry);
        const findings = checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry)).findings;
        expect(findings.map((f) => f.kind), `${entry.template} with empty slots produced no finding`).not.toEqual([]);
        // `dead-space`, `empty` or `render-integrity`: "there is a hole",
        // "there is nothing to read", or "there is hardly any ink on this
        // frame at all". Which one fires depends on how much the template's
        // ground still paints once nothing is standing on it, and all three
        // are correct answers for a plate with every slot empty.
        //
        // `render-integrity` is here because it is what CI actually reported
        // once the grounds were bound to their content, and it is the
        // STRONGEST of the three rather than a looser alternative. Clause A
        // (`inkShare < INK_SHARE_FLOOR`) returns on its own and suppresses
        // the rest — deliberately: "the render looks broken, not boring"
        // carries a different steer (re-render, do not rewrite), and a
        // dead-space sentence about a frame with 0.5% ink on it would send a
        // writer to fix copy that is not the problem. So a template landing
        // there is a template whose ground paints even LESS unconditionally
        // than one reported as a hole, which is the direction this test is
        // pushing. It is still a pixel fact: `inkShare` comes from the
        // screenshot, never from the DOM.
        expect(
          findings.some((f) => f.kind === "dead-space" || f.kind === "empty" || f.kind === "render-integrity"),
          `${entry.template}: ${findings.map((f) => f.kind).join(", ")} (inkShare ${entry.metrics.inkShare.toFixed(4)})`,
        ).toBe(true);
        // And the DOM agrees: with every slot hidden by its own `:empty`
        // rule, no text box painted.
        expect(entry.probe.textBoxShare).toBeLessThan(0.02);

        // ── AND IT FAILS ON THE PIXELS ALONE. ──
        //
        // This is the half the first version of this test could not see, and
        // the half that matters. Clause G has a DOM limb (`textBoxShare`
        // under `PROBE_TEXT_BOX_SHARE_FLOOR`) which an empty plate trips
        // whatever the pixels say — so for the whole life of the previous
        // revision the assertion above passed through that limb while the
        // pixel metrics said the plate was full: `cover.html` with EVERY SLOT
        // EMPTY measured 55.8% occupied against a 42% floor and 29.7%
        // imagery-or-device against a 10% one, because the ground painted a
        // colour field and a full-plate texture whatever the copy did. Re-run
        // with the DOM limb switched off (a `textBoxShare` well over its
        // floor), a finding must still fire — which it can only do from the
        // pixels. Every ink-bearing layer in the bundled set is now bound to
        // the content that justifies it, so an empty plate measures ~0.5%
        // occupied, under half the ink floor, and clause A answers first.
        const pixelsOnly = checkInterestFloor(entry.metrics, { ...entry.probe, textBoxShare: 0.5 }, roles[index]!, optsFor(entry)).findings;
        expect(
          pixelsOnly.some((f) => f.kind === "dead-space" || f.kind === "empty" || f.kind === "render-integrity"),
          `${entry.template} with empty slots passed on the PIXELS — a ground layer is painting unconditionally: ${JSON.stringify({
            inkShare: entry.metrics.inkShare,
            occupiedShare: entry.metrics.occupiedShare,
            contentOccupiedShare: entry.metrics.contentOccupiedShare,
            largestEmptyRectShare: entry.metrics.largestEmptyRectShare,
            imageryOrDeviceShare: entry.metrics.imageryOrDeviceShare,
          })}`,
        ).toBe(true);
      }
    },
    600_000,
  );

  /**
   * THE OTHER HALF OF THE SAME GUARD: a plate with copy on it, and a HOLE in
   * the middle of it.
   *
   * The empty-plate case above proves an unconditional ground cannot score;
   * this one proves the emptiness measurement can still SEE a hole on a plate
   * that is otherwise working. It is the property `largestEmptyRect` exists
   * for — `slide-metrics.ts`'s own header calls it "the metric that names the
   * complaint", because "a large empty upper area" is one contiguous block
   * and a slide can sit under a flat-share ceiling while still carrying one.
   *
   * It could not fire at all before this revision. Every bundled template
   * painted a full-bleed texture inset 16px, which marks a cell in every
   * position on the plate, so `largestEmptyRectShare` was the SAME 1.5% (the
   * 16px gutter the inset did not paint) on a plate with the full copy on it
   * and on a plate with nothing on it. The texture-immune second mask was
   * defeated too: the ground stack's combined mean shift crossed the content
   * threshold, so `largestEmptyContentRectShare` collapsed to the same 1.5%.
   *
   * So: render `headline_focus` and `closer` with their top and bottom copy
   * present and the MIDDLE slot missing, and require `dead-space`. Rendered
   * that way, `headline-focus.html` reports a 36% rectangle against a 28%
   * interior ceiling and `closer.html` 56% against 22%.
   */
  it(
    "a plate whose MIDDLE is hollow reports dead-space, on a plate that is otherwise carrying copy",
    async () => {
      const furniture = { dir: "ltr", fontScale: "m", textAlign: "start", accentColor: "#C4552F", groundStyle: "grid", slideIndex: "03" };
      // Hand-built for the same reason the empty case is: `InstagramSlideCopySchema`
      // requires a non-empty headline, and a slot that came through empty is a
      // RENDER accident rather than something the copy schema can express.
      const hollow: RenderCarouselInput = {
        client: "calibration",
        postId: "interest-floor-hollow",
        canvas: CANVAS,
        repoRoot: REPO_ROOT,
        templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
        slides: [
          // kicker at the top, body at the foot, no statement between them.
          { n: 1, template: "headline-focus.html", fields: { ...furniture, kicker: "THE FAILURE MODE", headline: "", body: MEDIUM.body }, images: {}, htmlFragments: {} },
          // eyebrow at the top, the ask at the foot, no takeaway between them.
          { n: 2, template: "closer.html", fields: { ...furniture, eyebrow: "WHAT TO DO", takeaway: "", question: "", cta: "Save this for your next planning session." }, images: {}, htmlFragments: {} },
        ],
      } as unknown as RenderCarouselInput;
      const measured = await render(withMeasureAnchors(hollow));
      const roles: SlideRole[] = ["interior", "closer"];

      for (const [index, entry] of measured.entries()) {
        report(`${entry.template} HOLLOW MIDDLE`, roles[index]!, entry);
        // The premise, asserted first: this plate is NOT the empty one. The
        // copy that is present really did paint, so a `dead-space` finding
        // here is about the hole and not about a blank render.
        expect(entry.probe.textBoxShare, `${entry.template} hollow: no copy painted, so this is the empty case, not the hollow one`).toBeGreaterThan(0.01);
        expect(entry.metrics.inkShare, `${entry.template} hollow: nothing painted at all`).toBeGreaterThan(INK_SHARE_FLOOR);

        const findings = checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry)).findings;
        expect(
          findings.map((f) => f.kind),
          `${entry.template} with a hollow middle did not report dead-space (largestEmptyRectShare ${entry.metrics.largestEmptyRectShare}) — a ground layer is painting where the composition is not`,
        ).toContain("dead-space");
      }
    },
    600_000,
  );

  /**
   * ROLES COME FROM POSITION, so every archetype that may sit at position 1
   * or last is judged at the TIGHTER cover/closer numbers — `occupiedShare`
   * 0.42 against 0.30 and `largestEmptyRectShare` 0.22 against 0.28 — plus
   * clause E, which interiors are exempt from.
   *
   * The five content archetypes were only ever calibrated at the interior
   * role (the first test in this file), and prompt @14 §7 accepts four of
   * them on slide 1, as does `default:cover-carries-device`'s own
   * `DEVICE_TEMPLATE_BASENAMES`. Their numbers at a positional role were
   * therefore unknown, which is what this closes.
   *
   * What is asserted is what the design actually promises: at its role's
   * floor a content archetype may fail ONLY clause E (it carries no imagery
   * and no drawn device), and attaching a device clears even that. Anything
   * else — a hole, an idle plate, a decorated empty one — is a template bug
   * per L.8's standing rule, and the band table this prints is how it gets
   * measured rather than argued.
   */
  it(
    "every content archetype clears the EMPTINESS half of its role's floor in position 1 and in the last position",
    async () => {
      const content: Array<{ label: string; over: Partial<InstagramSlideCopy> }> = [
        { label: "stat_callout", over: { layout: "stat_callout", stat: { figure: "73%", subLabel: "of teams file intake by hand", source: "Karos survey, 2026" } } },
        { label: "quote_card", over: { layout: "quote_card", quote: { text: "We stopped guessing and started measuring the queue.", attribution: "Head of Ops, 2026" } } },
        {
          label: "comparison_card",
          over: { layout: "comparison_card", comparison: { leftLabel: "Before", leftBody: "Five review rounds", rightLabel: "After", rightBody: "Two review rounds" } },
        },
        {
          label: "list_takeaway",
          over: {
            layout: "list_takeaway",
            items: [{ title: "Name the owner", note: "One person, not a channel" }, { title: "Measure the queue", note: "Weekly, not monthly" }, { title: "Cut a round" }],
          },
        },
      ];

      // Position 1 is judged as a cover, the last position as a closer.
      for (const [role, position] of [["cover", "first"], ["closer", "last"]] as const) {
        for (const { label, over } of content) {
          const slides =
            position === "first"
              ? [slide({ n: 1, ...MEDIUM, ...over }), slide({ n: 2, layout: "photo", ...SHORT }), slide({ n: 3, layout: "closer", headline: "That is the pattern", body: "Which round would you cut first?" })]
              : [slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "THE SHIFT" }), slide({ n: 2, layout: "photo", ...SHORT }), slide({ n: 3, ...MEDIUM, ...over })];
          const measured = await render(assemble(slides, [1, 2, 3].map((n) => selection(n, null))));
          const entry = position === "first" ? measured[0]! : measured[2]!;
          report(`${label} @ ${position}`, role, entry);

          const findings = checkInterestFloor(entry.metrics, entry.probe, role, optsFor(entry)).findings;
          // Clause E is the one a typographic archetype may legitimately fail
          // at a positional role; nothing else may.
          expect(findings.map((f) => f.kind).filter((k) => k !== "no-device"), `${label} @ ${position} (${role}): ${findings.map((f) => f.sentence).join(" | ")}`).toEqual(
            [],
          );
          expect(entry.probe.overflow, `${label} @ ${position} overflows: ${entry.probe.overflowing.join(", ")}`).toBe(false);
        }
      }
    },
    600_000,
  );

  it(
    "headline_focus FAILS the cover role and passes as interior — the pixel proof of default:cover-carries-device",
    async () => {
      const slides = [slide({ n: 1, layout: "headline_focus", ...MEDIUM, kicker: "THE SETUP" }), slide({ n: 2, layout: "photo", ...SHORT })];
      const measured = await render(assemble(slides, [selection(1, null), selection(2, null)]));
      const entry = measured[0]!;
      report("headline-focus as cover", "cover", entry);
      // The premise, again: an EXPLICIT `headline_focus` on slide 1 is still
      // honoured as one. What changed is only what a slide DEGRADES to there.
      expect(templateBasename(entry.template)).toBe("headline-focus");

      // The asserted exception. A statement slide is a good mid-carousel
      // turn and a bad cover, and the floor has to be able to say so —
      // otherwise the cover role's tighter numbers are decoration.
      const asCover = checkInterestFloor(entry.metrics, entry.probe, "cover", optsFor(entry)).findings;
      expect(asCover.map((f) => f.kind)).toContain("no-device");
      expect(checkInterestFloor(entry.metrics, entry.probe, "interior", optsFor(entry)).findings).toEqual([]);
    },
    300_000,
  );

  it(
    "a real hero slide measures as imagery, and a 1x1 TRANSPARENT hero is caught as no-device",
    async () => {
      const slides = [slide({ n: 1, layout: "photo", ...MEDIUM }), slide({ n: 2, layout: "photo", ...SHORT })];
      const measured = await render(
        assemble(slides, [
          selection(1, path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/")),
          selection(2, path.relative(REPO_ROOT, transparentHeroPath).replaceAll("\\", "/")),
        ]),
      );
      report("slide.html real hero", "cover", measured[0]!);
      report("slide.html transparent hero", "cover", measured[1]!);

      expect(measured[0]!.metrics.imageryShare).toBeGreaterThanOrEqual(0.5);
      // AND THE BRAND GROUND SURVIVES UNDER IT. A photograph has variety in
      // every cell, so it contributes no FLAT cells and cannot win the modal
      // flat colour — the ground stays the token the caller declared. This is
      // the assertion that fails the moment the "photograph" is really a flat
      // fill, which is how the old solid-magenta fixture went unnoticed: it
      // became the ground, and 41.9% of a visually full plate then measured
      // as an empty rectangle.
      expect(measured[0]!.metrics.backgroundMatchesBrandGround, "a photograph must not become the measured ground").toBe(true);
      // A FULL-BLEED PHOTOGRAPH PUTS INK IN THE BLEED BAND BY DEFINITION.
      // Measured on this fixture, `clippedEdgeShare` is ~1.7% against clause
      // B's 0.4% ceiling — four times over — so clause B's `clippedEdgeShare`
      // limb has to be inert for a slide that is carrying imagery, or every
      // correct photo slide fails the floor on every attempt. This assertion
      // is where that shows up.
      expect(measured[0]!.metrics.clippedEdgeShare, "the bleed-band exemption is only meaningful if the band actually has ink in it").toBeGreaterThan(
        CLIPPED_EDGE_SHARE_CEILING,
      );
      expect(checkInterestFloor(measured[0]!.metrics, measured[0]!.probe, "cover", optsFor(measured[0]!)).findings).toEqual([]);

      // The prep defect that had no symptom: a "successful" render whose
      // hero contributed no pixels at all. It renders, it is well-formed,
      // and it is empty — which is exactly what the measurement is for.
      //
      // A MEASURED DIGIT, deliberately, and NOT `IMAGERY_OR_DEVICE_FLOOR`.
      //
      // This line was widened to the floor once, on the reasoning that "the
      // base template now paints a readable gradient whether or not a hero
      // loaded, which took this from ~2.8% to ~4.3%". That was a first-pass
      // number the templates' own rework superseded: this plate measures
      // **2.7%** against the current tree (`.local/probe-template.mjs`'s
      // `slide-transparent-hero` row, and the third-pass table beside
      // `IMAGERY_OR_DEVICE_FLOOR` lists the same figure). So the widening was
      // not needed to turn anything green — and at the floor's value the
      // assertion became a restatement of the `no-device` expectation on the
      // next line, since both are the same comparison against the same
      // constant. Two assertions that cannot disagree pin one fact.
      //
      // 0.035 is 2.7% plus a third of itself: enough that a font or a
      // rasteriser nudging the number does not fail the suite, tight enough
      // that a template change which put real ink on this plate would. If it
      // ever legitimately moves, re-measure and move the literal WITH the new
      // number written here — that is what makes this line say something the
      // line below it does not.
      expect(measured[1]!.metrics.imageryOrDeviceShare, "a 1x1 transparent hero measured 2.7% on the current templates").toBeLessThan(0.035);
      expect(checkInterestFloor(measured[1]!.metrics, measured[1]!.probe, "cover", optsFor(measured[1]!)).findings.map((f) => f.kind)).toContain("no-device");
    },
    300_000,
  );

  /**
   * A COVER ON A PHOTOGRAPH, CARRYING A SERIES BADGE.
   *
   * Two gaps closed at once. Every other case in this file — and all 50 cases
   * in `.local/probe-template.mjs` — rendered `seriesBadge: ""`, and
   * `.brand-badge:empty { display: none }` then hid the badge in every one of
   * them, so nothing in the loop ever rendered it. And `cover.html` is the
   * one template whose field paint is switched OFF when a photograph loads,
   * which is exactly when its badge and eyebrow stop standing on a ramp the
   * template controls and start standing on someone's picture. `cover.html`
   * shipped a badge in `--accent-ink` (#141414) for one revision: correct on
   * the ramp head it was written for, 1.10:1 over a dark photograph.
   *
   * WHAT THIS TEST CAN AND CANNOT SEE. Nothing in `measureSlidePng` or in the
   * DOM probe measures CONTRAST, so this case pins the geometry — the floor,
   * and that the chip and scrim the legibility fix adds do not overflow or
   * push the plate off its numbers. The contrast itself is measured in
   * `.local/cover-contrast.mjs` (glyph core against the median of the text's
   * own band, over light, near-white and dark grained plates) and the numbers
   * are written beside the rules they justify in `cover.html`. Saying so here
   * is the point: a green on this case is not a claim about legibility.
   */
  it(
    "a cover on a photograph carrying a series badge clears the cover floor",
    async () => {
      const slides = [
        slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "THE SHIFT" }),
        slide({ n: 2, layout: "photo", ...SHORT }),
        slide({ n: 3, layout: "closer", headline: "That is the pattern", body: "Which round would you cut first?" }),
      ];
      const measured = await render(
        assemble(
          slides,
          [selection(1, path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/")), selection(2, null), selection(3, null)],
          {
            brandTokens: {
              templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
              slideTemplate: "slide.html",
              accentColor: "#C4552F",
              seriesBadge: "THE SIGNAL",
            },
          },
        ),
      );
      const entry = measured[0]!;
      report("cover + hero + badge", "cover", entry);
      expect(templateBasename(entry.template)).toBe("cover");
      expect(checkInterestFloor(entry.metrics, entry.probe, "cover", optsFor(entry)).findings.map((f) => f.kind).filter((k) => k !== "dead-space"), `cover + hero + badge`).toEqual([]);
      // The chip behind the eyebrow is a real box with real padding, and the
      // `.cov-rail`'s spread is a real shadow: neither may push anything out
      // of its parent, in either direction.
      expect(entry.probe.overflow, `cover + hero + badge overflows: ${entry.probe.overflowing.join(", ")}`).toBe(false);
    },
    300_000,
  );

  /**
   * HEBREW, ACROSS EVERY TEMPLATE THE SCRIPT SHEET TOUCHES.
   *
   * It used to render four of the eight, and the four it skipped were the
   * ones that were broken. `script-fonts.ts` overrides the leading of every
   * DISPLAY_SELECTOR to 1.12 for Hebrew, which is tighter than the 1.2-1.3 the
   * templates were sized against, and a display face's glyph box taller than
   * its line box makes the block report `scrollHeight > clientHeight` — which
   * the DOM probe calls an overflowing element and clause B fails the slide
   * on. Measured in Chromium with Heebo at 62px/1.12, the allowance needed is
   * ~0.177em; `list_takeaway` shipped 0.10-0.12em, `quote_card` 0.14em,
   * `comparison_card` 0.12-0.14em and `slide.html` 0.10em, so all four
   * reported `probe.overflow` on EVERY Hebrew render at every copy length —
   * a false `clipped` finding whose steer told the writer to shorten a
   * headline that fit. The allowance now comes from the sheet that sets the
   * leading rather than from a per-template constant, and this case is what
   * keeps the two in step.
   */
  it(
    "a HEBREW render of every bundled archetype passes, in the script's own faces, with no overflow",
    async () => {
      const hebrewTemplateDir = path.join(workDir, "templates-he");
      await materialize(hebrewTemplateDir, "Hebrew");
      const previous = templateDir;
      templateDir = hebrewTemplateDir;
      try {
        const slides = [
          slide({ n: 1, layout: "cover", ...HEBREW, kicker: "השבוע" }),
          slide({ n: 2, layout: "stat_callout", ...HEBREW, stat: { figure: "73%", subLabel: "מהצוותים מדווחים ידנית", source: "סקר פנימי, 2026" } }),
          slide({
            n: 3,
            layout: "list_takeaway",
            ...HEBREW,
            items: [{ title: "לקבוע אחראי", note: "אדם אחד, לא ערוץ" }, { title: "למדוד את התור", note: "שבועי, לא חודשי" }, { title: "לחתוך סבב" }],
          }),
          slide({ n: 4, layout: "quote_card", ...HEBREW, quote: { text: "הפסקנו לנחש והתחלנו למדוד את התור.", attribution: "מנהלת תפעול, 2026" } }),
          slide({
            n: 5,
            layout: "comparison_card",
            ...HEBREW,
            comparison: { leftLabel: "לפני", leftBody: "חמישה סבבי בדיקה", rightLabel: "אחרי", rightBody: "שני סבבי בדיקה" },
          }),
          // `photo` WITH a hero, so `slide.html` itself is rendered rather
          // than degraded away: it is the fourth file whose display leading
          // the script sheet overrides, and it was the fourth that overflowed.
          slide({ n: 6, layout: "photo", ...HEBREW }),
          slide({ n: 7, layout: "closer", headline: "זה כל הדפוס", body: "איזה סבב הייתם חותכים ראשון?" }),
        ];
        const measured = await render(
          assemble(slides, [1, 2, 3, 4, 5, 6, 7].map((n) => selection(n, n === 6 ? path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/") : null))),
        );
        const roles: SlideRole[] = ["cover", "interior", "interior", "interior", "interior", "interior", "closer"];
        for (const [index, entry] of measured.entries()) {
          report(`${entry.template} (Hebrew)`, roles[index]!, entry);
          expect(checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry)).findings, `${entry.template} (Hebrew)`).toEqual([]);
          // Hebrew's average glyph width differs from Latin's, so an in-page
          // character-count size ladder can pick a size that overflows with
          // no pixel signature except a clipped edge. The probe is the only
          // thing that sees it.
          expect(entry.probe.overflow, `${entry.template} (Hebrew) overflows: ${entry.probe.overflowing.join(", ")}`).toBe(false);
          // The first real proof that the Phase 0 script font LOADED, rather
          // than that its <link> was emitted.
          expect(entry.probe.fontFamiliesUsed.join(" "), `${entry.template} (Hebrew) used no Hebrew face`).toMatch(/Heebo|Assistant|Rubik/);
          // Glyphs painted, not tofu boxes and not an empty plate.
          expect(entry.metrics.textShare, `${entry.template} (Hebrew) painted no text`).toBeGreaterThan(0);
        }
      } finally {
        templateDir = previous;
      }
    },
    600_000,
  );
});
