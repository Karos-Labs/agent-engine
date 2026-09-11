/**
 * What a rendered slide's PIXELS actually contain — physics, with no policy
 * in it.
 *
 * Nothing here knows about Instagram, about archetypes, or about what makes
 * a slide good. There is no threshold, no verdict and no boolean called
 * `passes`: `measureSlidePng` reports numbers, and the channel that cares
 * (`agents/instagram-agent/src/workflow/interest-floor.ts`) owns every
 * constant those numbers are compared against. That split is deliberate and
 * load-bearing — a measurement that also judges cannot be reused by
 * tiktok/linkedin/x, and a threshold buried in a measurement is a threshold
 * nobody can calibrate.
 *
 * WHY MEASURE AT ALL. The owner's complaint about the shipped Karos Labs
 * carousels was "mostly grey screen" — a headline in the lower third over a
 * large empty upper area. Every check the pipeline had at that point looked
 * at STRUCTURE (does this archetype declare a device, does the copy have a
 * figure) and structure said yes. The defect only existed in the pixels, so
 * the pixels are where it has to be caught. `largestEmptyRect` in
 * particular is the metric that names the complaint: "a large empty upper
 * area" is one contiguous block, and a slide can sit under a flat-share
 * ceiling while still carrying one because texture elsewhere dilutes the
 * total.
 *
 * DETERMINISM IS PART OF THE CONTRACT. The cell grid is FIXED by the design
 * canvas, never adapted to the image's content, so the same PNG always
 * yields byte-identical numbers — the same promise `paletteForSlide` and
 * `isVariationSlot` already make on the authoring side. Every tie (the
 * modal background bin, the maximal rectangle) is broken by a rule stated
 * where it is applied.
 *
 * COST. Two decode passes over a 2160x2880 frame is ~12 M pixel visits,
 * roughly 150-350 ms per slide, and no model call: $0. See
 * `measureSlidePng` for why the second pass is not avoidable and why
 * retaining the frame to avoid it would be the wrong trade.
 */

import { z } from "zod";
import { decodePngRows } from "@agent-engine/tool-common";

// ─────────────────────────────────────────────────────────────────────────
// The grid
// ─────────────────────────────────────────────────────────────────────────

/**
 * The design-space canvas metrics are reported against. Instagram's portrait
 * plate; `render-carousel`'s `CanvasSchema` defaults to the same numbers and
 * `validateRenderInputs` pins `scale` to exactly 2, so a measured slide PNG
 * is 2160x2880 and the grid below is 270x360. A caller on another canvas
 * (a 1080x1920 vertical video frame) passes its own and gets its own fixed
 * grid; what is never allowed is a grid that depends on the CONTENT.
 */
export const DEFAULT_DESIGN_CANVAS = { w: 1080, h: 1440 } as const;

/**
 * One cell is 4x4 DESIGN px — 8x8 screenshot px at scale 2, so 64 samples
 * per cell and 97,200 cells over the standard plate. That is the same order
 * of work `brand-logo`'s `MAX_SAMPLES = 100_000` sampling already does per
 * asset, and it is fine enough that a 4-design-px feature is not lost while
 * coarse enough that per-cell statistics mean something.
 *
 * Consequence worth stating so nobody debugs a 3px discrepancy:
 * `largestEmptyRect` is quantised to 4 design px.
 */
export const CELL_DESIGN_PX = 4;

/**
 * 5 bits per channel (32 levels, 8 units wide) for every "is this the same
 * colour" question here. Coarser than `brand-logo`'s 4 bits because this is
 * counting DISTINCT colours inside an 8x8 patch rather than finding a mark's
 * two or three masses: at 4 bits a smooth two-token gradient collapses to
 * one colour and stops being distinguishable from a solid fill.
 */
const QUANT_BITS = 5;
const QUANT_SHIFT = 8 - QUANT_BITS;
const QUANT_LEVELS = 1 << (3 * QUANT_BITS);

/**
 * Per-cell distinct-colour counting stops here. Six is the highest number
 * any classification below asks about, so counting past eight buys nothing
 * and the cap keeps the per-cell colour set a fixed-width slice of one flat
 * array instead of 97,200 `Set`s.
 */
const CELL_DISTINCT_COLOUR_CAP = 8;

// ─────────────────────────────────────────────────────────────────────────
// Measurement tolerances
// ─────────────────────────────────────────────────────────────────────────

/**
 * How close two colours have to be to count as the same thing. These are
 * MEASUREMENT parameters, not editorial thresholds: they describe the
 * renderer's own noise floor and the token system's own smallest deliberate
 * step, and they are the same numbers whatever a caller considers a good
 * slide. The instagram agent's `interest-floor.ts` declares them as named
 * policy constants and passes them in, so there is one place to look and no
 * silent divergence — the defaults here are what that file declares today.
 */
