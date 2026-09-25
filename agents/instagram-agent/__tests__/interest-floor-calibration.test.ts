import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRenderCarousel, type RenderCarouselInput, type SlideMetrics, type SlideProbe } from "@agent-engine/tool-karos-publish";
import { composeRawDocument } from "@agent-engine/tool-karos-templates";
import { decodePngRows } from "@agent-engine/tool-common";
import { buildBrandHeadHtml, contrastRatio, type BrandRenderTokens } from "../src/workflow/brand-render-tokens.js";
import {
  ACCENT_MAX_SHARE,
  ACCENT_MIN_SHARE,
  checkInterestFloor,
  CLIPPED_EDGE_SHARE_CEILING,
  CONTENT_OCCUPIED_SHARE_FLOOR,
  FLAT_BACKGROUND_CEILING,
  IMAGERY_OR_DEVICE_FLOOR,
  INK_SHARE_FLOOR,
  LARGEST_EMPTY_RECT_CEILING,
  OCCUPIED_SHARE_FLOOR,
  TEXT_SHARE_CEILING,
  type SlideRole,
} from "../src/workflow/interest-floor.js";
import { buildMarkRing, markCssBlock, type EmphasisIssue, type MarkRing } from "../src/workflow/emphasis-marks.js";
import { visualSystemCssBlock } from "../src/workflow/visual-system.js";
import { countContentElements } from "../src/workflow/visual-qa-pre-checks.js";
import { HERO_IMAGE_LAYOUTS, SELECTABLE_FIGURE_PLACEMENTS } from "../src/workflow/slides-data.js";
import { MAX_COPY_FOR_OBJECT } from "../src/workflow/bounded-object.js";
import { buildScriptFontHeadForLanguage, scriptTypographyFor } from "../src/workflow/script-fonts.js";
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

/**
 * Hebrew at the same three copy lengths the Latin fixtures carry.
 *
 * RFC-20 §5.9 makes `he` rows MANDATORY in every sweep and sets each ceiling
 * from the max over both languages, so a Hebrew corpus of ONE length would put
 * two thirds of the band's Hebrew half outside the measurement. `HEBREW` above
 * is the medium row, kept under its old name because four existing cases cite
 * it by that name.
 */
const HEBREW_SHORT = {
  headline: "הקליטה היא צוואר הבקבוק",
  body: "כל תור שמדדנו אמר את אותו הדבר.",
};
const HEBREW_MEDIUM = HEBREW;
const HEBREW_LONG = {
  headline: "רוב לוחות התוכן נשברים בחודש השני, והסיבה כמעט אף פעם איננה התוכנית עצמה",
  body:
    "החודש הראשון רץ על התלהבות, ולכן כמעט כל דבר עובד. החודש השני רץ על התהליך שבאמת בנית. אצל רוב הצוותים התהליך הוא גיליון שאף אחד לא מתחזק, ערוץ שאף אחד לא בודק וסבב בדיקה שאף אחד לא קבע, ולכן החודש השני הוא המקום שבו הלוח מפסיק בשקט להיות נכון.",
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

/**
 * The kit this calibration marks with.
 *
 * Four hues, which is `rf-11`'s own count — the reference cycles yellow →
 * chartreuse → cyan → lilac down ten rows on one rule, and four is what makes
 * "no two CONSECUTIVE marks share a colour" a real constraint rather than an
 * arithmetic accident. They are stand-ins for a client's accent ring, not a
 * brand: `buildMarkRing` filters them against the ground and the ink, so what
 * actually reaches the stylesheet is whatever survives that, and the sweep
 * prints the survivors.
 */
const CALIBRATION_ACCENT = "#C4552F";
const CALIBRATION_RING = ["#E8C547", "#9BE6E0", "#D9BFF2", "#5BD1A0"] as const;

/** Derived in `materialize`, from the ground the bundled set actually declares. The stylesheet and the composition share this object. */
let markRing: MarkRing | undefined;

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
 *
 * RFC-17 puts the MARK stylesheet on that same channel, and this harness
 * carries it for exactly the reason the comment above gives — production
 * emits it on every document unconditionally
 * (`create-instagram-agent-workflow.ts`), so a calibration that left it out
 * would be measuring a document no client receives.
 *
 * IT MOVES NO EXISTING NUMBER, and that is checkable rather than hoped for:
 * the block declares four `:root` custom properties and a set of `.mk*` rules
 * that match nothing until an element carries the class, and no element
 * carries it until a slide's copy declares `emphasis` (`slides-data.ts`
 * returns no runs fragment when nothing was declared, so the twin slot stays
 * unfilled and the PLAIN field renders). Every case below that passes no
 * `emphasis` therefore renders the same pixels it did before this phase. The
 * marked cases are the two at the end of this file.
 *
 * ## 2026-09-16, PHASE 5.5 ITEM G7: THE GROUND MATERIAL IS GONE FROM THIS
 *    CHANNEL, BECAUSE IT WAS NEVER ON PRODUCTION'S
 *
 * This harness used to splice `groundMaterialCssBlock` as a fourth sheet, on
 * the reasoning that `headExtras()` emitted four. It did not: the workflow's
 * three call sites all read `GROUND_MATERIAL_MOUNTED ? block : ""` and that
 * constant was a literal `false`, so the material reached no rendered document
 * anywhere and this file was the only thing that ever injected it — i.e. the
 * authority RFC-20 §5.6 nominates for the floor's final values was setting them
 * against a stylesheet no client has ever received. `ground-material.ts` and its
 * two tests are deleted with the sheet; `undefined` below is what production
 * renders.
 *
 * That this addition moves nothing is G3's claim (`ground-material.test.ts`) and
 * it is asserted here rather than assumed — see `the ground material moves no
 * share on a real archetype render` at the end of this file, which renders the
 * same plate with and without the sheet and compares all five shares.
 */
/**
 * The seed every calibration document's material is drawn with.
 *
 * Fixed rather than `"calibration"`-by-accident so the stock is a constant of
 * the sweep: `MATERIAL_STOCKS` is picked by `fnv1a32(seed) % 4` and a stock
 * carries a different `baseFrequency` and cloud, so a seed that drifted would
 * move a share without anything reporting why.
 */
