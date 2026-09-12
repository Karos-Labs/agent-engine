import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CELL_DESIGN_PX,
  DEFAULT_DESIGN_CANVAS,
  DEFAULT_MEASURE_TOLERANCES,
  colourDistance,
  measureSlidePng,
  parseHexRgb,
  SlideMetricsSchema,
  type SlideMetrics,
} from "../src/slide-metrics.js";

/**
 * Chromium-free, and nothing is mocked. Every fixture is a REAL PNG built
 * here from chosen pixels — signature, IHDR, a deflated IDAT of unfiltered
 * scanlines, IEND — the same shape `brand-logo-contrast.test.ts` already
 * uses, and decoded back by the shipping decoder. There is no
 * `metrics: { flat: 0.93 }` object anywhere in this file, because a
 * hand-written metrics object would make every assertion here vacuous: the
 * point is that the INSTRUMENT reads real pixels correctly.
 *
 * Most fixtures use a small design canvas (216x288 at scale 2 => 432x576 px,
 * 54x72 cells). The grid is fixed BY THE DESIGN CANVAS, never fitted to the
 * content, so the geometry under test is identical at either size, and a
 * 6.2-megapixel frame per assertion would make this file take a minute.
 * THE AUDIT SLIDE is built at the real 2160x2880 on purpose — the numbers
 * the interest floor's constants cite have to be readable off the real plate.
 */

// ─────────────────────────────────────────────────────────────────────────
// A real PNG encoder, fast enough for a 6.2-megapixel frame
// ─────────────────────────────────────────────────────────────────────────

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * Truecolour 8-bit, filter type None on every row — the encoder does not need
 * to exercise the filters here (`decode-png.test.ts` owns that), so it writes
 * rows straight through and stays fast enough for a full plate.
 */
