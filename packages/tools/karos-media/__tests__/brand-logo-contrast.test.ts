import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BRAND_LOGO_CONTRAST_FLOOR,
  contrastRatio,
  logoContrastAgainst,
  normalizeHex,
  planBrandLogoPlacement,
  readBrandLogoInk,
  relativeLuminance,
  type BrandLogoInkProfile,
} from "../src/brand-logo.js";

/**
 * AU38 (SCRUM-322). The point of this file is that NOTHING in it is mocked.
 *
 * The contrast numbers below are checked against ratios published by the
 * WCAG 2.x understanding documents and the standard contrast checkers, not
 * against this implementation's own output; the PNGs are real PNGs, encoded
 * here byte by byte (signature, IHDR, deflated+filtered IDAT, IEND) from
 * pixel values chosen in the test, and decoded back by the shipping decoder.
 * A `passes: true` boolean anywhere in this pipeline would make every one of
 * these assertions vacuous, which is exactly why there isn't one.
 */

// ─────────────────────────────────────────────────────────────────────────
// A real minimal PNG encoder, so the decoder is fed real bytes
// ─────────────────────────────────────────────────────────────────────────

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Forward-filters and deflates real scanlines into a real PNG. `filters` cycles per row so every filter type gets exercised. */
function encodePng(options: {
  width: number;
  height: number;
  colorType: number;
  /** Row-major channel bytes, `width * channels` per row. */
  rows: number[][];
  filters?: number[];
  palette?: number[];
  paletteAlpha?: number[];
}): Uint8Array {
  const { width, height, colorType, rows } = options;
  const bpp = CHANNELS[colorType]!;
  const stride = width * bpp;
  const filters = options.filters ?? [0];

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // no interlace

  const filtered: number[] = [];
  let prior = new Array<number>(stride).fill(0);
  for (let y = 0; y < height; y++) {
    const raw = rows[y]!;
    expect(raw.length, `row ${y} must be ${stride} bytes`).toBe(stride);
    const filter = filters[y % filters.length]!;
    filtered.push(filter);
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? raw[x - bpp]! : 0;
      const up = prior[x]!;
      const upLeft = x >= bpp ? prior[x - bpp]! : 0;
      let value: number;
      switch (filter) {
        case 1:
          value = raw[x]! - left;
          break;
        case 2:
          value = raw[x]! - up;
          break;
        case 3:
          value = raw[x]! - ((left + up) >> 1);
          break;
        case 4:
          value = raw[x]! - paeth(left, up, upLeft);
          break;
        default:
          value = raw[x]!;
      }
      filtered.push(value & 0xff);
    }
    prior = raw;
  }

  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(options.palette ? [chunk("PLTE", Buffer.from(options.palette))] : []),
    ...(options.paletteAlpha ? [chunk("tRNS", Buffer.from(options.paletteAlpha))] : []),
    chunk("IDAT", zlib.deflateSync(Buffer.from(filtered))),
    chunk("IEND", Buffer.alloc(0)),
  ];
  return new Uint8Array(Buffer.concat(chunks));
}

/** An RGBA logo: `mark` pixels on the left half, fully transparent on the right. */
function rgbaMark(size: number, mark: [number, number, number], filters?: number[]): Uint8Array {
  const rows: number[][] = [];
  for (let y = 0; y < size; y++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) row.push(...(x < size / 2 ? [...mark, 255] : [0, 0, 0, 0]));
    rows.push(row);
  }
  return encodePng({ width: size, height: size, colorType: 6, rows, ...(filters ? { filters } : {}) });
}

function inkOf(bytes: Uint8Array, mime = "image/png"): BrandLogoInkProfile {
  const profile = readBrandLogoInk({ bytes, mime });
  expect(profile, "the decoder must read this asset").toBeDefined();
  return profile!;
}

// ─────────────────────────────────────────────────────────────────────────