export interface MeasureTolerances {
  /**
   * Ground tolerance, on the weighted 0-255 scale below. Chromium's
   * antialiasing plus the templates' own `color-mix(in srgb, var(--fg) 78%,
   * transparent)` overlays put ground-adjacent tones a few units off
   * ground; a headless 8-bit screenshot carries no dithering, so AA is the
   * only noise source and it stays inside +/-10. Cannot merge two brand
   * neutrals: derived ground/fg pairs are separated by >= 24 by the contrast
   * floor's own construction, and the bundled `#17181C`/`#F4F2EC` pair by
   * 220.
   */
  flat: number;
  /**
   * Ink threshold. Above `flat`, so no pixel is ever both ground and ink,
   * and below the smallest deliberate tonal step the token system makes.
   * Pixels in the 12-18 band are neither — an AA fringe wider than the
   * ground tolerance, counted in nothing.
   */
  ink: number;
  /** Accent tolerance. An accent paints through `color-mix`/opacity in several places (`.stat-band`, `.eyebrow`, hairlines), so measured only at 100% opacity it would under-count itself. */
  accent: number;
  /** A cell is flat when its samples vary by less than one AA step, per channel, on the 0..1 scale. */
  flatCellStddev: number;
}

export const DEFAULT_MEASURE_TOLERANCES: MeasureTolerances = {
  flat: 12,
  ink: 18,
  accent: 20,
  flatCellStddev: 6 / 255,
};

/**
 * A cell counts as SUBSTANTIALLY COVERED at 48 of its 64 samples. This is
 * the precondition for both device buckets (`imageryShare`,
 * `graphicShare`), and it is the line between content and type: a
 * photograph, a colour block, a bar or a big numeral's stroke COVERS the
 * cells it occupies, while glyphs leave most of their cell as ground.
 *
 * It is on `imageryShare` deliberately, and it is the one place this file
 * departs from a literal reading of its spec (which asked only for
 * `distinctColours >= 6 AND stddev >= 8/255`). An antialiased glyph edge is
 * a ramp from ground to foreground: over an 8x8 patch that ramp lands in
 * six or more 5-bit buckets with an enormous standard deviation, so without
 * the coverage requirement TEXT reads as imagery — and a headline-only
 * cover would then satisfy the very "does this slide carry anything but
 * words" floor it exists to fail. Coverage is what type does not have.
 */
const CELL_COVERED_INK_SHARE = 48 / 64;

/** A cell carries ink at 4 of 64 samples — about one glyph stem crossing it. Below that it is an AA speck. */
const CELL_INK_SHARE = 4 / 64;

/*
 * ── CONTENT vs DECORATION, and why `occupiedShare` alone was not enough ──
 *
 * `occupiedShare` counts a cell as occupied when ANY 4 of its 64 samples are
 * ink. That is the right question for "is there a mark here", and it is the
 * wrong question for "is there anything to read here": a full-frame
 * decorative field — a hairline pinstripe, a dot screen, a very low contrast
 * glyph wash — clears 4/64 in every cell it covers while moving each cell's
 * MEAN colour by a couple of units. Measured that way a plate carrying only
 * its ground decoration and no headline, no body, no device at all scores
 * ~0.42 occupied with a ~0.01 largest empty rectangle: indistinguishable
 * from a full slide, which makes an emptiness measurement useless exactly
 * where it matters.
 *
 * So a second mask is emitted beside the first, and its test is the one a
 * reader's eye applies: has this cell's AVERAGE COLOUR visibly left the
 * ground (`nonGroundMean`, the same `tol.ink` distance the pixel test uses,
 * applied to the cell mean), or is the cell substantially COVERED
 * (`CELL_COVERED_INK_SHARE`, the same test the imagery and graphic buckets
 * already use)?
 *
 * The arithmetic is what makes this a discriminator rather than a tuning
 * knob. On the bundled `#17181C`/`#F4F2EC` pair the foreground is ~220 units
 * from the ground, so:
 *
 *   * a cell whose ink covers 8% of it or more has a mean over 18 away →
 *     CONTENT. Type qualifies easily: at 4/64 = 6.25% coverage a cell is
 *     already at ~14, and cells touching a display face's 12-16px strokes
 *     are covered outright.
 *   * a 1.5px-every-18px hairline field at 14% of the foreground carries
 *     8.3% duty at ~24 units of contrast, so its cells sit ~2 units off the
 *     ground → DECORATION. There is no opacity at that duty cycle which
 *     would make it content: it would have to exceed 98%.
 *
 * Both masks are reported. Neither is "the right one": `occupiedShare`
 * answers "did anything paint" (a broken render paints nothing at all), and
 * `contentOccupiedShare` answers "is there anything here to read". The
 * channel's policy file decides which clause reads which, and this module
 * keeps its promise of having no policy in it.
 */

