import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { measureSlidePng, parseHexRgb, SlideMetricsSchema, wcagContrastRatio, type SlideMetrics } from "../src/slide-metrics.js";

/**
 * THE CONTROLS FOR `markedShare` / `markColourCount`, and the composition
 * evidence that ships beside them (RFC-17 §3.3, §5.6).
 *
 * Chromium-free and nothing is mocked. Every fixture is a REAL PNG built here
 * from chosen pixels and decoded back by the shipping decoder, the same shape
 * `slide-metrics.test.ts` already uses — there is no hand-written metrics
 * object anywhere in this file, because one would make every assertion in it
 * vacuous. The point is that the INSTRUMENT reads real pixels correctly.
 *
 * ## What the controls are for
 *
 * `markColourCount` is a number the next phase will be tempted to gate on,
 * and RFC-17 finding 5 refuses that on the strength of exactly one control:
 * **B2, the owner's grey screen with two marks stuck on it, scores 2.** A
 * floor of 3 would therefore sit ONE MARK above the very defect the interest
 * floor exists to catch. That number is asserted below rather than only
 * written in the RFC, so the reason the clause was refused is pinned in the
 * suite and a future phase has to change a test to forget it.
 *
 * ## Cell-aligned by construction
 *
 * Every rectangle's x/y/w/h is a multiple of `CELL_DESIGN_PX` (4), so each
 * measurement cell is entirely one colour. That makes each cell's mean exact
 * and its standard deviation zero, which is what lets a fixture assert an
 * exact `markColourCount` instead of a range. It also means these fixtures
 * say nothing about antialiased edges — the `flat` limb's behaviour on a real
 * AA fringe is a Chromium claim and CI is its gate.
 */

// ─────────────────────────────────────────────────────────────────────────
// A real PNG encoder
// ─────────────────────────────────────────────────────────────────────────

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

interface Rect {
  /** DESIGN px, every value a multiple of 4 so the rectangle lands on cell boundaries. */
  x: number;
  y: number;
  w: number;
  h: number;
  hex: string;
}

/** The design canvas these plates are measured against. Small on purpose: the grid is fixed BY the design canvas, so the geometry is identical at 1080x1440 and a 6.2-megapixel frame per assertion would make this file take a minute. */
const DESIGN = { w: 216, h: 288 } as const;
const SCALE = 2;

function rgbOf(hex: string): [number, number, number] {
  const parsed = parseHexRgb(hex);
  if (parsed === undefined) throw new Error(`${hex} is not a hex this module parses`);
  return parsed;
}