describe("WCAG contrast math (real values, checked against published ratios)", () => {
  it("reproduces the published reference ratios exactly", () => {
    // The two anchors of the scale.
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 10);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 10);

    // The classic AA boundary pair on white: #767676 passes 4.5:1, #777777 does not.
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#767676", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeLessThan(4.5);

    // Pure primaries on white, as every contrast checker reports them.
    expect(contrastRatio("#0000FF", "#FFFFFF")).toBeCloseTo(8.59, 2);
    expect(contrastRatio("#FF0000", "#FFFFFF")).toBeCloseTo(4.0, 2);
    expect(contrastRatio("#00FF00", "#FFFFFF")).toBeCloseTo(1.37, 2);
    expect(contrastRatio("#808080", "#FFFFFF")).toBeCloseTo(3.95, 2);

    // And on black, where the same colors sit on the other side of the scale.
    expect(contrastRatio("#0000FF", "#000000")).toBeCloseTo(2.44, 2);
    expect(contrastRatio("#767676", "#000000")).toBeCloseTo(4.62, 2);
  });

  it("is symmetric, and shorthand hex is the same color as longhand", () => {
    expect(contrastRatio("#123456", "#ABCDEF")).toBeCloseTo(contrastRatio("#ABCDEF", "#123456"), 12);
    expect(contrastRatio("#000", "#FFF")).toBeCloseTo(21, 10);
    expect(contrastRatio("#0000", "#FFFFFFFF")).toBeCloseTo(21, 10);
  });

  it("returns NaN — never a passing number — for anything that is not a hex color", () => {
    for (const bad of ["", "rebeccapurple", "#12345", "#1234567", "rgb(0,0,0)", "var(--bg)"]) {
      expect(Number.isNaN(contrastRatio(bad, "#FFFFFF")), `${bad} must not parse`).toBe(true);
      // The guard that matters: an unparsed token can never satisfy the floor.
      expect(contrastRatio(bad, "#FFFFFF") >= BRAND_LOGO_CONTRAST_FLOOR).toBe(false);
    }
  });

  it("computes WCAG relative luminance, not a lightness approximation", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 12);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 12);
    // Sanity that the sRGB transfer curve is applied: mid-gray is ~0.216, not 0.5.
    expect(relativeLuminance("#808080")!).toBeCloseTo(0.2159, 3);
    expect(relativeLuminance("nonsense")).toBeUndefined();
  });

  it("normalizes hex the way CSS does, and refuses invalid lengths", () => {
    expect(normalizeHex("#abc")).toBe("#AABBCC");
    expect(normalizeHex("  #17181c  ")).toBe("#17181C");
    expect(normalizeHex("#12345678")).toBe("#123456");
    expect(normalizeHex("#12345")).toBeUndefined();
    expect(normalizeHex(42)).toBeUndefined();
  });
});