/** Imagery needs real colour variety, not a ramp: six distinct 5-bit colours in one covered cell. */
const IMAGERY_MIN_DISTINCT_COLOURS = 6;

/** ...and real tonal spread with it. 8/255 is above the AA noise floor `flatCellStddev` describes. */
const IMAGERY_MIN_STDDEV = 8 / 255;

/** A graphic is a covered cell with almost no colour variety: a fill, a bar, a gradient step, the interior of a heavy stroke. */
const GRAPHIC_MAX_DISTINCT_COLOURS = 3;

/** A 5-bit colour is one of the slide's colours once it holds half a percent of the frame. Below that it is a fringe. */
const QUANTISED_COLOUR_MIN_WEIGHT = 0.005;

/**
 * The bleed band, in DESIGN px, at all four canvas edges. Ink inside it is
 * either a deliberate full-bleed element or a clipped line of text, and
 * `clippedEdgeShare` reports how much of it there is so the caller can tell
 * those apart with the DOM probe's `overflow` beside it.
 */
const EDGE_BAND_DESIGN_PX = 8;

// ─────────────────────────────────────────────────────────────────────────
// Colour maths
// ─────────────────────────────────────────────────────────────────────────

/**
 * Weighted RGB Euclidean distance, `sqrt(2dr^2 + 4dg^2 + 3db^2)/3`, on the
 * 0-255 scale (black to white is exactly 255).
 *
 * Weighted rather than plain because green carries most of the perceived
 * difference; NOT a CIE conversion, deliberately — every number in this
 * module and every threshold that reads it would then depend on a
 * colour-space implementation, for a comparison that only ever asks "is
 * this the same flat tone or not".
 */
export function colourDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** `#abc`/`#aabbcc` -> an RGB triple; `undefined` for anything else. Never repaired, never guessed — an unparseable token means "no expectation was supplied", not "black". */
export function parseHexRgb(value: string | undefined): [number, number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!HEX.test(trimmed)) return undefined;
  let digits = trimmed.slice(1);
  if (digits.length === 3) digits = [...digits].map((c) => c + c).join("");
  return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
}

function rgbHex(r: number, g: number, b: number): string {
  const clamp = (v: number): string => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0").toUpperCase();
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// The output
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every share is a fraction in `[0, 1]`. PIXEL shares (`flatBackgroundShare`,
 * `inkShare`, `accentShare`, `clippedEdgeShare`) are fractions of the full
 * frame's pixels; CELL shares (`occupiedShare`, `imageryShare`,
 * `graphicShare`, `textShare`, `largestEmptyRectShare`) are fractions of the
 * fixed cell grid. Both denominators are the whole canvas, so a share is
 * always readable as "this much of the plate".
 */
