/**
 * A photograph fixture that measures like a photograph.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Every Chromium-gated test in this package used to stand a photograph in
 * with a tiny solid PNG — a 1x1 grey pixel in `__tests__/fixtures/images/`, a
 * solid magenta 8x8 in the interest-floor calibration — because `object-fit:
 * cover` blows either one up to a full-bleed element and the AREA looked
 * right. Measured against `measureSlidePng`, they are the opposite of a
 * photograph on every axis it reads (`.local/hero-probe.mjs`, 2026-09-11):
 *
 *   hero fixture              bgHex     flat   occupied  emptyRect  imagery  img+dev
 *   solid magenta 8x8        #FF00FF   40.7%     58.1%      41.9%     3.9%    55.6%
 *   96x128, upscaled 11x     #17181C    8.2%     85.2%       7.6%     2.9%    28.7%
 *   1080x1440 (this file)    #17181C   12.4%     83.0%       7.6%    66.7%    68.2%
 *
 * Two independent defects, both the fixture's. A flat fill has ONE distinct
 * colour per cell, so it lands in the `graphic` bucket and never in
 * `imageryShare`. And because it is flat AND covers most of the plate, it
 * wins the modal-flat-cell vote and BECOMES the measured ground — at which
 * point the rest of the frame reads as bare ground and a visually full slide
 * reports a 41.9% empty rectangle and fails clause C.
 *
 * A real photograph does neither: it has variety in every cell, so it
 * contributes no flat cells to win the mode with, and the brand ground stays
 * the ground. Upscaling a small image cannot substitute — the browser's
 * bilinear smoothing removes exactly the per-cell variety being measured,
 * which is what the 96x128 row above shows. So the fixture is generated at
 * the design canvas's own size.
 */
import * as zlib from "node:zlib";

/** CRC-32, for the PNG chunk framing below. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A two-axis colour ramp plus deterministic per-pixel grain, which is what
 * gives every measured cell the six-plus distinct 5-bit colours and the
 * tonal spread the `imagery` bucket requires.
 *
 * Seeded from a fixed constant and filter-free, so two runs produce
 * byte-identical pixels: a number that moves in a calibration table means the
 * templates moved, never that the fixture did.
 *
 * Generate at the DESIGN canvas size (1080x1440), not the screenshot's
 * 2160x2880 — the measured grain survives the 2x upscale (66.7% imagery
 * against a 0.5 floor), and a screenshot-sized fixture would quadruple the
 * encode for nothing.
 */
export function syntheticPhotograph(width: number, height: number): Buffer {
  const GRAIN = 120;
  let seed = 0x2545f491;
  const noise = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * GRAIN;
  };
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  // One filter byte (0 = None) per scanline, then RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = clamp(40 + (x / width) * 170 + noise());
      raw[offset + 1] = clamp(70 + (y / height) * 120 + noise());
      raw[offset + 2] = clamp(150 - (x / width) * 90 + noise());
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB, which `measureSlidePng` decodes
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    // Level 1: the payload is noise, so a higher level costs seconds and saves nothing.
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