describe("reading a mark's colors out of real bytes", () => {
  it("decodes a real RGBA PNG and reports the mark's color, ignoring fully transparent pixels", () => {
    const ink = inkOf(rgbaMark(8, [0, 0, 0]));
    expect(ink.source).toBe("png");
    expect(ink.samples).toHaveLength(1);
    expect(ink.samples[0]!.hex).toBe("#000000");
    expect(ink.samples[0]!.weight).toBeCloseTo(1, 10);
  });

  it("unfilters every PNG filter type identically — Sub/Up/Average/Paeth rows decode to the same mark as None rows", () => {
    const plain = inkOf(rgbaMark(8, [214, 32, 96]));
    const filtered = inkOf(rgbaMark(8, [214, 32, 96], [0, 1, 2, 3, 4]));
    expect(filtered.samples).toEqual(plain.samples);
    expect(plain.samples[0]!.hex).toBe("#D62060");
  });

  it("decodes truecolor, grayscale and palette PNGs", () => {
    const rgb = inkOf(encodePng({ width: 2, height: 2, colorType: 2, rows: [[255, 0, 0, 255, 0, 0], [255, 0, 0, 255, 0, 0]] }));
    expect(rgb.samples[0]!.hex).toBe("#FF0000");

    const gray = inkOf(encodePng({ width: 2, height: 2, colorType: 0, rows: [[128, 128], [128, 128]] }));
    expect(gray.samples[0]!.hex).toBe("#808080");

    // Palette entry 0 is white and fully transparent; entry 1 is the mark.
    const paletted = inkOf(
      encodePng({
        width: 2,
        height: 2,
        colorType: 3,
        rows: [[0, 1], [1, 0]],
        palette: [255, 255, 255, 0, 0, 255],
        paletteAlpha: [0, 255],
      }),
    );
    expect(paletted.samples[0]!.hex).toBe("#0000FF");
  });

  it("reports every significant mass of a two-tone mark, and the contrast is the BEST mass, not the average", () => {
    // A dark wordmark exported on an opaque white plate: half white, half black.
    const rows: number[][] = [];
    for (let y = 0; y < 8; y++) {
      const row: number[] = [];
      for (let x = 0; x < 8; x++) row.push(...(x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
      rows.push(row);
    }
    const ink = inkOf(encodePng({ width: 8, height: 8, colorType: 6, rows }));
    expect(ink.samples.map((s) => s.hex).sort()).toEqual(["#000000", "#FFFFFF"]);

    // Legible on BOTH poles, because one of its two masses always separates.
    expect(logoContrastAgainst(ink, "#FFFFFF")).toEqual({ ratio: 21, hex: "#000000" });
    expect(logoContrastAgainst(ink, "#000000")).toEqual({ ratio: 21, hex: "#FFFFFF" });
    // An averaged implementation would report ~1 here and be wrong twice over.
  });

  it("reads an SVG's declared paints — the format most real client logos ship in", () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="none" stroke="none"/>` +
        `<path fill="#0A0A0A" d="M0 0"/><path style="fill:rgb(255, 255, 255)"/><circle stroke="white"/></svg>`,
      "utf8",
    );
    const ink = inkOf(new Uint8Array(svg), "image/svg+xml");
    expect(ink.source).toBe("svg");
    expect(ink.samples.map((s) => s.hex).sort()).toEqual(["#0A0A0A", "#FFFFFF"]);
  });

  it("reports UNREADABLE rather than a fake pass for formats it cannot decode", () => {
    expect(readBrandLogoInk({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mime: "image/jpeg" })).toBeUndefined();
    expect(readBrandLogoInk({ bytes: new Uint8Array([1, 2, 3, 4]), mime: "image/png" })).toBeUndefined();
    expect(readBrandLogoInk({ bytes: new Uint8Array(Buffer.from("<svg/>", "utf8")), mime: "image/svg+xml" })).toBeUndefined();
    // A fully transparent PNG has no mark to measure.
    const blank = encodePng({ width: 2, height: 2, colorType: 6, rows: [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]] });
    expect(readBrandLogoInk({ bytes: blank, mime: "image/png" })).toBeUndefined();
  });
});

describe("planBrandLogoPlacement — the enforcement itself", () => {
  /** The default templates' own `:root { --bg: #17181C }`. */
  const DARK_GROUND = "#17181C";
  const blackMark = () => inkOf(rgbaMark(8, [0, 0, 0]));
  const whiteMark = () => inkOf(rgbaMark(8, [255, 255, 255]));

  it("places a mark that clears the floor, and reports the ratio it actually measured", () => {
    const plan = planBrandLogoPlacement({ ground: DARK_GROUND, ink: whiteMark() });
    expect(plan.decision).toBe("place");
    expect(plan.scrim).toBeUndefined();
    expect(plan.contrastingHex).toBe("#FFFFFF");
    // Not "greater than the floor" — the real number, computed from #17181C.
    expect(plan.groundContrast).toBeCloseTo(contrastRatio("#FFFFFF", DARK_GROUND), 12);
    expect(plan.groundContrast).toBeCloseTo(17.7, 1);
  });

  it("CATCHES a planted low-contrast pairing: a black mark on the default dark ground is never placed as-is", () => {
    const ink = blackMark();
    // The planted failure, stated as a real number first: 1.18:1, far under 3:1.
    const measured = contrastRatio("#000000", DARK_GROUND);
    expect(measured).toBeCloseTo(1.18, 2);
    expect(measured).toBeLessThan(BRAND_LOGO_CONTRAST_FLOOR);

    const plan = planBrandLogoPlacement({ ground: DARK_GROUND, ink });
    expect(plan.decision).not.toBe("place"); // the whole ticket, in one line
    expect(plan.decision).toBe("scrim");
    expect(plan.groundContrast).toBeCloseTo(measured, 12);
    expect(plan.scrim?.color).toBe("#FFFFFF");
    // The remediation is itself verified, not assumed: 21:1 on the plate.
    expect(plan.scrim?.contrast).toBeCloseTo(21, 10);
    expect(plan.scrim!.contrast).toBeGreaterThanOrEqual(BRAND_LOGO_CONTRAST_FLOOR);
    expect(plan.reason).toContain("1.18:1");
  });

  it("prefers the kit's own fg as the scrim plate when that plate is itself legible", () => {
    const plan = planBrandLogoPlacement({ ground: DARK_GROUND, ink: blackMark(), fg: "#F4F2EC" });
    expect(plan.decision).toBe("scrim");
    expect(plan.scrim?.color).toBe("#F4F2EC");
    expect(plan.scrim?.contrast).toBeCloseTo(contrastRatio("#000000", "#F4F2EC"), 12);

    // ...and falls past it to an achromatic plate when the kit's fg would not help.
    const dimFg = planBrandLogoPlacement({ ground: DARK_GROUND, ink: blackMark(), fg: "#101010" });
    expect(dimFg.scrim?.color).toBe("#FFFFFF");
  });

  it("OMITS the mark on a surface that cannot carry a scrim, rather than rendering it into its own background", () => {
    const plan = planBrandLogoPlacement({ ground: DARK_GROUND, ink: blackMark(), allowScrim: false, surface: "cover" });
    expect(plan.decision).toBe("omit");
    expect(plan.groundContrast).toBeLessThan(BRAND_LOGO_CONTRAST_FLOOR);
    expect(plan.reason).toContain("cannot carry a scrim");
  });

  it("omits rather than guesses when the background token is not a color it can parse", () => {
    const plan = planBrandLogoPlacement({ ground: "var(--bg)", ink: blackMark() });
    expect(plan.decision).toBe("omit");
    expect(plan.groundContrast).toBeUndefined();
  });

  it("says plainly that an unreadable mark was not checked, instead of reporting a contrast it never computed", () => {
    const plan = planBrandLogoPlacement({ ground: DARK_GROUND });
    expect(plan.decision).toBe("place");
    expect(plan.groundContrast).toBeUndefined();
    expect(plan.reason).toContain("could not be read");
  });

  it("chooses the corner by rule: the series badge owns the start side, so the mark takes the end side", () => {
    expect(planBrandLogoPlacement({ ground: DARK_GROUND, ink: whiteMark() }).corner).toBe("top-start");
    expect(planBrandLogoPlacement({ ground: DARK_GROUND, ink: whiteMark(), hasSeriesBadge: true }).corner).toBe("top-end");
    // A video cover's series header is centred in the bar, so nothing yields.
    expect(planBrandLogoPlacement({ ground: DARK_GROUND, ink: whiteMark(), hasSeriesBadge: true, surface: "cover" }).corner).toBe("top-start");
  });

  it("is a pure function of its inputs — the same kit plans identically every time", () => {
    const once = planBrandLogoPlacement({ ground: DARK_GROUND, ink: blackMark(), fg: "#F4F2EC", hasSeriesBadge: true });
    const twice = planBrandLogoPlacement({ ground: DARK_GROUND, ink: blackMark(), fg: "#F4F2EC", hasSeriesBadge: true });
    expect(once).toEqual(twice);
  });

  it("every ground in the sRGB cube lands on a legible arrangement or an explicit omission — never an unchecked render", () => {
    const ink = blackMark();
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const ground = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          const plan = planBrandLogoPlacement({ ground, ink });
          if (plan.decision === "place") {
            expect(plan.groundContrast!, ground).toBeGreaterThanOrEqual(BRAND_LOGO_CONTRAST_FLOOR);
          } else {
            expect(plan.decision, ground).toBe("scrim");
            expect(plan.scrim!.contrast, ground).toBeGreaterThanOrEqual(BRAND_LOGO_CONTRAST_FLOOR);
          }
        }
      }
    }
  });
});
