import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { decodePngRows } from "@agent-engine/tool-common";
import { createRenderCarousel, measureSlidePng, type RenderCarouselInput, type SlideMetrics, type SlideProbe } from "@agent-engine/tool-karos-publish";
import { ACCENT_GROUND_CONTRAST_FLOOR, contrastRatio, DEFAULT_TEMPLATE_GROUND } from "../src/workflow/brand-render-tokens.js";
import { checkInterestFloor, FULL_BLEED_IMAGERY_SHARE, IMAGERY_OR_DEVICE_FLOOR, MIN_QUANTISED_COLOUR_COUNT } from "../src/workflow/interest-floor.js";
import { deviceCssBlock } from "../src/workflow/slide-devices.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import {
  DUOTONE_TINT_ALPHA,
  explainImageTreatment,
  GenerationStyleSchema,
  GRAIN_ALPHA,
  IMAGE_TREATMENT_FIELD,
  IMAGE_TREATMENT_FILTERS,
  imageTreatmentCssBlock,
  imageTreatmentFields,
  imageTreatmentVars,
  pickImageTreatment,
  resolveGenerationStyle,
  type GenerationStyle,
  type TreatmentKit,
} from "../src/workflow/style-lock.js";
import { InstagramSlideCopySchema, type ImageSelection, type InstagramCopyOutput, type InstagramSlideCopy } from "../src/workflow/types.js";
import { VisualDirectionSchema, type VisualDirection } from "../src/workflow/visual-direction.js";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * Phase 3, item S — the style lock.
 *
 * Three things are worth testing here and they are different in kind.
 *
 * The DECISION half is a ladder, so its tests are the ladder's rungs: each
 * refusal fires alone, the demotion fires instead of a drop, and the whole
 * thing is stable enough that checkpointing it and replaying it returns the
 * identical line — which is the entire promise `04k-freeze-generation-style`
 * makes to every attempt after the first.
 *
 * The COLOUR half carries the risk that actually matters. A treatment is a
 * filter over the photograph, and item L measures photographs. A grade that
 * washed a photo flat would make the interest floor fail a CORRECT slide —
 * the most expensive false positive this codebase can produce, since it costs
 * a Sonnet redraft and lands on a slide that was fine. That block runs the
 * REAL `measureSlidePng` over plates carrying the REAL filter maths from
 * Filter Effects 1, with a negative control proving the bars can fail, so the
 * claim is measured rather than asserted — and it needs no browser, so it is
 * real verification in every environment.
 *
 * The RENDERED half pins the other side of that claim: that the selectors,
 * blend modes and stacking contexts in the emitted stylesheet actually
 * deliver the grade to a document. That one needs Chromium, self-skips
 * without it, and is real verification in CI, which has one.
 */

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

/** A kit with room to move: a three-colour ring on a dark ground, the shape `deriveBrandRenderTokens` produces for a client with a real brand.json. */
const RICH_KIT: TreatmentKit = {
  cssVars: { "--bg": "#17181C", "--fg": "#F4F2EC" },
  palette: ["#E2703A", "#4FA3D1", "#F2C14E"],
  brandAccent: "#E2703A",
};

/** The same ring, but the anchor is a near-black that cannot clear the accent floor against the ground. */
const LOW_CONTRAST_KIT: TreatmentKit = {
  cssVars: { "--bg": "#17181C", "--fg": "#F4F2EC" },
  palette: ["#1E2026", "#4FA3D1"],
};

/** One mark and nothing spare — `buildAccentRing` could promote no second colour. */
const ONE_COLOUR_KIT: TreatmentKit = { cssVars: { "--bg": "#17181C", "--fg": "#F4F2EC" }, palette: ["#E2703A"] };

/** The spec's own worked example of a style-lock line. */
const DOCUMENTARY = "documentary 35 mm, single warm light source, muted terracotta and bone palette, fine grain";