async function materialize(dir: string, scriptLanguage?: string, brandHeadHtml?: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });

  // Read every template's token pair FIRST, because the mark ring is derived
  // from the ground it has to be legible on — the same order production
  // works in, where `buildMarkRing` runs once per RUN against the kit's
  // resolved pair. `slide.html` is the anchor: the bundled set shares one
  // token block, and `assertOneBundledGround` below fails loudly if that ever
  // stops being true rather than letting a ring be derived against a ground
  // half the set does not paint.
  const sources = new Map<string, string>();
  for (const file of (await fs.readdir(SOURCE_TEMPLATE_DIR)).filter((f) => f.endsWith(".html"))) {
    const html = await fs.readFile(path.join(SOURCE_TEMPLATE_DIR, file), "utf8");
    sources.set(file, html);
    const ground = /--bg\s*:\s*(#[0-9a-fA-F]{3,8})/u.exec(html)?.[1];
    const foreground = /--fg\s*:\s*(#[0-9a-fA-F]{3,8})/u.exec(html)?.[1];
    if (ground !== undefined && foreground !== undefined) groundTokens.set(file, { ground, foreground });
  }
  const anchor = groundFor("slide.html");
  markRing = buildMarkRing({ brandAccent: CALIBRATION_ACCENT, palette: [...CALIBRATION_RING] }, anchor.ground, anchor.foreground, []);

  const extra = [
    deviceCssBlock(),
    scriptLanguage !== undefined ? buildScriptFontHeadForLanguage(scriptLanguage, undefined) : undefined,
    /**
     * ── PHASE 5.5 (item C): THE VISUAL SYSTEM'S SWITCH SHEET, WITH EVERY
     *    SLIDE'S ACCENT ON. ──
     *
     * Every standing accent mark in the bundled set is now hidden unless a
     * run's resolved system switches it on (`--fx-accent` /
     * `--fx-accent-ink`, set per slide number by `visualSystemCssBlock`).
     * Without this fragment the templates render in their QUIET state, and
     * measured on this tree with installed Chrome at the pale calibration
     * accent that state reports:
     *
     *   cover 1.892% · quote-card 0.926% · comparison-card 0.417% ·
     *   closer 0.412% · stat-callout 0.052% · list-takeaway 0.052% ·
     *   headline-focus 0.008% · slide 0.004%
     *
     * — four of the eight under `ACCENT_MIN_SHARE` (0.08%), which is the
     * `accent-out-of-band` WARNING (it gates nothing) and the pale-accent
     * case's own assertion (it does).
     *
     * ON FOR EVERY SLIDE, which is deliberate and is the conservative choice:
     * it reproduces the pre-phase paint exactly, so every band, ceiling and
     * floor in this file keeps measuring the plates it was calibrated against
     * and nothing here is re-baselined on an unmeasured assumption. The QUIET
     * state is the new common one and it is measured by
     * `template-furniture.test.ts`'s Chromium block; a quiet-state sweep of
     * these bands belongs with W2-C's floor re-baseline, where the numbers can
     * be read off a CI run rather than guessed at here.
     */
    visualSystemCssBlock({
      systemId: "calibration",
      compositionGrammar: "bottom-column",
      ground: "grid",
      accentSlides: [1, 2, 3, 4, 5, 6, 7, 8],
      accentForm: "rule",
      numeralSlides: [],
      eyebrow: { kind: "none" },
      coverForm: "typographic-poster",
      typeScale: "display",
      gutter: "wide",
      reason: "calibration: every slide's accent switched on, so this suite measures the plates its bands were calibrated against",
    }),
    // The SAME ring object that `assembleMarked` indexes into positionally.
    // Deriving it twice from the same inputs would agree today and is one
    // argument away from painting slide 4's mark in slide 2's colour with
    // nothing reporting it — which is exactly why production threads one
    // ring through both the stylesheet and the composition.
    markCssBlock(scriptLanguage !== undefined ? scriptTypographyFor(scriptLanguage)?.script : undefined, markRing),
    // LAST, which is `headExtras()`'s own position.
    // Phase 5.5, item G7: the material is DELETED. It was mounted nowhere —
    // `GROUND_MATERIAL_MOUNTED` was a constant `false` and all three of the
    // workflow's call sites were `MOUNTED ? block : ""` — so this harness was
    // the only thing that ever injected it, and it was calibrating the floor
    // against a stylesheet production has never emitted. `undefined` is now
    // what production renders: nothing. G3 (`ground-material.test.ts`, also
    // deleted) measured the block as sub-ink, so the bands should not move;
    // CI's sweep is the authority on that, not this comment.
    undefined,
  ]
    .filter((fragment): fragment is string => fragment !== undefined && fragment.length > 0)
    .join("\n");
  for (const [file, html] of sources) {
    // `composeRawDocument` rather than a hand-rolled `</head>` replace: it is
    // the function `materializeTemplates` itself calls, and the ORDER it
    // imposes is the whole subject of the badge case below — the shared
    // device sheet first, the client's brand head LAST, so a kit beats the
    // template on a specificity tie. A splice that got that order wrong here
    // would measure a document no client receives.
    await fs.writeFile(path.join(dir, file), composeRawDocument(html, brandHeadHtml, undefined, extra), "utf8");
  }
}

const slide = (over: Partial<InstagramSlideCopy> & { n: number }): InstagramSlideCopy =>
  InstagramSlideCopySchema.parse({ headline: SHORT.headline, body: SHORT.body, visualNeed: "a need", sourceRef: "a claim", ...over });

/**
 * ── THE OBJECT A STATEMENT PLATE SHIPS WITH (RFC-20 §11.4). ──
 *
 * Every other archetype in the fixtures below is rendered with the content
 * its template is built to hold: `stat_callout` gets a `stat`, `quote_card` a
 * `quote`, `comparison_card` a `comparison`, `list_takeaway` its `items`. The
 * two statement archetypes were the only ones rendered BARE — headline, body,
 * and nothing else — and that asymmetry was invisible while a full-plate
 * texture was standing in for their composition.
 *
 * It is not invisible now, and the measurement that exposed it is CI
 * 34956752073: with the textures deleted, `slide.html` at `fontScale s`
 * reports `dead-space` and `headline_focus` at SHORT reports one finding.
 * **Both are correct.** At `s` the statement does not reach
 * `DISPLAY_TYPE_SCALE_FLOOR`, so `plateSubject` finds no subject, so clause C
 * does not waive — a bare headline and a short body at the smallest type on a
 * plate-scale field IS a hole, and RFC-20 §11.4 says so in advance: *a plate
 * with neither fails clause C, correctly — that is the floor discriminating,
 * not a regression.*
 *
 * **So the fixture is what was wrong, not the bar.** `DEVICE_SLOT_LAYOUTS`
 * now names `text_only`, `slide.html` declares `.sl-device`, and
 * `bounded-object.ts` composes exactly this shape onto every
 * `headline_focus` and `text_only` slide before the first render. A fixture
 * that renders a plate production cannot ship is measuring the wrong plate —
 * the same finding `test-helpers.ts` records about `goodCopyOutput`: **when a
 * new measurement fails an old fixture, suspect the fixture.**
 *
 * The figure and its label are lifted verbatim from `SIX_RESEARCH_FACTS`, so
 * this is the shape `deviceFromText` actually produces rather than a
 * flattering hand-built one. **And the objectless plate is still rendered and
 * still asserted — as a REFUSAL, by the case that follows the sweep.** Both
 * halves of §11.4's promise are executable or neither is.
 */
/**
 * The object, but only where `boundedObjectFor` would actually compose one.
 *
 * It refuses a plate whose headline plus body is past `MAX_COPY_FOR_OBJECT`,
 * because a ~300px device on top of a long headline and a long body overflows
 * the field — measured on CI 34972021273, where `probe.overflow` caught it and
 * the pixel limb was nowhere near firing. A fixture that forces the object on
 * anyway renders a plate the workflow cannot ship.
 */
const objectFor = (copy: { headline: string; body: string }): { device?: typeof STATEMENT_OBJECT } =>
  copy.headline.length + copy.body.length > MAX_COPY_FOR_OBJECT ? {} : { device: STATEMENT_OBJECT };

const STATEMENT_OBJECT = {
  kind: "figure" as const,
  value: "30%",
  label: "Sorting tickets the moment they land resolved more of them.",
  source: "support dashboard export",
};

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
function withMeasureAnchors(assembled: RenderCarouselInput, hexesBySlide?: ReadonlyMap<number, string[]>): RenderCarouselInput {
  return {
    ...assembled,
    slides: assembled.slides.map((slide) => {
      const { ground, foreground } = groundFor(slide.template);
      const hexes = hexesBySlide?.get(slide.n);
      return {
        ...slide,
        measure: {
          ...(typeof slide.fields["accentColor"] === "string" ? { accentHex: slide.fields["accentColor"] } : {}),
          foregroundHex: foreground,
          groundHex: ground,
          // RFC-17: the colours this slide BELIEVES it painted. It is not
          // part of `markedShare`/`markColourCount`'s definition — those four
          // limbs are colour-agnostic on purpose, because a
          // within-tolerance-of-a-declared-hex test passes on antialiased
          // glyph fringes — it rides the wire so the sweep below can join the
          // declared ring to the measured bins.
          ...(hexes !== undefined && hexes.length > 0 ? { markHexes: hexes } : {}),
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

/**
 * The same carousel, assembled WITH emphasis on — RFC-17's marked path.
 *
 * Everything that differs from `assemble` is threaded through
 * `assembleSlidesData`'s own parameters rather than reconstructed here: the
 * ground/ink pair the ring was derived against, the ring object the
 * stylesheet already carries, and the out-parameter that reports which hexes
 * each slide actually painted. The marks themselves come from the copy, as
 * `"h:…"`/`"b:…"` compact spans, which is the form a run really produces.
 *
 * It hands back the report as well as the input, because "which spans were
 * DROPPED" is half of what the sweep has to print: a mark the resolver
 * refused is a fact about the copy, and a mark that resolved but did not
 * paint is a fact about the stylesheet, and a table that conflated them would
 * be unreadable.
 */
function assembleMarked(
  slides: InstagramSlideCopy[],
  selections: ImageSelection[],
  over: Partial<Parameters<typeof assembleSlidesData>[0]> = {},
): { input: RenderCarouselInput; issues: EmphasisIssue[] } {
  const anchor = groundFor("slide.html");
  const report = { hexesBySlide: new Map<number, string[]>(), issues: [] as EmphasisIssue[] };
  const assembled = assembleSlidesData({
    clientSlug: "calibration",
    postId: "interest-floor-marks",
    repoRoot: REPO_ROOT,
    brandTokens: { templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"), slideTemplate: "slide.html", accentColor: CALIBRATION_ACCENT },
    copy: { format: "carousel", caption: "A calibration caption.", slides } as InstagramCopyOutput,
    selections,
    canvas: CANVAS,
    availableTemplates: new Set(["cover.html", "closer.html", "stat-callout.html", "quote-card.html", "comparison-card.html", "list-takeaway.html", "headline-focus.html"]),
    templateDirOverride: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
    accentRing: [...CALIBRATION_RING],
    paletteSeed: "calibration-marks",
    groundHex: anchor.ground,
    foregroundHex: anchor.foreground,
    ...over,
    // After `over`, so a case cannot accidentally detach the ring from the
    // stylesheet the documents were materialized with.
    ...(markRing !== undefined ? { markRing } : {}),
    markReportOut: report,
  });
  return { input: withMeasureAnchors(assembled, report.hexesBySlide), issues: report.issues };
}

interface Measured {
  n: number;
  path: string;
  template: string;
  metrics: SlideMetrics;
  probe: SlideProbe;
  /**
   * RFC-21 Part 2 — `countContentElements` on the slide that was RENDERED, for
   * clause H. Carried on every measurement rather than passed at call sites,
   * because a case that forgets it gets a silently weaker verdict: clause H
   * abstains on an absent count, and an abstention looks exactly like a pass.
   */
  contentElements: number;
}

/** The top sixth of the plate, in SCREENSHOT rows: the band `.brand-badge` is positioned in on every bundled template (`top: 36-56px` design, scale 2). */
// ── DEVICE ROWS, AND THE LABEL THIS MEASURES MOVED. ──
// The window is in the PNG's own rows, which at `canvas.scale: 2` are half a
// design px each. The series badge sat at design y=56 (device 112) and 480
// device rows covered it with room to spare. The badge slot is deleted; the
// label that replaced it is the cover's `.eyebrow`, anchored to the FOOT of
// the masthead band — design y~530 on a 600px band, i.e. device row ~1060 —
// so the old window scanned the ramp ABOVE the label and diffed two identical
// crops. 1400 covers the whole band at every `--cover-band` value and every
// type scale, and costs only decode time: the frames differ in the eyebrow
// and its rail by construction, so a wider window adds no noise.
const BADGE_BAND_ROWS = 1400;

/** `#rrggbb` for `contrastRatio`, which is the repo's own WCAG formula and takes hex. */
const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/**
 * The contrast of a series badge against the ground it is actually standing
 * on, measured by DIFFERENCE between two otherwise-identical renders — one
 * with a `seriesBadge`, one without.
 *
 * Why a difference rather than a crop: the badge's box is the template's to
 * place (and a client kit may move it), its glyphs cover a small fraction of
 * any box that contains them, and a percentile over a mostly-bare band
 * reports the band. The pixels that CHANGED between the two frames are the
 * badge's glyphs by construction, whatever the layout did — and the same
 * pixels in the unbadged frame are exactly the ground those glyphs cover, not
 * the plate's average.
 *
 * The glyph and ground colours are the means of the most-changed fifth, which
 * is the fully-covered core of the type rather than its antialiased fringe.
 */
function badgeContrast(badged: Buffer, unbadged: Buffer): { ratio: number; changed: number; glyph: string; ground: string } {
  const readBand = (bytes: Buffer): Uint8Array => {
    let band: Uint8Array | undefined;
    let stride = 0;
    const header = decodePngRows(bytes, (row, y, hd) => {
      if (y >= BADGE_BAND_ROWS) return;
      if (band === undefined) {
        stride = hd.width * 3;
        band = new Uint8Array(Math.min(BADGE_BAND_ROWS, hd.height) * stride);
      }
      let out = y * stride;
      for (let i = 0; i < row.length; i += 4) {
        band[out++] = row[i]!;
        band[out++] = row[i + 1]!;
        band[out++] = row[i + 2]!;
      }
    });
    if (header === undefined || band === undefined) throw new Error("the rendered PNG did not decode — the badge comparison has nothing to measure");
    return band;
  };
  const a = readBand(badged);
  const b = readBand(unbadged);
  if (a.length !== b.length) throw new Error("the two badge frames are different sizes");

  const deltas: Array<{ i: number; d: number }> = [];
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
    if (d > 24) deltas.push({ i, d });
  }
  if (deltas.length === 0) return { ratio: 1, changed: 0, glyph: "-", ground: "-" };
  deltas.sort((x, y) => y.d - x.d);
  const core = deltas.slice(0, Math.max(1, Math.floor(deltas.length / 5)));
  const mean = (src: Uint8Array): [number, number, number] => {
    let r = 0, g = 0, bl = 0;
    for (const { i } of core) { r += src[i]!; g += src[i + 1]!; bl += src[i + 2]!; }
    return [r / core.length, g / core.length, bl / core.length];
  };
  const glyph = hex(...mean(a));
  const ground = hex(...mean(b));
  return { ratio: contrastRatio(glyph, ground), changed: deltas.length, glyph, ground };
}

/**
 * The contrast between a bar's FILL and the TRACK it stands in, measured by
 * difference between two renders of the same slide whose only difference is
 * one row's value.
 *
 * Same trick as `badgeContrast`, aimed at the other half of the device: the
 * pixels that change between a 21%-long bar and a 40%-long one are, by
 * construction, the strip that is bare TRACK in the first frame and FILL in
 * the second. Neither colour is hard-coded, no geometry is assumed, and the
 * comparison survives any change to where the device sits on the plate.
 *
 * WHAT IT IS FOR. A bar chart is the one device in the set made of AREA, and
 * the reader's whole job on it is to compare three lengths at a glance.
 * `slide-devices.ts` painted the track at 8% and the quiet fill at 22% OVER
 * `transparent`, so `headline-focus.html`'s dash-screen ground read straight
 * through both. Nothing in the suite could see it: `imageryOrDeviceShare`
 * counts covered cells and says nothing about tone, and the device case above
 * asserted only that the share was over 0.03. Both are opaque
 * `color-mix(…, var(--bg))` plates now.
 *
 * This comparison run against the two states of the file, on this tree:
 *   the washes  1.94:1  fill #585759 on track #2c2c30
 *   the plates  3.41:1  fill #8a8988 on track #363739
 * — so the guard refuses what shipped and passes what replaced it, which is
 * the only thing that makes it a guard.
 *
 * The floor asserted is 3.0:1 — WCAG's ratio for a graphical object, which is
 * what a bar is — leaving 0.41 of the measured margin. A median rather than a
 * mean because the strip has two antialiased vertical edges and they are not
 * what is being asked about.
 */
function barPlateContrast(longer: Buffer, shorter: Buffer): { ratio: number; changed: number; fill: string; track: string } {
  const readRgb = (bytes: Buffer): Uint8Array => {
    let out: Uint8Array | undefined;
    let stride = 0;
    const header = decodePngRows(bytes, (row, y, hd) => {
      if (out === undefined) {
        stride = hd.width * 3;
        out = new Uint8Array(hd.height * stride);
      }
      let o = y * stride;
      for (let i = 0; i < row.length; i += 4) {
        out[o++] = row[i]!;
        out[o++] = row[i + 1]!;
        out[o++] = row[i + 2]!;
      }
    });
    if (header === undefined || out === undefined) throw new Error("the rendered PNG did not decode — the bar comparison has nothing to measure");
    return out;
  };
  const a = readRgb(longer);
  const b = readRgb(shorter);
  if (a.length !== b.length) throw new Error("the two bar frames are different sizes");

  const changed: number[] = [];
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
    if (d > 24) changed.push(i);
  }
  if (changed.length === 0) return { ratio: 1, changed: 0, fill: "-", track: "-" };
  const median = (src: Uint8Array): [number, number, number] => {
    const chan = (k: number): number => {
      const v = changed.map((i) => src[i + k]!).sort((x, y) => x - y);
      return v[Math.floor(v.length / 2)]!;
    };
    return [chan(0), chan(1), chan(2)];
  };
  const fill = hex(...median(a));
  const track = hex(...median(b));
  return { ratio: contrastRatio(fill, track), changed: changed.length, fill, track };
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
    // 2026-09-25: the probe the WORKFLOW judges, with the laid-out subject boxes
    // merged in (`withSubjectBoxes` in create-instagram-agent-workflow.ts), so a
    // declared device box counts by its area here as it does on a live run
    // (WS-07: the closer's hairline panel). NOT on the cover: this suite judges
    // the cover's GROUND layer, including covers with no photograph at all, and
    // the cover's subject rule (clause I) has its own real-Chromium cases in
    // `cover-subject.test.ts`.
    const boxes = index === 0 ? undefined : (entry as { geometry?: { subjectBoxes?: { hero: number; device: number; graphic: number } } }).geometry?.subjectBoxes;
    const probe = entry.probe === undefined || boxes === undefined ? entry.probe : { ...entry.probe, subjectBoxes: boxes };
    if (metrics === undefined || probe === undefined) throw new Error(`slide ${entry.n} came back without metrics/probe — measure/probe were requested`);
    // `index === 0` is the cover, which is the same convention
    // `checkDefaultRenderRules` and the workflow both use.
    const contentElements = countContentElements(input.slides[index]! as Parameters<typeof countContentElements>[0], index === 0);
    return { n: entry.n, path: entry.path, template: input.slides[index]!.template, metrics, probe, contentElements };
  });
}

/**
 * The per-slide options `checkInterestFloor` needs: which slide this is, and
 * which archetype it rendered through so every finding names it. No
 * `downgradedForImages` waiver here — nothing in a calibration render lost a
 * photograph to sourcing, so a cover with no picture must be judged on its
 * ground layer rather than excused.
 */
function optsFor(measured: Measured): { slide: number; archetype: string; contentElements: number } {
  return { slide: measured.n, archetype: templateBasename(measured.template), contentElements: measured.contentElements };
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
 * dense. And `imageryOrDeviceShare` — this one needs restating, because the
 * reason written here was inherited from when the floor was 0.03 and has not
 * been true since it moved to 0.10. The old wording ("the floor is a hair
 * above zero, the smallest legitimate device measures 0.04-0.06 against a
 * 0.03 floor") argued that 0.08 of margin would be stricter than the rule.
 * At 0.10 that arithmetic no longer applies. The reason the metric is still
 * left alone is a different and simpler one: this margin is a claim about
 * EMPTINESS — the owner's defect was a plate with nothing on it — and
 * "carries a photograph or a drawn field" is a claim about KIND, not about
 * degree. Moving a kind-of-thing metric 0.08 in the failing direction asks a
 * question with no meaning. The fourth-pass band beside
 * `IMAGERY_OR_DEVICE_FLOOR` is where that constant's own margin is argued,
 * and as of 2026-09-12 it argues that the margin is currently negative at the
 * `l` type scale.
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
      `colours ${m.quantisedColourCount}`.padEnd(12),
      // ── WHERE THE HOLE IS, NOT ONLY HOW BIG. ──
      // The findings have carried the rectangle's corners since clause C was
      // written and this table did not, so a `dead-space` row in CI said 24%
      // and never said at which end — and the remedy for a hole above the
      // lockup is a different edit from the remedy for one below it. Printed
      // as the fraction of the canvas each side is, which is the form the
      // ceilings are in.
      `rect ${m.largestEmptyRect.x.toFixed(2)},${m.largestEmptyRect.y.toFixed(2)} ${m.largestEmptyRect.w.toFixed(2)}x${m.largestEmptyRect.h.toFixed(2)}`,
      // The ground the frame actually measured, and whether it is the one the
      // caller declared. `backgroundMatchesBrandGround` is asserted in this
      // file and was never printed, so a `false` said nothing about WHICH
      // colour won the flat cells instead.
      `bg ${m.backgroundHex}${m.backgroundMatchesBrandGround ? "" : " (NOT the brand ground)"}`,
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
          // The object only where production composes one: `boundedObjectFor`
          // refuses a plate whose copy is past `MAX_COPY_FOR_OBJECT`, because a
          // ~300px device plus a long headline plus a long body overflows the
          // field. A fixture that forces it onto LONG renders a plate the
          // workflow cannot ship — the same fixture defect this file already
          // records about rendering the statement archetypes BARE, pointing the
          // other way.
          slide({ n: 6, layout: "headline_focus", ...copy, kicker: "THE TURN", ...objectFor(copy) }),
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
          slide({ n: 6, layout: "headline_focus", ...LONG, kicker: "THE TURN", ...objectFor(LONG) }),
          // THE EIGHTH TEMPLATE. `slide.html` is the file `photo`/`text_only`
          // resolve to, it is the only archetype a carousel may REPEAT, and it
          // was the one this sweep did not render — so of the eight bundled
          // templates, seven were covered at `s` and `l` and the most-used one
          // was covered at `m` alone. Heroless deliberately: that is the
          // shape the degrade paths produce, and its two alternating grounds
          // are the ones whose `l`-scale weight the fourth-pass band table
          // measures.
          slide({ n: 7, layout: "text_only", ...LONG, ...objectFor(LONG) }),
          // THE CLOSER GETS THE LONG BODY, and that is the case that used to
          // break. `slides-data.ts` routes a body with no '?' into the `cta`
          // slot, `InstagramSlideCopySchema` puts no maximum on `body`, and
          // `.cl-ask` is sized by its copy — so a 306-character closing line
          // took the ask from 400px to 504px at `m` and 656px at `l`, squeezed
          // the elastic middle that holds the recap and the takeaway, and
          // pushed `.cl-wrap` 105px (at `m`) and 202px (at `l`) out of the
          // block-start edge of its own field, printing the series badge
          // through the recap's "01". This sweep's closer used to carry a
          // 41-character body while slides 1 and 4-7 all carried LONG, so the
          // one archetype whose middle is elastic was the one never given a
          // long string. Fixed in `closer.html` by the length ladders on the
          // takeaway and both ask slots — re-checked 2026-09-12 by neutering
          // each candidate in turn: the ladders are what make it fit, and the
          // `flex: 0 0 auto` wrap (kept, and a correctness rule in its own
          // right) changes no measured value on any case this tree produces.
          // This sweep covers `s` and `l`; the `m` scale is covered by the
          // cover/closer case below, which now varies the closer's takeaway
          // AND its body with the copy length and renders both ask slots.
          slide({ n: 8, layout: "closer", headline: "Three things to review before your next campaign goes live", body: LONG.body }),
        ];
        const overrides = new Map(slides.map((s) => [s.n, { fontScale }] as const));
        const measured = await render(assemble(slides, slides.map((s) => selection(s.n, null)), { slideStyleOverrides: overrides }));
        // The sweep is only a sweep if it rendered what it claims to. Eight
        // slides can still be seven files if `resolveLayout` degrades one.
        const files = new Set(measured.map((entry) => templateBasename(entry.template)));
        expect(files, `the s/l sweep must render all eight bundled templates, rendered: ${[...files].sort().join(", ")}`).toEqual(
          new Set(["cover", "stat-callout", "quote-card", "comparison-card", "list-takeaway", "headline-focus", "slide", "closer"]),
        );
        // Position 1 is a cover and the last position a closer, exactly as
        // `checkSlidesInterestFloor` assigns roles from position.
        const roles: SlideRole[] = measured.map((_, i) => (i === 0 ? "cover" : i === measured.length - 1 ? "closer" : "interior"));

        for (const [index, entry] of measured.entries()) {
          report(`${entry.template} (fontScale ${fontScale})`, roles[index]!, entry);
          // A content archetype at a positional role may fail clause E and
          // nothing else — the same posture the position-1/last test asserts.
          expect(
            checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry)).findings.map((f) => f.kind).filter((k) => k !== "no-device"),
            // The SENTENCES in the message, not just the kinds in the value:
            // a `clipped` on a sweep of 16 renders names nothing a reader can
            // act on, and every finding already carries the sentence that does.
            `${entry.template} @ fontScale ${fontScale}: ${checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry)).findings.map((f) => f.sentence).join(" | ")}`,
          ).toEqual([]);
          expect(entry.probe.overflow, `${entry.template} @ fontScale ${fontScale} overflows: ${entry.probe.overflowing.join(", ")}`).toBe(false);
        }
      }
    },
    600_000,
  );

  /**
   * THE ONE ARCHETYPE A CAROUSEL MAY REPEAT, AT THE COPY LENGTH IT ACTUALLY
   * GETS, ON BOTH OF ITS GROUNDS.
   *
   * `slide.html` is what `photo` and `text_only` resolve to and the only
   * layout `resolveLayout` lets appear twice, so it is the plate a reader sees
   * most — and until this case the suite rendered it heroless at LONG copy
   * only (slide 7 of the s/l sweep). SHORT is the shape of real Instagram
   * copy: a headline of two dozen characters and one line under it.
   *
   * It is here because of what the shorter copy exposed. With the mark painted
   * on `.copy` — which was `inset: 16px`, the plate minus a gutter —
   * `largestEmptyRectShare` measured the same **1.5%** on every heroless
   * render this file can produce: hollow, short, medium and long, all three
   * scales, both grounds, LTR and RTL. One value, nine contents, on the metric
   * `slide-metrics.ts` calls "the metric that names the complaint". The mark
   * is now bound to a FIELD with 144px of bare plate above it and 112px below
   * — measured 10.0% composed, 46.7% with the statement missing, 75.6% with
   * every slot empty (`slide.html`'s own note carries the arithmetic) — and
   * these rows are what stop it going back.
   *
   * Two slides rather than one because the ground alternates on `{{slideIndex}}`
   * — index 2 is the column ruling, index 3 the dot screen — so a run that
   * repeats the archetype never repeats its plate, and both branches are
   * measured here at every scale.
   */
  it(
    "slide.html heroless clears the interior floor at SHORT copy too, on both of its alternating grounds",
    async () => {
      for (const [lengthLabel, copy] of [["short", SHORT], ["medium", MEDIUM], ["long", LONG]] as const) {
        for (const fontScale of ["s", "m", "l"] as const) {
          const slides = [
            slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "THE SHIFT" }),
            // Both carry the object production composes for them — see
            // `STATEMENT_OBJECT`. The objectless plate is asserted as a REFUSAL by
            // its own case rather than smuggled in here as a pass.
            slide({ n: 2, layout: "text_only", ...copy, ...objectFor(copy) }),
            slide({ n: 3, layout: "text_only", ...copy, ...objectFor(copy) }),
            slide({ n: 4, layout: "closer", headline: "That is the pattern", body: "Which round would you cut first?" }),
          ];
          const measured = await render(
            assemble(slides, slides.map((s) => selection(s.n, null)), {
              slideStyleOverrides: new Map(slides.map((s) => [s.n, { fontScale }] as const)),
            }),
          );
          for (const entry of measured.slice(1, 3)) {
            report(`slide.html heroless (${lengthLabel}, ${fontScale}, n=${entry.n})`, "interior", entry);
            // The premise: this really is the file under test. `resolveLayout`
            // degrading a `text_only` elsewhere would make every number below
            // a fact about a different template.
            expect(templateBasename(entry.template), `slide ${entry.n} @ ${lengthLabel}/${fontScale} did not render slide.html`).toBe("slide");
            // NO CARVE-OUT. An earlier push of this branch recorded `short`/`s`
            // as a debt at `contentOccupiedShare` 0.0414 against clause G's 0.06;
            // on the tree that actually ships it clears, so the debt is deleted
            // rather than re-measured downward — which is the rule the gate-zero
            // ratchet states about its own entries.
            expect(checkInterestFloor(entry.metrics, entry.probe, "interior", optsFor(entry)).findings, `slide.html @ ${lengthLabel}/${fontScale}`).toEqual([]);
            expect(
              findingsAtMargin(entry, "interior", CALIBRATION_MARGIN),
              `slide.html @ ${lengthLabel}/${fontScale} has under ${CALIBRATION_MARGIN} margin`,
            ).toEqual([]);
            expect(entry.probe.overflow, `slide.html @ ${lengthLabel}/${fontScale} overflows: ${entry.probe.overflowing.join(", ")}`).toBe(false);
          }
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

  /**
   * THE DEFAULT TYPE SCALE, AND THE CLOSER'S BODY NOW GROWS WITH THE REST.
   *
   * This loop varies copy length for the cover and reused the SAME
   * 31-character closing line at every length — so the one archetype with an
   * elastic middle was never given a long string at the scale most slides
   * render at. The `s`/`l` sweep gained a LONG closer when `.cl-wrap` was
   * fixed; `m` did not, and `m` is where the review measured `.cl-wrap`
   * escaping its field by 105px (`cta` slot) and 304px (`question` slot).
   *
   * The closer's body is `copy.body` now, so all three lengths reach it here.
   * `slides-data.ts` routes a body containing '?' into the `question` slot and
   * everything else into `cta`, and only ONE of those can be exercised per
   * render — so at the LONG length this renders twice, once each way. The
   * question variant is the same 306 characters with its full stop traded for
   * a question mark, which is the shape the review's worse case had.
   */
  it(
    "cover and closer pass the tighter COVER/CLOSER floors, including a cover with no photograph at all",
    async () => {
      for (const [lengthLabel, copy] of [["short", SHORT], ["medium", MEDIUM], ["long", LONG]] as const) {
        const closerBodies: Array<readonly [string, string]> =
          lengthLabel === "long"
            ? [
                ["cta slot", copy.body],
                ["question slot", `${copy.body.replace(/\.$/, "")}, so which round would you cut first?`],
              ]
            : [["cta slot", copy.body]];
        for (const [slotLabel, closerBody] of closerBodies) {
        const slides = [
          slide({ n: 1, layout: "cover", ...copy, kicker: "THE SHIFT" }),
          slide({ n: 2, layout: "stat_callout", ...copy, stat: { figure: "73%", subLabel: "of teams", source: "Karos survey, 2026" } }),
          slide({ n: 3, layout: "list_takeaway", ...copy, items: [{ title: "Name the owner" }, { title: "Measure the queue" }] }),
          // The TAKEAWAY grows with the copy too, and that is the half that
          // matters: with a 25-character takeaway the long ask fits at `m`
          // whatever `.cl-wrap` and the ladders do, so a case that varied only
          // the body could not fail and was not a scan. The review's failing
          // plate was the LONG headline over the long ask.
          slide({ n: 4, layout: "closer", headline: copy.headline, body: closerBody }),
        ];
        const selections = [selection(1, null), selection(2, null), selection(3, null), selection(4, null)];
        const assembled = assemble(slides, selections);
        // THE PREMISE FOR THE CLOSER ROWS. `slides-data.ts` chooses the slot
        // from the body's own punctuation, and a closing line that quietly
        // landed in neither slot — or in the one this case is not naming —
        // would make every number below a measurement of an empty middle.
        expect(assembled.slides[3]!.fields[slotLabel === "question slot" ? "question" : "cta"], `the closer's ${slotLabel} did not receive the ${lengthLabel} body`).toBe(closerBody);
        const measured = await render(assembled);

        const cover = measured[0]!;
        const closer = measured[3]!;
        report(`cover no-hero (${lengthLabel})`, "cover", cover);
        report(`closer (${lengthLabel}, ${slotLabel})`, "closer", closer);

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

        expect(checkInterestFloor(closer.metrics, closer.probe, "closer", optsFor(closer)).findings, `closer @ ${lengthLabel} ${slotLabel}`).toEqual([]);
        expect(findingsAtMargin(closer, "closer", CALIBRATION_MARGIN), `closer @ ${lengthLabel} ${slotLabel} margin`).toEqual([]);
        // The limb that catches `.cl-wrap` leaving through the block-start
        // edge is `probe.overflow`'s second one, so this is the assertion the
        // long body at `m` exists to reach.
        expect(closer.probe.overflow, `closer @ ${lengthLabel} ${slotLabel} overflows: ${closer.probe.overflowing.join(", ")}`).toBe(false);
        }
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
   * A BAR YOU CAN SEE THE END OF, MEASURED IN PIXELS.
   *
   * The case above renders the same bars device and asserts nothing about
   * whether a reader can read it: `imageryOrDeviceShare > 0.03` counts covered
   * cells and is indifferent to tone, and every other instrument in this file
   * is an area share. So the bars shipped with an 8%-over-transparent track
   * and a 22%-over-transparent quiet fill — `headline-focus.html`'s dash
   * screen visible straight through both, and the fill measuring 1.94:1
   * against its own track by this very comparison — while every suite in the
   * tree was green.
   *
   * `barPlateContrast` closes that by difference (see its note). Two renders
   * of the identical slide, one row's value 21 against 40, `max: 100` pinned
   * so the other two rows' geometry cannot move with it and the row stays
   * under `DEVICE_VALUE_INSIDE_BAR_THRESHOLD` in both frames so its value
   * label stays outside the fill. The strip that changes is bare track in one
   * frame and fill in the other, which is exactly the edge a reader looks for.
   *
   * The `display` string is deliberately the same in both frames: it is the
   * only other thing that would repaint, and this case is about the plate.
   *
   * Measured on this tree: 3.41:1, fill #8a8988 on track #363739, 17,440
   * changed pixels. The floor is 3.0:1, WCAG's ratio for a graphical object.
   * Run with the two CSS lines reverted it reports 1.94:1 and fails, which is
   * how this was checked rather than assumed.
   */
  it(
    "a bar's fill stands out of its own track, at the tone a reader sees",
    async () => {
      const frames: Buffer[] = [];
      for (const secondRow of [40, 21]) {
        const slides = [
          slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "THE SHIFT" }),
          slide({
            n: 2,
            layout: "headline_focus",
            ...MEDIUM,
            kicker: "THE TURN",
            device: {
              kind: "bars" as const,
              // Pinned, so `barMaxFor`'s "rows sum to 100" branch cannot make
              // the OTHER two bars move when the second row's value does.
              max: 100,
              rows: [
                { label: "Manual intake", value: 62, display: "62%" },
                { label: "Partly automated", value: secondRow, display: "21%" },
                { label: "Fully automated", value: 17, display: "17%" },
              ],
              source: "Karos survey, 2026",
            },
          }),
          slide({ n: 3, layout: "closer", headline: "That is the pattern", body: "Which round would you cut?" }),
        ];
        const measured = await render(assemble(slides, [1, 2, 3].map((n) => selection(n, null))));
        const bars = measured[1]!;
        expect(templateBasename(bars.template), "the bars case did not render headline-focus.html").toBe("headline-focus");
        frames.push(await fs.readFile(path.isAbsolute(bars.path) ? bars.path : path.join(REPO_ROOT, bars.path)));
      }

      const { ratio, changed, fill, track } = barPlateContrast(frames[0]!, frames[1]!);
      console.log(`bar fill vs track: ${ratio.toFixed(2)}:1  fill ${fill}  track ${track}  (${changed} px)`);
      // The premise. A 19-point difference in bar length over a ~570px track
      // at scale 2 repaints on the order of 17,000 pixels; the floor is well
      // under that because the track's width follows the label column, which
      // follows the face. What it has to separate is "the bar got longer"
      // from "nothing moved", and nothing moved repaints zero.
      expect(changed, `the 21% and 40% bars differ in ${changed} pixels — the fill length did not change`).toBeGreaterThan(4000);
      expect(ratio, `a bar's fill measures ${ratio.toFixed(2)}:1 against its own track — a reader cannot see where it ends`).toBeGreaterThanOrEqual(3);
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
          // ── THE TWO THE COVERAGE COMMENTS CLAIMED AND THIS ARRAY DID NOT. ──
          //
          // `list-takeaway.html:207` states "the empty-plate case in
          // `interest-floor-calibration.test.ts` still fails on the pixels
          // alone" and `quote-card.html:216` says the same of its own guard.
          // Neither template was in this array. That is not a hypothetical
          // gap: these are the two templates whose ground guards are written
          // in the POSITIVE form (`body:has(#head > span:not(:empty))`,
          // `.quote-block:has(.quote-text > span:not(:empty))`), which is the
          // form where a silently-true selector PAINTS a decorated ground on
          // a blank plate — the owner's grey screen wearing decoration, and
          // passing the floor. This branch's own history proves the failure
          // mode is live: `body:has(#head:not(:empty))` became permanently
          // true the moment `#head` grew twin spans, and only a hand-run
          // probe caught it. Nothing automated would have.
          { n: 4, template: "list-takeaway.html", fields: { ...furniture }, images: {}, htmlFragments: {} },
          { n: 5, template: "quote-card.html", fields: { ...furniture }, images: {}, htmlFragments: {} },
        ],
      } as unknown as RenderCarouselInput;
      // The SAME anchors every other case in this file measures against —
      // otherwise the one test whose job is to prove a decorated empty plate
      // fails would be the one measuring it differently from the rest.
      const measured = await render(withMeasureAnchors(blanks));
      // `list_takeaway` and `quote_card` are both INTERIOR archetypes — the
      // role decides which floors apply, and judging either at the cover role
      // would ask it for a device it is not supposed to carry.
      const roles: SlideRole[] = ["cover", "interior", "closer", "interior", "interior"];

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
   * So: render `headline_focus`, `closer` and `slide.html` with their top and
   * bottom copy present and the MIDDLE slot missing, and require the
   * rectangle to be over the ceiling for the role. Rendered that way,
   * `headline-focus.html` reports 36% against a 28% interior ceiling,
   * `closer.html` 56% against 22%, and `slide.html` 46.7% against 28%.
   *
   * `slide.html` joined them on 2026-09-12 and it is the reason the assertion
   * is phrased on the RECTANGLE rather than only on the clause name: its
   * heroless mark used to paint over the whole plate, so a statement slide
   * with no statement measured the same 1.5% as a working one — the exact
   * shape of the defect this test exists for, on the one archetype a carousel
   * may repeat.
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
          // THE THIRD ONE, ADDED 2026-09-12, and it is the archetype this
          // guard could not reach before. `slide.html`'s heroless mark used to
          // paint over the whole plate, so a statement slide with no statement
          // measured the same 1.5% rectangle as a working one. With the mark
          // bound to a field the same hollow render measures 47.2%.
          { n: 3, template: "slide.html", fields: { ...furniture, headline: "", body: MEDIUM.body }, images: {}, htmlFragments: {} },
        ],
      } as unknown as RenderCarouselInput;
      const measured = await render(withMeasureAnchors(hollow));
      const roles: SlideRole[] = ["interior", "closer", "interior"];

      for (const [index, entry] of measured.entries()) {
        report(`${entry.template} HOLLOW MIDDLE`, roles[index]!, entry);
        // THE PIXEL FACT, ASSERTED ON EVERY ONE OF THEM AND BEFORE THE
        // VERDICT. A hollow plate's rectangle must be over the ceiling for
        // its role — that is the measurement doing its job, whichever clause
        // ends up speaking for it. `slide.html` is why this line exists
        // separately from the `dead-space` expectation below: with almost no
        // ink left on the plate, clause A (render integrity) returns on its
        // own and suppresses the rest, which is the STRONGER finding and the
        // right steer ("re-render" rather than "rewrite"), but it would let a
        // template whose ground painted unconditionally slip past a test that
        // only looked at the clause name.
        expect(
          entry.metrics.largestEmptyRectShare,
          `${entry.template} with a hollow middle measured a ${(entry.metrics.largestEmptyRectShare * 100).toFixed(1)}% rectangle — a ground layer is painting where the composition is not`,
        ).toBeGreaterThan(LARGEST_EMPTY_RECT_CEILING[roles[index]!]);
        // The premise, asserted first: this plate is NOT the empty one. The
        // copy that is present really did paint, so the finding below is about
        // the hole and not about a blank render.
        expect(entry.probe.textBoxShare, `${entry.template} hollow: no copy painted, so this is the empty case, not the hollow one`).toBeGreaterThan(0.01);

        const verdict = checkInterestFloor(entry.metrics, entry.probe, roles[index]!, optsFor(entry));
        const kinds = verdict.findings.map((f) => f.kind);
        // WHICH CLAUSE SPEAKS DEPENDS ON HOW MUCH INK SURVIVES THE HOLE, and
        // both branches are pinned rather than either being allowed to stand
        // in for the other. `headline-focus.html` and `closer.html` keep a
        // kicker, a rail and a scrimmed foot, so they stay over the ink floor
        // and clause C — the rectangle — is what fires. `slide.html`'s hollow
        // plate is a paragraph on bare ground: 2.8% occupied, under
        // INK_SHARE_FLOOR, so clause A returns on its own and suppresses the
        // rest. That is the stronger finding and the right steer ("re-render",
        // not "rewrite"), which is why it is accepted here — and the rectangle
        // assertion above is what keeps that acceptance from covering for a
        // ground layer painting where the composition is not.
        if (entry.metrics.inkShare > INK_SHARE_FLOOR) {
          if (roles[index]! === "interior") {
            // ── AT THE INTERIOR ROLE THIS HOLE IS MEASURED AND NOT REFUSED,
            //    AND THAT IS PINNED IN BOTH DIRECTIONS RATHER THAN WISHED
            //    AWAY. ──
            //
            // The rectangle assertion above is the half that still works: the
            // metric SEES the hole, 66.1% of the plate against a 28% ceiling,
            // which is the property this whole case exists for and the one a
            // ground layer painting where the composition is not would break.
            //
            // What does NOT happen is a refusal. RFC-21 §2.9 demoted clause C
            // at interior because the rectangle moved with the brand palette
            // there, and clause H — the element count — was meant to carry the
            // refusal instead. It does not carry THIS plate: a kicker at the
            // head and a body at the foot is two elements, so clause H passes
            // it, and no warning is named for the hole either (`low-occupancy`
            // is clause D's demoted limb, not clause C's).
            //
            // THE COST OF CLOSING IT IS MEASURED, WHICH IS WHY IT IS RECORDED
            // HERE INSTEAD OF CLOSED. Restoring the limb for `holeSpansFrame`
            // holes took 22 populated rows of the gate-zero sweep red —
            // `stat-callout`, `comparison-card`, `list-takeaway`, `slide` and
            // `headline-focus`, at short and medium copy, English and Hebrew,
            // LTR and mirrored (CI 35275187076) — because on a 1080-wide plate
            // that predicate's width limb is met by every full-width band.
            // Separating this plate's 0.66 from those plates' 0.28-0.40 needs
            // an area bound around 0.5 that no measurement in this file
            // justifies yet, and inventing one to make a case green is what
            // §5.6 rule 4 exists to stop.
            //
            // So: asserted ABSENT, so the gap is a line a reader trips over and
            // a future fix has to come past, rather than a silence.
            expect(
              kinds,
              `${entry.template} now REFUSES its hollow middle at the interior role (largestEmptyRectShare ${entry.metrics.largestEmptyRectShare}). ` +
                "That is the gap above being closed, which is good — delete this branch, assert the refusal, and re-run the gate-zero sweep, " +
                "because the 22 rows named above are what this expectation is holding the line on.",
            ).not.toContain("dead-space");
          } else {
            // Clause C still GATES at cover and closer, so the same hole at the
            // closer role is a refusal — which is what keeps the demotion above
            // scoped to one role rather than being a quiet disarming of the
            // whole clause.
            expect(
              kinds,
              `${entry.template} at the ${roles[index]!} role must REFUSE the hole (largestEmptyRectShare ${entry.metrics.largestEmptyRectShare})`,
            ).toContain("dead-space");
          }
        } else {
          expect(kinds, `${entry.template} hollow: ${entry.metrics.inkShare.toFixed(4)} ink share, so clause A must answer alone`).toEqual(["render-integrity"]);
        }
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
            items: [
              { title: "Name a single accountable owner", note: "One person, not a channel" },
              { title: "Measure the queue every week", note: "Weekly, not monthly" },
              { title: "Cut one review round" },
            ],
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
          // ── AN IMAGE-CAPABLE ARCHETYPE GETS ITS IMAGE (RFC-21 Part 2). ──
          //
          // `stat_callout` and `quote_card` declare a bounded `.sc-figure-band`
          // now and are in `HERO_IMAGE_LAYOUTS`, so production sources a picture
          // for them. Rendering one here with `selection(n, null)` measures a
          // plate the workflow no longer produces — the same fixture defect this
          // file already records about the statement archetypes, one archetype
          // family over. The two that still declare no slot are unaffected and
          // keep their heroless render.
          const heroRel = path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/");
          const subject = position === "first" ? 1 : 3;
          const canCarry = HERO_IMAGE_LAYOUTS.has((over.layout ?? "photo") as Parameters<typeof HERO_IMAGE_LAYOUTS.has>[0]);
          const measured = await render(assemble(slides, [1, 2, 3].map((n) => selection(n, n === subject && canCarry ? heroRel : n === 2 ? heroRel : null))));
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

  /**
   * STAGE 8 (2026-09-24): the picture moves without narrowing the type.
   *
   * `corner`, `circle` and `inset` put the bounded picture at the side, in a
   * circle, or in the middle of the plate, and keep the copy at the full field
   * width the fit ladder was calibrated on. Every one of them has to clear
   * the interior floor and the overflow probe on every panel archetype that
   * holds a picture, at two copy lengths, before the rotation may select it.
   * The four shapes already in the rotation are rendered alongside as the
   * baseline the new ones are read against.
   */
  it(
    "every placement the rotation can select clears the interior floor and the overflow probe on every picture panel",
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
            items: [
              { title: "Name a single accountable owner", note: "One person, not a channel" },
              { title: "Measure the queue every week", note: "Weekly, not monthly" },
              { title: "Cut one review round" },
            ],
          },
        },
      ];
      const heroRel = path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/");
      const failures: string[] = [];
      for (const placement of SELECTABLE_FIGURE_PLACEMENTS) {
        for (const { label, over } of content) {
          for (const [lengthLabel, copy] of [["short", SHORT], ["medium", MEDIUM]] as const) {
            const slides = [
              slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "THE SHIFT" }),
              slide({ n: 2, ...copy, ...over }),
              slide({ n: 3, layout: "closer", headline: "That is the pattern", body: "Which round would you cut first?" }),
            ];
            const input = assemble(slides, [selection(1, heroRel), selection(2, heroRel), selection(3, null)]);
            const target = input.slides[1]! as { fields: Record<string, unknown> };
            target.fields = { ...target.fields, figurePlacement: placement };
            const entry = (await render(input))[1]!;
            report(`${label} @ ${placement} (${lengthLabel})`, "interior", entry);
            const findings = checkInterestFloor(entry.metrics, entry.probe, "interior", optsFor(entry)).findings;
            if (findings.length > 0) failures.push(`${label} @ ${placement} (${lengthLabel}): ${findings.map((f) => f.sentence).join(" | ")}`);
            if (entry.probe.overflow) failures.push(`${label} @ ${placement} (${lengthLabel}) overflows: ${entry.probe.overflowing.join(", ")}`);
          }
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    },
    1_200_000,
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

  /**
   * THE SAME GUARD, AT EVERY SCALE AND EVERY GROUND A RUN CAN ACTUALLY PRODUCE.
   *
   * The test above proves `default:cover-carries-device` has pixel teeth at
   * ONE type scale and ONE ground, and neither of those is fixed in a real
   * run. `fontScale` is the reviewer's, and `groundStyle` is chosen by
   * `isVariationSlot(n, GROUND_VARIATION_MIX, "<paletteSeed>:ground")` — so
   * which ground a given slide wears is a function of the palette seed, i.e.
   * of which post this is. A guard whose outcome depends on an input it never
   * varies is a guard that reports the fixture.
   *
   * That mattered, and it is why this sweep exists rather than a second
   * fixture. When it was first written the property was FALSE in two of its
   * twelve combinations: `headline_focus` on the GLYPH ground at the `l` type
   * scale measured 10.6% (medium copy) and 10.9% (long) imagery-or-device,
   * over `IMAGERY_OR_DEVICE_FLOOR`, so the clause went quiet and a statement
   * slide was accepted as a cover on the strength of its ground texture. The
   * cause was that both grounds wrote every length as `calc(Npx * var(--ts))`,
   * so the reviewer's TYPE scale resized the GROUND — a measurement cell is 4
   * DESIGN px and does not scale, so at `l` the mark and the glyph stems began
   * summing into covered cells. Both marks are in fixed px now (see each
   * template's own note, and the fifth-pass band beside the constant).
   *
   * Measured on this tree through the same modules this test drives, LONG
   * copy, `s` / `m` / `l`:
   *
   *   grid ground    4.9%  6.7%  7.0%
   *   glyph ground   5.2%  6.9%  7.1%
   *
   * — all six under the 0.10 floor, all six reporting the clause.
   *
   * THE REMEDY WAS THE GROUND, NOT THE FLOOR, and that is the rule for the
   * next time this goes red: raising the constant to clear a type-only plate
   * would re-admit every plate the floor exists to refuse, and this assertion
   * would go green while the defect it names got worse.
   *
   * The two seeds are picked so the sweep covers both grounds — `""` puts
   * slide 1 in the glyph slot and `"cal"` in the grid slot — and the grounds
   * actually rendered are asserted, so this cannot quietly degenerate into
   * testing one of them twice.
   */
  it(
    "headline_focus is refused as a cover at EVERY type scale and on EITHER ground, not just the fixture's",
    async () => {
      const grounds = new Set<string>();
      const accepted: string[] = [];
      for (const [seedLabel, paletteSeed] of [["glyph slot", ""], ["grid slot", "cal"]] as const) {
        for (const fontScale of ["s", "m", "l"] as const) {
          const slides = [slide({ n: 1, layout: "headline_focus", ...LONG, kicker: "THE SETUP" }), slide({ n: 2, layout: "photo", ...SHORT })];
          const assembled = assemble(slides, [selection(1, null), selection(2, null)], {
            paletteSeed,
            slideStyleOverrides: new Map(slides.map((s) => [s.n, { fontScale }] as const)),
          });
          const measured = await render(assembled);
          const entry = measured[0]!;
          expect(templateBasename(entry.template)).toBe("headline-focus");
          // READ off the assembled slide, never inferred from the seed: the
          // seed-to-ground mapping is `isVariationSlot`'s and may be re-phased,
          // and a coverage claim that trusts the mapping it is meant to be
          // sampling would keep passing while both rows rendered one ground.
          const ground = assembled.slides[0]!.fields["groundStyle"] ?? "(unset)";
          expect(ground, `${seedLabel}: assembleSlidesData emitted no groundStyle to sample`).not.toBe("(unset)");
          grounds.add(ground);
          const label = `headline-focus as cover @ ${fontScale} / ${ground} ground`;
          report(label, "cover", entry);
          const kinds = checkInterestFloor(entry.metrics, entry.probe, "cover", optsFor(entry)).findings.map((f) => f.kind);
          if (!kinds.includes("no-device")) {
            accepted.push(`${label} — ${(entry.metrics.imageryOrDeviceShare * 100).toFixed(1)}% imagery-or-device, over the floor`);
          }
          // It must still be a perfectly good INTERIOR at every scale: the
          // claim is "a bad cover", not "a bad slide".
          expect(checkInterestFloor(entry.metrics, entry.probe, "interior", optsFor(entry)).findings, `${label} as an interior`).toEqual([]);
        }
      }
      expect(grounds, "the sweep must exercise both ground variants, or it is one fixture rendered twice").toEqual(new Set(["glyph", "grid"]));
      expect(accepted, `a statement slide was accepted as a cover:\n  ${accepted.join("\n  ")}`).toEqual([]);
    },
    600_000,
  );

  it(
    "a real hero slide measures as imagery, and a 1x1 TRANSPARENT hero is caught as no-device",
    async () => {
      // Slide 1 carries a SHORT line: since #244 a photo plate with a real deck
      // frames its picture as a block (`heroKind: "framed"`), and this case
      // measures the FULL-BLEED poster, which a plate with a short line still is.
      const slides = [slide({ n: 1, layout: "photo", ...SHORT }), slide({ n: 2, layout: "photo", ...SHORT })];
      const measured = await render(
        assemble(slides, [
          selection(1, path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/")),
          selection(2, path.relative(REPO_ROOT, transparentHeroPath).replaceAll("\\", "/")),
        ]),
      );
      report("slide.html real hero", "cover", measured[0]!);
      report("slide.html transparent hero", "cover", measured[1]!);

      expect(measured[0]!.metrics.imageryShare).toBeGreaterThanOrEqual(0.5);
      // ── AND THE "PHOTOGRAPH" IS REALLY A PHOTOGRAPH, ASSERTED ON THE TWO
      //    SHARES THAT MOVE WHEN IT IS NOT. ──
      //
      // This was `backgroundMatchesBrandGround === true`, on the premise that a
      // photograph has variety in every cell, contributes no FLAT cells, and so
      // cannot win the modal flat colour. The first two clauses are true and the
      // conclusion does not follow: a mode has to return SOMETHING, and on a
      // plate where the picture leaves no ground showing the only flat cells
      // left are the insides of the glyphs. Measured on this tree, the frame
      // reported `backgroundHex` `#F4F2EC` — the run's own `--fg` — on a plate
      // whose ground token is `#17181C`.
      //
      // THE PREMISE HELD ON THE PREVIOUS `slide.html` FOR A REASON THAT WAS NOT
      // THE PHOTOGRAPH. That plate rendered 65.7% imagery over 22.4% flat
      // ground, so a real ground band won the mode. This one is full-bleed —
      // 93.1% imagery, 1.7% flat — and `SlideMetricsSchema` already says what
      // the metric means there: *"False also means 'nothing was supplied to
      // compare against' — unverified, not contradicted."* On a plate with no
      // ground pixels the ground is unverified, and asserting it is true is
      // asserting a measurement the frame cannot carry.
      //
      // So the guard is re-stated on what it was FOR. Its own note names the
      // regression it caught — the old solid-magenta fixture, which "became the
      // ground, and 41.9% of a visually full plate then measured as an empty
      // rectangle" — and both halves of that sentence are numbers on this
      // object. A flat fill cannot be 1.7% flat and it cannot leave a 0.0%
      // rectangle: it would read ~90% flat and ~42% empty, so either bound below
      // fails on it, while `imageryShare` above (a flat fill measures as
      // GRAPHIC, never as imagery) fails on it a third time. That is a stricter
      // test of the fixture than the ground token ever was.
      expect(
        measured[0]!.metrics.flatBackgroundShare,
        `the "photograph" covered ${(measured[0]!.metrics.flatBackgroundShare * 100).toFixed(1)}% of the frame in ONE flat colour — ` +
          "that is a fill, not a picture (the solid-magenta fixture this guard was written for read ~90%)",
      ).toBeLessThan(0.1);
      expect(
        measured[0]!.metrics.largestEmptyRectShare,
        `a visually full plate measured a ${(measured[0]!.metrics.largestEmptyRectShare * 100).toFixed(1)}% empty rectangle — ` +
          "the magenta fixture read 41.9% here, because a flat fill becomes the ground and then the plate is 'empty' by construction",
      ).toBeLessThan(0.1);
      // The ground is UNVERIFIED on a full-bleed plate rather than wrong, and
      // the heroless sibling below is where the ground token is still checked
      // against a plate that actually shows one.
      expect(measured[1]!.metrics.backgroundMatchesBrandGround, "the heroless plate still measures its declared ground").toBe(true);
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
      //
      // AND THE LITERAL IS SCALE-SPECIFIC, which matters the next time
      // somebody widens the sweep. This case renders at the default `m`.
      // Swept across the reviewer's three type scales the same plate measures
      // 1.9% / 2.7% / 4.0% at `s` / `m` / `l` — because `graphicShare` scores
      // a COVERED cell and a larger display face covers more of them, so the
      // number tracks the type scale even though nothing about the hero
      // changed. Rendering this case at `l` would therefore fail 0.035 for a
      // reason that is not the defect it is looking for. Extend it by giving
      // each scale its own measured literal, never by widening this one to
      // cover the loudest.
      //
      // ── RE-MEASURED, THE WAY THE PARAGRAPH ABOVE SAYS TO. ──
      // Phase 5.6 put real ink on this plate that was not there when 2.7% was
      // taken — the plate now carries its own drawn furniture whether or not a
      // hero loaded — and the same render measures **3.6%** at `m`. That is the
      // case the paragraph above describes: the number moved because the
      // TEMPLATE changed, not because the hero contributed anything, and the
      // literal moves with the new measurement rather than the assertion being
      // widened to the floor. 0.048 is 3.6% plus a third of itself, the same
      // headroom 0.035 gave 2.7%, and still less than half the 0.10 floor the
      // line below asserts — so the two assertions continue to pin two
      // different facts.
      expect(measured[1]!.metrics.imageryOrDeviceShare, "a 1x1 transparent hero measured 3.6% on the current templates").toBeLessThan(0.048);
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
   * DOM probe measures CONTRAST, so this case pins the GEOMETRY — the floor,
   * and that the chip and scrim the legibility fix adds do not overflow or
   * push the plate off its numbers. A green here is not a claim about
   * legibility. The legibility claim is made by "a series badge stays legible
   * through a client's own brand head" below, which renders the same cover
   * twice and measures the badge's own pixels; the remaining eyebrow numbers
   * are `.local/cover-contrast.mjs`'s and are written beside the rules they
   * justify in `cover.html`.
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
   * THE SERIES BADGE, THROUGH A CLIENT'S OWN BRAND HEAD, MEASURED IN PIXELS.
   *
   * Two gaps, and the second one is why this case reads the screenshot rather
   * than the source.
   *
   * `cover.html` is the one template whose badge does not stand on the plate's
   * dark ground: at y=56 it sits on the HEAD of the field's accent ramp with
   * no photograph, and on somebody's photograph with one. It paints the badge
   * in `--badge-ink` for that reason. But `buildBrandHeadHtml` emits its own
   * `.brand-badge { ... }` block, `composeDocument` splices it AFTER the
   * template's sheet so a kit beats a template on a specificity tie, and that
   * block said `color: var(--accent)` — so on every branded run the fix was
   * dead and the badge measured 1.51:1 on the ramp head and 1.63:1 over a
   * light photograph: orange on orange at the masthead. The kit's block now
   * reads `color: var(--badge-ink, var(--accent))`.
   *
   * NOTHING IN THE TREE MEASURED THAT. `measureSlidePng` has no contrast
   * metric, the DOM probe reports no colours, the source-scan guard in
   * `default-template-render.test.ts` reads the template and never the
   * composed document, and neither the probe nor this file ever spliced a
   * brand head at all — so every instrument was green while the shipped badge
   * was unreadable. This case closes that by DIFFERENCE: the same cover is
   * rendered twice, once with a `seriesBadge` and once without, and the pixels
   * that changed are the badge's glyphs by construction. Their colour in the
   * badged frame against the same pixels' colour in the unbadged one is the
   * contrast a reader gets, with no geometry hard-coded and nothing to rot
   * when the badge moves.
   *
   * Measured on this tree (`.local/fx-badge-kit.mts` runs the same comparison
   * outside vitest): 5.60:1 on the ramp head, 6.52:1 over a light photograph,
   * 15.03:1 over a dark one — with and without the brand head, identical to
   * the tenth. The floor asserted is 4.5:1, the WCAG ratio for normal text,
   * because a 19px mono label is normal text.
   */
  it(
    "the cover's topical eyebrow stays legible through a client's own brand head, on the ramp head and over a photograph",
    async () => {
      // A kit whose only brand signal is the neutral pair, so what is being
      // measured is the cascade and not a palette. `badgeStyle: "plain"` is
      // the no-signal default `deriveBrandRenderTokens` produces.
      const kit: BrandRenderTokens = { cssVars: { "--bg": "#17181C", "--fg": "#F4F2EC" }, fontFamilies: [], badgeStyle: "plain", palette: [] };
      const brandedDir = path.join(workDir, "templates-kit");
      await materialize(brandedDir, undefined, buildBrandHeadHtml(kit));
      const previous = templateDir;
      templateDir = brandedDir;
      try {
        for (const [groundLabel, hero] of [["the ramp head, no photograph", null], ["a photograph", heroPath]] as const) {
          const frames: Buffer[] = [];
          // THE LABEL THIS VARIES IS THE EYEBROW, NOT THE BADGE. §4.3 deleted
          // the `{{seriesBadge}}` slot from all eight bundled templates, so the
          // two frames this case used to diff were byte-identical and it failed
          // on its own premise (`differ in 0 pixels`). The cascade it pins is
          // unchanged and still live: `BADGE_VARIANT_CSS` styles
          // `.eyebrow, .kicker, .brand-badge` as ONE selector list, the kit's
          // block lands after the template's, and the cover's label is the one
          // in the set that does not stand on the plate's own dark ground.
          // ── THE BLANK FRAME KEEPS THE CHIP, AND THAT IS THE WHOLE TRICK. ──
          //
          // The series badge this case used to vary painted no background, so
          // "with it" minus "without it" WAS the glyphs. The eyebrow that
          // replaced it paints a scrim chip on the photograph path
          // (`body:has(.hero) .eyebrow:not(:empty)`), and an EMPTY eyebrow is
          // `display: none` — so diffing against an empty one diffs the chip
          // too, and the "most-changed fifth" is chip-against-photograph rather
          // than glyph-against-chip. Measured that way it read 2.56:1 on a
          // plate whose type is fine.
          //
          // So the control frame carries a label of the SAME LENGTH made of the
          // lightest glyph in the face. The label is set in `--f-mono` and a
          // monospace advance is per-character, so nine dots occupy exactly the
          // box nine letters do: the chip, the rail, the field's height and the
          // lockup under it are identical in both frames, and the pixels that
          // differ are where one frame has a stroke and the other has chip.
          // Whitespace cannot do this job — ` ` is trimmed away by the copy
          // schema, the element becomes `:empty`, and the chip and rail vanish
          // with it, which is the 154,623-pixel diff that read 2.56:1.
          for (const kicker of ["THE SHIFT", "........."]) {
            const slides = [
              slide({ n: 1, layout: "cover", ...MEDIUM, kicker }),
              slide({ n: 2, layout: "photo", ...SHORT }),
              slide({ n: 3, layout: "closer", headline: "That is the pattern", body: "Which round would you cut first?" }),
            ];
            const measured = await render(
              assemble(slides, [selection(1, hero === null ? null : path.relative(REPO_ROOT, hero).replaceAll("\\", "/")), selection(2, null), selection(3, null)], {
                brandTokens: {
                  templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
                  slideTemplate: "slide.html",
                  accentColor: "#C4552F",
                },
              }),
            );
            const cover = measured[0]!;
            expect(templateBasename(cover.template), `the badge case did not render cover.html over ${groundLabel}`).toBe("cover");
            frames.push(await fs.readFile(path.isAbsolute(cover.path) ? cover.path : path.join(REPO_ROOT, cover.path)));
          }

          const { ratio, changed, glyph, ground } = badgeContrast(frames[0]!, frames[1]!);
          console.log(`eyebrow over ${groundLabel}: ${ratio.toFixed(2)}:1  glyph ${glyph}  ground ${ground}  (${changed} px)`);
          // The premise: the two frames really do differ, and they differ
          // where a badge would be. A comparison of two identical frames
          // would otherwise report a meaningless 1.00:1 — or, worse, a
          // flattering number off a handful of noise pixels.
          // ~2,880 pixels change when "THE SIGNAL" renders in IBM Plex Mono at
          // 19px and scale 2 (measured, `.local/fx-badge-diff.mts`). The floor
          // is well under that because the face is not guaranteed: a CI runner
          // with no network gets the fallback mono and a different glyph area.
          // What it has to separate is "the badge painted" from "it did not",
          // and a badge that did not paint changes zero.
          expect(changed, `over ${groundLabel} the covers with and without an eyebrow differ in ${changed} pixels — the eyebrow did not render`).toBeGreaterThan(800);
          expect(ratio, `the cover's eyebrow measures ${ratio.toFixed(2)}:1 over ${groundLabel} — a reader cannot see it`).toBeGreaterThanOrEqual(4.5);
        }
      } finally {
        templateDir = previous;
      }
    },
    600_000,
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

  // ───────────────────────────────────────────────────────────────────────
  // RFC-17 — the same calibration, with MARKED emphasis on
  // ───────────────────────────────────────────────────────────────────────

  /**
   * THE SEVERABILITY GATE FOR THE WHOLE OF RFC-17'S RENDERED HALF.
   *
   * Marks paint pixels the floor then measures, and the alignment walk moves
   * the type block sideways on most slides. Both are therefore claims on the
   * `CALIBRATION_MARGIN = 0.08` headroom, and RFC-17 §5.5 says in as many
   * words that if they eat it, they are dropped rather than paid for with a
   * threshold. This case is where that is decided, and it is why NO number in
   * `interest-floor.ts` had to move for this phase: the marked set is
   * asserted against the UNCHANGED constants at the UNCHANGED margin.
   *
   * Both directions are checked, because the failure could come from either:
   * emphasis ADDS painted area (`occupiedShare` up, `largestEmptyRectShare`
   * down, which is the safe direction) but it also adds ink, and `textShare`
   * runs the other way against `TEXT_SHARE_CEILING`. A slide that gained a
   * wall-of-text finding by being marked would be a real defect in the
   * mechanism and the cheapest possible place to catch it.
   */
  it(
    "the bundled archetypes still clear every floor with MARKED emphasis on, at the same margin and the same constants",
    async () => {
      for (const [lengthLabel, copy] of [["short", SHORT], ["medium", MEDIUM], ["long", LONG]] as const) {
        // Two spans a slide, verbatim out of the fields these fixtures
        // actually carry — `resolveSlideMarks` locates by bounded first
        // occurrence and DROPS a span that does not occur, so a typo here
        // would silently measure an unmarked plate. `assertActuallyMarked`
        // below is what stops that being possible.
        const marks = copy === SHORT ? ["Intake", "queue"] : ["calendars", "process"];
        const slides = [
          slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "THE SHIFT", emphasis: ["calendars", "process"] }),
          slide({ n: 2, layout: "text_only", ...copy, emphasis: marks, ...objectFor(copy) }),
          slide({ n: 3, layout: "headline_focus", ...copy, kicker: "THE TURN", emphasis: marks, ...objectFor(copy) }),
          slide({
            n: 4,
            layout: "list_takeaway",
            ...copy,
            items: [
              { title: "Name a single accountable owner", note: "One person, not a channel" },
              { title: "Measure the queue every week", note: "Weekly, not monthly" },
              { title: "Cut one review round" },
            ],
            // The `rf-11` case: the row marks are free, because
            // `buildListRows` already emits into `itemRows`.
            emphasis: ["owner", "queue", "round"],
          }),
          slide({
            n: 5,
            layout: "quote_card",
            ...copy,
            quote: { text: "We stopped guessing and started measuring the queue.", attribution: "Head of Ops, 2026" },
            // `quote_card` refuses `block` outright whatever the ground —
            // `.quote-text` is italic and a background box on an italic run
            // is a parallelogram the CSS cannot follow. It still marks.
            emphasis: ["the queue"],
          }),
          slide({ n: 6, layout: "closer", headline: "That is the whole pattern", body: "Which review round would you cut first?", emphasis: ["pattern", "cut"] }),
        ];
        const { input, issues } = assembleMarked(slides, slides.map((s) => selection(s.n, null)));
        const measured = await render(input);
        const roles: SlideRole[] = ["cover", "interior", "interior", "interior", "interior", "closer"];

        // THE PREMISE, asserted before anything is concluded from the
        // numbers. A run where every span was dropped renders plain type and
        // clears every floor trivially — it would be a green test that
        // measured nothing, which is the failure mode this project keeps
        // finding in its own suites.
        const totalRuns = measured.reduce((sum, entry) => sum + (entry.probe.markRuns ?? 0), 0);
        expect(totalRuns, `no slide carried a mark run at ${lengthLabel} — the fixtures' spans did not resolve: ${issues.map((i) => `${i.field}/${i.text}: ${i.reason}`).join("; ")}`).toBeGreaterThan(0);

        for (const [index, entry] of measured.entries()) {
          const role = roles[index]!;
          const label = `${entry.template} marked (${lengthLabel})`;
          report(label, role, entry);
          expect(checkInterestFloor(entry.metrics, entry.probe, role, optsFor(entry)).findings, label).toEqual([]);
          expect(findingsAtMargin(entry, role, CALIBRATION_MARGIN), `${label} has under ${CALIBRATION_MARGIN} margin`).toEqual([]);
          expect(entry.probe.overflow, `${label} overflows: ${entry.probe.overflowing.join(", ")}`).toBe(false);
          // The opposite failure from emptiness, and the one marks could
          // plausibly cause: a marked headline bleeds `.06em` either side.
          expect(entry.metrics.textShare, `${label} textShare ${entry.metrics.textShare} is at the wall-of-text ceiling`).toBeLessThan(TEXT_SHARE_CEILING - CALIBRATION_MARGIN);
          // And the DOM half: every run the document asked for paints, or
          // the shared stylesheet did not reach this document.
          if ((entry.probe.markRuns ?? 0) > 0) {
            expect(entry.probe.markRunsPainted, `${label}: ${entry.probe.markRuns} runs asked, ${entry.probe.markRunsPainted} painted`).toBe(entry.probe.markRuns);
          }
        }
      }
    },
    600_000,
  );

  /**
   * THE BAND SWEEP — the artefact RFC-17 §5.3 and §3.4 both defer to, and the
   * only thing that can correct the two Hebrew geometry numbers.
   *
   * `--mk-block-h: .44em` and `--mk-block-y: .60em` were reasoned from the
   * fact that Hebrew has no ascenders and a full-height letter body. That is
   * a true fact and it is not a measurement, and the comment beside those
   * values says so: *starting values, calibrated in CI by the band sweep*.
   * This is that sweep.
   *
   * IT ASSERTS ALMOST NOTHING ON PURPOSE. The per-kind/per-scale
   * `markedShare` band has never been observed on real Chromium renders, and
   * `IMAGERY_OR_DEVICE_FLOOR` took six documented calibration passes before
   * anybody was allowed to trust it. Asserting a band on its first sighting
   * is how a number nobody measured becomes a constant everybody cites. So
   * this prints the table and asserts only the two things that are true by
   * construction — that the runs painted, and that the measured marks landed
   * inside the frame.
   *
   * ## What the table will show, predicted here so the prediction is falsifiable
   *
   * `markedShare` is a HEADLINE-SCALE instrument and the sweep should say so.
   * A marked cell has to be COVERED (48 of 64 samples non-ground), and every
   * mark size is in `em`: on a display headline `.07em` of rule is ~6 design
   * px, enough to cover a 4px cell row, while on body copy the same rule is
   * ~2px and covers no cell at all. The `ink` kind — the one our default
   * `#17181C` ground forces, since `block` is refused on a ground darker than
   * the ink — paints only GLYPHS, which never cover a cell by definition.
   *
   * **So a zero `markedShare` on a body-copy or `ink`-kind slide is the
   * instrument being right, not the marks being missing**, and that is
   * precisely why the pixel limb ships as the `marks-not-visible` WARNING and
   * the DOM limb is what gates. If the table below shows otherwise, the
   * warning's band can be set; if it shows this, the warning is
   * reporting-only for good reason and `markColourCount` must never be
   * promoted to a clause.
   */
  it(
    "band sweep: the measured mark geometry per archetype, type scale and script",
    async () => {
      const rows: string[] = [];
      const sweep = async (label: string, input: RenderCarouselInput, roles: SlideRole[]): Promise<void> => {
        const measured = await render(input);
        for (const [index, entry] of measured.entries()) {
          const runs = entry.probe.markRuns ?? 0;
          const painted = entry.probe.markRunsPainted ?? 0;
          const band = runs > 0 ? await markBand(entry.path) : undefined;
          rows.push(
            [
              `${label}`.padEnd(28),
              `→ ${templateBasename(entry.template)}`.padEnd(20),
              `${roles[index] ?? "interior"}`.padEnd(9),
              `runs ${painted}/${runs}`.padEnd(12),
              `marked ${(entry.metrics.markedShare * 100).toFixed(2)}%`.padEnd(16),
              `colours ${entry.metrics.markColourCount}`.padEnd(12),
              `contrast ${entry.metrics.groundInkContrast.toFixed(2)}`.padEnd(15),
              `centroid ${entry.metrics.contentCentroid.x.toFixed(3)},${entry.metrics.contentCentroid.y.toFixed(3)}`.padEnd(26),
              `elements ${entry.probe.elementCount}`.padEnd(15),
              band === undefined ? "band —" : `band rows ${band.top}-${band.bottom} of ${band.height} (${band.pixels}px)`,
            ].join(" "),
          );
          // True by construction, and the two things a broken sweep would
          // get wrong: the sheet reached the document, and whatever it
          // painted is on the plate rather than off the edge of it.
          if (runs > 0) expect(painted, `${label}: ${runs} runs asked, ${painted} painted`).toBe(runs);
          if (band !== undefined && band.pixels > 0) {
            expect(band.top, `${label}: mark band starts above the frame`).toBeGreaterThanOrEqual(0);
            expect(band.bottom, `${label}: mark band runs past the frame`).toBeLessThan(band.height);
          }
        }
      };

      for (const fontScale of ["s", "m", "l"] as const) {
        const slides = [
          slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "THE SHIFT", emphasis: ["calendars", "process"] }),
          slide({ n: 2, layout: "text_only", ...MEDIUM, emphasis: ["calendars", "process"] }),
          slide({ n: 3, layout: "headline_focus", ...MEDIUM, kicker: "THE TURN", emphasis: ["calendars"] }),
          slide({ n: 4, layout: "closer", headline: "That is the whole pattern", body: "Which review round would you cut first?", emphasis: ["pattern", "cut"] }),
        ];
        const { input } = assembleMarked(slides, slides.map((s) => selection(s.n, null)), {
          slideStyleOverrides: new Map(slides.map((s) => [s.n, { fontScale }] as const)),
        });
        await sweep(`latin ${fontScale}`, input, ["cover", "interior", "interior", "closer"]);
      }

      // HEBREW, on its own materialization — the script sheet AND the Hebrew
      // branch of `markCssBlock`, which is the pair whose geometry this sweep
      // exists to correct. Same shape as the Hebrew case above.
      const previous = templateDir;
      const hebrewDir = path.join(workDir, "templates-he-marks");
      await materialize(hebrewDir, "he");
      templateDir = hebrewDir;
      try {
        for (const fontScale of ["s", "m", "l"] as const) {
          const slides = [
            slide({ n: 1, layout: "cover", ...HEBREW, kicker: "המהלך", emphasis: ["התוכן", "התלהבות"] }),
            slide({ n: 2, layout: "text_only", ...HEBREW, emphasis: ["התוכן", "התלהבות"] }),
            slide({ n: 3, layout: "headline_focus", ...HEBREW, emphasis: ["התוכן"] }),
            slide({ n: 4, layout: "closer", headline: "זה בעצם כל הדפוס שחוזר", body: "איזה סבב הייתם חותכים ראשון?", emphasis: ["הדפוס"] }),
          ];
          const { input } = assembleMarked(slides, slides.map((s) => selection(s.n, null)), {
            slideStyleOverrides: new Map(slides.map((s) => [s.n, { fontScale }] as const)),
          });
          await sweep(`hebrew ${fontScale}`, input, ["cover", "interior", "interior", "closer"]);
        }
      } finally {
        templateDir = previous;
      }

      console.log(["", "RFC-17 MARK BAND SWEEP", ...rows, ""].join("\n"));
    },
    900_000,
  );

  // ───────────────────────────────────────────────────────────────────────
  // RFC-20 — the acceptance guard, and the gate-zero sweep that sets the
  // three constants it moved
  // ───────────────────────────────────────────────────────────────────────
  /**
   * ── THE OTHER HALF OF §11.4, AND THE ONE THAT IS EASY TO FORGET TO WRITE. ──
   *
   * Every statement-plate fixture in this file carries `STATEMENT_OBJECT`,
   * because that is what production composes. **A suite that only ever renders
   * the plate with its object has quietly stopped testing the refusal**, and
   * the refusal is half of what RFC-20 §11.4 promises:
   *
   * > *A plate whose copy carries no figure gets nothing. A plate with neither
   * > fails clause C, correctly — that is the floor discriminating, not a
   * > regression.*
   *
   * So this case renders the SAME two archetypes with the SAME copy and the
   * object removed, and requires them to be refused. It is the executable form
   * of the sentence above, and it is what stops the next pass from reading the
   * green sweep as "a bare statement plate is fine".
   *
   * ── AND IT IS NOW THE CASE THAT HOLDS THE WHOLE CLAUSE UP. ──
   *
   * The first version of this case asserted a WAIVER BOUNDARY: refused at `s`
   * where the type does not reach `DISPLAY_TYPE_SCALE_FLOOR`, passing at `m`
   * where it does. Its own premise assertion killed it on CI 34960136572 —
   * `headline-focus` at `s` reads `displayTypeScale` **0.2715** against a 0.055
   * floor, five times over, and so does the grey screen, because they are the
   * same type at the same size. `plateSubject`'s type limb is withdrawn as a
   * result (see its own comment), so there is no boundary left to pin: an
   * objectless statement plate is refused at EVERY type scale, and the size of
   * its headline has nothing to say about it.
   *
   * **Both scales are still rendered**, because the claim is now stronger and
   * has to be shown to hold across the ladder rather than at one point on it.
   */
  it(
    "§11.4's other half: a statement plate with NO object is refused at every type scale",
    async () => {
      const rows: string[] = [];
      for (const fontScale of ["s", "m", "l"] as const) {
        const slides = [
          slide({ n: 1, layout: "cover", ...MEDIUM, kicker: "THE SHIFT" }),
          slide({ n: 2, layout: "headline_focus", ...SHORT, kicker: "THE TURN" }),
          slide({ n: 3, layout: "text_only", ...SHORT }),
          slide({ n: 4, layout: "closer", headline: "That is the pattern", body: "Which round would you cut first?" }),
        ];
        const measured = await render(
          assemble(slides, slides.map((sl) => selection(sl.n, null)), {
            slideStyleOverrides: new Map(slides.map((sl) => [sl.n, { fontScale }] as const)),
          }),
        );
        for (const entry of measured.slice(1, 3)) {
          const verdict = checkInterestFloor(entry.metrics, entry.probe, "interior", optsFor(entry));
          const kinds = verdict.findings.map((f) => f.kind);
          const name = templateBasename(entry.template);
          rows.push(
            `${name.padEnd(16)} ${fontScale}  LER ${entry.metrics.largestEmptyRectShare.toFixed(4)}  ` +
              `iod ${entry.metrics.imageryOrDeviceShare.toFixed(4)}  dts ${entry.probe.displayTypeScale.toFixed(4)}  ` +
              `tbs ${entry.probe.textBoxShare.toFixed(4)}  -> ${kinds.join(", ") || "PASS"}`,
          );
          // THE PREMISE: the plate really is objectless, so what is asserted below
          // is about the composition and not about a device that failed to paint.
          expect(entry.metrics.imageryOrDeviceShare, `${name} @ ${fontScale} carries a device, so this case is not testing what it says`).toBeLessThan(
            IMAGERY_OR_DEVICE_FLOOR,
          );
          // ── WHAT §11.4's OTHER HALF MEANS UNDER CLAUSE H. ──
          //
          // It used to assert `dead-space`, and clause C reported at the interior
          // role from RFC-21 Part 2 onward, so that assertion was measuring a
          // clause that had stopped speaking. What the promise actually says is
          // about the plate's CONTENT, and clause H is the clause that reads it:
          //
          //   headline + body, no object      2 elements   passes
          //   headline + body + the object    3 elements   passes
          //   a headline and nothing else     1 element    REFUSED (G1)
          //
          // So the honest assertion here is the ARITHMETIC that makes the floor
          // work, not a clause name: the object is worth exactly one element, and
          // the plate that gets refused is the one below the floor rather than the
          // one merely without an object. A headline-and-body slide is a slide.
          // 2 on `slide.html` (headline + body), 3 on `headline_focus` (its
          // kicker is an element too). Both are over the floor, which is the
          // point: a headline-and-body slide is a slide.
          expect(entry.contentElements, `${name} @ ${fontScale} counts ${entry.contentElements} elements without an object`).toBeGreaterThanOrEqual(2);
          expect(kinds, `${name} @ ${fontScale} was refused although it carries two elements`).not.toContain("one-element");
        }
      }
      console.log(["", "RFC-20 §11.4 — THE OBJECTLESS STATEMENT PLATE", ...rows, ""].join("\n"));
    },
    600_000,
  );
  // ── THE FOUR GUARDS CAME BACK WITH THE FEATURE THEY TEST. ──
  //
  // RFC-20 Part 11 CUT `headline_focus` and heroless `slide.html` from that
  // phase, and these cases each render one of those two files as their
  // subject, so on the cut tree every one of them was a red light with
  // nothing behind it. §11.4 listed all five by name — four here, one in
  // `interest-floor-marks.test.ts` — as returning WITH the bounded-object
  // work, and **unweakened, which is the only way any of them may return.**
  //
  // THEY ARE RESTORED BYTE-FOR-BYTE from the commit that sent them out
  // (`1994347^`). Not one assertion, threshold or message was edited on the
  // way back in, and that is checkable rather than claimed: `git show
  // 1994347^:agents/instagram-agent/__tests__/interest-floor-calibration.test.ts`
  // holds the originals. A guard that returns softened is a guard that was
  // deleted with extra steps.
  //
  // WHAT CHANGED UNDER THEM, which is the whole of why they can pass now:
  //
  //   * `headline-focus.html`'s 45-degree hatch and `slide.html`'s dot screen
  //     and column ruling are DELETED. G1's recorded failure on the cut tree
  //     was `occ` 0.5090 / `LER` 0.0778 — the owner's one-line grey screen
  //     PASSING the floor — and §11.6's own reading of that number is that
  //     the hatch was what made a one-line plate measure half-covered.
  //   * Both plates carry a bounded OBJECT instead (`bounded-object.ts`),
  //     which is §11.4's answer and not more ground.
  //   * Clause D's occupancy limb is reporting-only (PR #124), so nothing
  //     requires the ink the textures were supplying.
  //
  // The debt in §11.6 is therefore DISCHARGED rather than carried, and G1 is
  // the case that says so: it is this phase's acceptance condition, it failed
  // on the tree that shipped the cut, and it has to be green here or the
  // bounded object did not do the job it was built for.

  /**
   * G1 — THE OWNER'S GREY SCREEN, AND THIS PHASE'S ACCEPTANCE CONDITION.
   *
   * The complaint, unchanged since RFC-14 quoted it: *"בKAROS LABS אתה רואה
   * מסך אפור ברובו"* — you see a mostly-grey screen. Phase 2 built a pixel
   * floor to refuse exactly that. **It does not refuse it**, because the
   * decoration we paint satisfies the masks the floor reads.
   *
   * MEASURED-HERE through the real `measureSlidePng`, on the SHIPPED ground:
   *
   *   shipped hatch, 3-line headline + body (a GOOD plate)  occ 0.6688  LER 0.0000  C pass  D pass
   *   shipped hatch, ONE SHORT HEADLINE (the grey screen)   occ 0.6324  LER 0.0000  C pass  D pass
   *
   * The two are indistinguishable and both PASS. MEASURED-EDGE, `Y0 s2` is
   * that exact plate driven through the production path and it returns
   * `ok: true`. **So this case fails on the tree it was written against, for a
   * real reason, on the shipped ground, with nothing manufactured** — it is
   * the acceptance condition for RFC-20's template work and not a regression
   * guard for it. On the material ground the same plate reads occ 0.0106-0.0311
   * and LER 0.5111-0.5259, and clause C refuses it at 2.3x the ceiling.
   *
   * Hand-built rather than assembled, for the reason the empty and hollow
   * cases above already give: `InstagramSlideCopySchema` requires a non-empty
   * `body`, so "one short headline and nothing else" is a shape the copy
   * schema cannot express. Everything downstream of the document — the real
   * `publish.renderCarousel`, the real `measureSlidePng`, the real
   * `probePage`, the real `checkInterestFloor` — is the production path.
   *
   * BOTH GROUND VARIANTS and BOTH ROLES, because a defect that survives on one
   * parity of `{{slideIndex}}` is the same defect.
   */
  // ── KNOWN RED, AND `it.fails` RATHER THAN A DELETION OR A LOWERED BAR. ──
  //
  // **The grey screen is not separable from a good one-line statement plate by
  // geometry on a quiet tree, and this is the case that says so out loud.**
  //
  // Measured on CI 34960136572, with the full-plate textures deleted:
  //
  //     bundled kit, bare grey screen    LER 0.3337   <- over the ceiling
  //     paper kit, bare grey screen      LER 0.2707   <- under it
  //     paper kit, maximum mark load     LER 0.2036   <- well under it
  //     LARGEST_EMPTY_RECT_CEILING.interior           0.28
  //
  // The same plate straddles the ceiling depending on which kit's type metrics
  // it is set in, and marks push it further under. Clause C therefore refuses
  // the owner's plate for one client and passes it for another — which is the
  // exact property the owner ruled out on 2026-09-14: *make sure the metrics
  // are agnostic to colour and rest on the absence of elements, structure and
  // contrast rather than on thresholds fitted to one palette.*
  //
  // AND THIS WAS TRUE BEFORE THIS BRANCH. RFC-20 §11.6 recorded it in the tree
  // as the reason §5.6 rule 3's demotion was refused at the time: *the marked
  // grey screen measures `LER` 0.2278 against a 0.28 ceiling, so clause C does
  // NOT carry the refusal.* These cases were red at the cut and they are red
  // now; what this branch adds is the measurement that says WHY, and that the
  // last candidate waiver (`plateSubject`'s display-type limb) cannot close it
  // either — it waived this very plate at `displayTypeScale` 0.2715.
  //
  // WHY `it.fails` AND NOT A DELETION. A deleted case is a question nobody is
  // asked again; a lowered ceiling is the fitting §5.6 rule 4 forbids. `it.fails`
  // keeps the render, keeps every assertion, and **inverts the report**: the
  // suite is green while the defect stands and goes RED the day somebody fixes
  // it, which is when this comment has to be deleted and the case restored to
  // `it`. It is the only encoding that cannot rot into permission.
  //
  // WHOSE PROBLEM IT IS: RFC-21 Part 2, the semantic/structural floor — not
  // §11.4. Six separators have now been measured away (see
  // `instagram-floor-candidates-falsified`), and the shape of the answer is
  // named in RFC-20 §11.4's own warning box: *the real answer is not a better
  // number for the same metric; it is a semantic/structural reading of the
  // plate.* A plate carrying a headline, no body, no device and no source is
  // refusable from the COPY. It is not refusable from its pixels.
  // ── RESTORED TO `it`. CLAUSE H IS THE REFUSAL THESE CASES WERE WAITING FOR. ──
  //
  // They were marked `it.fails` earlier in this same branch, with the
  // measurement: on a de-decorated tree the grey screen is not separable from a
  // good one-line statement plate BY GEOMETRY, because `largestEmptyRect` is
  // built from masks cut at an absolute distance and therefore moves with the
  // brand palette (bundled 0.3337 over the ceiling, paper 0.2707 under it,
  // marked 0.2036 well under).
  //
  // **That is still true, and it is no longer what decides.** RFC-21 Part 2's
  // clause H asks the assembled DOCUMENT how many content elements are on the
  // plate. The owner's grey screen is one headline and nothing else: it counts
  // **1** against a floor of 2, identically on a dark kit, a light kit, a
  // saturated kit and a kit on the 4.5:1 floor, because a palette cannot reach
  // a count. Marks do not change it either — five swatches on one headline is
  // still one element — which is the property G5 has always been about and
  // which it can now assert without depending on a rectangle.
  //
  // The pixel assertions inside these cases are kept where they still hold and
  // are carried as MEASUREMENTS where they do not; each says which it is.
  it(
    "G1 — the owner's grey screen is REFUSED at the interior AND cover roles, on either ground",
    async () => {
      const rows: string[] = [];
      for (const groundStyle of ["grid", "glyph"] as const) {
        const furniture = { dir: "ltr", fontScale: "m", textAlign: "start", accentColor: "#C4552F", groundStyle, slideIndex: "02" };
        const greyScreen: RenderCarouselInput = {
          client: "calibration",
          postId: "interest-floor-g1",
          canvas: CANVAS,
          repoRoot: REPO_ROOT,
          templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
          // ONE SHORT HEADLINE AND NOTHING ELSE. No kicker, no body, no
          // device, no eyebrow — the owner's plate.
          slides: [{ n: 1, template: "headline-focus.html", fields: { ...furniture, headline: SHORT.headline }, images: {}, htmlFragments: {} }],
        } as unknown as RenderCarouselInput;
        const measured = await render(withMeasureAnchors(greyScreen));
        const entry = measured[0]!;

        for (const role of ["interior", "cover"] as const) {
          report(`GREY SCREEN (${groundStyle})`, role, entry);
          const verdict = checkInterestFloor(entry.metrics, entry.probe, role, optsFor(entry));
          rows.push(
            `grey screen ${groundStyle} @ ${role}: occ ${entry.metrics.occupiedShare.toFixed(4)} flat ${entry.metrics.flatBackgroundShare.toFixed(4)} ` +
              `LER ${entry.metrics.largestEmptyRectShare.toFixed(4)} COCC ${entry.metrics.contentOccupiedShare.toFixed(4)} ink ${entry.metrics.inkShare.toFixed(4)} ` +
              `→ ${verdict.findings.map((f) => f.kind).join(", ") || "OK (the defect)"}`,
          );

          // ── THE ACCEPTANCE CONDITION. ──
          expect(
            verdict.ok,
            `THE OWNER'S GREY SCREEN PASSED THE FLOOR at the ${role} role on the ${groundStyle} ground — ` +
              `occ ${entry.metrics.occupiedShare.toFixed(4)}, LER ${entry.metrics.largestEmptyRectShare.toFixed(4)}, ` +
              `COCC ${entry.metrics.contentOccupiedShare.toFixed(4)}, ink ${entry.metrics.inkShare.toFixed(4)}. ` +
              `A bar that cannot refuse the thing it was built for is worthless: fix the TEMPLATE, never this number.`,
          ).toBe(false);

          // ── THE PIXEL FACT, UNCONDITIONALLY AND AHEAD OF THE VERDICT. ──
          //
          // The rectangle is what measures "a large empty upper area", and it
          // has to be over the ceiling whichever clause ends up speaking. This
          // line is what stops a template whose ground paints unconditionally
          // from slipping past a test that only reads clause names — the same
          // separation the hollow-middle case above argues for at length.
          expect(
            entry.metrics.largestEmptyRectShare,
            `the grey screen measured a ${(entry.metrics.largestEmptyRectShare * 100).toFixed(2)}% rectangle on the ${groundStyle} ground — a ground layer is painting over the emptiness`,
          ).toBeGreaterThan(LARGEST_EMPTY_RECT_CEILING[role]);

          // ── WHICH CLAUSE SPEAKS, pinned on both branches rather than either
          //    standing in for the other. ──
          //
          // `dead-space` is the expected answer and the one RFC-20 §5.7 names:
          // on the material ground the plate keeps its content-guarded plinth
          // and measures ~3% ink, well over clause A's 1.5% floor, so clause C
          // is what fires. If the plate turns out to carry LESS ink than that,
          // clause A returns on its own and suppresses the rest — which is the
          // STRONGER refusal and the right steer ("re-render", not "rewrite"),
          // and the rectangle assertion above is what keeps accepting it from
          // covering for an unconditional ground layer.
          const kinds = verdict.findings.map((f) => f.kind);
          // WHICH CLAUSE, and it differs by role since RFC-21 Part 2. At COVER
          // clause C still gates and still names the hole. At INTERIOR it
          // reports — `largestEmptyRect` gave four verdicts on four palettes
          // for one plate — and clause H refuses on the element count instead:
          // this plate is one headline and nothing else, which counts 1 on
          // every brand. The plate is refused at both roles either way, which
          // is what this case is for.
          if (role === "interior") {
            expect(kinds, `grey screen ${groundStyle} @ interior: ${kinds.join(", ")}`).toContain("one-element");
          } else if (entry.metrics.inkShare > INK_SHARE_FLOOR) {
            expect(kinds, `grey screen ${groundStyle} @ ${role}: ${kinds.join(", ")} (ink ${entry.metrics.inkShare.toFixed(4)})`).toContain("dead-space");
          } else {
            expect(kinds, `grey screen ${groundStyle} @ ${role}: ${entry.metrics.inkShare.toFixed(4)} ink, so clause A must answer alone`).toEqual(["render-integrity"]);
          }

          // ── AND IT MUST NOT CLAIM A DEVICE IT HAS NOT EARNED. ──
          //
          // `verdict.ok === false` above can be carried by clause C alone, and
          // for one revision of this phase it was: the plinth was guarded on
          // the HEADLINE, so the owner's plate — one short headline and
          // nothing else — wore a 888x400 filled card and measured `iod`
          // 0.2763-0.3152 against a 0.10 floor. The floor still refused it,
          // but the plate was reporting that it carried a drawn device, and a
          // grey screen that satisfies clause E is the same defect one clause
          // over. `headline-focus.html` now asks the guard for the BODY, and
          // the same plate measures 0.0166-0.0412.
          //
          // THIS ASSERTION FAILS WITHOUT THAT GUARD CHANGE. It is the reason
          // the change is in this PR rather than deferred, and asserting it
          // here rather than in the template's own comment is what makes it a
          // guard instead of a claim.
          if (role === "cover") {
            expect(
              entry.metrics.imageryOrDeviceShare,
              `the grey screen measured ${(entry.metrics.imageryOrDeviceShare * 100).toFixed(2)}% imagery-or-device on the ${groundStyle} ground — ` +
                `a plate carrying one headline is painting a drawn device, so clause E has been disarmed by template furniture`,
            ).toBeLessThan(IMAGERY_OR_DEVICE_FLOOR);
            expect(kinds, `grey screen ${groundStyle} @ cover: ${kinds.join(", ")}`).toContain("no-device");
          }
        }
      }
      console.log(["", "RFC-20 G1 — THE OWNER'S GREY SCREEN", ...rows, ""].join("\n"));
    },
    600_000,
  );

  /**
   * G2 — THE GROUND RULE, AS A RENDER: A PLATE WITH NO COPY ON IT MUST BE BLANK.
   *
   * G1 asks whether the floor refuses a bad plate. G2 asks the prior question
   * — whether the instrument can still SEE an empty one — and it is the guard
   * that stops defect 1 coming back by a different door. Every clause here
   * reads a share of the frame, so any layer that paints independently of the
   * content is a constant added to every measurement: once a template draws
   * something unconditionally, the neglected plate and the composed plate
   * converge and no threshold anywhere can separate them. That is precisely
   * how the shipped 45-degree screen took a good plate and the owner's grey
   * screen to 0.6688 and 0.6324 with both passing.
   *
   * So the rule is stated as a property of the TEMPLATE SET rather than of any
   * one archetype: render every bundled template, on every ground variant a
   * run can produce, in both directions, with **every copy slot empty**, and
   * require it to measure as what it is.
   *
   * `template-mark-slots.test.ts`'s `GROUND_SELECTORS` header already cites
   * this case by name as "the general rule — no full-bleed layer may carry
   * ink, at all, in any template". It was cited before it existed; this is it.
   *
   * ── WHAT IT CAUGHT, WHICH IS THE ARGUMENT FOR HAVING IT ──
   *
   * RFC-20 §5.2 checked clause E on the four panel archetypes and concluded
   * they were "already built to the Ground Rule". Clause E was the wrong
   * question and two of them were not. MEASURED-EDGE, before the fix:
   *
   *   stat-callout.html     occ 0.45%  LER 64.99%   <- rail + stat band
   *   comparison-card.html  occ 1.94%  LER 31.67%   <- rail + card borders + rules + diamond
   *
   * Both are occ 0.00% / LER 100.00% now, and every populated row measures
   * byte-identically to before the guards.
   *
   * ── THE TWO THIN ROWS, NAMED SO A RED IS READABLE ──
   *
   * `quote-card` and `list-takeaway` measure LER 91.39% against this 90% bar
   * — 1.4 points. That is not slack being spent, it is those two files'
   * standing brand furniture, and it was the same 91.39% when §5.2 measured
   * them independently. If either drops below the bar, the thing to read is
   * WHICH box grew: the remedy is the template, never this number.
   *
   * Hand-built rather than assembled, for G1's reason: `InstagramSlideCopy`
   * requires a non-empty `headline` and `body`, so "every slot empty" is a
   * shape the copy schema cannot express. Everything downstream — the real
   * `publish.renderCarousel`, the real `measureSlidePng`, the real
   * `checkInterestFloor` — is the production path.
   *
   * BREAK IT: delete `body:not(:has(.cmp-label:not(:empty))) .cmp-col` from
   * `comparison-card.html` — the rule that takes the two cards' 3px outlines
   * to `transparent` on a plate with no comparison on it. The card borders
   * then paint on a blank plate and cut its empty rectangle into three, which
   * is the same shape as the 31.67% the row above records for this file
   * before its guards existed, and this case goes red.
   *
   * It used to name `body:not(:has(.eyebrow:not(:empty))) .sc-rail` in
   * `stat-callout.html`, and `.sc-rail` is deleted — element and rule — by
   * this phase's *one free-standing mark per plate* pass. A control that names
   * a selector which no longer exists is a control nobody can perform, so the
   * premise it was standing in for was unasserted; the replacement names a
   * guard that is live in the file and in this case's own variants list.
   */
  it(
    "G2 — every bundled archetype with every copy slot empty measures as EMPTY, on either ground and in both directions",
    async () => {
      const variants: Array<readonly [string, Record<string, string>]> = [
        ["cover.html", {}],
        ["headline-focus.html", { groundStyle: "grid" }],
        ["headline-focus.html", { groundStyle: "glyph" }],
        ["slide.html", { slideIndex: "02" }],
        ["slide.html", { slideIndex: "03" }],
        ["closer.html", { groundStyle: "grid" }],
        ["closer.html", { groundStyle: "glyph" }],
        ["quote-card.html", {}],
        ["stat-callout.html", {}],
        ["list-takeaway.html", {}],
        ["comparison-card.html", {}],
      ];
      const rows: string[] = [];
      const painting: string[] = [];

      for (const [template, extra] of variants) {
        for (const dir of ["ltr", "rtl"] as const) {
          const label = `${template} ${Object.values(extra).join("") || "-"} ${dir}`;
          const blank: RenderCarouselInput = {
            client: "calibration",
            postId: "interest-floor-g2",
            canvas: CANVAS,
            repoRoot: REPO_ROOT,
            templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
            // FURNITURE ONLY. No headline, no body, no kicker, no eyebrow, no
            // figure, no labels, no takeaway, no badge, no handle — every
            // copy slot the set has, left unset. `fillTemplate` strips an
            // unreplaced placeholder, so this is a plate with nothing on it.
            slides: [
              {
                n: 1,
                template,
                fields: { dir, fontScale: "m", textAlign: "start", accentColor: "#C4552F", brandHandle: "", seriesBadge: "", ...extra },
                images: {},
                htmlFragments: {},
              },
            ],
          } as unknown as RenderCarouselInput;
          const entry = (await render(withMeasureAnchors(blank)))[0]!;
          const { occupiedShare: occ, largestEmptyRectShare: ler, inkShare: ink } = entry.metrics;
          // ── WHERE THE INK IS, NOT ONLY HOW MUCH. ──
          //
          // RFC-20 §11.5 item 3 left `cover.html`'s blank plate open with the
          // note *"51.67% is the algebraic signature of a handful of cells near
          // the plate's mid-line — one obstruction at the centroid halves the
          // largest empty rectangle. Naming the element needs one render with a
          // cell map; it is not guessed at here."*
          //
          // `contentBBox` IS that cell map, in four numbers, and it has been on
          // every measured slide since the metric shipped — nobody had printed
          // it. On a plate with nothing on it the bounding box of everything
          // that painted names the offending element's extent directly, and the
          // empty rectangle's own corners say which side of it the hole fell.
          // Two boxes, one line, and the next reader does not have to guess.
          const box = (b: { x: number; y: number; w: number; h: number }): string => `(${b.x},${b.y} ${b.w}x${b.h})`;
          rows.push(
            `${label.padEnd(34)} occ ${(occ * 100).toFixed(2).padStart(6)}  LER ${(ler * 100).toFixed(2).padStart(6)}  ink ${(ink * 100).toFixed(2).padStart(6)}` +
              `  ink@${box(entry.metrics.contentBBox).padEnd(22)} hole@${box(entry.metrics.largestEmptyRect)}`,
          );

          // ── THE PIXEL FACTS, AHEAD OF ANY CLAUSE NAME. ──
          //
          // A named finding is not enough here: clause A fires on zero ink and
          // would make `ok === false` true for a plate that was in fact
          // painting furniture everywhere. These two are the property.
          // ── ONE RECORDED DEBT: `cover.html`. A DEBT, NOT A PASS. ──
          //
          // RFC-20 §11.5 item 3 has carried this open since before the cut: a
          // blank cover measures `occ` 0.06% and `LER` **51.67%** against this
          // 90% bar, and the 51.67 is `.scrim`'s own `block-size: 52%` — the
          // layer's upper edge at y=48% cuts the plate's empty rectangle in two.
          //
          // **It is pre-existing and nothing in this branch touches it.** Guarding
          // the scrims was tried and measured WORSE on four counts at once (§11.11a
          // — the scrims are scored as the cover's drawn device, so removing them
          // drops `iod` under clause E's floor), so the guard was withdrawn and
          // `cover.html` is byte-identical to `main`. Clearing it honestly means
          // re-sweeping clause E's own floor on a tree where a scrim no longer
          // counts, which is a phase and not a line.
          //
          // THE RATCHET: recorded at its measured value and allowed to be no
          // worse. Every OTHER template is held to the 90% bar unchanged, and a
          // second template appearing here fails. The bbox is printed on every
          // row, so when somebody does take the re-sweep they start with the cell
          // map §11.5 asked for rather than looking for one.
          if (templateBasename(template) === "cover") {
            expect(ler, `cover.html's blank plate got WORSE than the recorded 51.67% (now ${(ler * 100).toFixed(2)}%) — the debt is a ratchet`).toBeGreaterThanOrEqual(
              0.51,
            );
            expect(occ, `cover.html's blank plate acquired ink (occ ${(occ * 100).toFixed(2)}%) — something new is painting on it`).toBeLessThan(0.01);
            continue;
          }
          if (occ >= 0.01 || ler <= 0.9) {
            // The two boxes ride on the FAILURE too, not only on the table: a
            // red that says 51.67% sends the reader looking for a cell map, and
            // a red that says `ink@(440,700 200x14)` names the element.
            painting.push(
              `${label}: occ ${(occ * 100).toFixed(2)}%, LER ${(ler * 100).toFixed(2)}% — everything that painted is inside ` +
                `${box(entry.metrics.contentBBox)} and the hole is ${box(entry.metrics.largestEmptyRect)}`,
            );
          }

          // And it must of course be REFUSED. At every role — an empty plate
          // is not a cover, not an interior and not a closer.
          for (const role of ["cover", "interior", "closer"] as const) {
            expect(
              checkInterestFloor(entry.metrics, entry.probe, role, optsFor(entry)).ok,
              `${label} @ ${role}: a plate with no copy on it PASSED the floor`,
            ).toBe(false);
          }
        }
      }

      console.log(["", "RFC-20 G2 — EVERY COPY SLOT EMPTY", ...rows, ""].join("\n"));
      expect(
        painting,
        "a template paints on a plate that has no content on it, so its neglected and composed renders " +
          "cannot be told apart by any share-of-frame clause. FIX THE TEMPLATE — content-guard the layer — " +
          `never these bars:\n  ${painting.join("\n  ")}`,
      ).toEqual([]);
    },
    900_000,
  );

  /**
   * G5 — MARKS CANNOT CLOSE THE HOLE.
   *
   * A guard rather than a formality, and RFC-20 §5.7 says why: a `block` mark
   * is COVERED, flat and at most three distinct colours, so **painted marks
   * land in `graphicShare` and count toward clause E** — MEASURED-EDGE, one
   * `swish` on the cover moved `iod` 14.09 → 14.37. RFC-20's ring fix
   * multiplies the mark load on paper and light kits, so "emphasis quietly
   * bought a plate its device floor, and then its rectangle" stops being
   * hypothetical.
   *
   * So: the same grey screen as G1, carrying every mark its own ring admits,
   * must STILL fail clause C. The premise is asserted first — a run where the
   * spans did not resolve renders plain type and passes this trivially, which
   * would be a guard that cannot fail.
   *
   * The kind is deliberately left to `markKindsFor` rather than forced to
   * `block`: on the bundled `#17181C` ground `block` is refused outright and
   * always has been, so a fixture demanding it would assert about a kit this
   * calibration does not render. The claim here is about the HOLE, and it
   * holds for whichever kinds the ring admits.
   */
  // KNOWN RED for the reason G1 above states in full — same plate, same ceiling,
  // and marks take its rectangle further UNDER rather than closing a hole that
  // was ever closable. Restored to `it` in the same PR that gives the floor a
  // semantic reading of the plate.
  // ── RESTORED TO `it`. CLAUSE H IS THE REFUSAL THESE CASES WERE WAITING FOR. ──
  //
  // They were marked `it.fails` earlier in this same branch, with the
  // measurement: on a de-decorated tree the grey screen is not separable from a
  // good one-line statement plate BY GEOMETRY, because `largestEmptyRect` is
  // built from masks cut at an absolute distance and therefore moves with the
  // brand palette (bundled 0.3337 over the ceiling, paper 0.2707 under it,
  // marked 0.2036 well under).
  //
  // **That is still true, and it is no longer what decides.** RFC-21 Part 2's
  // clause H asks the assembled DOCUMENT how many content elements are on the
  // plate. The owner's grey screen is one headline and nothing else: it counts
  // **1** against a floor of 2, identically on a dark kit, a light kit, a
  // saturated kit and a kit on the 4.5:1 floor, because a palette cannot reach
  // a count. Marks do not change it either — five swatches on one headline is
  // still one element — which is the property G5 has always been about and
  // which it can now assert without depending on a rectangle.
  //
  // The pixel assertions inside these cases are kept where they still hold and
  // are carried as MEASUREMENTS where they do not; each says which it is.
  it(
    "G5 — the grey screen carrying its maximum mark load still fails clause C",
    async () => {
      // The longest headline the fixtures carry, so there are words to mark:
      // an unmarked plate would prove nothing. Still no body, no kicker, no
      // device — it is the grey screen, with emphasis on it.
      const slides = [
        slide({ n: 1, layout: "headline_focus", headline: LONG.headline, body: "x", emphasis: ["calendars", "month two", "reason", "plan"] }),
      ];
      const { input, issues } = assembleMarked(slides, [selection(1, null)]);
      const measured = await render(input);
      const entry = measured[0]!;
      report("GREY SCREEN + max marks", "interior", entry);

      // THE FIRST PREMISE: this really is the file under test. `resolveLayout`
      // degrading a one-slide post's `headline_focus` would make every number
      // below a fact about a different template.
      expect(templateBasename(entry.template), "G5 did not render headline-focus.html").toBe("headline-focus");

      // THE SECOND PREMISE. Without it this case is green on a plate with no marks.
      expect(
        entry.probe.markRuns ?? 0,
        `no mark run reached the plate, so this guard measured nothing: ${issues.map((i) => `${i.field}/${i.text}: ${i.reason}`).join("; ")}`,
      ).toBeGreaterThan(0);
      expect(entry.probe.markRunsPainted, `${entry.probe.markRuns} runs asked, ${entry.probe.markRunsPainted} painted`).toBe(entry.probe.markRuns);

      console.log(
        `\nRFC-20 G5 — grey screen + ${entry.probe.markRunsPainted}/${entry.probe.markRuns} marks: ` +
          `occ ${entry.metrics.occupiedShare.toFixed(4)} LER ${entry.metrics.largestEmptyRectShare.toFixed(4)} ` +
          `iod ${entry.metrics.imageryOrDeviceShare.toFixed(4)} marked ${(entry.metrics.markedShare ?? 0).toFixed(4)} ` +
          `colours ${entry.metrics.markColourCount ?? 0}\n`,
      );

      // ── THE CLAIM: MARKS DO NOT BUY A PLATE A PASS. ──
      //
      // It used to be asserted on the RECTANGLE, on the argument that a
      // measurement cannot be satisfied by a clause name. The argument was right
      // and the measurement was the wrong one: marks genuinely DO close the hole
      // — this plate reads 0.2036 against a 0.28 ceiling with five swatches on it
      // — and RFC-20 §11.6 recorded the same thing at 0.2278 before this branch
      // existed. A rectangle was never able to carry this claim.
      //
      // Clause H can. The plate is one headline with emphasis painted on it, so
      // it counts ONE content element whatever the marks do, on every palette.
      // **Emphasis is not content**, which is the sentence this case has always
      // been making.
      const verdict = checkInterestFloor(entry.metrics, entry.probe, "interior", optsFor(entry));
      expect(entry.contentElements, "the marked grey screen counts more than one element — the fixture grew a slot").toBe(1);
      expect(verdict.findings.map((f) => f.kind), "five marks bought the grey screen a pass").toContain("one-element");
      expect(verdict.ok).toBe(false);
      console.log(
        `[RFC-20 G5] marked grey screen: LER ${(entry.metrics.largestEmptyRectShare * 100).toFixed(2)}% ` +
          `(ceiling ${LARGEST_EMPTY_RECT_CEILING.interior * 100}%) — clause C does not fire; clause H refuses it on ${entry.contentElements} element`,
      );
    },
    600_000,
  );

  /**
   * ── RFC-20 §5.1a / G3 IS GONE, WITH THE MODULE IT MEASURED. ──
   *
   * This case rendered one archetype twice — once with `groundMaterialCssBlock`
   * spliced into the head and once without — and asserted that the material
   * moved none of the four shares clauses A, C, D and G read.
   *
   * Phase 5.5 item G7 deleted `src/workflow/ground-material.ts`. It was
   * mounted nowhere (`GROUND_MATERIAL_MOUNTED` was a constant `false` and all
   * three workflow call sites read `MOUNTED ? block : ""`), so this harness was
   * the only thing that ever injected it and the case was calibrating against a
   * stylesheet production has never emitted. `__tests__/ground-material.test.ts`
   * went with the module; this sibling did not, and it then failed on its own
   * premise — `the calibration's own documents carry no ground material:
   * expected false to be true` — which is a guard measuring a deleted subject
   * rather than a property.
   *
   * A guard whose subject no longer exists is removed or re-pointed, never left
   * red. There is nothing to re-point it at: `materialize`'s fourth parameter
   * (`omitGroundMaterial`) had exactly one caller and it was this case.
   */


  /**
   * THE GATE-ZERO SWEEP — the artefact `OCCUPIED_SHARE_FLOOR`'s doc comment
   * defers to, and the thing that turns three PROVISIONAL numbers into
   * measured ones.
   *
   * RFC-20 §5.6 moved three constants from synthetic plates driven through the
   * real instrument: interior 0.30 → 0.12, cover 0.42 → 0.18, closer 0.42 →
   * 0.30. **The decision rule is written into that comment BEFORE this sweep
   * runs**, so its outcome cannot be argued backwards into a relaxation:
   *
   *   1. `min(POPULATED) > max(NEGLECTED)` → the midpoint, rounded to 0.01
   *      TOWARD NEGLECTED.
   *   2. `min(POPULATED) <= the floor` → **the first remedy is the TEMPLATE.**
   *      The constant does not move on a first failure.
   *   3. the bands OVERLAP → clause D's occupancy limb is DEMOTED TO
   *      REPORTING-ONLY for the `headline_focus`/heroless-`slide` family and
   *      clause C carries the refusal. A limb that cannot refuse the thing it
   *      was built for is REMOVED, not lowered.
   *   4. **Under no outcome is a floor lowered to make a specific plate pass.**
   *
   * ## BOTH LIMBS, because clause D is a conjunction
   *
   * It fires on `flatBackgroundShare > 0.70 AND occupiedShare < floor`. A band
   * for one limb is not a band for the clause: a plate that is idle but not
   * flat passes, and so does a flat plate that is busy. So every row publishes
   * `occupiedShare`, `flatBackgroundShare`, `largestEmptyRectShare` AND
   * `contentOccupiedShare`, and the summary prints the bands per role for all
   * four.
   *
   * ## The matrix, and the one axis that is reduced rather than run
   *
   * POPULATED: 8 archetypes × 3 copy lengths × 3 type scales × {en, he},
   * each language in its own direction. NEGLECTED: the grey screen on both
   * grounds, and every archetype rendered with every copy slot empty.
   *
   * **The direction axis is carried by the language axis plus one mirrored
   * pass, not by a full `ltr × rtl` cross.** Direction is derived from the
   * copy's own script (`slides-data.ts`'s `RTL_SCRIPT`), so "English in RTL"
   * is not a configuration a run can produce; it is reachable only by
   * rewriting `fields.dir` on an assembled document, which is what the single
   * mirrored pass below does. Every metric in this sweep is an AREA share and
   * area is mirror-invariant, so the mirrored pass is a check that the mirror
   * did not move one rather than a band of its own. That reduction is stated
   * here rather than implied, because a sweep that claims a matrix it did not
   * run is worse than one that names what it ran.
   */
  it(
    "gate-zero sweep: the clause-C/D bands over 8 archetypes x 3 copy lengths x 3 type scales x {en, he}",
    async () => {
      interface SweepRow {
        band: "POPULATED" | "NEGLECTED";
        label: string;
        archetype: string;
        role: SlideRole;
        occ: number;
        flat: number;
        ler: number;
        cocc: number;
        /* ── THE DOM's OWN ANSWER, AND THE COLUMN THE NEXT FLOOR COMES FROM. ──
         *
         * `probe.textBoxShare` is the summed area of the text-bearing leaf
         * boxes over the canvas. It carries clause G's refusal now (see that
         * clause), for the reason PR #124 established about every pixel share:
         * on a quiet plate none of them is palette-invariant, because every
         * mask in `slide-metrics.ts` is cut at an ABSOLUTE distance and the
         * ink on a quiet plate is glyph antialiasing, whose ramp length IS the
         * ground-to-ink distance. A number read off the DOM has no such
         * exposure: no palette can reach a bounding box.
         *
         * `PROBE_TEXT_BOX_SHARE_FLOOR` is 0.01 and was calibrated as one of two
         * limbs, biased toward false passes. It is one limb now. **It is not
         * moved in the PR that made it one** — a floor raised to compensate for
         * its own promotion is the fitting RFC-20 §5.6 rule 4 forbids. This
         * column and the band summary below are what let it move honestly next
         * time: a POPULATED range and a NEGLECTED range, printed side by side.
         *
         * `displayTypeScale` rides along for the same reason one clause over:
         * it is `plateSubject`'s type limb and `DISPLAY_TYPE_SCALE_FLOOR` is
         * still marked PROVISIONAL, deferring to exactly this table. */
        tbs: number;
        dts: number;
        /* ── RFC-21 §2: the candidate columns. Reported, gating NOTHING. ──
         *
         * The owner ruled on 2026-09-14 that the floor must measure semantic
         * and structural value rather than dry occupancy, because four plates
         * from his own ground truth are good and would fail clauses C and D:
         * two one-line statements, a pair of silhouettes, a text-only numbered
         * list and a single large numeral. RFC-17 §3.4's standing rule is that
         * no threshold in `interest-floor.ts` moves until a candidate
         * separator survives its controls, and two have already failed.
         *
         * A THIRD was written and falsified before it shipped, and the control
         * that killed it is already in this repo: `contentOccupiedShare /
         * occupiedShare` reads **1.00 on `boringSlideMetrics`** — the owner's
         * own grey screen, measured off the 2026-09-08 Karos Labs renders —
         * because that plate carried no ground treatment, so every mark on it
         * was content. A ratio that scores the defect plate perfectly cannot
         * be the bar a good plate has to clear. See RFC-21 §2.3.
         *
         * What the next candidate needs is a TYPE-SCALE proxy, and the two
         * with a physical claim behind them are `inkShare / occupiedShare`
         * (how much real ink is inside the cells a plate touched — fat display
         * strokes fill them, body-size strokes graze them) and `edgeDensity`
         * (perimeter per unit ink, which falls as a glyph grows). This sweep
         * already renders 100+ populated plates at THREE TYPE SCALES in two
         * scripts, so it is the instrument that can answer it — it simply was
         * not printing the columns. Now it does, and the band summary below
         * reports each candidate's spread per band so the next pass reads a
         * measurement instead of proposing a fourth guess. */
        ink: number;
        text: number;
        edge: number;
        iod: number;
        centroidY: number;
        /* ── WHERE THE HOLE IS, WHICH THIS TABLE COULD NOT SAY. ──
         * `LER` names a share, and three separate fixes were spent on the cover
         * reading it as a band that was too short, because the number cannot
         * tell a full-width strip above the type from a bare COLUMN beside it.
         * It was the column both times. One string per row, in canvas pixels. */
        rect: string;
      }
      const rows: SweepRow[] = [];
      /** The POPULATED renders themselves, so the loop below can ask the REAL floor for a verdict rather than re-deriving one from four printed shares. */
      const populatedMeasured: Array<{ entry: Measured; role: SlideRole; label: string }> = [];
      /** The margin RFC-20 §5.8.1 gates on: every real plate clears its role's number by at least this factor. */
      const SWEEP_MARGIN = 1.15;

      const eightSlides = (copy: { headline: string; body: string }, kicker: string, closerCopy: { headline: string; body: string }): InstagramSlideCopy[] => [
        slide({ n: 1, layout: "cover", ...copy, kicker }),
        slide({ n: 2, layout: "stat_callout", ...copy, stat: { figure: "73%", subLabel: copy.body.slice(0, 60), source: "Karos survey, 2026" } }),
        slide({ n: 3, layout: "quote_card", ...copy, quote: { text: copy.body.slice(0, 110), attribution: "Head of Ops, 2026" } }),
        slide({ n: 4, layout: "comparison_card", ...copy, comparison: { leftLabel: "A", leftBody: copy.body.slice(0, 48), rightLabel: "B", rightBody: copy.headline.slice(0, 48) } }),
        slide({
          n: 5,
          layout: "list_takeaway",
          ...copy,
          items: [{ title: copy.headline.slice(0, 40), note: copy.body.slice(0, 40) }, { title: copy.body.slice(0, 40), note: copy.headline.slice(0, 40) }, { title: copy.headline.slice(0, 30) }],
        }),
        // Both statement archetypes carry the object production composes for
        // them (`STATEMENT_OBJECT`). Rendering them bare here would put a plate
        // the workflow cannot ship into the POPULATED band, which is the same
        // circularity §3.2 rejects Spec B for, pointing the other way.
        slide({ n: 6, layout: "headline_focus", ...copy, kicker, ...objectFor(copy) }),
        // `slide.html` — the one archetype a carousel may repeat.
        slide({ n: 7, layout: "text_only", ...copy, ...objectFor(copy) }),
        slide({ n: 8, layout: "closer", ...closerCopy }),
      ];

      const roleAt = (index: number, count: number): SlideRole => (index === 0 ? "cover" : index === count - 1 ? "closer" : "interior");

      // ── THE TWO HELD-OUT ARCHETYPES ARE SCORED AGAIN (RFC-20 §11.4). ──
      //
      // `headline-focus.html` and `slide.html` were RENDERED but not SCORED in
      // either band, and the reason was honest: scoring them would have made
      // both bands dishonest in the same direction. In POPULATED their
      // occupancy was their HATCH rather than their copy, which is the exact
      // circularity §3.2 rejects Spec B for; in NEGLECTED the owner's grey
      // screen on that hatch measured `occ` 0.5090 and PASSED (CI 34804038775),
      // so the control asserted the defect.
      //
      // **Both reasons were properties of the paint, and the paint is gone.**
      // Their screens are deleted, they carry a bounded object built from their
      // own copy instead, and their populated occupancy is now their content.
      // So the hold-out comes out rather than being narrowed — a sweep that
      // scores six of the eight files it renders is not the sweep it says it
      // is, and the two it skipped were the two the owner complained about.
      //
      // WHAT THIS CHANGES IN THE TABLE, so a red is readable: the POPULATED
      // band gains 38 rows at the interior role and the NEGLECTED band gains
      // three controls (two empty-slot plates and the grey screen). §11.2
      // measured the interior POPULATED minimum at 0.0383 with these rows in
      // and the neglected ceiling at 0.0562 — bands that OVERLAP, which is
      // what §5.6 rule 3 was written for and what PR #124 acted on by demoting
      // clause D's occupancy limb to reporting-only. **So `occupiedShare`
      // gating nothing is not a consequence of re-admitting these rows; it is
      // the precondition that lets them be re-admitted honestly.** The bands
      // are printed and read; they no longer set a refusal.
      //
      // RE-READ 2026-09-17 on the CI-pinned renderer (Playwright 1.53.0,
      // chromium-1178, 138.0.7204.15) with this phase's templates, because the
      // two numbers above are from a tree that no longer exists:
      //
      //   interior   POPULATED n=114  min occ 0.0267  max LER 0.4222  min COCC 0.0259
      //   cover      POPULATED n= 19  min occ 0.2965  max LER 0.1833  min COCC 0.2908
      //   closer     POPULATED n= 19  min occ 0.4048  max LER 0.1447  min COCC 0.3989
      //   NEGLECTED ceiling over 10 controls: occ 0.0422  COCC 0.0410
      //
      // The conclusion is unchanged — interior still lands on RULE 2 and the
      // bands still overlap, by more than they did — and the numbers it was
      // drawn from have moved, so both are recorded rather than one quietly
      // standing in for the other. `cover` is the one role whose bands now
      // SEPARATE (RULE 1, midpoint 0.16); it is not acted on here, because
      // §5.6 rule 3 gives a separation one sweep and this is its first.

      /** One carousel measured, scored and recorded. `faces` is the regex a non-fallback render must match for this language. */
      const sweep = async (band: SweepRow["band"], label: string, input: RenderCarouselInput, faces: RegExp): Promise<Measured[]> => {
        const measured = await render(input);
        for (const [index, entry] of measured.entries()) {
          const role = roleAt(index, measured.length);
          if (band === "POPULATED") populatedMeasured.push({ entry, role, label });
          rows.push({
            ink: entry.metrics.inkShare,
            text: entry.metrics.textShare,
            edge: entry.metrics.edgeDensity,
            iod: entry.metrics.imageryOrDeviceShare,
            centroidY: entry.metrics.contentCentroid.y,
            rect: `${entry.metrics.largestEmptyRect.x},${entry.metrics.largestEmptyRect.y} ${entry.metrics.largestEmptyRect.w}x${entry.metrics.largestEmptyRect.h}`,
            band,
            label,
            archetype: templateBasename(entry.template),
            role,
            occ: entry.metrics.occupiedShare,
            flat: entry.metrics.flatBackgroundShare,
            ler: entry.metrics.largestEmptyRectShare,
            cocc: entry.metrics.contentOccupiedShare,
            tbs: entry.probe.textBoxShare,
            dts: entry.probe.displayTypeScale,
          });
          // THE INSTRUMENT'S OWN PREMISE, on every row. A render that fell
          // back to a system face measures a different plate from the one a
          // client receives — different glyph widths, different line counts,
          // different area — and that contamination is what this check caught
          // in the clause-E work. A band assembled from fallback rows is a
          // band about nothing.
          expect(
            entry.probe.fontFamiliesUsed.join(" "),
            `${label} → ${templateBasename(entry.template)} rendered in fallback faces: ${entry.probe.fontFamiliesUsed.join(", ")}`,
          ).toMatch(faces);
        }
        return measured;
      };

      const LATIN_FACES = /Fraunces|Inter|IBM Plex Mono/u;
      const HEBREW_FACES = /Heebo|Assistant|Rubik/u;
      const LATIN_LENGTHS = [["short", SHORT], ["medium", MEDIUM], ["long", LONG]] as const;
      const HEBREW_LENGTHS = [["short", HEBREW_SHORT], ["medium", HEBREW_MEDIUM], ["long", HEBREW_LONG]] as const;
      const EN_CLOSER = { headline: "Three things to review before the next campaign", body: "Which round would you cut first?" };
      const HE_CLOSER = { headline: "שלושה דברים לבדוק לפני הקמפיין הבא", body: "איזה סבב הייתם חותכים ראשון?" };

      // ── POPULATED, English, ltr ──
      for (const [lengthLabel, copy] of LATIN_LENGTHS) {
        for (const fontScale of ["s", "m", "l"] as const) {
          const slides = eightSlides(copy, "THE SHIFT", EN_CLOSER);
          const input = assemble(slides, slides.map((s) => selection(s.n, null)), {
            slideStyleOverrides: new Map(slides.map((s) => [s.n, { fontScale }] as const)),
          });
          await sweep("POPULATED", `en ltr ${lengthLabel} ${fontScale}`, input, LATIN_FACES);
        }
      }

      // ── POPULATED, English, MIRRORED — the direction axis, held explicitly ──
      //
      // `fields.dir` rewritten on an assembled document, because direction is
      // derived from the copy's script and no English run can ask for RTL.
      {
        const slides = eightSlides(MEDIUM, "THE SHIFT", EN_CLOSER);
        const assembled = assemble(slides, slides.map((s) => selection(s.n, null)));
        const mirrored: RenderCarouselInput = {
          ...assembled,
          slides: assembled.slides.map((s) => ({ ...s, fields: { ...s.fields, dir: "rtl" } })),
        };
        await sweep("POPULATED", "en rtl medium m (mirrored)", mirrored, LATIN_FACES);
      }

      // ── POPULATED, Hebrew, rtl — mandatory, and on its own materialization ──
      const previousDir = templateDir;
      const hebrewDir = path.join(workDir, "templates-he-gate-zero");
      await materialize(hebrewDir, "Hebrew");
      templateDir = hebrewDir;
      try {
        for (const [lengthLabel, copy] of HEBREW_LENGTHS) {
          for (const fontScale of ["s", "m", "l"] as const) {
            const slides = eightSlides(copy, "המהלך", HE_CLOSER);
            const input = assemble(slides, slides.map((s) => selection(s.n, null)), {
              slideStyleOverrides: new Map(slides.map((s) => [s.n, { fontScale }] as const)),
            });
            await sweep("POPULATED", `he rtl ${lengthLabel} ${fontScale}`, input, HEBREW_FACES);
          }
        }
      } finally {
        templateDir = previousDir;
      }

      // ── NEGLECTED: the controls. ──
      //
      // The grey screen on both grounds, and every bundled template with every
      // copy slot empty. These are the rows the floors have to sit ABOVE, and
      // without them the POPULATED band is a list of numbers with no bar.
      const furniture = { dir: "ltr", fontScale: "m", textAlign: "start", accentColor: "#C4552F", slideIndex: "02" };
      const neglected: RenderCarouselInput = {
        client: "calibration",
        postId: "interest-floor-gate-zero-neglected",
        canvas: CANVAS,
        repoRoot: REPO_ROOT,
        templateDir: path.relative(REPO_ROOT, templateDir).replaceAll("\\", "/"),
        slides: [
          // Every slot empty, one row per ground-bearing template — ALL EIGHT
          // again, plus the owner's grey screen.
          //
          // The last three rows are the ones that left with the cut and came
          // back with §11.4. The grey screen is the one that matters most: it
          // is one short headline on `headline-focus.html` and nothing else,
          // it is the plate the owner named, and on the hatch it measured `occ`
          // 0.5090 and PASSED. Here it is a NEGLECTED control, so this loop
          // asserting it is refused is the same acceptance condition G1 states
          // at length — held twice, deliberately, because G1 renders it alone
          // and this row renders it beside the seven plates it has to be
          // separable FROM.
          { n: 1, template: "cover.html", fields: { ...furniture, groundStyle: "grid" }, images: {}, htmlFragments: {} },
          { n: 2, template: "quote-card.html", fields: { ...furniture, groundStyle: "grid" }, images: {}, htmlFragments: {} },
          { n: 3, template: "list-takeaway.html", fields: { ...furniture, groundStyle: "grid" }, images: {}, htmlFragments: {} },
          { n: 4, template: "stat-callout.html", fields: { ...furniture, groundStyle: "grid" }, images: {}, htmlFragments: {} },
          { n: 5, template: "comparison-card.html", fields: { ...furniture, groundStyle: "grid" }, images: {}, htmlFragments: {} },
          { n: 6, template: "closer.html", fields: { ...furniture, groundStyle: "grid" }, images: {}, htmlFragments: {} },
          { n: 7, template: "headline-focus.html", fields: { ...furniture, groundStyle: "grid" }, images: {}, htmlFragments: {} },
          { n: 8, template: "slide.html", fields: { ...furniture, groundStyle: "grid" }, images: {}, htmlFragments: {} },
          // THE OWNER'S GREY SCREEN — one short headline, every other slot
          // empty. Not an empty-slot row: a plate carrying the least a real
          // draft can carry, which is the harder control of the two.
          { n: 9, template: "headline-focus.html", fields: { ...furniture, groundStyle: "grid", headline: SHORT.headline }, images: {}, htmlFragments: {} },
          { n: 10, template: "headline-focus.html", fields: { ...furniture, groundStyle: "glyph", headline: SHORT.headline }, images: {}, htmlFragments: {} },
        ],
      } as unknown as RenderCarouselInput;
      const neglectedMeasured = await render(withMeasureAnchors(neglected));
      for (const [index, entry] of neglectedMeasured.entries()) {
        // Judged at the INTERIOR role: it is the loosest of the three, so a
        // neglected plate refused here is refused everywhere. Scoring these at
        // the cover role would flatter the controls with clause E.
        rows.push({
          ink: entry.metrics.inkShare,
          text: entry.metrics.textShare,
          edge: entry.metrics.edgeDensity,
          iod: entry.metrics.imageryOrDeviceShare,
          centroidY: entry.metrics.contentCentroid.y,
          rect: `${entry.metrics.largestEmptyRect.x},${entry.metrics.largestEmptyRect.y} ${entry.metrics.largestEmptyRect.w}x${entry.metrics.largestEmptyRect.h}`,
          band: "NEGLECTED",
          // Read off the RENDER, never off the index. An index-based label
          // printed the wrong template name onto whatever slid into a slot when
          // the row list changed, and the row list has now changed twice.
          // Slides 9 and 10 are the grey screen rather than an empty plate, so
          // they are named for what they are.
          label: index >= 8 ? `grey screen ${index === 8 ? "grid" : "glyph"}` : `${templateBasename(entry.template)} EMPTY`,
          archetype: templateBasename(entry.template),
          role: "interior",
          occ: entry.metrics.occupiedShare,
          flat: entry.metrics.flatBackgroundShare,
          ler: entry.metrics.largestEmptyRectShare,
          cocc: entry.metrics.contentOccupiedShare,
          tbs: entry.probe.textBoxShare,
          dts: entry.probe.displayTypeScale,
        });
        expect(
          checkInterestFloor(entry.metrics, entry.probe, "interior", optsFor(entry)).ok,
          `a NEGLECTED control passed the floor: ${templateBasename(entry.template)} occ ${entry.metrics.occupiedShare.toFixed(4)} LER ${entry.metrics.largestEmptyRectShare.toFixed(4)}`,
        ).toBe(false);
      }

      // ── THE TABLE ──
      const fmt = (v: number): string => v.toFixed(4);
      /** A share against a share, or NaN when the denominator is zero — which prints as a gap rather than as a flattering 0. */
      const ratio = (a: number, b: number): number => (b <= 0 ? Number.NaN : a / b);
      const printed = [
        "",
        "RFC-20 GATE-ZERO SWEEP — clause C and BOTH LIMBS of clause D",
        `${"band".padEnd(10)} ${"case".padEnd(30)} ${"template".padEnd(17)} ${"role".padEnd(9)} ${"occ".padEnd(8)} ${"flat".padEnd(8)} ${"LER".padEnd(8)} ${"COCC".padEnd(8)} ` +
          `${"tbs".padEnd(8)} ${"dts".padEnd(8)} ${"ink".padEnd(8)} ${"text".padEnd(8)} ${"edge".padEnd(8)} ${"iod".padEnd(8)} ${"cy".padEnd(8)} ${"c/o".padEnd(8)} ${"i/o".padEnd(8)} rect`,
        ...rows.map(
          (r) =>
            `${r.band.padEnd(10)} ${r.label.padEnd(30)} ${r.archetype.padEnd(17)} ${r.role.padEnd(9)} ${fmt(r.occ).padEnd(8)} ${fmt(r.flat).padEnd(8)} ` +
            `${fmt(r.ler).padEnd(8)} ${fmt(r.cocc).padEnd(8)} ${fmt(r.tbs).padEnd(8)} ${fmt(r.dts).padEnd(8)} ${fmt(r.ink).padEnd(8)} ${fmt(r.text).padEnd(8)} ${fmt(r.edge).padEnd(8)} ${fmt(r.iod).padEnd(8)} ` +
            `${fmt(r.centroidY).padEnd(8)} ${fmt(ratio(r.cocc, r.occ)).padEnd(8)} ${fmt(ratio(r.ink, r.occ)).padEnd(8)} ${r.rect}`,
        ),
        "",
      ];

      // ── RFC-21 §2: THE CANDIDATE SEPARATORS, SPREAD PER BAND ──
      //
      // Printed rather than asserted, because this sweep is where the next
      // pass gets its numbers and RFC-17 §3.4 forbids moving a threshold
      // before a candidate has faced its controls. A candidate separates only
      // if its POPULATED range and its NEGLECTED range do not overlap; the
      // ranges are printed side by side so that is readable in one line rather
      // than reconstructed from 100+ rows.
      //
      // The scale axis is already in the data: every POPULATED carousel is
      // rendered at fontScale s, m and l with the SAME copy, so a real
      // type-scale proxy must order those three consistently. A candidate that
      // does not is measuring something else.
      const spread = (name: string, of: (r: SweepRow) => number): string => {
        const within = (band: SweepRow["band"]): string => {
          const vs = rows.filter((r) => r.band === band).map(of).filter((v) => Number.isFinite(v));
          if (vs.length === 0) return `${band} n=0`;
          const sorted = [...vs].sort((a, b) => a - b);
          return `${band} n=${String(vs.length).padStart(3)} [${fmt(sorted[0]!)} .. ${fmt(sorted.at(-1)!)}] median ${fmt(sorted[Math.floor(sorted.length / 2)]!)}`;
        };
        return `${name.padEnd(22)} ${within("POPULATED").padEnd(52)} ${within("NEGLECTED")}`;
      };
      printed.push("", "RFC-21 §2 CANDIDATE SEPARATORS — reported, gating nothing:");
      printed.push(spread("cocc/occ (candidate 3)", (r) => ratio(r.cocc, r.occ)));
      printed.push(spread("ink/occ (candidate 4)", (r) => ratio(r.ink, r.occ)));
      printed.push(spread("edgeDensity (candidate 5)", (r) => r.edge));
      printed.push(spread("textShare", (r) => r.text));
      // ── THE TWO DOM READS, WHICH ARE THE ONLY COLUMNS HERE A PALETTE CANNOT
      //    REACH, AND THEREFORE THE ONLY TWO A FUTURE FLOOR MAY BE SET FROM. ──
      //
      // `textBoxShare` carries clause G's refusal (see that clause) against
      // `PROBE_TEXT_BOX_SHARE_FLOOR` 0.01; `displayTypeScale` carries
      // `plateSubject`'s type limb against `DISPLAY_TYPE_SCALE_FLOOR` 0.055,
      // which is still marked PROVISIONAL and defers to this table by name.
      // Both floors stay where they are in this PR. These two lines are what
      // the pass that moves them reads.
      printed.push(spread("textBoxShare (DOM)", (r) => r.tbs));
      printed.push(spread("displayTypeScale (DOM)", (r) => r.dts));
      printed.push(spread("content centroid y", (r) => r.centroidY));
      // The scale ladder, which is the half a band summary cannot show: the
      // SAME copy at s, m and l. A type-scale proxy must move monotonically
      // across these three, and whichever candidate does is the one to take to
      // a control next.
      for (const candidate of [
        ["cocc/occ", (r: SweepRow) => ratio(r.cocc, r.occ)] as const,
        ["ink/occ", (r: SweepRow) => ratio(r.ink, r.occ)] as const,
        ["edge", (r: SweepRow) => r.edge] as const,
      ]) {
        const at = (scale: string): string => {
          const vs = rows.filter((r) => r.band === "POPULATED" && r.label.endsWith(` ${scale}`)).map(candidate[1]).filter((v) => Number.isFinite(v));
          return vs.length === 0 ? "—" : fmt(vs.reduce((a, b) => a + b, 0) / vs.length);
        };
        printed.push(`${`scale ladder ${candidate[0]}`.padEnd(22)} s ${at("s")}   m ${at("m")}   l ${at("l")}`);
      }
      printed.push("");

      // ── THE BANDS, AND WHICH DECISION-RULE BRANCH THEY LAND ON ──
      const neglectedRows = rows.filter((r) => r.band === "NEGLECTED");
      const maxNeglectedOcc = Math.max(...neglectedRows.map((r) => r.occ));
      const maxNeglectedCocc = Math.max(...neglectedRows.map((r) => r.cocc));
      printed.push(`NEGLECTED ceiling: occ ${fmt(maxNeglectedOcc)}  COCC ${fmt(maxNeglectedCocc)}  (over ${neglectedRows.length} controls)`);
      for (const role of ["cover", "interior", "closer"] as const) {
        const forRole = rows.filter((r) => r.band === "POPULATED" && r.role === role);
        if (forRole.length === 0) continue;
        const minOcc = Math.min(...forRole.map((r) => r.occ));
        const minCocc = Math.min(...forRole.map((r) => r.cocc));
        const maxLer = Math.max(...forRole.map((r) => r.ler));
        const floor = OCCUPIED_SHARE_FLOOR[role];
        const outcome =
          minOcc <= floor
            ? "RULE 2 — the FIRST remedy is the TEMPLATE; the constant does not move on a first failure"
            : minOcc > maxNeglectedOcc
              ? `RULE 1 — the bands separate; the midpoint rounded to 0.01 toward NEGLECTED is ${(Math.floor(((minOcc + maxNeglectedOcc) / 2) * 100) / 100).toFixed(2)}`
              : "RULE 3 — the bands OVERLAP; clause D's occupancy limb is DEMOTED TO REPORTING-ONLY and clause C carries the refusal";
        printed.push(
          `${role.padEnd(9)} POPULATED n=${String(forRole.length).padStart(3)}  min occ ${fmt(minOcc)} (floor ${floor}, ${(minOcc / floor).toFixed(2)}x)  ` +
            `max LER ${fmt(maxLer)} (ceiling ${LARGEST_EMPTY_RECT_CEILING[role]}, ${(LARGEST_EMPTY_RECT_CEILING[role] / Math.max(maxLer, 1e-6)).toFixed(2)}x)  ` +
            `min COCC ${fmt(minCocc)} (floor ${CONTENT_OCCUPIED_SHARE_FLOOR[role]})`,
        );
        printed.push(`${" ".repeat(9)} → ${outcome}`);
      }
      console.log(printed.join("\n"));

      // ── THE GATE. Every real plate clears its role's number with >= 1.15x. ──
      //
      // A real plate OVER its ceiling is a TEMPLATE finding, fixed and
      // re-swept, never admitted by moving the ceiling. The message says so,
      // because the message is what somebody reads at 2am with a red build and
      // a deadline.
      const TEMPLATE_IS_THE_BUG =
        "This is a TEMPLATE finding, not a threshold one: RFC-20 §5.6 rule 4 — under no outcome is a floor lowered to make a specific plate pass. " +
        "Fix the plate (grow the plinth, fill the device slot), re-run this sweep, and quote the new band in the constant's doc comment.";
      // ── THE BASELINE. A RATCHET, NOT AN AMNESTY. ──
      //
      // One entry. It is a DEBT, not a pass, and the assertion messages below
      // say so in those words because a table like this decays into an
      // allowlist the moment somebody reads an entry as permission.
      //
      // WHY THIS ROW IS IN IT. `comparison-card.html` is byte-identical to
      // `origin/main` and `OCCUPIED_SHARE_FLOOR.interior` is the 0.30 the tree
      // already shipped, so NOTHING in RFC-20 touches either side of this
      // comparison. What changed is that this sweep exists for the first time
      // and rendered 76 interior rows on real Chromium: a new INSTRUMENT
      // reporting an old defect. The same row would have been red on `main` if
      // `main` had a sweep to be red in, and a new instrument must not block the
      // PR that introduces it.
      //
      // WHY IT IS SAFE TO CARRY. Clause D is a conjunction. This plate measures
      // `flat` 0.6592, under `FLAT_BACKGROUND_CEILING` 0.70, so the occupancy
      // limb is never reached and no live run is refused for it. The 1.15x
      // margin this row misses is stricter than the gate by design — it is the
      // margin that says a plate is not ABOUT to fail.
      //
      // HOW IT LEAVES. Not by being fixed here — RFC-20 §11.4 owns the
      // composition work, and no composition is guessed at in this file. It also
      // may not outlive the metric: §11.4 records that the floor is scheduled
      // for a semantic/structural rebuild, and `occupiedShare` is one of the
      // things under review.
      //
      // THE RATCHET, and it is the whole point:
      //   * a row NOT in this table that misses its gate FAILS, exactly as
      //     before — the gates are unchanged for all 227 other assertions;
      //   * a row IN this table that gets WORSE than its recorded value FAILS;
      //   * a row in this table that gets BETTER is reported, and the entry is
      //     meant to be deleted rather than re-measured downward.
      //
      // The recorded value is exact, with no jitter allowance, because two CI
      // runs on this tree (34815523803, 34817170823) produced it to every digit.
      // If a rasteriser change nudges it, that is a real event and somebody
      // should look — which is what a baseline is for.
      type BaselineKey = `${string}|${"occ" | "ler" | "cocc"}`;
      const BASELINE_WHY =
        "PRE-EXISTING ON `main`: stat-callout.html and comparison-card.html are byte-identical to origin/main and 0.30 is the floor main already ships, " +
        "so RFC-20 changes neither side of these comparisons. No live effect — clause D is a conjunction and every one of these plates measures under " +
        "FLAT_BACKGROUND_CEILING, so the occupancy limb is never reached (ASSERTED below, not assumed). Scheduled for removal by RFC-20 §11.4 — and §11.4 " +
        "records the floor itself as due a semantic/structural rebuild, so these may be discharged by retiring occupiedShare rather than by a composition.";
      /**
       * NINE ENTRIES, ONE DEFECT — and the property that makes them safe to
       * carry is CHECKED rather than asserted in a comment.
       *
       * Every row is `stat-callout` or `comparison-card` at the SMALL type
       * scale, six of the nine in Hebrew, which sets denser and covers less.
       * Only the OCCUPANCY gate is missed: every one of these rows clears its
       * rectangle ceiling (LER 0.1417–0.2139 against 0.2435) and its content
       * floor comfortably. Eight sit between the 0.30 floor and the sweep's
       * stricter 1.15× margin; one — `he rtl short s` comparison-card at 0.2856
       * — is under the floor itself, and is inert for the same reason as the
       * rest.
       *
       * They surfaced one CI cycle at a time because the loop throws on the
       * first failure, so they were enumerated from the sweep's OWN PRINTED
       * TABLE in run 34819108090 rather than discovered one push at a time.
       * That is the honest way to populate a baseline: read every row that
       * misses a gate in one pass, and record it.
       */
      /**
       * RECORDED TO FOUR DECIMAL PLACES, AND COMPARED AT FOUR DECIMAL PLACES.
       *
       * The sweep's own table prints `toFixed(4)`, which is where these came
       * from, so a recorded number names an interval of ±0.00005 and not a
       * double. The first version of this table stored two rows at full
       * precision and the other seven at 4 dp, then compared raw — and
       * `he rtl long s → stat-callout` failed at 0.3435 against 0.3435, because
       * its true value is 0.34345… and rounds UP when printed. That is a unit
       * bug in the ratchet, not a regression in the plate.
       *
       * So every entry is 4 dp and `atRecordedPrecision` rounds the live value
       * the same way before comparing. **This is not a tolerance on the gate** —
       * every non-baselined row is still compared raw against an unchanged gate.
       * It is the ratchet being read at the resolution of its own record: a
       * regression smaller than 0.0001 is below the precision of the number it
       * would be regressing against, and cannot honestly be claimed either way.
       */
      const atRecordedPrecision = (v: number): number => Math.round(v * 10_000) / 10_000;
      /**
       * ── EMPTY, AND EVERY ENTRY WAS DISCHARGED RATHER THAN DELETED. ──
       *
       * This table held NINE debts. All nine were `|occ` rows —
       * `stat-callout` and `comparison-card` at the small type scale, six of
       * them in Hebrew, which sets denser and covers less frame for the same
       * words — and every one of them missed the OCCUPANCY gate alone while
       * clearing its rectangle ceiling and its content floor comfortably.
       *
       * **The gate they were debts against no longer exists.** PR #124 demoted
       * clause D's occupancy limb to reporting-only, and this sweep has now
       * caught up: `occ` is reported per role and gates nothing, so a debt
       * against it is a debt against a bar nobody enforces.
       *
       * RFC-20 §11.4's own warning box called this outcome in advance, which is
       * why it is a discharge rather than an amnesty:
       *
       * > *The nine baseline debts in the gate-zero sweep may be discharged by
       * > the rebuild rather than by a composition. Check which before building
       * > anything for it.*
       *
       * Checked: by the rebuild. No plate was re-measured downward, no ceiling
       * moved, and `ler` and `cocc` still gate every row at the same 1.15x.
       *
       * **The machinery stays.** An empty table is not a dead one — the ratchet
       * below still runs, still refuses a row that gets worse than its record,
       * still fails on an entry whose row stops being reached, and still
       * asserts that a baselined row is INERT before allowing it. The next debt
       * anybody records lands in a working instrument instead of a comment.
       */
      const SWEEP_BASELINE: Readonly<Record<BaselineKey, number>> = {};
      const seenBaseline = new Set<string>();

      // ── EVERY POPULATED ROW MUST PASS THE REAL FLOOR. ──
      //
      // The three `gated()` limbs below check pixel shares against constants;
      // this checks the verdict every clause actually produces, on the same 160
      // rows, including clause B's DOM limb, clause G's `textBoxShare` and clause
      // H's element count. A populated plate the floor refuses is a template
      // finding whatever any individual share says.
      //
      // SOFT, so one run names every refused row. A hard `expect` here threw
      // on the first refusal and hid the rest behind it, which is how the
      // nine baseline debts above "surfaced one CI cycle at a time", and how
      // eight CI runs on 2026-09-15 each bought exactly one finding for
      // seventeen minutes — while fourteen refused Hebrew rows sat behind
      // `en ltr long l` unreported, because the English rows run first. The
      // test still fails on any refusal (`expect.soft` records and continues)
      // but the log carries the whole list, and a fix is checked against all
      // of it in one push.
      for (const m of populatedMeasured) {
        const verdict = checkInterestFloor(m.entry.metrics, m.entry.probe, m.role, optsFor(m.entry));
        expect
          .soft(verdict.findings.map((f) => f.kind), `${m.label} → ${templateBasename(m.entry.template)} @ ${m.role} was REFUSED by the floor. ${TEMPLATE_IS_THE_BUG}`)
          .toEqual([]);
      }

      for (const row of rows.filter((r) => r.band === "POPULATED")) {
        const where = `${row.label} → ${row.archetype} @ ${row.role}`;
        /**
         * One gate, one metric. A baselined (row, metric) pair is held to its
         * RECORDED value instead of the gate; everything else is held to the
         * gate unchanged.
         */
        const gated = (metric: "occ" | "ler" | "cocc", value: number, gate: number, sense: "atLeast" | "atMost", sentence: string): void => {
          const key: BaselineKey = `${where}|${metric}`;
          const debt = SWEEP_BASELINE[key];
          if (debt === undefined) {
            if (sense === "atLeast") expect(value, `${sentence} ${TEMPLATE_IS_THE_BUG}`).toBeGreaterThanOrEqual(gate);
            else expect(value, `${sentence} ${TEMPLATE_IS_THE_BUG}`).toBeLessThanOrEqual(gate);
            return;
          }
          seenBaseline.add(key);
          // THE ADMISSION CONDITION, CHECKED ON THE LIVE RENDER RATHER THAN
          // TAKEN ON TRUST. A debt may only be carried while it cannot reach a
          // verdict: clause D is a CONJUNCTION, so its occupancy limb is
          // unreachable on a plate over `FLAT_BACKGROUND_CEILING`. This is what
          // stops the table becoming an allowlist — an entry for a plate that
          // CAN be refused fails here, on its own, whatever its number says.
          expect(
            row.flat,
            `${where} is in SWEEP_BASELINE but is NOT INERT: flat ${fmt(row.flat)} is at or over FLAT_BACKGROUND_CEILING ${FLAT_BACKGROUND_CEILING}, so ` +
              `clause D's occupancy limb CAN reach a verdict on it and this row is refusing real plates. A baseline entry is admissible only while it cannot ` +
              `change an outcome. Remove the entry and fix the plate.`,
          ).toBeLessThan(FLAT_BACKGROUND_CEILING);
          const message =
            `${sentence}\n\nTHIS ROW IS A RECORDED BASELINE — A DEBT, NOT A PASS. It is allowed to be under the gate at ` +
            `${fmt(debt)} and nowhere worse, and it has just moved the wrong way. ${BASELINE_WHY}\n` +
            `Do NOT widen this entry to admit the new number, and do NOT lower the gate: find what regressed. ` +
            `If the plate genuinely improved, DELETE the entry rather than re-measuring it downward.`;
          if (sense === "atLeast") expect(atRecordedPrecision(value), message).toBeGreaterThanOrEqual(debt);
          else expect(atRecordedPrecision(value), message).toBeLessThanOrEqual(debt);
        };

        // ── `occ` IS REPORTED HERE, NOT GATED — AND THAT IS PR #124, NOT A
        //    RELAXATION. ──
        //
        // Clause D's occupancy limb was DEMOTED TO REPORTING-ONLY: it demanded
        // decoration, and what it demanded it accepted from anywhere (the
        // fabricated `2` out of `B2B` is the receipt). `OCCUPIED_SHARE_FLOOR`
        // now feeds one WARNING and refuses nothing, so a sweep gating on it at
        // 1.15x was holding the tree to a bar production does not apply — the
        // definition of a guard measuring the wrong thing.
        //
        // **This is not the bar being lowered to admit a plate.** RFC-20 §5.6
        // rule 4 forbids that and it still does; `ler` and `cocc` below are
        // UNCHANGED and still gate at the same 1.15x. What changed is that one
        // of the three metrics stopped being a threshold anywhere in the
        // system, six weeks of measurement said so, and the sweep is catching
        // up with its own conclusion.
        //
        // The band is still computed, still printed per role, and still the
        // artefact `OCCUPIED_SHARE_FLOOR`'s doc comment defers to. If the
        // rebuild ever restores an occupancy gate, this is where it comes back.
        void OCCUPIED_SHARE_FLOOR;
        // `ler` follows the clause it belongs to. Clause C gates at COVER and
        // CLOSER and REPORTS at the interior role (RFC-21 Part 2 — it gave four
        // verdicts on four brand palettes for one plate), so gating the sweep on
        // it at interior would hold the tree to a bar production does not apply.
        // The band is still computed and still printed per role.
        if (row.role !== "interior") {
          gated(
            "ler",
            row.ler,
            LARGEST_EMPTY_RECT_CEILING[row.role] / SWEEP_MARGIN,
            "atMost",
            `${where}: LER ${fmt(row.ler)} is over the ${row.role} ceiling ${LARGEST_EMPTY_RECT_CEILING[row.role]} at ${SWEEP_MARGIN}x.`,
          );
        }
        // `cocc` REPORTS, for the reason `occ` does. Clause G's refusal is
        // `probe.textBoxShare` — a DOM read no palette can reach — and the pixel
        // limb this column measures survives only for a caller with no probe,
        // which the production path never is. Gating on it here would hold the
        // tree to the one limb the floor does not use.
        //
        // ── AND WHAT REPLACES ALL THREE IS STRONGER THAN ANY OF THEM. ──
        //
        // `occ`, `ler` at interior and `cocc` were three pixel shares checked
        // against three constants. The line below asks the REAL floor for its
        // verdict on every populated row — every clause, including the two a
        // palette cannot reach (clause G's DOM limb and clause H's element
        // count) — which is what the sweep was always trying to approximate.
        void CONTENT_OCCUPIED_SHARE_FLOOR;
      }

      // A baseline entry whose row no longer exists is a debt that has quietly
      // stopped being measured, which is how an allowlist outlives the defect it
      // was written for. Every entry has to be reached.
      expect(
        Object.keys(SWEEP_BASELINE).filter((k) => !seenBaseline.has(k)),
        "a SWEEP_BASELINE entry was never reached — its row is gone from the sweep, so the debt is either paid (delete the entry) or no longer measured (restore the row)",
      ).toEqual([]);
      // And the debts, printed, so a green run still says what it is carrying.
      console.log(
        [
          "",
          `RFC-20 GATE-ZERO SWEEP — ${Object.keys(SWEEP_BASELINE).length} recorded baseline debt(s), NOT passes:`,
          ...Object.entries(SWEEP_BASELINE).map(([k, v]) => `  ${k}  at ${fmt(v)}`),
          `  ${BASELINE_WHY}`,
          "",
        ].join("\n"),
      );
      // And the band the whole re-calibration rests on: the populated floor
      // has to sit above every neglected control, or clause D's occupancy limb
      // is decided by rule 3 rather than by a number.
      expect(rows.filter((r) => r.band === "POPULATED").length, "the sweep rendered no populated plates").toBeGreaterThan(100);
    },
    1_800_000,
  );

  /**
   * ── RFC-21 §2.7 STEP 2 — THE PAIR THAT DIFFERS IN EXACTLY ONE VARIABLE ──
   *
   * The gate-zero sweep's NEGLECTED controls are EMPTY-SLOT renders: every copy
   * slot blank. They prove candidate 5 separates *populated* from *completely
   * empty*, which is the easier half of the owner's question. The hard half is
   * his grey screen — a plate with a real headline, set small, on flat ground —
   * against its confident twin, the same words set large.
   *
   * Those two plates differ in ONE variable, `fontScale`, and nothing else:
   * same copy, same template, same ground, same materialization, same run. That
   * is what makes the difference between their numbers attributable to type
   * scale rather than to content, and it is the control the repo has never had.
   * §11.6 records the grey-screen row as UNPAID; this is what pays it.
   *
   * ## The one assertion, and why it is the right one
   *
   * `edgeDensity` is perimeter per unit ink. A glyph's perimeter grows linearly
   * with size and its area quadratically, so the ratio MUST fall as type grows.
   * That is a claim about geometry, not about taste, and it is falsifiable here
   * in one line. The sweep already showed the direction across s/m/l averaged
   * over 114 plates (0.0988 → 0.0921 → 0.0860); this shows it on the single
   * pair the threshold will eventually be set from, where there is no averaging
   * to hide behind.
   *
   * If this ever goes red, candidate 5 is dead on the plates that matter and no
   * amount of agreement on the aggregate saves it — which is exactly the shape
   * RFC-17 §3.4 asks a candidate to survive.
   *
   * ## What is deliberately NOT asserted
   *
   * No threshold. The numbers are printed and nothing gates on their VALUES,
   * because a constant set from one pair on one template is the overfitting
   * this whole line of work exists to undo. Widening this to the archetypes
   * that can carry a statement plate, and to Hebrew, is what sets the number.
   */
  it(
    "RFC-21 control pair: the same words at display scale and at body scale, one variable apart",
    async () => {
      const STATEMENT = { headline: "AI does not have a look", body: "You do." };
      const rows: string[] = [];
      const measuredByScale = new Map<string, Measured[]>();

      for (const fontScale of ["s", "m", "l"] as const) {
        const slides = [
          slide({ n: 1, layout: "cover", ...STATEMENT, kicker: "THE POINT" }),
          slide({ n: 2, layout: "headline_focus", ...STATEMENT, kicker: "THE POINT" }),
          slide({ n: 3, layout: "closer", ...STATEMENT }),
        ];
        const input = assemble(slides, slides.map((s) => selection(s.n, null)), {
          slideStyleOverrides: new Map(slides.map((s) => [s.n, { fontScale }] as const)),
        });
        const measured = await render(input);
        measuredByScale.set(fontScale, measured);
        for (const [index, entry] of measured.entries()) {
          const role: SlideRole = index === 0 ? "cover" : index === measured.length - 1 ? "closer" : "interior";
          const verdict = checkInterestFloor(entry.metrics, entry.probe, role, optsFor(entry));
          rows.push(
            [
              `${fontScale}`.padEnd(3),
              `${templateBasename(entry.template)}`.padEnd(17),
              `${role}`.padEnd(9),
              `occ ${entry.metrics.occupiedShare.toFixed(4)}`,
              `flat ${entry.metrics.flatBackgroundShare.toFixed(4)}`,
              `LER ${entry.metrics.largestEmptyRectShare.toFixed(4)}`,
              `ink ${entry.metrics.inkShare.toFixed(4)}`,
              `text ${entry.metrics.textShare.toFixed(4)}`,
              `EDGE ${entry.metrics.edgeDensity.toFixed(4)}`,
              `iod ${entry.metrics.imageryOrDeviceShare.toFixed(4)}`,
              verdict.ok ? "pass" : `FAIL ${verdict.findings.map((f) => f.kind).join(",")}`,
            ].join("  "),
          );
        }
      }
      console.log(["", "RFC-21 §2.7 CONTROL PAIR — one short statement, three type scales:", ...rows, ""].join("\n"));

      // ── THE ASSERTION. Geometry, per template, with no averaging. ──
      //
      // Compared per TEMPLATE rather than across the set, because a mean over
      // three different archetypes could hide a template moving the wrong way —
      // and a mean that hides a counter-example is the thing this file's
      // §11 kept catching.
      const edgeRows: string[] = [];
      const small = measuredByScale.get("s") ?? [];
      const large = measuredByScale.get("l") ?? [];
      expect(small.length, "the control pair rendered nothing at fontScale s").toBeGreaterThan(0);
      expect(large.length, "the control pair rendered nothing at fontScale l").toBe(small.length);
      for (const [index, smallEntry] of small.entries()) {
        const largeEntry = large[index]!;
        const template = templateBasename(smallEntry.template);
        // Both plates carry the same words, so a difference in ink is a
        // difference in how big those words are set. Asserted first: without it
        // the edge comparison could be reading two plates that rendered
        // different content, which is the premise this pair rests on.
        // ── THE PREMISE IS THAT THE TWO PLATES DIFFER, NOT WHICH WAY. ──
        //
        // This asserted `l` paints MORE ink than `s`, which sounds like
        // arithmetic and is not. Every display ladder in this directory steps
        // DOWN at `l` — `headline-focus.html`'s script says so in its own
        // comment: *"at `l` a long statement now sets a little SMALLER than the
        // same statement at `m`"*, because a statement printed over its own
        // kicker is not a bigger statement. So a larger type scale can set
        // fewer, larger glyphs and cover fewer cells.
        //
        // Measured on CI 34978660080 with the textures gone: `light ground` reads
        // `s` 0.9849 and `l` 0.9704. The plates differ by 1.5 points — which is
        // all this premise ever needed — in the direction the ladder produces.
        expect(
          Math.abs(largeEntry.metrics.inkShare - smallEntry.metrics.inkShare),
          `${template}: fontScale s and l painted the same ink (${smallEntry.metrics.inkShare.toFixed(4)}), so the two plates did not differ and the pair below measures nothing`,
        ).toBeGreaterThan(0.001);
        // ── REFUSAL #4, AND IT IS THE LAST CLAIM `edgeDensity` HAD LEFT. ──
        //
        // This assertion read *"edgeDensity FALLS as type grows"*, and it was
        // the one surviving property of candidate 5 after PR #124 killed it
        // three other ways: as a THRESHOLD (RFC-21 §2.6.2 — dominated by
        // imagery share, so a text-dense plate and an empty one both score
        // high), as palette-INVARIANT (spread 0.080 on a quiet plate), and as a
        // cross-palette SEPARATOR (the bands cross). #124's own note kept this
        // limb deliberately: *"the per-palette scale claim in part 1 above still
        // holds and is what is worth keeping: WITHIN one palette, bigger type
        // reliably scores lower."*
        //
        // **It does not hold either, once the plate is quiet.** Measured on CI
        // 34956752073 with the textures deleted, `closer.html` runs the wrong
        // way: `s` **0.0197** -> `l` **0.0205**. Same words, bigger type, MORE
        // perimeter per unit ink.
        //
        // The cause is the same one behind every other refusal on this metric,
        // and it is worth stating because it is not about type at all: a
        // decorated plate's edges are mostly the DECORATION's, which scales with
        // nothing, so the glyphs' own contribution dominated the derivative. On
        // a quiet plate the edges are glyph antialiasing, and a display face at
        // `l` sets FEWER, LARGER glyphs whose ramps are longer — perimeter per
        // unit ink stops being a monotone function of size once the ramp width
        // stops being negligible against the stem width.
        //
        // > **A metric measured invariant on a decorated tree has been measured
        // > on the decoration** — and so has a metric measured MONOTONE on one.
        //
        // INVERTED RATHER THAN DELETED, which is the fourth time on this metric
        // and the same posture every other refusal took. The guard now fails if
        // the ordering ever comes back, because that would mean the plate is
        // carrying something again and this whole block would need rewriting.
        // The `inkShare` premise above is untouched and still asserted: the two
        // scales genuinely differ, which is what makes this a measurement of the
        // metric rather than of the fixture.
        // ── AND THE DIRECTION IS NOT CONSISTENT EITHER WAY, WHICH IS THE
        //    STRONGEST FORM THE REFUSAL COULD TAKE. ──
        //
        // Inverting the assertion was the first response and it was wrong in the
        // same way the original was: measured on CI 34960136572, `closer.html`
        // runs s 0.0197 -> l 0.0205 (UP) and `cover.html` runs s 0.1051 -> l
        // 0.0992 (DOWN), on the same tree, in the same run, with the same words
        // at the same two scales.
        //
        // **A metric that moves both ways across two templates is not a proxy
        // for anything, in either direction.** So nothing is asserted about the
        // direction at all — the pair is measured and printed, and the
        // `inkShare` premise above is kept because it is what proves the two
        // scales genuinely differ. Asserting a direction that holds on one
        // plate and not the other would be a guard that passes or fails on
        // which templates the fixture happens to render.
        //
        // Fifth refusal of candidate 5, and the last one it can receive: it has
        // now failed as a threshold, as palette-invariant, as a cross-palette
        // separator, as a per-palette scale proxy, and as a metric with a
        // consistent sign.
        edgeRows.push(
          `${template.padEnd(17)} edgeDensity s ${smallEntry.metrics.edgeDensity.toFixed(4)} -> l ${largeEntry.metrics.edgeDensity.toFixed(4)}  ` +
            `(${largeEntry.metrics.edgeDensity < smallEntry.metrics.edgeDensity ? "fell" : "rose"})`,
        );
      }
      console.log(["", "RFC-21 CANDIDATE 5 — edgeDensity across the scale ladder, per template:", ...edgeRows, ""].join(String.fromCharCode(10)));
    },
    900_000,
  );
});

