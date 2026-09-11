import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRenderCarousel, type RenderCarouselInput, type SlideMetrics, type SlideProbe } from "@agent-engine/tool-karos-publish";
import { checkInterestFloor, type SlideRole } from "../src/workflow/interest-floor.js";
import { buildScriptFontHeadForLanguage } from "../src/workflow/script-fonts.js";
import { deviceCssBlock } from "../src/workflow/slide-devices.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import { templateBasename } from "../src/workflow/visual-qa-pre-checks.js";
import { InstagramSlideCopySchema, type ImageSelection, type InstagramCopyOutput, type InstagramSlideCopy } from "../src/workflow/types.js";
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
/** Solid magenta 8x8 — `object-fit: cover` blows it up to a full-bleed photograph's worth of pixels. */
const MAGENTA_8X8 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGP8z/CfARtgwio6aCUAkYsCDoRKzmMAAAAASUVORK5CYII=",
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

/** Assembles one carousel through the REAL `assembleSlidesData`, so every rendered field is the one a run would produce. */
function assemble(slides: InstagramSlideCopy[], selections: ImageSelection[], over: Partial<Parameters<typeof assembleSlidesData>[0]> = {}): RenderCarouselInput {
  return assembleSlidesData({
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
  });
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

function report(label: string, role: SlideRole, measured: Measured): void {
  const m = measured.metrics;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  // The band table the constants' doc comments cite.
  console.log(
    [
      label.padEnd(34),
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
    await fs.writeFile(heroPath, MAGENTA_8X8);
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
        report(`cover.html no-hero (${lengthLabel})`, "cover", cover);
        report(`closer.html (${lengthLabel})`, "closer", closer);

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
      const blanks: RenderCarouselInput = {
        clientSlug: "calibration",
        postId: "interest-floor-empty",
        canvas: CANVAS,
        templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
        slides: [
          { n: 1, template: "cover.html", fields: { ...furniture }, images: {}, htmlFragments: {} },
          { n: 2, template: "headline-focus.html", fields: { ...furniture }, images: {}, htmlFragments: {} },
          { n: 3, template: "closer.html", fields: { ...furniture }, images: {}, htmlFragments: {} },
        ],
      } as unknown as RenderCarouselInput;
      const measured = await render(blanks);
      const roles: SlideRole[] = ["cover", "interior", "closer"];

      for (const [index, entry] of measured.entries()) {
        report(`${entry.template} EMPTY`, roles[index]!, entry);
        const findings = checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry)).findings;
        expect(findings.map((f) => f.kind), `${entry.template} with empty slots produced no finding`).not.toEqual([]);
        // `dead-space` or `empty`: either "there is a hole" or "there is
        // nothing to read". Which one fires depends on what the template's
        // ground paints unconditionally, and both are correct answers.
        expect(findings.some((f) => f.kind === "dead-space" || f.kind === "empty"), `${entry.template}: ${findings.map((f) => f.kind).join(", ")}`).toBe(true);
        // And the DOM agrees: with every slot hidden by its own `:empty`
        // rule, no text box painted.
        expect(entry.probe.textBoxShare).toBeLessThan(0.02);
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
      report("headline-focus.html as cover", "cover", entry);

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
      // A FULL-BLEED PHOTOGRAPH PUTS INK IN THE BLEED BAND BY DEFINITION.
      // Measured on a synthetic full-frame photograph, `clippedEdgeShare` is
      // ~2.6% against clause B's 0.4% ceiling — six times over — so clause
      // B's `clippedEdgeShare` limb has to be inert for a slide that is
      // carrying imagery, or every correct photo slide fails the floor on
      // every attempt. This assertion is where that shows up.
      expect(checkInterestFloor(measured[0]!.metrics, measured[0]!.probe, "cover", optsFor(measured[0]!)).findings).toEqual([]);

      // The prep defect that had no symptom: a "successful" render whose
      // hero contributed no pixels at all. It renders, it is well-formed,
      // and it is empty — which is exactly what the measurement is for.
      expect(measured[1]!.metrics.imageryOrDeviceShare).toBeLessThan(0.03);
      expect(checkInterestFloor(measured[1]!.metrics, measured[1]!.probe, "cover", optsFor(measured[1]!)).findings.map((f) => f.kind)).toContain("no-device");
    },
    300_000,
  );

  it(
    "a HEBREW render of cover/stat_callout/list_takeaway/closer passes, in the script's own faces, with no overflow",
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
          slide({ n: 4, layout: "closer", headline: "זה כל הדפוס", body: "איזה סבב הייתם חותכים ראשון?" }),
        ];
        const measured = await render(assemble(slides, [1, 2, 3, 4].map((n) => selection(n, null))));
        const roles: SlideRole[] = ["cover", "interior", "interior", "closer"];
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