function encodeRgbPng(width: number, height: number, paintRow: (row: Buffer, y: number) => void): Uint8Array {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  const row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    paintRow(row, y);
    raw[y * (stride + 1)] = 0; // filter: None
    row.copy(raw, y * (stride + 1) + 1);
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

const GROUND = "#17181C";
const FOREGROUND = "#F4F2EC";
const ACCENT = "#FF3B30";

function rgb(hex: string): Buffer {
  const parsed = parseHexRgb(hex);
  expect(parsed, `${hex} must parse`).toBeDefined();
  return Buffer.from(parsed!);
}

/** The small canvas most assertions use, and its scale-2 pixel size. */
const SMALL = { w: 216, h: 288 };
const SMALL_PX = { w: SMALL.w * 2, h: SMALL.h * 2 };

function measured(bytes: Uint8Array, opts: Parameters<typeof measureSlidePng>[1] = {}): SlideMetrics {
  const outcome = measureSlidePng(bytes, { design: SMALL, ...opts });
  expect(outcome.ok, outcome.ok ? "" : `measurement refused: ${outcome.ok === false ? outcome.reason : ""}`).toBe(true);
  const metrics = (outcome as { ok: true; metrics: SlideMetrics }).metrics;
  // Every fixture's output is schema-valid, so a field added later cannot
  // quietly stop being emitted.
  expect(SlideMetricsSchema.parse(metrics)).toEqual(metrics);
  return metrics;
}

// ─────────────────────────────────────────────────────────────────────────
// The colour metric itself
// ─────────────────────────────────────────────────────────────────────────

describe("colourDistance is on the 0-255 scale and weights green hardest", () => {
  it("puts black and white exactly 255 apart", () => {
    expect(colourDistance(0, 0, 0, 255, 255, 255)).toBeCloseTo(255, 6);
  });

  it("is zero for identical colours and symmetric", () => {
    expect(colourDistance(23, 24, 28, 23, 24, 28)).toBe(0);
    expect(colourDistance(10, 200, 30, 240, 5, 90)).toBeCloseTo(colourDistance(240, 5, 90, 10, 200, 30), 10);
  });

  it("separates the bundled ground/foreground pair far beyond any tolerance here", () => {
    const [gr, gg, gb] = parseHexRgb(GROUND)!;
    const [fr, fg, fb] = parseHexRgb(FOREGROUND)!;
    expect(colourDistance(gr, gg, gb, fr, fg, fb)).toBeGreaterThan(200);
  });

  it("weights an equal delta in green above red above blue", () => {
    expect(colourDistance(100, 100, 100, 100, 120, 100)).toBeGreaterThan(colourDistance(100, 100, 100, 100, 100, 120));
    expect(colourDistance(100, 100, 100, 100, 100, 120)).toBeGreaterThan(colourDistance(100, 100, 100, 120, 100, 100));
  });
});

describe("parseHexRgb refuses rather than repairs", () => {
  it("reads #rgb and #rrggbb", () => {
    expect(parseHexRgb("#fff")).toEqual([255, 255, 255]);
    expect(parseHexRgb("#17181C")).toEqual([23, 24, 28]);
    expect(parseHexRgb("  #17181c  ")).toEqual([23, 24, 28]);
  });

  it("returns undefined for a named colour, an rgb() call, an eight-digit hex and undefined", () => {
    expect(parseHexRgb("black")).toBeUndefined();
    expect(parseHexRgb("rgb(0,0,0)")).toBeUndefined();
    expect(parseHexRgb("#17181CFF")).toBeUndefined();
    expect(parseHexRgb(undefined)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE AUDIT SLIDE, synthesised at the real plate size
// ─────────────────────────────────────────────────────────────────────────

/**
 * The defect the owner reported, rebuilt: 2160x2880 of uniform `#17181C`
 * with a single 1080x300 band of type low on the plate and nothing else.
 *
 * The band is drawn as 5px stems on a 40px pitch rather than as a solid
 * rectangle, because a headline is not a rectangle. That distinction is the
 * whole point of the coverage precondition on the device buckets: 5px stems
 * never fill a cell, so they read as `textShare`, and the slide correctly
 * reports that it carries NO imagery and NO device — which is what makes it
 * a defect rather than a style.
 */
const AUDIT_BAND = { x: 540, y: 2100, w: 1080, h: 300, stem: 5, pitch: 40 };

function auditSlide(): Uint8Array {
  const ground = rgb(GROUND);
  const ink = rgb(FOREGROUND);
  return encodeRgbPng(2160, 2880, (row, y) => {
    row.fill(ground);
    if (y < AUDIT_BAND.y || y >= AUDIT_BAND.y + AUDIT_BAND.h) return;
    for (let x = AUDIT_BAND.x; x < AUDIT_BAND.x + AUDIT_BAND.w; x += AUDIT_BAND.pitch) {
      for (let s = 0; s < AUDIT_BAND.stem; s++) ink.copy(row, (x + s) * 3);
    }
  });
}

describe("the audit slide — a mostly-flat plate with a headline low and nothing else", () => {
  const outcome = measureSlidePng(auditSlide(), { design: DEFAULT_DESIGN_CANVAS, expected: { ground: GROUND } });
  const metrics = (outcome as { ok: true; metrics: SlideMetrics }).metrics;

  it("measures at the real plate size against the real cell grid", () => {
    expect(outcome.ok).toBe(true);
  });

  it("reads the brand ground back exactly and confirms it", () => {
    expect(metrics.backgroundHex).toBe(GROUND);
    expect(metrics.backgroundMatchesBrandGround).toBe(true);
  });

  it("is overwhelmingly flat background", () => {
    expect(metrics.flatBackgroundShare).toBeGreaterThanOrEqual(0.9);
  });

  it("occupies almost none of the frame", () => {
    expect(metrics.occupiedShare).toBeLessThanOrEqual(0.22);
  });

  it("carries one enormous empty rectangle — the 'mostly grey screen', named", () => {
    expect(metrics.largestEmptyRectShare).toBeGreaterThanOrEqual(0.5);
    // The band starts at screenshot y 2100, i.e. cell row 262 (which it only
    // partly covers, so that row counts as occupied). Everything above is one
    // full-width empty block.
    expect(metrics.largestEmptyRect).toEqual({ x: 0, y: 0, w: 1080, h: 262 * CELL_DESIGN_PX });
  });

  it("carries NO imagery and NO device — the finding that makes it a defect", () => {
    expect(metrics.imageryShare).toBe(0);
    expect(metrics.graphicShare).toBe(0);
    expect(metrics.imageryOrDeviceShare).toBe(0);
  });

  it("reads the band as type, with the edge density type has", () => {
    expect(metrics.textShare).toBeGreaterThan(0);
    // Two of every five-pixel stem are boundary pixels, so 0.4. Real type at
    // scale 2 lands in the same band, and the contrast with the solid wash
    // below (0.003) is what makes edgeDensity a usable cross-check.
    expect(metrics.edgeDensity).toBeGreaterThan(0.06);
    expect(metrics.edgeDensity).toBeLessThan(0.6);
  });

  it("reports no accent when the caller named none, and just the two colours the plate is made of", () => {
    expect(metrics.accentShare).toBe(0);
    expect(metrics.accentPresent).toBe(false);
    expect(metrics.quantisedColourCount).toBe(2); // the ground and the type; nothing else holds half a percent
  });

  it("has no ink anywhere near the canvas edges", () => {
    expect(metrics.clippedEdgeShare).toBe(0);
  });

  it("counts every mark on it as CONTENT, because it carries no ground treatment at all", () => {
    // The audit slide is bare ground plus type, so the two masks agree to
    // within the handful of cells a stem only clips: 5px stems on a 40px
    // pitch are a 12.5% duty cycle, which moves a cell's mean 27 units off
    // the ground — past `ink` — so type registers on BOTH masks. They only
    // diverge on a decorated plate, which is the next block.
    expect(metrics.contentOccupiedShare).toBeCloseTo(metrics.occupiedShare, 3);
    expect(metrics.largestEmptyContentRectShare).toBeCloseTo(metrics.largestEmptyRectShare, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE DECORATED EMPTY PLATE — the reason a second occupancy mask exists
// ─────────────────────────────────────────────────────────────────────────

/**
 * Item M.3's ground field, painted over the brand ground, and NOTHING else:
 * no headline, no body, no kicker, no accent, no content of any kind.
 *
 * `headline-focus.html`'s field verbatim, at scale 2 — 1.5px rules every 18px
 * design becomes 3px every 36px, at `color-mix(in srgb, var(--fg) 14%,
 * transparent)` over `#17181C`, which Chromium composites to `rgb(54,55,57)`
 * — inset 16px design = 32px screenshot.
 *
 * This is the plate that made the second mask necessary. Under the FIRST mask
 * a cell counts as occupied when any 4 of its 64 samples are ink, and this
 * field clears that in every cell it covers, so a plate with no content at
 * all reported ~42% occupied and a ~1.5% largest empty rectangle: numbers
 * indistinguishable from a full slide, which passed clauses A, C, D and F of
 * the interest floor. The whole point of the content mask is that a texture
 * cannot satisfy it, and the arithmetic is why: an 8.3% duty cycle at 24
 * units of contrast moves a cell's mean about 2 units off the ground.
 */
const FIELD = { stripe: 3, pitch: 36, inset: 32, colour: "#363937" };

function decoratedEmptySlide(): Uint8Array {
  const ground = rgb(GROUND);
  const stripe = rgb(FIELD.colour);
  return encodeRgbPng(2160, 2880, (row, y) => {
    row.fill(ground);
    if (y < FIELD.inset || y >= 2880 - FIELD.inset) return;
    for (let x = FIELD.inset; x < 2160 - FIELD.inset; x++) {
      if ((x + y) % FIELD.pitch < FIELD.stripe) stripe.copy(row, x * 3);
    }
  });
}

describe("a plate carrying ONLY its ground decoration", () => {
  const outcome = measureSlidePng(decoratedEmptySlide(), { design: DEFAULT_DESIGN_CANVAS, expected: { ground: GROUND } });
  const metrics = (outcome as { ok: true; metrics: SlideMetrics }).metrics;

  it("still reads the brand ground, because the field is a minority of the pixels", () => {
    expect(outcome.ok).toBe(true);
    expect(metrics.backgroundHex).toBe(GROUND);
    expect(metrics.backgroundMatchesBrandGround).toBe(true);
  });

  it("counts the field as ink and as OCCUPIED — which is what made an emptiness measurement useless on its own", () => {
    // A stripe pixel is 24 units from the ground, past `ink` (18), so every
    // stripe pixel is ink and every cell the field crosses carries some.
    expect(colourDistance(...(parseHexRgb(FIELD.colour) as [number, number, number]), ...(parseHexRgb(GROUND) as [number, number, number]))).toBeGreaterThan(
      DEFAULT_MEASURE_TOLERANCES.ink,
    );
    expect(metrics.inkShare).toBeGreaterThan(0.05);
    expect(metrics.occupiedShare).toBeGreaterThan(0.4);
    expect(metrics.largestEmptyRectShare).toBeLessThan(0.05);
    // And it lands in `textShare`, so decoration was being scored as type.
    expect(metrics.textShare).toBeGreaterThan(0.4);
  });

  it("counts NONE of it as content, and hands back the whole plate as the empty content rectangle", () => {
    expect(metrics.contentOccupiedShare).toBe(0);
    expect(metrics.largestEmptyContentRectShare).toBe(1);
    expect(metrics.largestEmptyContentRect).toEqual({ x: 0, y: 0, w: DEFAULT_DESIGN_CANVAS.w, h: DEFAULT_DESIGN_CANVAS.h });
  });

  it("is not a device either, at any duty cycle — the field never covers a cell", () => {
    expect(metrics.imageryOrDeviceShare).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The instrument can distinguish a photograph, a graphic and type
// ─────────────────────────────────────────────────────────────────────────

/** xorshift32 — a deterministic noise field, so "the same PNG twice" stays a meaningful assertion. */
function noiseSlide(seed = 0x2f6e2b1): Uint8Array {
  let state = seed;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) & 0xff;
  };
  return encodeRgbPng(SMALL_PX.w, SMALL_PX.h, (row) => {
    for (let i = 0; i < row.byteLength; i++) row[i] = next();
  });
}

describe("a full-frame photograph", () => {
  const metrics = measured(noiseSlide());

  it("reads as imagery across essentially the whole frame", () => {
    expect(metrics.imageryShare).toBeGreaterThanOrEqual(0.9);
    expect(metrics.graphicShare).toBeLessThan(0.05);
    expect(metrics.imageryOrDeviceShare).toBeGreaterThanOrEqual(0.9);
  });

  it("is not flat and is fully occupied", () => {
    expect(metrics.flatBackgroundShare).toBeLessThan(0.05);
    expect(metrics.occupiedShare).toBeGreaterThan(0.95);
    expect(metrics.largestEmptyRectShare).toBeLessThan(0.02);
  });

  it("refuses a supplied brand ground it cannot see — a photograph's modal tone is not a brand ground", () => {
    const anchored = measured(noiseSlide(), { expected: { ground: GROUND } });
    expect(anchored.backgroundMatchesBrandGround).toBe(false);
    expect(anchored.backgroundHex).not.toBe(GROUND);
  });

  it("reports NO dominant colour, which is the honest reading of a photograph", () => {
    // The count is "5-bit colours each holding at least half a percent of the
    // frame" — a slide's palette. A noise field spreads 248,832 pixels over
    // 32,768 bins, so not one bin reaches the floor. A caller reading this
    // number as "monochrome" has to read `imageryShare` beside it.
    expect(metrics.quantisedColourCount).toBe(0);
  });
});

describe("half the plate as one solid accent block", () => {
  function halfAccent(): Uint8Array {
    const ground = rgb(GROUND);
    const accent = rgb(ACCENT);
    return encodeRgbPng(SMALL_PX.w, SMALL_PX.h, (row, y) => {
      row.fill(y < SMALL_PX.h / 2 ? accent : ground);
    });
  }

  const metrics = measured(halfAccent(), { expected: { ground: GROUND, accent: ACCENT } });

  it("reads as a graphic over exactly half the cells, and never as imagery", () => {
    expect(metrics.graphicShare).toBeCloseTo(0.5, 6);
    expect(metrics.imageryShare).toBe(0);
    expect(metrics.imageryOrDeviceShare).toBeCloseTo(0.5, 6);
  });

  it("has almost no edges — a wash is covered, not drawn", () => {
    // One boundary row of 432 px against 124,416 ink pixels.
    expect(metrics.edgeDensity).toBeLessThan(0.01);
    expect(metrics.inkShare).toBeCloseTo(0.5, 6);
  });

  it("measures the accent's own share and reports it present", () => {
    expect(metrics.accentShare).toBeCloseTo(0.5, 6);
    expect(metrics.accentPresent).toBe(true);
  });

  it("reports exactly two colours and the brand ground it was given", () => {
    expect(metrics.quantisedColourCount).toBe(2);
    expect(metrics.backgroundHex).toBe(GROUND);
    expect(metrics.backgroundMatchesBrandGround).toBe(true);
  });

  it("reports no accent at all when the caller named none — an accent is never guessed", () => {
    const unnamed = measured(halfAccent(), { expected: { ground: GROUND } });
    expect(unnamed.accentShare).toBe(0);
    expect(unnamed.accentPresent).toBe(false);
    expect(unnamed.graphicShare).toBeCloseTo(0.5, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ANTIALIASED TYPE — the fixture that makes the coverage precondition
// load-bearing
// ─────────────────────────────────────────────────────────────────────────

/**
 * A band of type WITH ANTIALIASING, which is the case that decides whether
 * `imageryShare` means anything.
 *
 * Chromium antialiases a glyph edge over about a pixel, and a curved edge
 * blends by a different fraction on every row — so an 8x8 patch straddling a
 * stroke holds the ground colour, the foreground colour, and a handful of
 * intermediate tones. That is six or more distinct 5-bit colours with an
 * enormous standard deviation: EXACTLY the signature of a photograph, on a
 * cell that contains nothing but a letter.
 *
 * What separates them is coverage. A photograph fills its cells; a stroke
 * this narrow leaves three of eight columns as ground. Take the coverage
 * precondition off `imageryShare` and this fixture reports itself as
 * imagery — which would let a headline-only cover clear the "carries
 * something" floor that exists to fail it. That is why the assertion below
 * is `imageryShare === 0` and not merely "small".
 */
function antialiasedTypeSlide(): Uint8Array {
  const ground = parseHexRgb(GROUND)!;
  const fg = parseHexRgb(FOREGROUND)!;
  const blend = (t: number): Buffer =>
    Buffer.from([Math.round(ground[0] + (fg[0] - ground[0]) * t), Math.round(ground[1] + (fg[1] - ground[1]) * t), Math.round(ground[2] + (fg[2] - ground[2]) * t)]);
  const groundPx = Buffer.from(ground);
  const solid = Buffer.from(fg);

  return encodeRgbPng(SMALL_PX.w, SMALL_PX.h, (row, y) => {
    row.fill(groundPx);
    if (y < 300 || y >= 400) return;
    // A different edge coverage on every row, the way a curve antialiases.
    const edge = blend(0.15 + (0.7 * (y % 6)) / 5);
    // 1px edge + 3px solid + 1px edge = 5 of every 8 columns, so no cell is
    // ever substantially covered.
    for (let x = 0; x < SMALL_PX.w - 5; x += 16) {
      edge.copy(row, x * 3);
      solid.copy(row, (x + 1) * 3);
      solid.copy(row, (x + 2) * 3);
      solid.copy(row, (x + 3) * 3);
      edge.copy(row, (x + 4) * 3);
    }
  });
}

describe("antialiased type is type, not imagery", () => {
  const metrics = measured(antialiasedTypeSlide(), { expected: { ground: GROUND } });

  it("carries the full photographic signature — many colours, huge spread — and still reads as NO imagery and NO device", () => {
    expect(metrics.imageryShare).toBe(0);
    expect(metrics.graphicShare).toBe(0);
    expect(metrics.imageryOrDeviceShare).toBe(0);
  });

  it("reads as text instead, and is occupied where the band is", () => {
    expect(metrics.textShare).toBeGreaterThan(0.02);
    expect(metrics.occupiedShare).toBeGreaterThan(metrics.textShare * 0.9);
  });

  it("still finds its brand ground under the antialiasing", () => {
    expect(metrics.backgroundHex).toBe(GROUND);
    expect(metrics.backgroundMatchesBrandGround).toBe(true);
    expect(metrics.flatBackgroundShare).toBeGreaterThan(0.8);
  });

  it("proves the precondition is the only thing holding the classification, by measuring the cells it depends on", () => {
    // If the band's cells were merely low-variety, the coverage rule would be
    // redundant. They are not: quantised down to 5 bits this fixture uses the
    // ground, the foreground and six intermediate tones, and the tolerances
    // put every one of the five stem columns beyond the ink threshold.
    const [gr, gg, gb] = parseHexRgb(GROUND)!;
    const [fr, fg2, fb] = parseHexRgb(FOREGROUND)!;
    const faintest = 0.15;
    const faintDistance = colourDistance(
      gr + (fr - gr) * faintest,
      gg + (fg2 - gg) * faintest,
      gb + (fb - gb) * faintest,
      gr,
      gg,
      gb,
    );
    expect(faintDistance, "even the faintest edge tone is ink, so the stem is 5 of 8 columns wide").toBeGreaterThan(DEFAULT_MEASURE_TOLERANCES.ink);
    expect(5 / 8, "and 5 of 8 columns is below the coverage line").toBeLessThan(48 / 64);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Geometry: the maximal empty rectangle
// ─────────────────────────────────────────────────────────────────────────

describe("largestEmptyRect returns the larger of two holes, in exact design px", () => {
  /** One full-width solid bar across design rows 40..47, leaving a 40-design-px hole above and a 240-design-px hole below. */
  function barSlide(): Uint8Array {
    const ground = rgb(GROUND);
    const ink = rgb(FOREGROUND);
    return encodeRgbPng(SMALL_PX.w, SMALL_PX.h, (row, y) => {
      row.fill(y >= 80 && y < 96 ? ink : ground);
    });
  }

  const metrics = measured(barSlide());

  it("names the lower, larger hole and not the upper one", () => {
    expect(metrics.largestEmptyRect).toEqual({ x: 0, y: 48, w: 216, h: 240 });
    expect(metrics.largestEmptyRectShare).toBeCloseTo(240 / 288, 6);
  });

  it("reports the whole canvas as the hole when nothing is on the plate at all", () => {
    const blank = measured(encodeRgbPng(SMALL_PX.w, SMALL_PX.h, (row) => row.fill(rgb(GROUND))));
    expect(blank.largestEmptyRect).toEqual({ x: 0, y: 0, w: SMALL.w, h: SMALL.h });
    expect(blank.largestEmptyRectShare).toBe(1);
    expect(blank.inkShare).toBe(0);
    expect(blank.occupiedShare).toBe(0);
    expect(blank.edgeDensity).toBe(0); // no ink at all: a ratio with no denominator is reported as zero, not NaN
  });

  it("reports no hole at all on a fully covered plate", () => {
    const covered = measured(noiseSlide());
    expect(covered.largestEmptyRect.w * covered.largestEmptyRect.h).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Clipping at the canvas edge
// ─────────────────────────────────────────────────────────────────────────

describe("clippedEdgeShare sees ink inside the 8-design-px bleed band", () => {
  it("counts a full-width strip pressed against the top edge", () => {
    const ground = rgb(GROUND);
    const ink = rgb(FOREGROUND);
    // 16 screenshot px == 8 design px, exactly the band.
    const clipped = measured(encodeRgbPng(SMALL_PX.w, SMALL_PX.h, (row, y) => row.fill(y < 16 ? ink : ground)));
    expect(clipped.clippedEdgeShare).toBeCloseTo((SMALL_PX.w * 16) / (SMALL_PX.w * SMALL_PX.h), 6);
  });

  it("counts nothing for a strip held clear of every edge", () => {
    const ground = rgb(GROUND);
    const ink = rgb(FOREGROUND);
    // Inset on all four sides: a FULL-WIDTH strip would still cross the left
    // and right bands, which is correct and is why this fixture is inset in
    // both axes.
    const inset = measured(
      encodeRgbPng(SMALL_PX.w, SMALL_PX.h, (row, y) => {
        row.fill(ground);
        if (y >= 40 && y < 56) ink.copy(row, 40 * 3, 0, 160 * 3);
      }),
    );
    expect(inset.clippedEdgeShare).toBe(0);
    expect(inset.inkShare).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Never throws, never guesses, always the same answer
// ─────────────────────────────────────────────────────────────────────────

describe("measureSlidePng refuses instead of failing", () => {
  it("returns { ok: false } for an undecodable buffer and does not throw", () => {
    const outcome = measureSlidePng(new Uint8Array([1, 2, 3, 4, 5]));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/PNG/);
  });

  it("returns { ok: false } for an empty buffer", () => {
    expect(measureSlidePng(new Uint8Array(0)).ok).toBe(false);
  });

  it("returns { ok: false } when the PNG is not an integer multiple of the design canvas, naming both sizes", () => {
    const odd = encodeRgbPng(1000, 1440, (row) => row.fill(rgb(GROUND)));
    const outcome = measureSlidePng(odd, { design: DEFAULT_DESIGN_CANVAS });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("1000x1440");
    expect(outcome.ok === false && outcome.reason).toContain("1080x1440");
  });

  it("returns { ok: false } for a design canvas that is not a multiple of the cell", () => {
    const outcome = measureSlidePng(encodeRgbPng(10, 10, (row) => row.fill(rgb(GROUND))), { design: { w: 5, h: 5 } });
    expect(outcome.ok).toBe(false);
  });

  it("gives byte-identical numbers for the same PNG measured twice", () => {
    const bytes = noiseSlide();
    const first = measured(bytes, { expected: { ground: GROUND, accent: ACCENT } });
    const second = measured(bytes, { expected: { ground: GROUND, accent: ACCENT } });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("gives byte-identical numbers for two independently built copies of the same picture", () => {
    expect(JSON.stringify(measured(noiseSlide()))).toBe(JSON.stringify(measured(noiseSlide())));
  });
});

describe("the caller's tolerances are parameters, not hidden constants", () => {
  it("counts a near-ground tone as flat at the default tolerance and as ink at a tightened one", () => {
    // #1E1F24 is ~7 units off #17181C on the weighted scale: inside the
    // default 12-unit ground tolerance, outside a 3-unit one.
    const near = "#1E1F24";
    const [nr, ng, nb] = parseHexRgb(near)!;
    const [gr, gg, gb] = parseHexRgb(GROUND)!;
    const separation = colourDistance(nr, ng, nb, gr, gg, gb);
    expect(separation).toBeGreaterThan(3);
    expect(separation).toBeLessThan(12);

    const bytes = encodeRgbPng(SMALL_PX.w, SMALL_PX.h, (row, y) => row.fill(y < SMALL_PX.h / 2 ? rgb(near) : rgb(GROUND)));
    expect(measured(bytes, { expected: { ground: GROUND } }).flatBackgroundShare).toBeCloseTo(1, 6);
    expect(measured(bytes, { expected: { ground: GROUND }, tolerances: { flat: 3, ink: 4 } }).flatBackgroundShare).toBeCloseTo(0.5, 6);
  });
});