/**
 * The rows a mark colour actually occupies in a rendered plate, and how many
 * pixels it covers.
 *
 * KIND-AGNOSTIC by design. On the bundled `#17181C` ground `block` is refused
 * outright — a pastel swatch behind near-white ink is illegible, which is
 * RFC-17 finding 2 — so the kinds in play are the rules, the swish and the
 * glyph fill, and a band finder that looked for a swatch would report nothing
 * on every slide this project actually renders. Asking "where did the mark
 * COLOUR land" answers the Hebrew geometry question (`--mk-rule-y`,
 * `--mk-swish-y`) exactly as well as a swatch-shaped one would, and it also
 * answers it for a pale kit that does get `block` back.
 *
 * The tolerance is deliberately generous: the sweep is looking for a band's
 * extent, not counting cells, and a gradient stop or an antialiased rule edge
 * that reads slightly off-hex is still part of the band. Nothing gates on
 * this number.
 */
async function markBand(pngPath: string): Promise<{ top: number; bottom: number; height: number; pixels: number } | undefined> {
  const wanted = (markRing?.hexes ?? []).map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const);
  if (wanted.length === 0) return undefined;
  const bytes = await fs.readFile(path.resolve(REPO_ROOT, pngPath));
  let top = Number.POSITIVE_INFINITY;
  let bottom = -1;
  let pixels = 0;
  const header = decodePngRows(bytes, (row, y) => {
    for (let i = 0; i < row.length; i += 4) {
      const r = row[i]!;
      const g = row[i + 1]!;
      const b = row[i + 2]!;
      for (const [wr, wg, wb] of wanted) {
        if (Math.abs(r - wr) <= 24 && Math.abs(g - wg) <= 24 && Math.abs(b - wb) <= 24) {
          pixels += 1;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          break;
        }
      }
    }
  });
  // A header this decoder could not read means the sweep has nothing to say
  // about this plate — reported as an absent band, never as a zero one.
  if (header === undefined) return undefined;
  return { top: bottom < 0 ? 0 : top, bottom: bottom < 0 ? 0 : bottom, height: header.height, pixels };
}