export const SlideMetricsSchema = z.object({
  backgroundHex: z
    .string()
    .describe("The slide's ground colour: the modal quantised mean over its flat cells, or the caller's expected ground when that is within tolerance of the mode."),
  backgroundMatchesBrandGround: z
    .boolean()
    .describe(
      "True only when the caller supplied an expected ground AND the measured mode agreed with it. False also means 'nothing was supplied to compare against' — unverified, not contradicted.",
    ),
  flatBackgroundShare: z.number().describe("Pixels within the flat tolerance of backgroundHex, over all pixels."),
  inkShare: z.number().describe("Pixels beyond the ink threshold from backgroundHex, over all pixels. Every non-ground pixel counts — a photograph and a scrim are ink, not only glyphs."),
  occupiedShare: z.number().describe("Cells carrying ink or whose mean colour is off the ground, over all cells. Area used, not glyph coverage. A decorative texture counts here — see contentOccupiedShare."),
  contentOccupiedShare: z
    .number()
    .describe(
      "Cells whose MEAN colour has visibly moved off the ground, or that are substantially covered. Excludes a low-contrast decorative texture, which occupiedShare counts.",
    ),
  largestEmptyContentRect: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .describe("The largest axis-aligned rectangle carrying no CONTENT-occupied cell, in DESIGN px. A decorative ground does not shrink it."),
  largestEmptyContentRectShare: z.number().describe("That rectangle's area over the canvas area."),
  largestEmptyRect: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .describe("The largest axis-aligned rectangle of unoccupied cells, in DESIGN px against the design canvas, quantised to CELL_DESIGN_PX."),
  largestEmptyRectShare: z.number().describe("That rectangle's area over the canvas area."),
  imageryShare: z.number().describe("Covered cells with real colour variety and tonal spread — a photograph, a textured field."),
  graphicShare: z.number().describe("Covered cells with almost no colour variety — a fill, a bar, a gradient, a heavy stroke's interior."),
  imageryOrDeviceShare: z.number().describe("imageryShare + graphicShare. The two buckets are mutually exclusive by construction, so this never double-counts."),
  textShare: z.number().describe("Cells carrying ink that are neither imagery nor graphic — glyphs, hairlines, rules."),
  accentShare: z.number().describe("Pixels within the accent tolerance of the caller's expected accent. Zero when no accent was supplied."),
  accentPresent: z.boolean().describe("Whether any accent pixel was found at all."),
  edgeDensity: z.number().describe("Ink pixels with a 4-neighbour on the ground, over all ink pixels. High for type, near zero for a solid wash."),
  quantisedColourCount: z
    .number()
    .int()
    .describe(
      "5-bit colours each holding at least half a percent of the frame — the slide's PALETTE, not its colour range. A photograph spreads its pixels over so many bins that none reaches the floor and this is 0, so a caller treating a low count as 'monochrome' has to read imageryShare beside it.",
    ),
  clippedEdgeShare: z.number().describe("Ink inside the 8-design-px bleed band at any canvas edge, over all pixels."),
});
export type SlideMetrics = z.infer<typeof SlideMetricsSchema>;

/**
 * `measureSlidePng` NEVER throws and never guesses. An undecodable buffer, a
 * frame past the decoder's pixel cap, interlaced data or a size that is not
 * an integer multiple of the design canvas all come back as
 * `{ ok: false, reason }`, and the caller degrades to "not measured" — which
 * is a fact it can report, where a fabricated set of numbers would be an
 * editorial verdict with no evidence under it.
 */
export type SlideMetricsOutcome = { ok: true; metrics: SlideMetrics } | { ok: false; reason: string };

/**
 * What the caller already knows about this slide's palette. Anchoring
 * matters: on a full-bleed photograph the modal colour IS the photograph, and
 * a flat-background share measured against a photograph's dominant tone is
 * meaningless. Supplying the brand ground lets the measurement say "the
 * ground is where the brand says it is" rather than "the ground is whatever
 * there was most of".
 */
export interface MeasureSlideExpectations {
  /** The slide's ground token (`--bg`). Used as `backgroundHex` when the measured mode agrees with it within `flat`. */
  ground?: string;
  /** The slide's accent. Without it `accentShare` is 0 and `accentPresent` is false — an accent cannot be measured against an accent nobody named. */
  accent?: string;
}

export interface MeasureSlideOptions {
  /** Defaults to `DEFAULT_DESIGN_CANVAS`. The PNG must be an integer multiple of it, equally in both axes. */
  design?: { w: number; h: number };
  expected?: MeasureSlideExpectations;
  /** Overrides for individual tolerances; anything omitted keeps `DEFAULT_MEASURE_TOLERANCES`. */
  tolerances?: Partial<MeasureTolerances>;
}

// ─────────────────────────────────────────────────────────────────────────
// The DOM probe's shape
// ─────────────────────────────────────────────────────────────────────────

/**
 * The other half of a slide's measurement, and it lives here beside the
 * pixel half because the two are always read together and one consumer
 * reads both.
 *
 * It is not decoration. `headline-focus.html` and `stat-callout.html` size
 * their display type from an in-page `textContent.length` breakpoint, and
 * Hebrew's different average glyph width means that breakpoint can choose a
 * size that overflows its box with no pixel signature at all except a few
 * clipped edge pixels. `fontFamiliesUsed` is also the first real evidence
 * that a script font LOADED, rather than that its `<link>` was emitted.
 */
export const SlideProbeSchema = z.object({
  n: z.number().int().positive().describe("The slide this probe belongs to."),
  overflow: z.boolean().describe("Any element whose scroll box exceeds its client box by more than 1px."),
  overflowing: z.array(z.string()).describe("Up to six selectors for those elements, so a failure can name what overflowed."),
  offscreen: z.array(z.string()).describe("Up to six selectors for boxes escaping the canvas rectangle by more than 1px."),
  elementCount: z.number().int().describe("Elements in the rendered document — a blank slide and a busy one are different numbers."),
  textBoxShare: z.number().describe("Summed area of the text-bearing leaf boxes over the canvas area. The DOM's own view of how much of the plate is type."),
  fontFamiliesUsed: z.array(z.string()).describe("The resolved first font family of every text-bearing leaf, deduplicated and sorted."),
});
export type SlideProbe = z.infer<typeof SlideProbeSchema>;