const direction = (over: Partial<{ styleLock: { id: string; line: string }; treatment: string[]; forbid: string[] }> = {}) => ({
  styleLock: { id: "documentary-35mm", line: DOCUMENTARY },
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────
// The frozen line
// ─────────────────────────────────────────────────────────────────────────

describe("resolveGenerationStyle — one line, frozen once, inherited by every attempt", () => {
  it("freezes the direction's style lock, tidied but not rewritten", () => {
    const style = resolveGenerationStyle(direction(), RICH_KIT);
    expect(style.line).toBe(DOCUMENTARY);
    expect(style.id).toBe("documentary-35mm");
    expect(style.source).toBe("direction");
  });

  it("collapses whitespace and caps the line where VisualDirectionSchema caps it, so a frozen line always round-trips", () => {
    const long = `${"a very specific grade ".repeat(20)}`;
    const style = resolveGenerationStyle(direction({ styleLock: { id: "long", line: `  documentary\n\n  35 mm  ${long}` } }), RICH_KIT);
    expect(style.line).not.toMatch(/\s{2}|\n/);
    expect(style.line!.length).toBeLessThanOrEqual(200);
    expect(GenerationStyleSchema.safeParse(style).success).toBe(true);
  });

  it("is stable across attempts: a checkpoint round-trip replays the identical style", () => {
    // What `04k-freeze-generation-style` actually promises. The engine
    // checkpoints the step's return value as JSON and hands it back verbatim
    // on every later attempt and every revision round, so the assertion that
    // matters is that a re-resolve AND a JSON replay both land on the same
    // object — a clock, a random source or a Map iteration order anywhere in
    // the ladder would break exactly this.
    const first = resolveGenerationStyle(direction(), RICH_KIT);
    const second = resolveGenerationStyle(direction(), RICH_KIT);
    expect(second).toStrictEqual(first);

    const replayed = GenerationStyleSchema.parse(JSON.parse(JSON.stringify(first)));
    expect(replayed).toStrictEqual(first);
    expect(replayed.line).toBe(first.line);
    expect(replayed.treatment).toBe(first.treatment);
  });

  it("with no direction the style is absent and the run behaves exactly as it did before item S", () => {
    const style = resolveGenerationStyle(undefined, RICH_KIT);
    expect(style.line).toBeUndefined();
    expect(style.source).toBe("none");
    expect(style.treatment).toBe("none");
    expect(imageTreatmentFields(style)).toStrictEqual({});
    expect(imageTreatmentCssBlock(style)).toBe("");
  });

  it("a direction with no style lock still freezes nothing rather than inventing a line from brand tokens", () => {
    const style = resolveGenerationStyle({ treatment: ["muted, warm, filmic"] }, RICH_KIT);
    expect(style.line).toBeUndefined();
    expect(style.id).toBe("unset");
    // The treatment is still decidable from the direction's own treatment
    // lines — the grade and the generation line are two different promises.
    expect(style.treatment).toBe("warm-desaturate");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The treatment ladder
// ─────────────────────────────────────────────────────────────────────────

describe("pickImageTreatment — one treatment per client, never per slide", () => {
  it("is pure and stable for a fixed (kit, styleLock)", () => {
    const calls = Array.from({ length: 5 }, () => pickImageTreatment(RICH_KIT, DOCUMENTARY));
    expect(new Set(calls).size).toBe(1);
    expect(calls[0]).toBe("warm-desaturate");
  });

  it("reads the spec's own example line as a grade, not a duotone", () => {
    expect(pickImageTreatment(RICH_KIT, DOCUMENTARY)).toBe("warm-desaturate");
  });

  it("picks the duotone when the style asks for one and the anchor accent clears the ground", () => {
    expect(contrastRatio(RICH_KIT.palette[0]!, RICH_KIT.cssVars["--bg"]!)).toBeGreaterThanOrEqual(ACCENT_GROUND_CONTRAST_FLOOR);
    const decision = explainImageTreatment(RICH_KIT, "a muted duotone in the brand terracotta");
    expect(decision.treatment).toBe("duotone-scrim");
    expect(decision.tintHex).toBe("#E2703A");
  });

  it("REFUSES the duotone when the anchor accent fails ACCENT_GROUND_CONTRAST_FLOOR, and demotes rather than dropping", () => {
    // The gate that keeps a treatment from ever making type illegible. It
    // demotes to the gentle grade instead of `none` because the requirement
    // is that the set reads as ONE set — a quieter set still does.
    expect(contrastRatio(LOW_CONTRAST_KIT.palette[0]!, LOW_CONTRAST_KIT.cssVars["--bg"]!)).toBeLessThan(ACCENT_GROUND_CONTRAST_FLOOR);
    const decision = explainImageTreatment(LOW_CONTRAST_KIT, "a muted duotone in the brand ink");
    expect(decision.treatment).toBe("warm-desaturate");
    expect(decision.tintHex).toBeUndefined();
    expect(decision.reason).toContain("#1E2026");
    expect(decision.reason).toContain(`${ACCENT_GROUND_CONTRAST_FLOOR}:1`);
  });

  it("a one-colour kit yields none — that kit has no treatment latitude to spend", () => {
    const decision = explainImageTreatment(ONE_COLOUR_KIT, "a muted duotone, fine grain");
    expect(decision.treatment).toBe("none");
    expect(decision.reason).toContain("one-colour");
  });

  it("no kit at all yields none, and says so distinctly from the one-colour case", () => {
    const decision = explainImageTreatment(undefined, DOCUMENTARY);
    expect(decision.treatment).toBe("none");
    expect(decision.reason).toContain("no derived brand kit");
  });

  it("a style that asks for no treatment yields none — silence is not consent to grade", () => {
    expect(pickImageTreatment(RICH_KIT, "three people at a workbench, mid-morning, shot from above")).toBe("none");
    expect(pickImageTreatment(RICH_KIT, "")).toBe("none");
    expect(pickImageTreatment(RICH_KIT)).toBe("none");
  });

  it("falls back to the gentle grade when a duotone is asked for but the kit ships no usable anchor hex", () => {
    const kit: TreatmentKit = { cssVars: { "--bg": "#17181C" }, palette: ["not-a-hex", "#4FA3D1"] };
    const decision = explainImageTreatment(kit, "duotone");
    expect(decision.treatment).toBe("warm-desaturate");
    expect(decision.reason).toContain("no usable anchor accent");
  });

  it("judges legibility against the default template ground when the kit derived none", () => {
    // A client with no derived --bg still renders on #17181C, so checking
    // against nothing would be the check quietly not happening.
    const kit: TreatmentKit = { cssVars: {}, palette: ["#1E2026", "#4FA3D1"] };
    expect(contrastRatio("#1E2026", DEFAULT_TEMPLATE_GROUND)).toBeLessThan(ACCENT_GROUND_CONTRAST_FLOOR);
    expect(explainImageTreatment(kit, "duotone").treatment).toBe("warm-desaturate");
  });
});

describe("the forbid veto — this half of the pipeline is ours to obey", () => {
  it("a direction that forbids colour grading strips the treatment entirely and names the entry", () => {
    const style = resolveGenerationStyle(direction({ forbid: ["stock handshakes", "Heavy editing or colour grading"] }), RICH_KIT);
    expect(style.treatment).toBe("none");
    expect(style.treatmentReason).toContain("heavy editing");
    // The generation line is untouched: the veto is about our CSS, not about
    // what the image model is told.
    expect(style.line).toBe(DOCUMENTARY);
  });

  it("falls back to the brief's forbidden topics only when the direction carries no forbid list", () => {
    const brief = { forbidden: { topics: ["duotone treatments of client photography"], claims: [] } };
    expect(resolveGenerationStyle(direction(), RICH_KIT, brief).treatment).toBe("none");
    // With its own list present the direction wins, and item Q derives that
    // list from this same field — concatenating would double-count one
    // client's single sentence.
    expect(resolveGenerationStyle(direction({ forbid: ["stock handshakes"] }), RICH_KIT, brief).treatment).toBe("warm-desaturate");
  });

  it("does not strip a treatment over a forbidden TOPIC that merely contains an editing word", () => {
    // The regression that made every veto cue a phrase: `brief.forbidden.topics`
    // holds subject matter, and a client that will not talk about spam filters
    // has said nothing at all about its photographs.
    const brief = { forbidden: { topics: ["spam filters", "grading rubrics"], claims: [] } };
    expect(resolveGenerationStyle(direction(), RICH_KIT, brief).treatment).toBe("warm-desaturate");
  });
});

describe("the treatment cue reads the direction's treatment lines, not only the style lock", () => {
  it("a duotone written in the treatment lines wins over a subject-only style lock", () => {
    const style = resolveGenerationStyle(
      { styleLock: { id: "workbench", line: "three people at a workbench, shot from above" }, treatment: ["a muted duotone in the brand terracotta"] },
      RICH_KIT,
    );
    expect(style.treatment).toBe("duotone-scrim");
    expect(style.tintHex).toBe("#E2703A");
    // And the frozen LINE is still the style lock's, never the treatment line.
    expect(style.line).toBe("three people at a workbench, shot from above");
  });
});

describe("the seam with item Q's VisualDirection", () => {
  /**
   * `resolveGenerationStyle` declares its own narrow interfaces instead of
   * importing `visual-direction.ts`, so this is the test that keeps the
   * structural claim honest: a REAL `VisualDirection`, parsed through its own
   * schema, has to flow straight in. If item Q ever renames `styleLock`,
   * `treatment` or `forbid`, this fails here rather than silently freezing a
   * run with no style.
   */
  const realDirection: VisualDirection = VisualDirectionSchema.parse({
    version: 1,
    generatedAt: "2026-09-11T00:00:00.000Z",
    generatedBy: "instagram-art-director@1",
    subject: ["technical operators at their own desks"],
    light: ["one warm window source, no fill"],
    palette: ["terracotta", "bone"],
    treatment: ["a muted duotone in the brand terracotta, fine grain"],
    forbid: ["stock handshakes"],
    lines: Array.from({ length: 4 }, (_, i) => ({ line: `Direction line ${i + 1}.`, basis: "brand kit: --accent", confidence: "medium" })),
    styleLock: { id: "warm-documentary", line: DOCUMENTARY },
    source: "brand+brief",
    gaps: [],
  });

  it("freezes a real VisualDirection without adaptation", () => {
    const style = resolveGenerationStyle(realDirection, RICH_KIT);
    expect(style.line).toBe(DOCUMENTARY);
    expect(style.id).toBe("warm-documentary");
    // The duotone lives in the direction's `treatment` lines, which is where
    // an art director actually writes it.
    expect(style.treatment).toBe("duotone-scrim");
    expect(style.tintHex).toBe(RICH_KIT.palette[0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// What the renderer receives
// ─────────────────────────────────────────────────────────────────────────

describe("imageTreatmentFields / imageTreatmentVars — additive, and absent when nothing was selected", () => {
  it("emits no field for none, so every existing slides-data fixture stays byte-identical", () => {
    expect(imageTreatmentFields({ treatment: "none" })).toStrictEqual({});
    expect(imageTreatmentVars({ treatment: "none" })).toStrictEqual({});
  });

  it("emits the treatment id as one field, the same value on every slide", () => {
    expect(imageTreatmentFields({ treatment: "warm-desaturate" })).toStrictEqual({ [IMAGE_TREATMENT_FIELD]: "warm-desaturate" });
  });

  it("declares the filter and the grain for a grade, and adds the tint only for a duotone", () => {
    const warm = imageTreatmentVars({ treatment: "warm-desaturate" });
    expect(warm["--img-treatment"]).toBe(IMAGE_TREATMENT_FILTERS["warm-desaturate"]);
    expect(warm["--img-grain"]).toContain("repeating-conic-gradient");
    expect(warm["--img-tint"]).toBeUndefined();

    const duo = imageTreatmentVars({ treatment: "duotone-scrim", tintHex: "#E2703A" });
    expect(duo["--img-treatment"]).toBe(IMAGE_TREATMENT_FILTERS["duotone-scrim"]);
    expect(duo["--img-tint"]).toBe("#E2703A");
  });

  it("refuses a tint that is not a hex rather than splicing it into a stylesheet", () => {
    expect(imageTreatmentVars({ treatment: "duotone-scrim", tintHex: "red; } body { display: none" })["--img-tint"]).toBeUndefined();
  });
});

describe("imageTreatmentCssBlock — code-owned, asset-free, and reachable from every template", () => {
  const warm = imageTreatmentCssBlock({ treatment: "warm-desaturate" });
  const duo = imageTreatmentCssBlock({ treatment: "duotone-scrim", tintHex: "#E2703A" });

  it("is empty for none", () => {
    expect(imageTreatmentCssBlock({ treatment: "none" })).toBe("");
  });

  it("never reaches for an asset: no url() anywhere, so assertSafeMarkup's CSS rules still hold and nothing is fetched", () => {
    for (const sheet of [warm, duo]) expect(sheet).not.toMatch(/url\s*\(/i);
  });

  it("grades every rendered hero in every template through the file:// selector, and never the brand mark", () => {
    for (const sheet of [warm, duo]) {
      expect(sheet).toContain('img[src^="file://"]:not(.brand-logo)');
      expect(sheet).toContain("filter: var(--img-treatment, none);");
    }
  });

  it("paints the overlays only when a photograph actually arrived", () => {
    // An unfilled {{image:hero}} substitutes as src="" (render-carousel.ts),
    // and a 12% accent wash over a bare ground is a defect, not a grade.
    for (const sheet of [warm, duo]) expect(sheet).toContain(':has(> img[src]:not([src=""]))');
  });

  it("carries the grain at its constant, and the tint only in the duotone sheet", () => {
    expect(warm).toContain(`opacity: ${GRAIN_ALPHA}`);
    expect(warm).not.toContain("--img-tint");
    expect(duo).toContain(`opacity: ${DUOTONE_TINT_ALPHA}`);
    expect(duo).toContain("mix-blend-mode: multiply");
  });

  it("uses logical, direction-agnostic geometry only — an RTL slide is graded the same way", () => {
    // The same source scan `slide-devices-rtl.test.ts` runs over the device
    // sheet. `inset: 0` is four-sided and therefore direction-free; a
    // physical left/right here would grade a Hebrew slide off-centre.
    for (const sheet of [warm, duo]) expect(sheet).not.toMatch(/(?:^|[\s;{])(?:left|right|margin-left|margin-right|padding-left|padding-right)\s*:/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The rendered half — the risk that matters, pinned on real pixels
// ─────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SOURCE_TEMPLATE_DIR = path.resolve(__dirname, "..", "assets", "templates", "default");
const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 } as const;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * A synthetic PHOTOGRAPH: a two-axis hue ramp with an ordered dither on top,
 * 8-bit truecolour, filter None on every row.
 *
 * It has to be a real photographic plate rather than the solid magenta the
 * calibration test uses, because the two numbers under test —
 * `imageryShare` (which needs per-cell colour variety AND tonal spread) and
 * `quantisedColourCount` (which needs eight 5-bit colours each holding half a
 * percent of the frame) — are exactly the numbers a flat fill cannot produce
 * and a real photo can. Deterministic: no random source, so a failure here
 * is reproducible.
 */
function syntheticPhotograph(width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      const dither = ((x * 7 + y * 13) % 11) - 5;
      const r = Math.max(0, Math.min(255, Math.round(40 + 190 * u + dither)));
      const g = Math.max(0, Math.min(255, Math.round(30 + 170 * v + dither)));
      const b = Math.max(0, Math.min(255, Math.round(200 - 150 * ((u + v) / 2) + dither)));
      const at = rowStart + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// The grade's colour maths, measured through the REAL slide metrics
// ─────────────────────────────────────────────────────────────────────────

/**
 * The `saturate()` matrix from Filter Effects 1 (feColorMatrix type
 * "saturate"), which is what `filter: saturate(s)` is defined to be.
 */
function saturate(px: readonly [number, number, number], s: number): [number, number, number] {
  const [r, g, b] = px;
  return [
    (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
  ];
}

/** `sepia(a)`: the spec's sepia matrix interpolated `a` of the way from identity. */
function sepia(px: readonly [number, number, number], a: number): [number, number, number] {
  const [r, g, b] = px;
  const k = 1 - a;
  return [
    (0.393 + 0.607 * k) * r + (0.769 - 0.769 * k) * g + (0.189 - 0.189 * k) * b,
    (0.349 - 0.349 * k) * r + (0.686 + 0.314 * k) * g + (0.168 - 0.168 * k) * b,
    (0.272 - 0.272 * k) * r + (0.534 - 0.534 * k) * g + (0.131 + 0.869 * k) * b,
  ];
}

/** `contrast(c)`: a linear ramp about mid-grey, per Filter Effects 1. */
function contrast(px: readonly [number, number, number], c: number): [number, number, number] {
  return px.map((v) => (v / 255 - 0.5) * c * 255 + 127.5) as [number, number, number];
}

/** `mix-blend-mode: multiply` at `alpha`, per Compositing 1: Co = (1-as)*Cb + as*(Cb*Cs). */
function multiplyTint(px: readonly [number, number, number], tint: readonly [number, number, number], alpha: number): [number, number, number] {
  return px.map((v, i) => (1 - alpha) * v + alpha * ((v * tint[i]!) / 255)) as [number, number, number];
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Applies one treatment's colour maths to a pixel, exactly as the emitted CSS
 * declares it: the `filter` list in order, then the tint overlay.
 *
 * The grain layer is deliberately NOT modelled. It only ever ADDS local
 * variation, so leaving it out makes every assertion below strictly
 * conservative — the plate this measures is flatter than the one Chromium
 * paints.
 */
function applyTreatment(px: readonly [number, number, number], style: Pick<GenerationStyle, "treatment" | "tintHex">): [number, number, number] {
  if (style.treatment === "none") return [px[0], px[1], px[2]];
  if (style.treatment === "warm-desaturate") return contrast(sepia(saturate(px, 0.82), 0.06), 1.03).map(clamp255) as [number, number, number];
  const tinted = multiplyTint(saturate(px, 0.55), parseRgb(style.tintHex ?? "#E2703A"), DUOTONE_TINT_ALPHA);
  return tinted.map(clamp255) as [number, number, number];
}

function parseRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * Ten tones spanning the luminance range with real chroma on each — a
 * photograph's tonal ladder, reduced to the smallest set that can exercise
 * both numbers under test at once.
 *
 * Both numbers pull in opposite directions and a naive gradient satisfies
 * neither: `imageryShare` needs six-plus distinct colours and real spread
 * INSIDE every 4x4-design-pixel cell, while `quantisedColourCount` needs
 * eight colours that each hold half a percent of the WHOLE frame. Structured
 * texture over a small tonal ladder is what a real photograph has and what a
 * smooth ramp does not.
 */
const PHOTO_TONES: ReadonlyArray<[number, number, number]> = Array.from({ length: 10 }, (_, i) => {
  const l = 30 + i * 22;
  return [clamp255(l + 35 * Math.cos(i * 0.9)), clamp255(l + 35 * Math.cos(i * 0.9 + 2.1)), clamp255(l + 35 * Math.cos(i * 0.9 + 4.2))] as [number, number, number];
});

/** Encodes a full-bleed plate of `PHOTO_TONES`, optionally graded, as 8-bit truecolour at the design canvas. */
function encodePlate(width: number, height: number, style: Pick<GenerationStyle, "treatment" | "tintHex">): Uint8Array {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  const graded = PHOTO_TONES.map((tone) => applyTreatment(tone, style));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const tone = graded[(x * 3 + y * 5) % graded.length]!;
      const at = rowStart + 1 + x * 3;
      raw[at] = tone[0];
      raw[at + 1] = tone[1];
      raw[at + 2] = tone[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

describe("the grade does not flatten a photograph — measured, not asserted", () => {
  /**
   * The claim this block exists to falsify: a treatment that washed a photo
   * out would make item L fail a CORRECT slide, which is the most expensive
   * false positive this codebase can produce (a Sonnet redraft spent on a
   * slide that was fine).
   *
   * It runs the REAL `measureSlidePng` over plates whose pixels carry the
   * REAL filter maths from Filter Effects 1 — the same definitions Chromium
   * implements — so it is a claim about colour science, checkable anywhere,
   * with no browser. It does NOT replace the Chromium block below, which
   * pins the other half: that the selectors, blend modes and stacking
   * contexts actually deliver this grade to a rendered document.
   */
  const plates = (["none", "warm-desaturate", "duotone-scrim"] as const).map((treatment) => {
    const style = { treatment, ...(treatment === "duotone-scrim" ? { tintHex: RICH_KIT.palette[0]! } : {}) } as Pick<GenerationStyle, "treatment" | "tintHex">;
    const outcome = measureSlidePng(encodePlate(1080, 1440, style));
    return { treatment, outcome };
  });

  it.each(plates)("$treatment keeps the plate measuring as imagery", ({ treatment, outcome }) => {
    expect(outcome.ok, `${treatment} must measure`).toBe(true);
    if (!outcome.ok) return;
    // The band table the treatment constants cite — the same artefact the
    // interest-floor calibration prints, so a threshold that moves here moves
    // because a measured number said so.
    console.log(
      `${treatment.padEnd(16)} imagery ${(outcome.metrics.imageryShare * 100).toFixed(1)}%   graphic ${(outcome.metrics.graphicShare * 100).toFixed(1)}%   colours ${outcome.metrics.quantisedColourCount}   flat ${(outcome.metrics.flatBackgroundShare * 100).toFixed(1)}%`,
    );
    expect(outcome.metrics.imageryShare, `${treatment} imageryShare`).toBeGreaterThanOrEqual(FULL_BLEED_IMAGERY_SHARE);
    expect(outcome.metrics.imageryOrDeviceShare, `${treatment} imageryOrDeviceShare`).toBeGreaterThanOrEqual(IMAGERY_OR_DEVICE_FLOOR);
  });

  it.each(plates)("$treatment keeps at least eight quantised colours in the frame", ({ treatment, outcome }) => {
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Eight is item S's own bar; item L's low-colour-count warning sits at
    // MIN_QUANTISED_COLOUR_COUNT, far below, and is what a wash would trip.
    expect(outcome.metrics.quantisedColourCount, `${treatment} quantisedColourCount`).toBeGreaterThanOrEqual(8);
    expect(outcome.metrics.quantisedColourCount).toBeGreaterThan(MIN_QUANTISED_COLOUR_COUNT);
  });

  it("would catch a wash — the negative control that makes the two bars above falsifiable", () => {
    // A guard nothing can trip is not a guard. This is the treatment item S
    // is NOT allowed to be: the same plate lerped 94% toward the ground, i.e.
    // exactly the "crush it to flat monochrome" the taste rules forbid. Both
    // bars have to fail on it, or the three passing assertions above are
    // measuring nothing.
    //
    // Measured while writing this: at an 88% wash `imageryShare` had already
    // collapsed while `quantisedColourCount` still read exactly 8. So the
    // imagery bar is the sensitive one and the colour count is the backstop —
    // worth knowing before anyone ever loosens one of them alone.
    const stride = 1080 * 3;
    const raw = Buffer.alloc(1440 * (stride + 1));
    const ground = parseRgb("#17181C");
    const washed = PHOTO_TONES.map((tone) => tone.map((v, i) => clamp255(v * 0.06 + ground[i]! * 0.94)) as [number, number, number]);
    for (let y = 0; y < 1440; y++) {
      const rowStart = y * (stride + 1);
      raw[rowStart] = 0;
      for (let x = 0; x < 1080; x++) {
        const tone = washed[(x * 3 + y * 5) % washed.length]!;
        const at = rowStart + 1 + x * 3;
        raw[at] = tone[0];
        raw[at + 1] = tone[1];
        raw[at + 2] = tone[2];
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1080, 0);
    ihdr.writeUInt32BE(1440, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const outcome = measureSlidePng(
      new Uint8Array(
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          chunk("IHDR", ihdr),
          chunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
          chunk("IEND", Buffer.alloc(0)),
        ]),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.metrics.imageryShare).toBeLessThan(FULL_BLEED_IMAGERY_SHARE);
    expect(outcome.metrics.quantisedColourCount).toBeLessThan(8);
  });

  it("costs the untreated plate almost none of its colour variety", () => {
    const [base, warm, duo] = plates.map((plate) => (plate.outcome.ok ? plate.outcome.metrics : undefined));
    expect(base).toBeDefined();
    expect(warm).toBeDefined();
    expect(duo).toBeDefined();
    // The gentle grade is gentle by construction; the duotone desaturates
    // harder and is the one worth bounding. Both stay within a fifth of the
    // untreated plate's colour count — a wash would not.
    expect(warm!.quantisedColourCount).toBeGreaterThanOrEqual(Math.floor(base!.quantisedColourCount * 0.8));
    expect(duo!.quantisedColourCount).toBeGreaterThanOrEqual(Math.floor(base!.quantisedColourCount * 0.8));
  });
});

const photoSlide = (n: number): InstagramSlideCopy =>
  InstagramSlideCopySchema.parse({
    n,
    layout: "photo",
    headline: "Intake is the bottleneck",
    body: "Every queue we measured said the same thing.",
    visualNeed: "a workbench at mid-morning",
    sourceRef: "a claim",
  });

const selection = (n: number, imagePath: string): ImageSelection => ({
  n,
  imagePath,
  reason: "style-lock fixture",
  license: "CC0",
  rightsUsable: true,
  watermarkFree: true,
  claimMatch: 5,
  claimMatchReason: "style-lock fixture",
});

let workDir: string;
let outDir: string;
let heroPath: string;

/**
 * Materializes the bundled templates the way `04c-resolve-templates` does —
 * the shared device sheet AND this run's treatment sheet spliced before
 * `</head>` through the one `extraHeadHtml` channel. Rendering the raw files
 * would measure a document no client ever receives.
 */
async function materialize(dir: string, style: Pick<GenerationStyle, "treatment" | "tintHex">): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const extra = [deviceCssBlock(), imageTreatmentCssBlock(style)].filter((fragment) => fragment.length > 0).join("\n");
  for (const file of (await fs.readdir(SOURCE_TEMPLATE_DIR)).filter((f) => f.endsWith(".html"))) {
    const html = await fs.readFile(path.join(SOURCE_TEMPLATE_DIR, file), "utf8");
    await fs.writeFile(path.join(dir, file), html.replace("</head>", `${extra}\n</head>`), "utf8");
  }
}

/**
 * Renders one photo slide under the given treatment and hands back the
 * measured plate AND the PNG Chromium actually produced.
 *
 * The bytes are what make this block falsifiable. Every threshold asserted
 * below is a floor the UNTREATED plate clears too, so on their own they would
 * still pass if `imageTreatmentCssBlock`'s selectors stopped matching — a
 * template renaming `.bg`, a studio row wrapping the hero differently, the
 * `:has()` guard mis-firing on an absolute `src`, or the sheet simply not
 * being spliced. The sheet would be a no-op, every generated set would quietly
 * stop reading as one set, and nothing here would say so. A comparison against
 * the untreated render is the assertion only the CSS can satisfy.
 */
async function renderUnder(style: Pick<GenerationStyle, "treatment" | "tintHex">): Promise<{ metrics: SlideMetrics; probe: SlideProbe; png: Buffer }> {
  const templateDir = path.join(workDir, `templates-${style.treatment}`);
  await materialize(templateDir, style);
  const rel = (p: string) => path.relative(REPO_ROOT, p).replaceAll("\\", "/");

  const input: RenderCarouselInput = assembleSlidesData({
    clientSlug: "style-lock",
    postId: `treatment-${style.treatment}`,
    repoRoot: REPO_ROOT,
    brandTokens: { templateDir: rel(templateDir), slideTemplate: "slide.html", accentColor: RICH_KIT.palette[0]! },
    copy: { format: "carousel", caption: "A style-lock caption.", slides: [photoSlide(1)] } as InstagramCopyOutput,
    selections: [selection(1, rel(heroPath))],
    canvas: CANVAS,
    availableTemplates: new Set(["cover.html", "closer.html", "stat-callout.html", "quote-card.html", "comparison-card.html", "list-takeaway.html", "headline-focus.html"]),
    templateDirOverride: rel(templateDir),
  });

  const outcome = await createRenderCarousel().execute(
    { ...input, outDir: rel(outDir), measure: true, probe: true },
    { ctx: { runId: "style-lock", clientSlug: "style-lock", productId: "instagram-agent", runKind: "setup", metadata: {} } },
  );
  if (outcome.status !== "success") throw new Error(`render failed: ${JSON.stringify(outcome)}`);
  const entry = outcome.result.rendered[0];
  if (entry?.metrics === undefined || entry.probe === undefined) throw new Error("measure/probe were requested but came back empty");
  // No `mediaStore` in this test, so `persistRenderedSlide` wrote the file and
  // `path` is where. Read now: every treatment renders slide 1 into the same
  // `outDir`, so the next call overwrites it.
  return { metrics: entry.metrics, probe: entry.probe, png: await fs.readFile(entry.path) };
}

/**
 * Mean red/green/blue and mean chroma (max channel − min channel) over the
 * decoded plate.
 *
 * Chroma is the number the treatments are DEFINED to move: `warm-desaturate`
 * is `saturate(0.82) sepia(0.06) contrast(1.03)` and `duotone-scrim` is
 * `saturate(0.55)` under an accent-tinted multiply. Both must pull the mean
 * chroma of a colourful plate down. Nothing in the template, the copy or the
 * measurement can do that — only the filter.
 */
function plateStats(png: Buffer): { r: number; g: number; b: number; chroma: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let chroma = 0;
  // The row API, not `decodePngPixels`: a 2160x2880 plate is a 24.9 MB RGBA
  // buffer and three of them are alive in this test.
  const header = decodePngRows(png, (row, _y, hdr) => {
    for (let x = 0; x < hdr.width; x++) {
      const at = x * 4;
      const red = row[at]!;
      const green = row[at + 1]!;
      const blue = row[at + 2]!;
      r += red;
      g += green;
      b += blue;
      chroma += Math.max(red, green, blue) - Math.min(red, green, blue);
    }
  });
  if (header === undefined) throw new Error("the rendered plate did not decode");
  const pixels = header.width * header.height;
  return { r: r / pixels, g: g / pixels, b: b / pixels, chroma: chroma / pixels };
}

describe.skipIf(!isChromiumInstalled())("a treated photograph is still a photograph — item L must not fail a correct slide", () => {
  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-style-lock-"));
    outDir = path.join(workDir, "out");
    heroPath = path.join(workDir, "hero.png");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(heroPath, syntheticPhotograph(270, 360));
  }, 120_000);

  afterAll(async () => {
    if (workDir !== undefined) await fs.rm(workDir, { recursive: true, force: true });
  });

  it(
    "clears IMAGERY_OR_DEVICE_FLOOR and keeps its colours under BOTH treatments, and passes the interest floor",
    async () => {
      const plates: Array<{ label: string; metrics: SlideMetrics; probe: SlideProbe; png: Buffer }> = [];
      for (const style of [
        { treatment: "none" } as const,
        { treatment: "warm-desaturate" } as const,
        { treatment: "duotone-scrim", tintHex: RICH_KIT.palette[0]! } as const,
      ]) {
        const measured = await renderUnder(style);
        plates.push({ label: style.treatment, ...measured });
      }

      for (const plate of plates) {
        // The band table the treatment constants cite, printed the way the
        // interest-floor calibration prints its own.
        const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
        console.log(
          [
            plate.label.padEnd(16),
            `imagery ${pct(plate.metrics.imageryShare)}`.padEnd(18),
            `imagery+device ${pct(plate.metrics.imageryOrDeviceShare)}`.padEnd(25),
            `colours ${plate.metrics.quantisedColourCount}`.padEnd(13),
            `flat ${pct(plate.metrics.flatBackgroundShare)}`.padEnd(13),
            `occupied ${pct(plate.metrics.occupiedShare)}`,
          ].join(" "),
        );

        expect(plate.metrics.imageryOrDeviceShare, `${plate.label} imageryOrDeviceShare`).toBeGreaterThanOrEqual(IMAGERY_OR_DEVICE_FLOOR);
        expect(plate.metrics.imageryShare, `${plate.label} imageryShare`).toBeGreaterThanOrEqual(FULL_BLEED_IMAGERY_SHARE);
        // Eight, per item S's own test bullet — comfortably above item L's
        // own low-colour-count warning floor, which is what a wash would trip.
        expect(plate.metrics.quantisedColourCount, `${plate.label} quantisedColourCount`).toBeGreaterThanOrEqual(8);
        expect(plate.metrics.quantisedColourCount).toBeGreaterThan(MIN_QUANTISED_COLOUR_COUNT);

        const verdict = checkInterestFloor(plate.metrics, plate.probe, "interior", { slide: 1, archetype: "slide" });
        expect(verdict.findings.map((f) => `${f.kind}: ${f.sentence}`), `${plate.label} must pass the interest floor`).toStrictEqual([]);
      }

      // ── The half that can fail: the sheet actually painted ──
      //
      // Every assertion above is a floor the UNTREATED plate clears as well,
      // so without this the block would pass unchanged if the treatment CSS
      // reached the document and matched nothing. These are inequalities
      // against the untreated render of the SAME slide, and only the filter
      // can produce them.
      const base = plates.find((p) => p.label === "none")!;
      const baseStats = plateStats(base.png);
      console.log(`untreated       mean rgb ${baseStats.r.toFixed(1)}/${baseStats.g.toFixed(1)}/${baseStats.b.toFixed(1)}   chroma ${baseStats.chroma.toFixed(2)}`);

      for (const plate of plates.filter((p) => p.label !== "none")) {
        const stats = plateStats(plate.png);
        console.log(`${plate.label.padEnd(16)}mean rgb ${stats.r.toFixed(1)}/${stats.g.toFixed(1)}/${stats.b.toFixed(1)}   chroma ${stats.chroma.toFixed(2)}`);

        // 1. The pixels are not the untreated pixels. A no-op sheet fails here
        //    first, and it fails whatever the filter happens to be.
        expect(Buffer.compare(plate.png, base.png), `${plate.label} rendered byte-identically to the untreated plate — the treatment CSS painted nothing`).not.toBe(0);

        // 2. They differ in the direction the filter defines: both treatments
        //    desaturate, so mean chroma must fall, and by more than decode
        //    noise. A sheet that matched a different element (or a grain layer
        //    alone) would move the bytes without moving this.
        expect(stats.chroma, `${plate.label} did not desaturate the photograph`).toBeLessThan(baseStats.chroma - 1);
      }

      // 3. The two treatments are different treatments, not one alias — the
      //    tint layer is `duotone-scrim`'s alone, so its plate cannot equal
      //    `warm-desaturate`'s.
      const warm = plates.find((p) => p.label === "warm-desaturate")!.png;
      const duotone = plates.find((p) => p.label === "duotone-scrim")!.png;
      expect(Buffer.compare(warm, duotone), "the two treatments rendered identically — one of the two sheets did nothing").not.toBe(0);
    },
    600_000,
  );
});