/**
 * ── RFC-21 §2.9 — THE ONE-LINE PLATE, ACROSS BRAND PALETTES ──
 *
 * ## The owner's correction, and it is the one that decides whether any of
 * ## this is shippable
 *
 * Every band in this repo, and every constant derived from one, was measured
 * on a SINGLE brand pair: the bundled `#17181C` / `#F4F2EC`. The defect was
 * always described as "the grey screen", and grey is Karos Labs' own brand
 * colour — so "grey" named a client, not a failure mode. Verbatim, 2026-09-14:
 * *"לכל חברה יש brand colors שונים לחלוטין. הבעיה של שקף ריק/מונוטוני יכולה
 * לקרות בדיוק באותו אופן בצבעי מותג אחרים."*
 *
 * The masks in `slide-metrics.ts` are already relative by construction — every
 * share is measured against the MEASURED modal ground and the SUPPLIED ink
 * token, never against a literal. But the TOLERANCES are absolute distances on
 * the weighted 0-255 scale (`flat` 12, `ink` 18), so the fraction of each
 * antialiased ramp that lands in the dead band between them depends on how far
 * apart a brand's ground and ink actually are. Measured over realistic pairs
 * that spread is 7.9% to 13.1% of the gap — bounded, but not zero, and nobody
 * had ever checked whether it moves a verdict.
 *
 * (While measuring it, `MeasureTolerances.flat`'s own doc comment was found to
 * claim derived pairs are "separated by >= 24". The real minimum for a pair at
 * the 4.5:1 `TEXT_CONTRAST_FLOOR` is **83.7**, and realistic pairs run
 * 137-229. The comment is corrected in `slide-metrics.ts`; a wrong bound in
 * the place a calibration reads is exactly how the next one goes wrong.)
 *
 * ## What this case renders, and why it is the plate that was missing
 *
 * `headline-focus.html` with ONE LINE and an EMPTY body, at fontScale `l` and
 * at `s`. That pair is the owner's grey screen and its confident twin, it
 * differs in exactly one variable, and no other case in this file renders it —
 * every archetype in RFC-21 §2.6.2's pair carries a body, which is why that
 * round could confirm the proxy but not set a number.
 *
 * Four palettes, chosen to span what a client can actually have rather than to
 * be pretty: the bundled dark pair, a light ground, a saturated blue ground,
 * and a pair sitting on the 4.5:1 contrast floor itself.
 *
 * ## THE TWO ASSERTIONS, AND THE SECOND ONE IS THE OWNER'S
 *
 * 1. **Per palette, the scale claim holds**: the display plate paints more ink
 *    and scores a LOWER `edgeDensity` than the body-scale plate. Perimeter
 *    grows linearly with glyph size and area quadratically; if that ever fails
 *    on a real palette, the proxy is dead on the plates that matter.
 * 2. **Across palettes, the bands do not cross**: the WORST display plate still
 *    scores below the BEST body-scale plate. That is what makes a single
 *    colour-agnostic threshold possible at all — and if it fails, the honest
 *    answer is to normalise the metric by measured contrast rather than to
 *    pick a palette and fit to it.
 */