/** Later rectangles paint over earlier ones. */
function plate(ground: string, rects: readonly Rect[]): Uint8Array {
  const width = DESIGN.w * SCALE;
  const height = DESIGN.h * SCALE;
  const groundRgb = rgbOf(ground);
  const painted = rects.map((r) => ({ ...r, rgb: rgbOf(r.hex) }));
  for (const r of rects) {
    for (const value of [r.x, r.y, r.w, r.h]) {
      if (value % 4 !== 0) throw new Error(`rect ${JSON.stringify(r)} is not cell-aligned — every coordinate must be a multiple of 4 design px`);
    }
  }

  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dy = y / SCALE;
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const dx = x / SCALE;
      let colour = groundRgb;
      for (const r of painted) {
        if (dx >= r.x && dx < r.x + r.w && dy >= r.y && dy < r.y + r.h) colour = r.rgb;
      }
      const offset = rowStart + 1 + x * 3;
      raw[offset] = colour[0];
      raw[offset + 1] = colour[1];
      raw[offset + 2] = colour[2];
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

function measure(bytes: Uint8Array, expected: { ground?: string; ink?: string; accent?: string; marks?: readonly string[] }): SlideMetrics {
  const outcome = measureSlidePng(bytes, { design: { w: DESIGN.w, h: DESIGN.h }, expected });
  if (!outcome.ok) throw new Error(`the fixture did not measure: ${outcome.reason}`);
  // Parsed on every call, so a field added to the schema without a value — or
  // a value of the wrong shape — fails here rather than in a sweep.
  expect(SlideMetricsSchema.parse(outcome.metrics)).toEqual(outcome.metrics);
  return outcome.metrics;
}

// ─────────────────────────────────────────────────────────────────────────
// The palettes
// ─────────────────────────────────────────────────────────────────────────

/** The bundled dark pair. Our default ground is `#17181C`, which is why RFC-17 finding 2 matters at all. */
const DARK_GROUND = "#17181C";
const LIGHT_INK = "#F4F2EC";

/** A Phase-2 ground decoration: off the ground, off the ink, flat, and covering area — every limb of the mark definition except intent. */
const DECORATION = "#3A3F52";

/** Two mark colours for control B2. */
const B2_MARK_A = "#C9A227";
const B2_MARK_B = "#4FB286";

/** The reference plates' pair: paper and a near-black serif. */
const PAPER = "#EFEDE8";
const DARK_INK = "#111111";

/** rf-11's four marks, read off the reference: yellow, chartreuse, cyan, lilac. */
const REFERENCE_MARKS = ["#F2E14C", "#C6EF5A", "#9BE6E0", "#D9BFF2"] as const;

// ─────────────────────────────────────────────────────────────────────────
// The five controls
// ─────────────────────────────────────────────────────────────────────────

/**
 * CONTROL A — the bare grey screen.
 *
 * Ground, and one solid slab of INK standing in for the interior of a display
 * headline's strokes. Every cell of that slab is covered, flat and off the
 * ground: it satisfies limbs (i), (ii) and (iii) and is rejected by limb (iv)
 * alone. This is the fixture the off-ink limb exists for, and the break-it
 * run in the PR body is deleting limb (iv) and watching this control's count
 * go from 0 to 1.
 */
const CONTROL_A: readonly Rect[] = [{ x: 16, y: 200, w: 184, h: 40, hex: LIGHT_INK }];

/** CONTROL B — the same grey screen with ONE Phase-2 decoration over it. */
const CONTROL_B: readonly Rect[] = [{ x: 0, y: 0, w: 216, h: 48, hex: DECORATION }, ...CONTROL_A];

/**
 * CONTROL B2 — the owner's grey screen with TWO marks stuck on it.
 *
 * THE CONTROL THAT REFUSES CLAUSE H. It scores 2, a third mark takes it to 3,
 * and a gate whose floor is one mark above the defect it exists to catch is
 * not a gate. Nothing may read `markColourCount` as a verdict.
 */
const CONTROL_B2: readonly Rect[] = [
  ...CONTROL_A,
  { x: 16, y: 160, w: 64, h: 16, hex: B2_MARK_A },
  { x: 96, y: 160, w: 64, h: 16, hex: B2_MARK_B },
];

/** CONTROL C — the dense reference list (rf-11): eight rows, each with a marked term, four hues cycling. */
const CONTROL_C: readonly Rect[] = Array.from({ length: 8 }, (_, i) => [
  { x: 144, y: 28 + i * 24, w: 56, h: 16, hex: REFERENCE_MARKS[i % 4]! },
  { x: 16, y: 32 + i * 24, w: 120, h: 8, hex: DARK_INK },
]).flat();

/** CONTROL D — the deliberate near-empty plate (rf-05 S8): two lines of type, four marks, and a great deal of bare paper. */
const CONTROL_D: readonly Rect[] = [
  { x: 40, y: 112, w: 136, h: 8, hex: DARK_INK },
  { x: 40, y: 124, w: 40, h: 8, hex: REFERENCE_MARKS[0]! },
  { x: 96, y: 124, w: 40, h: 8, hex: REFERENCE_MARKS[1]! },
  { x: 40, y: 148, w: 136, h: 8, hex: DARK_INK },
  { x: 40, y: 160, w: 40, h: 8, hex: REFERENCE_MARKS[2]! },
  { x: 96, y: 160, w: 40, h: 8, hex: REFERENCE_MARKS[3]! },
];

describe("markColourCount separates the controls", () => {
  it("scores 0 on the bare grey screen — a display stroke's interior is not a mark", () => {
    const metrics = measure(plate(DARK_GROUND, CONTROL_A), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(metrics.backgroundHex).toBe(DARK_GROUND);
    expect(metrics.markColourCount).toBe(0);
    expect(metrics.markedShare).toBe(0);
  });

  it("scores 1 on the one-hue decorated grey screen", () => {
    const metrics = measure(plate(DARK_GROUND, CONTROL_B), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(metrics.markColourCount).toBe(1);
    expect(metrics.markedShare).toBeGreaterThan(0);
  });

  /**
   * THE NUMBER THAT REFUSES CLAUSE H, asserted rather than remembered.
   *
   * If this ever reads 3 or more the argument in RFC-17 finding 5 has changed
   * and the refusal has to be re-argued from the new control, not quietly
   * revisited.
   */
  it("scores 2 on the owner's grey screen with two marks stuck on it — which is why markColourCount cannot gate", () => {
    const metrics = measure(plate(DARK_GROUND, CONTROL_B2), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(metrics.markColourCount).toBe(2);
  });

  it("scores 4 on the dense reference list", () => {
    const metrics = measure(plate(PAPER, CONTROL_C), { ground: PAPER, ink: DARK_INK });
    expect(metrics.backgroundHex).toBe(PAPER);
    expect(metrics.markColourCount).toBe(4);
  });

  it("scores 4 on the deliberate near-empty plate", () => {
    const metrics = measure(plate(PAPER, CONTROL_D), { ground: PAPER, ink: DARK_INK });
    expect(metrics.markColourCount).toBe(4);
  });

  /**
   * AND THE POINT OF THE WHOLE THING, stated as one assertion: the count
   * cannot tell a deliberate plate from a neglected one, because the two good
   * plates and the marked grey screen differ by TWO. RFC-17 Part 3's ruling —
   * the floor does not move and nothing here is an exemption — rests on this.
   */
  it("cannot separate deliberate emptiness from neglect: the marked grey screen sits inside the good plates' band", () => {
    const marked = measure(plate(DARK_GROUND, CONTROL_B2), { ground: DARK_GROUND, ink: LIGHT_INK }).markColourCount;
    const empty = measure(plate(PAPER, CONTROL_D), { ground: PAPER, ink: DARK_INK }).markColourCount;
    expect(marked).toBeGreaterThan(0);
    expect(empty - marked).toBe(2);
  });
});

describe("the four limbs, one at a time", () => {
  it("limb (iv): with no ink token supplied, nothing is reported rather than a three-limb superset", () => {
    // The same plate that scores 0 WITH the token would score its display
    // slab as a mark without one, so the metric reports nothing instead.
    const withInk = measure(plate(DARK_GROUND, CONTROL_B2), { ground: DARK_GROUND, ink: LIGHT_INK });
    const without = measure(plate(DARK_GROUND, CONTROL_B2), { ground: DARK_GROUND });
    expect(withInk.markColourCount).toBe(2);
    expect(without.markColourCount).toBe(0);
    expect(without.markedShare).toBe(0);
    expect(without.groundInkContrast).toBe(0);
  });

  it("limb (iii): a cell that IS the ground is not a mark, however much of the plate it covers", () => {
    // A plate with nothing on it but ground. Every cell is covered by
    // definition of "not ink", flat, and at zero distance from the ground.
    const metrics = measure(plate(DARK_GROUND, []), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(metrics.markedShare).toBe(0);
    expect(metrics.markColourCount).toBe(0);
  });

  it("limb (ii): a textured field is not a mark, because a mark is FLAT", () => {
    // A checkerboard at the sample level: every cell alternates two colours
    // that are each off the ground and off the ink, so limbs (i), (iii) and
    // (iv) all pass and only the flatness limb can reject it.
    const width = DESIGN.w * SCALE;
    const height = DESIGN.h * SCALE;
    const stride = width * 3;
    const raw = Buffer.alloc(height * (stride + 1));
    const a = rgbOf("#C9A227");
    const b = rgbOf("#4FB286");
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1);
      raw[rowStart] = 0;
      for (let x = 0; x < width; x++) {
        const colour = (x + y) % 2 === 0 ? a : b;
        const offset = rowStart + 1 + x * 3;
        raw[offset] = colour[0];
        raw[offset + 1] = colour[1];
        raw[offset + 2] = colour[2];
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const bytes = new Uint8Array(
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
        chunk("IEND", Buffer.alloc(0)),
      ]),
    );
    const metrics = measure(bytes, { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(metrics.markedShare).toBe(0);
    expect(metrics.markColourCount).toBe(0);
  });

  it("a colour holding fewer than 16 cells does not count, and one holding 16 does", () => {
    const twelve = measure(plate(DARK_GROUND, [{ x: 16, y: 160, w: 24, h: 8, hex: B2_MARK_A }]), { ground: DARK_GROUND, ink: LIGHT_INK });
    const sixteen = measure(plate(DARK_GROUND, [{ x: 16, y: 160, w: 32, h: 8, hex: B2_MARK_A }]), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(twelve.markedShare).toBeGreaterThan(0); // the cells ARE marked...
    expect(twelve.markColourCount).toBe(0); // ...the COLOUR just does not hold enough of them
    expect(sixteen.markColourCount).toBe(1);
  });
});

describe("markedShare", () => {
  it("is the marked cells over the whole cell grid, and a mark of known size measures its own area", () => {
    // 64x16 design px = 16x4 = 64 cells, over 54x72 = 3888.
    const metrics = measure(plate(DARK_GROUND, [{ x: 16, y: 160, w: 64, h: 16, hex: B2_MARK_A }]), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(metrics.markedShare).toBeCloseTo(64 / ((DESIGN.w / 4) * (DESIGN.h / 4)), 10);
  });

  it("does not count the declared mark hexes it was handed — the definition is colour-agnostic on purpose", () => {
    // Declaring a colour that is nowhere on the plate changes nothing, and
    // declaring the right ones changes nothing either. A within-tolerance
    // test would make this metric a guard that cannot fail.
    const base = plate(DARK_GROUND, CONTROL_B2);
    const none = measure(base, { ground: DARK_GROUND, ink: LIGHT_INK });
    const wrong = measure(base, { ground: DARK_GROUND, ink: LIGHT_INK, marks: ["#FF00FF", "#00FF00"] });
    const right = measure(base, { ground: DARK_GROUND, ink: LIGHT_INK, marks: [B2_MARK_A, B2_MARK_B] });
    expect(wrong.markColourCount).toBe(none.markColourCount);
    expect(right.markColourCount).toBe(none.markColourCount);
    expect(wrong.markedShare).toBe(none.markedShare);
  });
});

describe("groundInkContrast is supplied, never inferred (RFC-17 finding 8)", () => {
  it("reports the bundled pair at 15.8:1", () => {
    const metrics = measure(plate(DARK_GROUND, CONTROL_A), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(metrics.groundInkContrast).toBeCloseTo(15.84, 1);
  });

  /**
   * The finding, reproduced as an assertion: on a DECORATED plate an
   * ink-inference path picks the decoration's tint, and the decoration's own
   * contrast against the ground is nothing like the real pair's. The supplied
   * token is indifferent to the decoration, which is the property that was
   * bought.
   */
  it("is unmoved by a decoration whose own contrast against the ground is a fraction of the real pair's", () => {
    const decorated = measure(plate(DARK_GROUND, CONTROL_B), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(decorated.groundInkContrast).toBeCloseTo(15.84, 1);
    const whatInferenceWouldHaveReported = wcagContrastRatio(rgbOf(DARK_GROUND), rgbOf(DECORATION));
    expect(whatInferenceWouldHaveReported).toBeLessThan(3);
  });

  it("is 0, never a guess, when no ink token was supplied", () => {
    expect(measure(plate(DARK_GROUND, CONTROL_A), { ground: DARK_GROUND }).groundInkContrast).toBe(0);
  });
});

describe("composition evidence, compared against nothing", () => {
  it("puts the centroid where the ink is", () => {
    const bottomLeft = measure(plate(DARK_GROUND, [{ x: 8, y: 200, w: 60, h: 60, hex: LIGHT_INK }]), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(bottomLeft.contentCentroid.x).toBeCloseTo((8 + 30) / DESIGN.w, 2);
    expect(bottomLeft.contentCentroid.y).toBeCloseTo((200 + 30) / DESIGN.h, 2);

    // 76+32 === 108 === w/2 and 112+32 === 144 === h/2, cell-aligned.
    const centred = measure(plate(DARK_GROUND, [{ x: 76, y: 112, w: 64, h: 64, hex: LIGHT_INK }]), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(centred.contentCentroid.x).toBeCloseTo(0.5, 2);
    expect(centred.contentCentroid.y).toBeCloseTo(0.5, 2);
  });

  it("bounds the ink, and reports a zero-area box on a plate with nothing on it", () => {
    const box = measure(plate(DARK_GROUND, [{ x: 8, y: 200, w: 60, h: 60, hex: LIGHT_INK }]), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(box.contentBBox).toEqual({ x: 8, y: 200, w: 60, h: 60 });

    const blank = measure(plate(DARK_GROUND, []), { ground: DARK_GROUND, ink: LIGHT_INK });
    expect(blank.contentBBox).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    // The frame centre, so a caller never reads (0,0) as a real placement —
    // `contentBBox.w === 0` is how "nothing painted" is told apart.
    expect(blank.contentCentroid).toEqual({ x: 0.5, y: 0.5 });
  });

  /**
   * The reason candidate 2 was abandoned, kept as a measurement rather than a
   * memory: the bounding box is the same on a plate with one line placed dead
   * centre and on one with the same line plus a stranded corner caption, so it
   * cannot be the deliberateness discriminator either. The centroid moves;
   * the box does not.
   */
  it("a stranded corner element snaps the bounding box to the frame, which is why the box alone cannot judge composition", () => {
    const line: Rect = { x: 48, y: 140, w: 120, h: 8, hex: LIGHT_INK };
    const alone = measure(plate(DARK_GROUND, [line]), { ground: DARK_GROUND, ink: LIGHT_INK });
    const stranded = measure(plate(DARK_GROUND, [line, { x: 4, y: 4, w: 8, h: 8, hex: LIGHT_INK }, { x: 204, y: 276, w: 8, h: 8, hex: LIGHT_INK }]), {
      ground: DARK_GROUND,
      ink: LIGHT_INK,
    });
    expect(alone.contentBBox.w).toBe(120);
    expect(stranded.contentBBox.w).toBeGreaterThan(200);
    expect(stranded.contentBBox.h).toBeGreaterThan(270);
  });
});

describe("nothing that already shipped moved", () => {
  /**
   * The five new fields are accumulators over data the classification loop
   * already had in hand. If adding them had perturbed a mask, a share or the
   * ground vote, that would show up here — the same plate measured with and
   * without an ink token reports identical numbers on every field that
   * predates RFC-17.
   */
  it("supplying an ink token changes only the RFC-17 fields", () => {
    const bytes = plate(PAPER, CONTROL_C);
    const without = measure(bytes, { ground: PAPER });
    const withInk = measure(bytes, { ground: PAPER, ink: DARK_INK });
    const strip = (m: SlideMetrics): Omit<SlideMetrics, "markedShare" | "markColourCount" | "groundInkContrast"> => {
      const { markedShare: _a, markColourCount: _b, groundInkContrast: _c, ...rest } = m;
      return rest;
    };
    expect(strip(without)).toEqual(strip(withInk));
  });
});