// ─────────────────────────────────────────────────────────────────────────
// The measurement
// ─────────────────────────────────────────────────────────────────────────

interface EmptyRectCells {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

/**
 * The classic histogram + stack sweep for the maximal all-empty rectangle
 * over the cell mask, O(cells).
 *
 * Ties are resolved by strict `>`, and the sweep runs top row to bottom and
 * left to right within a row, so equal-area rectangles always resolve to the
 * topmost then leftmost one. That rule exists so a caller can quote the
 * rectangle's coordinates in a steer sentence and get the same coordinates
 * next time.
 */
function largestEmptyRectangle(empty: Uint8Array, cols: number, rows: number): EmptyRectCells {
  const heights = new Int32Array(cols);
  let best: EmptyRectCells = { x: 0, y: 0, w: 0, h: 0, area: 0 };
  const stack: number[] = [];

  for (let cy = 0; cy < rows; cy++) {
    const rowBase = cy * cols;
    for (let cx = 0; cx < cols; cx++) heights[cx] = empty[rowBase + cx] === 1 ? heights[cx]! + 1 : 0;

    stack.length = 0;
    for (let cx = 0; cx <= cols; cx++) {
      const h = cx === cols ? 0 : heights[cx]!;
      while (stack.length > 0) {
        const topIndex = stack[stack.length - 1]!;
        const topHeight = heights[topIndex]!;
        if (topHeight < h) break;
        stack.pop();
        const left = stack.length > 0 ? stack[stack.length - 1]! + 1 : 0;
        const width = cx - left;
        const area = topHeight * width;
        if (area > best.area) best = { x: left, y: cy - topHeight + 1, w: width, h: topHeight, area };
      }
      stack.push(cx);
    }
  }

  return best;
}

/**
 * Reads one rendered slide PNG and reports what is in it.
 *
 * TWO DECODE PASSES, and the reason is not laziness. Almost every counter
 * here is relative to the slide's own ground colour, and the ground colour
 * is not known until every flat cell in the frame has been seen — so pass
 * one builds the background-independent statistics (per-cell means, spread
 * and colour variety, plus the frame's colour histogram), the ground is
 * decided from those, and pass two counts ink, flat, accent, edges and
 * clipping against it. The alternative is to retain the decoded frame
 * between the two folds, which at 2160x2880 is a 24.9 MB RGBA buffer held
 * for the duration; re-inflating instead costs about 150 ms of CPU and
 * nothing else. Both passes stream one scanline at a time.
 */
export function measureSlidePng(bytes: Uint8Array, opts: MeasureSlideOptions = {}): SlideMetricsOutcome {
  const design = opts.design ?? DEFAULT_DESIGN_CANVAS;
  const tol: MeasureTolerances = { ...DEFAULT_MEASURE_TOLERANCES, ...opts.tolerances };

  if (design.w <= 0 || design.h <= 0 || design.w % CELL_DESIGN_PX !== 0 || design.h % CELL_DESIGN_PX !== 0) {
    return { ok: false, reason: `design canvas ${design.w}x${design.h} is not a positive multiple of the ${CELL_DESIGN_PX}px cell` };
  }

  const cols = design.w / CELL_DESIGN_PX;
  const rows = design.h / CELL_DESIGN_PX;
  const cellCount = cols * rows;

  // Pass 1 accumulators. Typed arrays rather than objects: 97,200 cells of
  // per-channel sums and squares is ~5 MB this way and ~10x that as objects.
  const sumR = new Float64Array(cellCount);
  const sumG = new Float64Array(cellCount);
  const sumB = new Float64Array(cellCount);
  const sumSqR = new Float64Array(cellCount);
  const sumSqG = new Float64Array(cellCount);
  const sumSqB = new Float64Array(cellCount);
  const colourSet = new Int32Array(cellCount * CELL_DISTINCT_COLOUR_CAP).fill(-1);
  const colourCount = new Uint8Array(cellCount);
  const histogram = new Int32Array(QUANT_LEVELS);

  let scale = 0;
  let cellPx = 0;
  let samplesPerCell = 0;
  let sizeProblem: string | undefined;

  const header = decodePngRows(bytes, (row, y, hdr) => {
    if (scale === 0) {
      // Established once, from the header, and then constant: the grid is
      // fixed by the design canvas, not fitted to the image.
      const sx = hdr.width / design.w;
      const sy = hdr.height / design.h;
      if (!Number.isInteger(sx) || sx < 1 || sx !== sy) {
        sizeProblem = `${hdr.width}x${hdr.height} is not an integer multiple of the ${design.w}x${design.h} design canvas`;
        scale = -1;
        return;
      }
      scale = sx;
      cellPx = CELL_DESIGN_PX * scale;
      samplesPerCell = cellPx * cellPx;
    }
    if (scale < 0) return; // refused above; the outcome is decided after the decode

    const cellRowBase = ((y / cellPx) | 0) * cols;
    for (let x = 0; x < hdr.width; x++) {
      const px = x * 4;
      // Alpha is not composited. Chromium's screenshot is fully opaque, and
      // compositing a transparent source over an assumed backdrop would
      // invent the very pixels this function exists to report.
      const r = row[px]!;
      const g = row[px + 1]!;
      const b = row[px + 2]!;
      const cell = cellRowBase + ((x / cellPx) | 0);

      sumR[cell] = sumR[cell]! + r;
      sumG[cell] = sumG[cell]! + g;
      sumB[cell] = sumB[cell]! + b;
      sumSqR[cell] = sumSqR[cell]! + r * r;
      sumSqG[cell] = sumSqG[cell]! + g * g;
      sumSqB[cell] = sumSqB[cell]! + b * b;

      const key = ((r >> QUANT_SHIFT) << (2 * QUANT_BITS)) | ((g >> QUANT_SHIFT) << QUANT_BITS) | (b >> QUANT_SHIFT);
      histogram[key] = histogram[key]! + 1;

      const held = colourCount[cell]!;
      if (held < CELL_DISTINCT_COLOUR_CAP) {
        const base = cell * CELL_DISTINCT_COLOUR_CAP;
        let seen = false;
        for (let i = 0; i < held; i++) {
          if (colourSet[base + i] === key) {
            seen = true;
            break;
          }
        }
        if (!seen) {
          colourSet[base + held] = key;
          colourCount[cell] = held + 1;
        }
      }
    }
  });

  if (header === undefined) return { ok: false, reason: "not a decodable non-interlaced 8/16-bit PNG, or past the decoder's 16-megapixel cap" };
  if (sizeProblem !== undefined) return { ok: false, reason: sizeProblem };

  const totalPixels = header.width * header.height;

  // ── The ground colour ─────────────────────────────────────────────────
  // The modal quantised mean over the cells that are flat. Grouping by the
  // quantised mean and then averaging the group's real means gives a
  // representative that is not itself quantised, so a ground token is
  // reproduced exactly rather than snapped to a bin centre.
  const flatBins = new Map<number, { count: number; r: number; g: number; b: number }>();
  const cellMeanR = new Float64Array(cellCount);
  const cellMeanG = new Float64Array(cellCount);
  const cellMeanB = new Float64Array(cellCount);
  const cellStddev = new Float64Array(cellCount);

  for (let cell = 0; cell < cellCount; cell++) {
    const mr = sumR[cell]! / samplesPerCell;
    const mg = sumG[cell]! / samplesPerCell;
    const mb = sumB[cell]! / samplesPerCell;
    cellMeanR[cell] = mr;
    cellMeanG[cell] = mg;
    cellMeanB[cell] = mb;
    // Population variance per channel; the WORST channel decides, because a
    // cell is flat only when every channel is flat.
    const vr = Math.max(0, sumSqR[cell]! / samplesPerCell - mr * mr);
    const vg = Math.max(0, sumSqG[cell]! / samplesPerCell - mg * mg);
    const vb = Math.max(0, sumSqB[cell]! / samplesPerCell - mb * mb);
    const sd = Math.sqrt(Math.max(vr, vg, vb)) / 255;
    cellStddev[cell] = sd;
    if (sd >= tol.flatCellStddev) continue;
    const key = ((Math.round(mr) >> QUANT_SHIFT) << (2 * QUANT_BITS)) | ((Math.round(mg) >> QUANT_SHIFT) << QUANT_BITS) | (Math.round(mb) >> QUANT_SHIFT);
    const bin = flatBins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bin.count += 1;
    bin.r += mr;
    bin.g += mg;
    bin.b += mb;
    flatBins.set(key, bin);
  }

  let modeR: number;
  let modeG: number;
  let modeB: number;
  if (flatBins.size > 0) {
    let bestKey = -1;
    let bestCount = -1;
    // Lowest key wins a tie, so the mode is total rather than
    // insertion-ordered.
    for (const [key, bin] of flatBins) {
      if (bin.count > bestCount || (bin.count === bestCount && key < bestKey)) {
        bestKey = key;
        bestCount = bin.count;
      }
    }
    const bin = flatBins.get(bestKey)!;
    modeR = bin.r / bin.count;
    modeG = bin.g / bin.count;
    modeB = bin.b / bin.count;
  } else {
    // NOT ONE FLAT CELL ANYWHERE — a full-bleed photograph or a noise field.
    // The frame's modal 5-bit colour, reported at its bin centre. There is no
    // ground here to report precisely, and the honest consequence is that
    // `backgroundMatchesBrandGround` will be false.
    let bestKey = 0;
    let bestCount = -1;
    for (let key = 0; key < QUANT_LEVELS; key++) {
      if (histogram[key]! > bestCount) {
        bestKey = key;
        bestCount = histogram[key]!;
      }
    }
    const channelMask = (1 << QUANT_BITS) - 1;
    const half = 1 << (QUANT_SHIFT - 1);
    modeR = (((bestKey >> (2 * QUANT_BITS)) & channelMask) << QUANT_SHIFT) + half;
    modeG = (((bestKey >> QUANT_BITS) & channelMask) << QUANT_SHIFT) + half;
    modeB = ((bestKey & channelMask) << QUANT_SHIFT) + half;
  }

  const expectedGround = parseHexRgb(opts.expected?.ground);
  const groundMatches =
    expectedGround !== undefined && colourDistance(modeR, modeG, modeB, expectedGround[0], expectedGround[1], expectedGround[2]) <= tol.flat;
  const ground: [number, number, number] = groundMatches && expectedGround !== undefined ? expectedGround : [modeR, modeG, modeB];
  const [bgR, bgG, bgB] = ground;
  const backgroundHex = rgbHex(bgR, bgG, bgB);

  const accent = parseHexRgb(opts.expected?.accent);

  // ── Pass 2: everything measured against the ground ────────────────────
  const cellInk = new Int32Array(cellCount);
  let flatPixels = 0;
  let inkPixels = 0;
  let accentPixels = 0;
  let edgePixels = 0;
  let clippedInkPixels = 0;

  const bandPx = EDGE_BAND_DESIGN_PX * scale;
  const width = header.width;
  const height = header.height;
  /*
   * EDGES, and why this needs three sweeps per row rather than one.
   *
   * An ink pixel is an EDGE pixel when at least one of its four in-frame
   * neighbours is not ink — the boundary of the ink region. That makes
   * `edgeDensity` a ratio in [0, 1]: near 1 for glyphs (almost every ink
   * pixel of a letterform touches ground), near 0 for a solid wash, which is
   * exactly the cross-check the caller wants.
   *
   * A pixel's left/right neighbours are only known once the whole row is
   * classified, and its DOWN neighbour only once the next row arrives. So
   * each row is classified first, the previous row's verdict is then
   * finalised against it and counted, and only then is this row's own
   * horizontal/upward verdict written. A pixel outside the canvas is not
   * "ground": a full-bleed element touching the frame edge is a bleed, not an
   * outline.
   */
  let prevInk = new Uint8Array(width);
  let curInk = new Uint8Array(width);
  let prevEdge = new Uint8Array(width);
  let curEdge = new Uint8Array(width);
  let havePrev = false;

  const secondPass = decodePngRows(bytes, (row, y) => {
    const inBandRow = y < bandPx || y >= height - bandPx;
    const cellRowBase = ((y / cellPx) | 0) * cols;

    for (let x = 0; x < width; x++) {
      const px = x * 4;
      const r = row[px]!;
      const g = row[px + 1]!;
      const b = row[px + 2]!;
      const distance = colourDistance(r, g, b, bgR, bgG, bgB);
      const isInk = distance > tol.ink;
      if (distance <= tol.flat) flatPixels += 1;
      if (isInk) {
        inkPixels += 1;
        const cell = cellRowBase + ((x / cellPx) | 0);
        cellInk[cell] = cellInk[cell]! + 1;
        if (inBandRow || x < bandPx || x >= width - bandPx) clippedInkPixels += 1;
      }
      if (accent !== undefined && colourDistance(r, g, b, accent[0], accent[1], accent[2]) <= tol.accent) accentPixels += 1;
      curInk[x] = isInk ? 1 : 0;
    }

    if (havePrev) {
      for (let x = 0; x < width; x++) {
        if (prevInk[x] === 1 && curInk[x] === 0) prevEdge[x] = 1; // its down-neighbour is ground
        edgePixels += prevEdge[x]!;
      }
    }

    for (let x = 0; x < width; x++) {
      const isInk = curInk[x] === 1;
      const openLeft = x > 0 && curInk[x - 1] === 0;
      const openRight = x + 1 < width && curInk[x + 1] === 0;
      const openUp = havePrev && prevInk[x] === 0;
      curEdge[x] = isInk && (openLeft || openRight || openUp) ? 1 : 0;
    }

    const ink = prevInk;
    prevInk = curInk;
    curInk = ink;
    const edge = prevEdge;
    prevEdge = curEdge;
    curEdge = edge;
    havePrev = true;
  });

  if (secondPass === undefined) return { ok: false, reason: "the PNG decoded once and then did not — the buffer changed under the measurement" };
  for (let x = 0; x < width; x++) edgePixels += prevEdge[x]!; // the last row, whose own row below never arrived

  // ── Cell classification ───────────────────────────────────────────────
  let occupiedCells = 0;
  let contentOccupiedCells = 0;
  let imageryCells = 0;
  let graphicCells = 0;
  let textCells = 0;
  const empty = new Uint8Array(cellCount);
  const emptyOfContent = new Uint8Array(cellCount);

  for (let cell = 0; cell < cellCount; cell++) {
    const inkShareOfCell = cellInk[cell]! / samplesPerCell;
    const distinct = colourCount[cell]!;
    const covered = inkShareOfCell >= CELL_COVERED_INK_SHARE;
    const carriesInk = inkShareOfCell >= CELL_INK_SHARE;
    const nonGroundMean = colourDistance(cellMeanR[cell]!, cellMeanG[cell]!, cellMeanB[cell]!, bgR, bgG, bgB) > tol.ink;

    const isImagery = covered && distinct >= IMAGERY_MIN_DISTINCT_COLOURS && cellStddev[cell]! >= IMAGERY_MIN_STDDEV;
    const isGraphic = covered && !isImagery && distinct <= GRAPHIC_MAX_DISTINCT_COLOURS;
    if (isImagery) imageryCells += 1;
    if (isGraphic) graphicCells += 1;
    if (carriesInk && !isImagery && !isGraphic) textCells += 1;

    if (carriesInk || nonGroundMean) occupiedCells += 1;
    else empty[cell] = 1;

    // The content mask: see `CELL_INK_SHARE`'s neighbouring comment. A
    // decorative texture clears `carriesInk` in every cell it covers and
    // moves none of their means, so it fills `empty` while leaving
    // `emptyOfContent` untouched — which is the whole point.
    if (covered || nonGroundMean) contentOccupiedCells += 1;
    else emptyOfContent[cell] = 1;
  }

  const rect = largestEmptyRectangle(empty, cols, rows);
  const contentRect = largestEmptyRectangle(emptyOfContent, cols, rows);
  let quantisedColourCount = 0;
  const colourFloor = QUANTISED_COLOUR_MIN_WEIGHT * totalPixels;
  for (let key = 0; key < QUANT_LEVELS; key++) if (histogram[key]! >= colourFloor) quantisedColourCount += 1;

  const imageryShare = imageryCells / cellCount;
  const graphicShare = graphicCells / cellCount;

  return {
    ok: true,
    metrics: {
      backgroundHex,
      backgroundMatchesBrandGround: groundMatches,
      flatBackgroundShare: flatPixels / totalPixels,
      inkShare: inkPixels / totalPixels,
      occupiedShare: occupiedCells / cellCount,
      contentOccupiedShare: contentOccupiedCells / cellCount,
      largestEmptyRect: {
        x: rect.x * CELL_DESIGN_PX,
        y: rect.y * CELL_DESIGN_PX,
        w: rect.w * CELL_DESIGN_PX,
        h: rect.h * CELL_DESIGN_PX,
      },
      largestEmptyRectShare: (rect.w * CELL_DESIGN_PX * rect.h * CELL_DESIGN_PX) / (design.w * design.h),
      largestEmptyContentRect: {
        x: contentRect.x * CELL_DESIGN_PX,
        y: contentRect.y * CELL_DESIGN_PX,
        w: contentRect.w * CELL_DESIGN_PX,
        h: contentRect.h * CELL_DESIGN_PX,
      },
      largestEmptyContentRectShare: (contentRect.w * CELL_DESIGN_PX * contentRect.h * CELL_DESIGN_PX) / (design.w * design.h),
      imageryShare,
      graphicShare,
      imageryOrDeviceShare: imageryShare + graphicShare,
      textShare: textCells / cellCount,
      accentShare: accentPixels / totalPixels,
      accentPresent: accentPixels > 0,
      edgeDensity: inkPixels > 0 ? edgePixels / inkPixels : 0,
      quantisedColourCount,
      clippedEdgeShare: clippedInkPixels / totalPixels,
    },
  };
}