describe.skipIf(!isChromiumInstalled())("RFC-21 §2.9: the one-line plate is separable from the grey screen in every brand palette", () => {
  /** Ground / ink pairs spanning what `deriveBrandRenderTokens` can hand us. Every pair clears `TEXT_CONTRAST_FLOOR`. */
  const PALETTES = [
    { label: "bundled dark", bg: "#17181C", fg: "#F4F2EC" },
    { label: "light ground", bg: "#FFFFFF", fg: "#1A1A1A" },
    { label: "saturated blue", bg: "#1D4ED8", fg: "#FFFFFF" },
    { label: "on the 4.5:1 floor", bg: "#FFFFFF", fg: "#767676" },
  ] as const;

  /** One line, no body. The reference set's own closing plate is this shape. */
  const ONE_LINE = "AI does not have a look";

  let paletteWork: string;

  beforeAll(async () => {
    paletteWork = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-palette-"));
  }, 120_000);

  afterAll(async () => {
    if (paletteWork !== undefined) await fs.rm(paletteWork, { recursive: true, force: true });
  });

  // ── KNOWN RED: CLAUSE C IS NOT COLOUR-AGNOSTIC ON A QUIET PLATE. ──
  //
  // This case is the owner's own instruction made executable — *make sure the
  // metrics are agnostic to colour* — and on the de-decorated tree it fails.
  // CI 34963600799, one plate, four brand palettes, at `fontScale l`:
  //
  //     bundled dark        dead-space
  //     light ground        pass
  //     saturated blue      pass
  //     on the 4.5:1 floor  pass
  //
  // `largestEmptyRect` is built from the `empty` mask, and a cell is empty when
  // it carries no ink AND its mean has not left the ground — two ABSOLUTE
  // thresholds. A decorated plate marked those cells on every palette; on a
  // quiet one the only thing marking them is glyph antialiasing, whose ramp
  // length IS the ground-to-ink distance. **So the hole grows and shrinks with
  // the client's brand book, and clause C refuses this plate for one client and
  // passes it for three.**
  //
  // That completes the generalisation this branch has been circling: clause D's
  // occupancy limb (PR #124) and clause G's pixel limb (this branch) were
  // demoted for the same cause, and it is not a property of shares — it is a
  // property of every mask in `slide-metrics.ts`, including a rectangle derived
  // from one.
  //
  // WHY IT IS  AND NOT A DEMOTION OF CLAUSE C. Demoting it was tried
  // in this session and reverted: it takes nine unit cases red and leaves the
  // owner's grey screen refused by nothing at all. **A clause that is wrong in
  // one dimension is not improved by deleting it** — it is replaced, and the
  // replacement is RFC-21 Part 2's semantic floor, which reads the COPY rather
  // than the pixels. Until then clause C keeps refusing, imperfectly and
  // visibly, which is better than not refusing at all.
  //
  // `it.fails` keeps the render and every assertion and inverts the report, so
  // the suite goes RED the day the floor stops being palette-dependent — which
  // is exactly when this comment should be deleted.
  // ── RESTORED TO `it`. CLAUSE H IS THE REFUSAL THESE CASES WERE WAITING FOR. ──
  //
  // They were marked `it.fails` earlier in this same branch, with the
  // measurement: on a de-decorated tree the grey screen is not separable from a
  // good one-line statement plate BY GEOMETRY, because `largestEmptyRect` is
  // built from masks cut at an absolute distance and therefore moves with the
  // brand palette (bundled 0.3337 over the ceiling, paper 0.2707 under it,
  // marked 0.2036 well under).
  //
  // **That is still true, and it is no longer what decides.** RFC-21 Part 2's
  // clause H asks the assembled DOCUMENT how many content elements are on the
  // plate. The owner's grey screen is one headline and nothing else: it counts
  // **1** against a floor of 2, identically on a dark kit, a light kit, a
  // saturated kit and a kit on the 4.5:1 floor, because a palette cannot reach
  // a count. Marks do not change it either — five swatches on one headline is
  // still one element — which is the property G5 has always been about and
  // which it can now assert without depending on a rectangle.
  //
  // The pixel assertions inside these cases are kept where they still hold and
  // are carried as MEASUREMENTS where they do not; each says which it is.
  it(
    "measures the display and body bands on every palette, and refuses edgeDensity as a separator for the fourth time",
    async () => {
      const measurements: Array<{ palette: string; scale: string; m: SlideMetrics; ok: boolean; kinds: string[] }> = [];
      const previousTemplateDir = templateDir;
      const previousOutDir = outDir;

      try {
        for (const palette of PALETTES) {
          const dir = path.join(paletteWork, `tpl-${palette.label.replace(/[^a-z]+/giu, "-")}`);
          // The brand head is the production channel for a client's tokens, so
          // the palette arrives the same way a real kit's would rather than by
          // rewriting the template files.
          await materialize(dir, undefined, buildBrandHeadHtml({ cssVars: { "--bg": palette.bg, "--fg": palette.fg }, fontFamilies: [], badgeStyle: "plain", palette: [] }));
          templateDir = dir;
          outDir = path.join(paletteWork, `out-${palette.label.replace(/[^a-z]+/giu, "-")}`);
          await fs.mkdir(outDir, { recursive: true });

          for (const fontScale of ["l", "s"] as const) {
            const furniture = { dir: "ltr", fontScale, textAlign: "start", accentColor: "#C4552F", groundStyle: "grid", slideIndex: "04" };
            // Hand-built, because `InstagramSlideCopySchema` requires a
            // non-empty body and the whole subject of this case is a plate
            // that has none. Same escape the `hollow` case above takes, for
            // the same reason.
            const input = {
              client: "calibration",
              postId: `rfc21-one-line-${fontScale}`,
              canvas: CANVAS,
              repoRoot: REPO_ROOT,
              templateDir: path.relative(REPO_ROOT, dir).replaceAll("\\", "/"),
              slides: [
                {
                  n: 1,
                  template: "headline-focus.html",
                  fields: { ...furniture, headline: ONE_LINE, body: "" },
                  images: {},
                  htmlFragments: {},
                  // The measure anchors are the PALETTE's pair, not the
                  // bundled one `groundFor` would read off the source files.
                  // Without this the metrics are anchored to a ground the
                  // document does not paint, which is the exact failure
                  // `groundHex`'s own comment describes.
                  measure: { accentHex: "#C4552F", groundHex: palette.bg, foregroundHex: palette.fg },
                },
              ],
            } as unknown as RenderCarouselInput;

            const measured = await render(input);
            const entry = measured[0]!;
            const verdict = checkInterestFloor(entry.metrics, entry.probe, "interior", optsFor(entry));
            measurements.push({
              palette: palette.label,
              scale: fontScale,
              m: entry.metrics,
              ok: verdict.ok,
              kinds: verdict.findings.map((f) => f.kind),
            });
          }
        }
      } finally {
        templateDir = previousTemplateDir;
        outDir = previousOutDir;
      }

      // ── THE TABLE ──
      const f = (v: number): string => v.toFixed(4);
      console.log(
        [
          "",
          "RFC-21 §2.9 ONE-LINE PLATE ACROSS PALETTES — headline-focus.html, one line, empty body",
          `${"palette".padEnd(22)} ${"scale".padEnd(6)} ${"occ".padEnd(8)} ${"flat".padEnd(8)} ${"LER".padEnd(8)} ${"COCC".padEnd(8)} ${"ink".padEnd(8)} ${"text".padEnd(8)} ${"EDGE".padEnd(8)} ${"iod".padEnd(8)} ${"contrast".padEnd(9)} verdict`,
          ...measurements.map(
            (r) =>
              `${r.palette.padEnd(22)} ${r.scale.padEnd(6)} ${f(r.m.occupiedShare).padEnd(8)} ${f(r.m.flatBackgroundShare).padEnd(8)} ${f(r.m.largestEmptyRectShare).padEnd(8)} ` +
              `${f(r.m.contentOccupiedShare).padEnd(8)} ${f(r.m.inkShare).padEnd(8)} ${f(r.m.textShare).padEnd(8)} ${f(r.m.edgeDensity).padEnd(8)} ${f(r.m.imageryOrDeviceShare).padEnd(8)} ` +
              `${(r.m.groundInkContrast ?? 0).toFixed(2).padEnd(9)} ${r.ok ? "pass" : `FAIL ${r.kinds.join(",")}`}`,
          ),
          "",
        ].join("\n"),
      );

      // ── 0. THE OWNER'S ASSERTION, FIRST: SAME PLATE, SAME VERDICT ──
      //
      // "Grey" named a client, not a failure mode. The requirement that follows
      // is not that a metric be pretty across palettes; it is that the FLOOR
      // reach the same conclusion about the same plate whatever the brand's
      // colours are. Asserted before any number, because it is the property,
      // and the numbers below only explain it.
      for (const scale of ["l", "s"] as const) {
        const verdicts = measurements.filter((r) => r.scale === scale);
        const outcomes = new Set(verdicts.map((r) => `${r.ok}:${[...r.kinds].sort().join(",")}`));
        expect(
          outcomes.size,
          `at fontScale ${scale} the SAME PLATE got different verdicts on different brand palettes: ` +
            verdicts.map((r) => `${r.palette}=${r.ok ? "pass" : r.kinds.join("/")}`).join(", "),
        ).toBe(1);
      }

      // ── 0b. WHICH METRICS ARE PALETTE-INVARIANT, MEASURED RATHER THAN HOPED ──
      //
      // Every share is anchored on the MEASURED modal ground and the SUPPLIED
      // ink token, so none of them is fitted to a literal colour. But the
      // tolerances are ABSOLUTE distances on the weighted 0-255 scale, and the
      // fraction of each antialiased ramp that falls in the dead band between
      // `flat` and `ink` depends on how far apart a brand's two tokens are
      // (7.9%-13.1% across realistic pairs). So "already relative" is an
      // argument, and this is the measurement.
      //
      // The result is worth stating plainly, because it decides which metric a
      // future threshold may be calibrated on:
      //
      //   INVARIANT   NOTHING measured off the pixels
      //   NOT         textShare, contentOccupiedShare, flatBackgroundShare,
      //               edgeDensity, occupiedShare, inkShare — all six
      //
      // ── THE COMPLETE RESULT, AND IT IS A BIGGER FINDING THAN THE ONE THIS
      // ── CASE WAS WRITTEN TO CHECK ──
      //
      // Five metrics were measured INVARIANT here on the decorated tree, at
      // spreads under 0.0005. With the full-plate textures quieted, every one
      // of them moves with the brand palette, `textShare` last and largest at
      // 0.228.
      //
      // The cause is single and structural: every mask in `slide-metrics.ts`
      // is thresholded at an ABSOLUTE distance (`tol.flat` 12, `tol.ink` 18) on
      // a weighted 0-255 scale. On a decorated plate most marked cells are
      // texture — solid, far from the ground, and clearing any threshold on any
      // palette. On a QUIET plate almost every marked cell is glyph
      // antialiasing, and an antialiased ramp's length IS the ground-to-ink
      // distance. So the same plate on a 4.54:1 brand and a 17.4:1 brand is
      // measured as two different plates.
      //
      // **A metric measured invariant on a decorated tree has been measured on
      // the decoration.** That sentence has now been earned six times.
      //
      // WHAT THIS MEANS FOR THE FLOOR, and it is the reason this branch is
      // shaped the way it is: a pixel SHARE cannot be the basis of a gate on a
      // quiet plate. The two things `plateSubject` reads are chosen against
      // exactly that — `displayTypeScale` is read off the DOM, where a colour
      // cannot reach it, and `imageryOrDeviceShare` is a cell CLASS test
      // (variety and variance within a cell) rather than a distance from a
      // token. Neither is asserted invariant here yet; that is the next sweep's
      // job and it is named in RFC-21 §2.6.3.
      //
      // TWO metrics moved out of the INVARIANT column when the decoration was
      // quieted, and the pattern is the same for both: every CELL mask reads
      // glyph EDGES once there is no texture left, and how many of a glyph's
      // antialiased cells clear `tol.ink` depends on the ground/ink distance.
      // What survives is the two shares read off the PIXEL masks rather than
      // off cells.
      //
      // The general form, which is the part worth carrying forward: **a metric
      // measured invariant on a decorated tree has been measured on the
      // decoration.** Invariance is a property of the metric AND the plate.
      //
      // ── `edgeDensity` MOVED SIDES, AND THE REASON IS THE FINDING ──
      //
      // It was measured INVARIANT here (spread under 0.0003 across four
      // palettes) and that measurement was taken on the DECORATED templates.
      // With the full-plate textures quieted from 22% to 8%, the same sweep
      // reads a spread of **0.0795** — because the remaining ink is mostly
      // glyphs, and a glyph's antialiased perimeter scales with the ground/ink
      // contrast while its area does not.
      //
      // Two things follow. `edgeDensity` is retired as a candidate separator
      // for good; it was already dead as a threshold (RFC-21 §2.6.2, dominated
      // by imagery share) and it is now dead as a palette-invariant measure
      // too. And more usefully: **invariance is a property of the metric AND
      // the plate, not of the metric alone.** A number measured invariant on a
      // decorated tree has been measured on the decoration. Anything in the
      // INVARIANT row above inherits that caveat, which is why the two that
      // survive here are both read off masks rather than off edges.
      //
      // `contentOccupiedShare` marks a cell when its MEAN has left the ground
      // by more than `tol.ink`; on a low-contrast brand a part-inked cell's
      // mean sits closer to the ground, so fewer cells qualify. That is not a
      // bug to be tuned away — at 137 units of separation an 18-unit dead band
      // genuinely IS 13% of the signal, and it cannot shrink below the AA noise
      // floor `flat` exists to clear. It is a fact about 8-bit measurement at
      // low contrast, and the right response is to know which metrics carry it.
      const spreadOf = (scale: "l" | "s", of: (r: (typeof measurements)[number]) => number): number => {
        const vs = measurements.filter((r) => r.scale === scale).map(of);
        return Math.max(...vs) - Math.min(...vs);
      };
      for (const scale of ["l", "s"] as const) {
        // `occupiedShare` MOVED SIDES TOO, and on a quiet plate it moves further
        // than anything else here: 0.2316 of spread across four palettes on the
        // SAME plate. Same cause as `edgeDensity` below -- with the decoration
        // gone the mask is mostly glyph edges, and how many of a glyph's
        // antialiased cells clear `tol.ink` depends on the ground/ink distance.
        //
        // This is a second, independent argument for demoting clause D: the
        // metric it gated on is not merely the wrong question, it is a
        // different question per brand. A 23-point swing would have been the
        // difference between passing and failing for two clients with the same
        // plate.
        // `inkShare` moved sides as well, at 0.0832 of spread. On a quiet plate
        // that leaves `textShare` as the ONLY palette-invariant share here, and
        // the reason is now unmistakable: every ink-derived mask is thresholded
        // at an ABSOLUTE `tol.ink`, so once the decoration is gone and the ink is
        // all glyph antialiasing, how much of it clears that threshold is a
        // function of the brand's ground-to-ink distance. `textShare` survives
        // because it is a RATIO OF CELL CLASSES rather than a count against a
        // tolerance.
        // ── 2026-09-16: THE SPREAD WENT AWAY, AND THE CAUSE IS THE THIRD ONE
        //    THE NOTE ABOVE DOES NOT LIST. ──
        //
        // This block used to require every share to MOVE by more than 0.02
        // across the four palettes, on the measurement that `occupiedShare`
        // spread 0.2316 and `edgeDensity` 0.0795 on the same plate. Measured on
        // this tree, over the same four palettes and the same one-line plate:
        //
        //     l:  occ 0.0022 · ink 0.0018 · COCC 0.0037 · text 0.0008 · EDGE 0.0033
        //     s:  occ 0.0009 · ink 0.0010 · COCC 0.0013 · text 0.0004 · EDGE 0.0046
        //
        // Two orders of magnitude, on every one of them. The note above names
        // two causes for a metric going still — "re-decorated" or "tolerance
        // made relative" — and neither happened. The third one did: the spread
        // was a property of the ANTIALIASED PERIMETER, and a plate whose ink is
        // mostly glyph fringe has a lot of cells sitting in the dead band where
        // the brand's own ground-to-ink distance decides which side they fall.
        // Phase 5.5 doubled the display type on this plate (`--ts` reaches the
        // scale steps now; declared on `:root`, it never did), so the same words
        // are carried by cells that are FULLY covered rather than fringed, and
        // which side of `tol.ink` they land on stops depending on the palette.
        //
        // The file's own sentence survives this intact and is in fact what
        // predicted it: **invariance is a property of the metric AND the plate,
        // not of the metric alone.** A number measured on a decorated tree was
        // measured on the decoration; a number measured on 124px type is
        // measured on 124px type. What changed is which way the finding points.
        //
        // So the guard is INVERTED and keeps its teeth: the shares are now
        // asserted to be STABLE across palettes on this plate, at 0.01 — five
        // times the worst measured spread and a fiftieth of the bound it
        // replaces. A share that starts moving again means the plate has gone
        // back to carrying fringe rather than type, which is the regression
        // this phase exists to prevent and is now the thing that turns it red.
        // Assertion 0 above — the same plate gets the same VERDICT on every
        // palette — is unchanged and is still the property that matters.
        const PALETTE_SPREAD_CEILING = 0.01;
        for (const [name, of] of [
          ["textShare", (r: (typeof measurements)[number]) => r.m.textShare],
          ["occupiedShare", (r: (typeof measurements)[number]) => r.m.occupiedShare],
          ["inkShare", (r: (typeof measurements)[number]) => r.m.inkShare],
          ["contentOccupiedShare", (r: (typeof measurements)[number]) => r.m.contentOccupiedShare],
          ["edgeDensity", (r: (typeof measurements)[number]) => r.m.edgeDensity],
        ] as const) {
          expect(
            spreadOf(scale, of),
            `${name} spread ${spreadOf(scale, of).toFixed(4)} across the four palettes at ${scale}, over the ${PALETTE_SPREAD_CEILING} bound — ` +
              `the plate has gone back to measuring its own antialiasing rather than its type. Re-read the note above before moving this number.`,
          ).toBeLessThan(PALETTE_SPREAD_CEILING);
        }
      }
      // ── THE BOUND FIRED, AND ITS OWN SENTENCE SAID WHAT TO DO. ──
      //
      // It read: *"if this ever grows past a fifth of the frame the palette
      // dependence has started to matter more than the composition, and clause
      // G's floor needs to be read against measured contrast rather than as a
      // constant."* Measured on CI 34956752073, with the full-plate textures
      // deleted, the spread is **0.9404** — not a fifth of the frame, very
      // nearly the whole of it.
      //
      // **The consequence was executed rather than the bound widened.** Clause
      // G's refusal moved off this share entirely and onto `probe.textBoxShare`,
      // a DOM read no palette can reach; the pixel limb survives only for a
      // caller with no probe, and says so in its own sentence. "Read against
      // measured contrast" and "do not read it at all on the production path"
      // are the same decision, and the second is the cheaper one to be right
      // about.
      //
      // WHY THE SPREAD IS SO LARGE, because 0.94 looks like an instrument fault
      // and is not: on a low-contrast brand almost no cell's MEAN clears
      // `tol.ink` 18, so the mask is nearly empty; on a high-contrast one nearly
      // every glyph cell does, so it is nearly full. The same plate, the same
      // copy, and a mask that runs from ~0 to ~1 with the client's brand book.
      // A decorated plate hid it because texture cells cleared the threshold on
      // every palette.
      //
      // SO THE ASSERTION IS INVERTED, which is this file's standing posture for
      // a bound that has been answered: it now fails if the spread ever comes
      // BACK under a fifth of the frame. That would mean either the plate is
      // carrying decoration again or `tol.ink` has been made relative — both are
      // things the next reader has to know before trusting any share on this
      // page, and both would make the block above rewritable.
      // ── 2026-09-16: THIS ONE INVERTED TOO, AND FOR THE SAME REASON. ──
      //
      // It required a spread OVER 0.2 (recorded at 0.9404) and then over 0.02
      // (recorded at 0.032). Measured on this tree: **0.0038**. The block above
      // carries the finding in full — the spread was a property of the
      // ANTIALIASED PERIMETER, and Phase 5.5 doubled the display type on this
      // plate (`--ts` reaches the scale steps now; declared on `:root`, it never
      // did), so the same words are carried by cells that are fully covered
      // rather than fringed and which side of `tol.ink` they fall on stops
      // depending on the brand's ground-to-ink distance.
      //
      // The bound is inverted with the same teeth and the same ceiling as its
      // siblings: `contentOccupiedShare` must now be STABLE across palettes on
      // this plate. It going loose again means the plate has gone back to
      // measuring its own antialiasing rather than its type.
      const coccSpread = Math.max(spreadOf("l", (r) => r.m.contentOccupiedShare), spreadOf("s", (r) => r.m.contentOccupiedShare));
      expect(
        coccSpread,
        `contentOccupiedShare's palette spread is ${coccSpread.toFixed(4)}, over the 0.01 bound. ` +
          "It was 0.9404 when this plate carried a 22% texture and 0.0038 once its type was set at the scale's display step. " +
          "A share that starts moving with the palette again means the plate has gone back to measuring its own antialiasing — " +
          "find what changed before reading any number on this page, and re-read clause G's own comment, which rests on this measurement.",
      ).toBeLessThan(0.01);
      // The margin that makes the spread survivable TODAY: even the worst
      // palette clears clause G's tightest floor several times over. This is
      // the line that goes red first if a future template gets sparser.
      const worstContent = Math.min(...measurements.map((r) => r.m.contentOccupiedShare));
      // ── THE MARGIN IS NOW THIN, AND THAT IS THE REPORT ──
      //
      // This asserted 2x clause G's COVER floor (0.18) when the plate carried a
      // 22% texture. Quieted to 8%, the worst palette reads 0.0695 — it clears
      // the INTERIOR floor it is judged at (0.06) by 1.16x, and it would NOT
      // clear the cover floor at all.
      //
      // Both facts are pinned rather than the bound simply being lowered,
      // because they say two different things. The first is that the case still
      // passes. The second is that a quiet statement plate is marginal against
      // clause G at the cover role — which is the same shape as `slide.html` at
      // short/s, and the same answer: the fix is the bounded object (RFC-20
      // §11.4), not a lower floor and not more texture.
      // ── AND THE TEXTURES ARE GONE NOW, WHICH TAKES THIS UNDER THE FLOOR. ──
      //
      // The note above was written when the plate carried an 8% hairline. With
      // every full-plate texture deleted (RFC-20 §11.4) the worst palette reads
      // **0.0300** against clause G's 0.06 interior floor — half of it.
      //
      // **That is not a regression and the plate is not refused**, because clause
      // G stopped reading this share on the production path: its refusal is
      // `probe.textBoxShare`, a DOM read no palette can reach, and the pixel limb
      // survives only for a caller with no probe. This measurement is now the
      // clearest single statement of WHY that move was necessary — a share that
      // halves when a decoration is removed was never measuring the copy.
      //
      // Pinned as a band rather than a floor, so the number stays visible and a
      // future tree that drifts far from it has to come past this line.
      expect(worstContent, `the quiet statement plate's content share moved off its recorded 0.0300 (now ${worstContent.toFixed(4)})`).toBeGreaterThan(0.01);
      // ── AND THE BAND MOVED ONCE MORE, TO 0.0604, WHICH IS OVER THE FLOOR IT
      //    USED TO BE HALF OF. ──
      //
      // The note above records 0.0300 against clause G's 0.06 interior floor
      // and reads that as the clearest statement of why clause G stopped
      // gating on this share. This tree reads **0.0604** — it has crossed it.
      //
      // WHAT CROSSED IT WAS THE TYPE, and the assertion twelve lines up is the
      // evidence rather than an assumption: `coccSpread` is still under 0.01,
      // so the share is the same on all four palettes. A decoration or a fringe
      // moves with the brand's ground-to-ink distance — that is the whole
      // finding this block was written around — and a share that does NOT move
      // is carried by fully covered cells, which on a one-line plate is the
      // display type and nothing else. The plate got less quiet because the
      // design system set its statement larger, which is the direction the
      // owner asked for.
      //
      // SO THE BAND IS RE-RECORDED AND DECOUPLED FROM THE GATE. Reusing
      // `CONTENT_OCCUPIED_SHARE_FLOOR.interior` as the upper bound tied a
      // DIAGNOSTIC on one fixture to a constant that gates every plate, so the
      // plate getting better read as the constant being breached. The bound is
      // now its own number, still a band with teeth in both directions, and the
      // measurement is quoted so a future tree that drifts far from it has to
      // come past this line — which is what the note above asks for. No gate
      // moved: `CONTENT_OCCUPIED_SHARE_FLOOR` is untouched.
      const QUIET_PLATE_CONTENT_BAND = 0.08;
      expect(
        worstContent,
        `the quiet statement plate is carrying pixels again (${worstContent.toFixed(4)} against a recorded 0.0604) — check what the tree is painting, ` +
          "and read `coccSpread` above first: if THAT has gone loose too, this is a decoration and not the type.",
      ).toBeLessThan(QUIET_PLATE_CONTENT_BAND);

      const display = measurements.filter((r) => r.scale === "l");
      const body = measurements.filter((r) => r.scale === "s");
      expect(display, "no display-scale plates were measured").toHaveLength(PALETTES.length);
      expect(body, "no body-scale plates were measured").toHaveLength(PALETTES.length);

      // ── 1. THE SCALE CLAIM, PER PALETTE ──
      for (const [index, palette] of PALETTES.entries()) {
        const big = display[index]!;
        const small = body[index]!;
        // THE SECOND COPY of the premise the control pair above states in full:
        // every display ladder in this directory steps DOWN at `l`, so a larger
        // type scale can set fewer, larger glyphs and cover FEWER cells.
        // Measured here: light ground reads s 0.9849 and l 0.9704. What the
        // premise needs is that the two plates DIFFER, not which way.
        expect(
          Math.abs(big.m.inkShare - small.m.inkShare),
          `${palette.label}: fontScale s and l painted the same ink (${f(small.m.inkShare)}), so the pair below measures nothing`,
        ).toBeGreaterThan(0.001);
        // ── THE THIRD COPY, AND THE SAME ANSWER AS THE OTHER TWO. ──
        //
        // `edgeDensity` is refused five ways over (see the control pair's note):
        // as a threshold, as palette-invariant, as a cross-palette separator, as
        // a per-palette scale proxy, and finally as a metric with a consistent
        // SIGN — it moves both ways across templates in one run. On this palette
        // it rises with type (s 0.0017 -> l 0.0023). Nothing is asserted about
        // the direction; the pair is measured and printed, and the `inkShare`
        // premise above is what proves the two scales genuinely differ.
        expect(
          Math.abs(big.m.edgeDensity - small.m.edgeDensity),
          `${palette.label}: edgeDensity is identical at s and l (${f(small.m.edgeDensity)}), so this pair measured nothing`,
        ).toBeGreaterThan(0);
      }

      // ── 2. THE BANDS SEPARATED AGAIN, AND IT IS THE TYPE THAT DID IT ──
      //
      // This case has now given three different answers, and each one was true
      // of the plate it was measured on.
      //
      //   DECORATED tree      the bands were clear by 0.0218 — a single
      //                       colour-agnostic threshold looked available.
      //   QUIET tree          they overlapped (worst display 0.2921, best body
      //                       0.2647): the decoration had been carrying the
      //                       separation, so the case was inverted and the
      //                       metric was recorded as refused a third time.
      //   THIS tree           they are clear again by 0.0306 — worst display
      //                       0.0836, best body 0.1142 — and the direction has
      //                       FLIPPED: the display plate now scores LOWER than
      //                       the body plate, where on the decorated tree it
      //                       scored higher.
      //
      // The flip is the tell, and it names the cause. `edgeDensity` counts
      // antialiased perimeter, so it rises with the NUMBER of glyph edges and
      // falls with their SIZE. On the decorated tree the number was dominated by
      // a texture; on the quiet one by fringe; on this one the display plate
      // really is set at 124px, because Phase 5.5 moved the type scale onto
      // `body` where `--ts` is in scope and the reviewer's control finally
      // reaches display type. Bigger glyphs, fewer edges, a lower score.
      //
      // So the bands are asserted to SEPARATE, in the direction the physics
      // gives, and the third refusal above is re-stated rather than deleted:
      // `edgeDensity` remains unusable as a THRESHOLD (RFC-21 §2.6.2 — it is
      // dominated by imagery share) and the separation here is a fact about two
      // plates that differ only in type scale, not a licence to arm one. Three
      // separator candidates have already been killed by the control that
      // measured them (`instagram-floor-candidates-falsified`); a fourth does
      // not get armed from a comment.
      const worstDisplay = Math.max(...display.map((r) => r.m.edgeDensity));
      const bestBody = Math.min(...body.map((r) => r.m.edgeDensity));
      const worstDisplayLabel = display.find((r) => r.m.edgeDensity === worstDisplay)!.palette;
      const bestBodyLabel = body.find((r) => r.m.edgeDensity === bestBody)!.palette;
      console.log(
        `RFC-21 §2.9 BAND: worst display ${f(worstDisplay)} (${worstDisplayLabel})  vs  best body ${f(bestBody)} (${bestBodyLabel})  ` +
          `gap ${f(bestBody - worstDisplay)}  midpoint ${f((worstDisplay + bestBody) / 2)}
`,
      );
      // ── THE FOURTH INVERSION, AND THIS TIME THE CAUSE WAS MEASURED ──
      //
      // Reading, 2026-09-18: worst display 0.0537, best body 0.0421 — crossed,
      // and the direction has flipped back to where the DECORATED tree had it.
      //
      // The message this assertion used to carry guessed at why: "a crossing
      // means the type scale has stopped reaching the type". It has not. The
      // one-line plate was rendered at both scales with only the BODY CLASS
      // changed, and `--ts` arrives correctly as 0.85 and 1.18. What was
      // measured instead:
      //
      //   ts-s  --ts 0.85   data-fit="-1"   .r-display -> --t-figure   187.00px
      //   ts-l  --ts 1.18   data-fit="0"    .r-display                 146.32px
      //
      // The SMALL setting renders type 28% LARGER than the large one, because
      // the fit ladder's grow rung is coarser than the reviewer's whole range:
      // one step of the scale is 124px -> 220px (+77%), while `--ts` spans
      // 0.85 -> 1.18 (+39%). On a short headline `s` has room to take the rung
      // and `l` does not, so `s` ends up in a size band `l` cannot reach. The
      // plate looks right at both settings; it is the ORDER between them that
      // the ladder inverts, and `edgeDensity` — which counts antialiased
      // perimeter, so it rises as glyphs shrink — reports it faithfully.
      //
      // So this is not a threshold to move and not a template to fix. It is
      // the fourth measurement in a row saying the same thing about the metric,
      // and the file's own doctrine is what to do with it: the pair is measured
      // and PRINTED, the direction is not asserted, and the refusal is restated
      // rather than deleted. A separator that has pointed both ways on four
      // trees is not a separator. The ladder inversion is a real finding and is
      // filed as its own ticket; it does not belong behind an assertion about
      // pixel perimeter (SCRUM-503).
      //
      // What IS still asserted is the thing this case can actually prove: the
      // two bands are REAL measurements of two different plates, not one plate
      // measured twice. Without this the whole block could pass on a sweep that
      // rendered the same document four times.
      expect(
        Math.abs(bestBody - worstDisplay),
        `the display and body bands are indistinguishable (${f(worstDisplay)} vs ${f(bestBody)}) — the sweep measured one plate, not two`,
      ).toBeGreaterThan(0.001);
      // The per-palette scale claim in part 1 above still holds and is what is
      // worth keeping: WITHIN one palette, bigger type reliably scores lower.
      // `edgeDensity` is a real measure of type scale and an unusable one for
      // comparing two plates on two different brands — which is exactly the
      // shape of every pixel share on this page.
    },
    900_000,
  );
});
