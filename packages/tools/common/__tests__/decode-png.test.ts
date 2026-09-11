import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePngPixels, decodePngRows, PNG_MAX_PIXELS, type PngHeader } from "../src/png.js";

/**
 * Nothing here is mocked, and nothing here asserts against the decoder's own
 * output. Every fixture is a REAL PNG, encoded byte by byte below —
 * signature, IHDR, optional PLTE/tRNS, a forward-filtered and deflated IDAT,
 * IEND — from pixel values chosen in the test, and the assertions are those
 * chosen values read back.
 *
 * The encoder cycles a DIFFERENT filter type per row on purpose: `None`,
 * `Sub`, `Up`, `Average` and `Paeth` all have to reconstruct the same
 * pixels, and a decoder that got Paeth or Average subtly wrong would still
 * pass a single-filter fixture. That is the bug class this file exists for.
 */

// ─────────────────────────────────────────────────────────────────────────
// A real minimal PNG encoder
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

/** Every filter type, so each fixture exercises all five reconstructions. */
const ALL_FILTERS = [0, 1, 2, 3, 4];

interface EncodeOptions {
  width: number;
  height: number;
  colorType: number;
  bitDepth?: 8 | 16;
  /** Row-major SAMPLE values, `width * channels` per row. 16-bit rows carry 16-bit values. */
  rows: number[][];
  filters?: number[];
  palette?: number[];
  paletteAlpha?: number[];
  interlace?: number;
  /** Drop this many bytes off the end of the deflated IDAT, to build a truncated file. */
  truncateIdatBy?: number;
  /** Emit an IHDR with these dimensions while the IDAT holds `rows` — for the oversize-refusal test. */
  declareSize?: { width: number; height: number };
}

function encodePng(options: EncodeOptions): Uint8Array {
  const { width, height, colorType, rows } = options;
  const bitDepth = options.bitDepth ?? 8;
  const sampleBytes = bitDepth === 16 ? 2 : 1;
  const bpp = CHANNELS[colorType]! * sampleBytes;
  const stride = width * bpp;
  const filters = options.filters ?? [0];
  const declared = options.declareSize ?? { width, height };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(declared.width, 0);
  ihdr.writeUInt32BE(declared.height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = options.interlace ?? 0;

  // Sample values -> big-endian bytes, then forward-filter against the
  // previous UNFILTERED row exactly as the PNG spec defines it.
  const filtered: number[] = [];
  let prior = new Array<number>(stride).fill(0);
  for (let y = 0; y < height; y++) {
    const samples = rows[y]!;
    const raw: number[] = [];
    for (const value of samples) {
      if (sampleBytes === 2) {
        raw.push((value >> 8) & 0xff, value & 0xff);
      } else {
        raw.push(value & 0xff);
      }
    }
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

  let idatBytes = zlib.deflateSync(Buffer.from(filtered));
  if (options.truncateIdatBy !== undefined) {
    idatBytes = idatBytes.subarray(0, idatBytes.byteLength - options.truncateIdatBy);
  }

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      ...(options.palette ? [chunk("PLTE", Buffer.from(options.palette))] : []),
      ...(options.paletteAlpha ? [chunk("tRNS", Buffer.from(options.paletteAlpha))] : []),
      chunk("IDAT", idatBytes),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** Collects every row as its own copy — the decoder reuses one buffer, and this is the test that proves a caller must copy. */
function collect(bytes: Uint8Array): { header: PngHeader; rows: Uint8Array[] } | undefined {
  const rows: Uint8Array[] = [];
  const header = decodePngRows(bytes, (row) => {
    rows.push(Uint8Array.from(row));
  });
  if (header === undefined) return undefined;
  return { header, rows };
}

function pixel(rows: Uint8Array[], x: number, y: number): [number, number, number, number] {
  const row = rows[y]!;
  return [row[x * 4]!, row[x * 4 + 1]!, row[x * 4 + 2]!, row[x * 4 + 3]!];
}

// ─────────────────────────────────────────────────────────────────────────
// Colour types x bit depths x all five filters
// ─────────────────────────────────────────────────────────────────────────

/**
 * A 5x5 gradient in whatever channel layout the colour type wants. The
 * values vary in BOTH axes so `Sub` (left), `Up` (above) and `Paeth`
 * (left+above+diagonal) each have something real to predict — a flat block
 * would decode correctly under a broken predictor.
 */
function gradientRows(width: number, height: number, channels: number, scale = 1): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        row.push(((17 * x + 29 * y + 61 * c + 3) % 251) * scale);
      }
    }
    rows.push(row);
  }
  return rows;
}

describe("decodePngRows — colour types 0/2/3/4/6 at both bit depths, all five filters", () => {
  it("greyscale (type 0, 8-bit) replicates the grey across RGB with opaque alpha", () => {
    const rows = gradientRows(5, 5, 1);
    const decoded = collect(encodePng({ width: 5, height: 5, colorType: 0, rows, filters: ALL_FILTERS }));
    expect(decoded).toBeDefined();
    expect(decoded!.header).toMatchObject({ width: 5, height: 5, bitDepth: 8, colorType: 0, channels: 1, hasAlpha: false });
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const grey = rows[y]![x]!;
        expect(pixel(decoded!.rows, x, y), `grey at ${x},${y}`).toEqual([grey, grey, grey, 255]);
      }
    }
  });

  it("truecolour (type 2, 8-bit) reads R, G and B in order", () => {
    const rows = gradientRows(5, 5, 3);
    const decoded = collect(encodePng({ width: 5, height: 5, colorType: 2, rows, filters: ALL_FILTERS }));
    expect(decoded).toBeDefined();
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const [r, g, b] = [rows[y]![x * 3]!, rows[y]![x * 3 + 1]!, rows[y]![x * 3 + 2]!];
        expect(pixel(decoded!.rows, x, y), `rgb at ${x},${y}`).toEqual([r, g, b, 255]);
      }
    }
  });

  it("palette (type 3) expands the index through PLTE and reads tRNS alpha", () => {
    // Three entries; the third is fully transparent.
    const palette = [200, 10, 20, 10, 200, 30, 40, 50, 200];
    const paletteAlpha = [255, 128, 0];
    const rows: number[][] = [];
    for (let y = 0; y < 4; y++) {
      const row: number[] = [];
      for (let x = 0; x < 4; x++) row.push((x + y) % 3);
      rows.push(row);
    }
    const decoded = collect(encodePng({ width: 4, height: 4, colorType: 3, rows, filters: ALL_FILTERS, palette, paletteAlpha }));
    expect(decoded).toBeDefined();
    expect(decoded!.header.hasAlpha, "a palette with tRNS carries alpha").toBe(true);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const index = (x + y) % 3;
        expect(pixel(decoded!.rows, x, y), `palette index ${index} at ${x},${y}`).toEqual([
          palette[index * 3]!,
          palette[index * 3 + 1]!,
          palette[index * 3 + 2]!,
          paletteAlpha[index]!,
        ]);
      }
    }
  });

  it("reports a palette index past the declared palette as fully transparent, never as invented black ink", () => {
    // One entry, indices 0..2 used: 1 and 2 are out of range.
    const rows = [
      [0, 1, 2],
      [2, 1, 0],
    ];
    const decoded = collect(encodePng({ width: 3, height: 2, colorType: 3, rows, palette: [90, 91, 92] }));
    expect(decoded).toBeDefined();
    expect(pixel(decoded!.rows, 0, 0)).toEqual([90, 91, 92, 255]);
    expect(pixel(decoded!.rows, 1, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(decoded!.rows, 2, 0)).toEqual([0, 0, 0, 0]);
  });

  it("greyscale+alpha (type 4, 8-bit) reads the alpha channel", () => {
    const rows = gradientRows(5, 5, 2);
    const decoded = collect(encodePng({ width: 5, height: 5, colorType: 4, rows, filters: ALL_FILTERS }));
    expect(decoded).toBeDefined();
    expect(decoded!.header.hasAlpha).toBe(true);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const grey = rows[y]![x * 2]!;
        const alpha = rows[y]![x * 2 + 1]!;
        expect(pixel(decoded!.rows, x, y), `grey+alpha at ${x},${y}`).toEqual([grey, grey, grey, alpha]);
      }
    }
  });

  it("RGBA (type 6, 8-bit) reads all four channels", () => {
    const rows = gradientRows(6, 6, 4);
    const decoded = collect(encodePng({ width: 6, height: 6, colorType: 6, rows, filters: ALL_FILTERS }));
    expect(decoded).toBeDefined();
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        expect(pixel(decoded!.rows, x, y), `rgba at ${x},${y}`).toEqual([
          rows[y]![x * 4]!,
          rows[y]![x * 4 + 1]!,
          rows[y]![x * 4 + 2]!,
          rows[y]![x * 4 + 3]!,
        ]);
      }
    }
  });

  it("16-bit truecolour (type 2) reduces each sample to its high byte", () => {
    // 16-bit values whose high and low bytes differ, so a decoder reading the
    // wrong byte cannot accidentally agree.
    const rows: number[][] = [];
    for (let y = 0; y < 4; y++) {
      const row: number[] = [];
      for (let x = 0; x < 4; x++) row.push((x * 40 + 3) * 256 + 200, (y * 50 + 7) * 256 + 100, 0x2a00 + 0xff);
      rows.push(row);
    }
    const decoded = collect(encodePng({ width: 4, height: 4, colorType: 2, bitDepth: 16, rows, filters: ALL_FILTERS }));
    expect(decoded).toBeDefined();
    expect(decoded!.header.bitDepth).toBe(16);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(pixel(decoded!.rows, x, y), `16-bit rgb at ${x},${y}`).toEqual([x * 40 + 3, y * 50 + 7, 0x2a, 255]);
      }
    }
  });

  it("16-bit RGBA (type 6) reduces the alpha channel too", () => {
    const rows = [[0x1234, 0x5678, 0x9abc, 0xdef0], [0x0102, 0x0304, 0x0506, 0x0708]];
    const decoded = collect(encodePng({ width: 1, height: 2, colorType: 6, bitDepth: 16, rows, filters: [0, 4] }));
    expect(decoded).toBeDefined();
    expect(pixel(decoded!.rows, 0, 0)).toEqual([0x12, 0x56, 0x9a, 0xde]);
    expect(pixel(decoded!.rows, 0, 1)).toEqual([0x01, 0x03, 0x05, 0x07]);
  });

  it("16-bit greyscale (type 0) reduces to the high byte and stays opaque", () => {
    const rows = [[0xbeef], [0x1234], [0x00ff]];
    const decoded = collect(encodePng({ width: 1, height: 3, colorType: 0, bitDepth: 16, rows, filters: ALL_FILTERS }));
    expect(decoded).toBeDefined();
    expect(pixel(decoded!.rows, 0, 0)).toEqual([0xbe, 0xbe, 0xbe, 255]);
    expect(pixel(decoded!.rows, 0, 1)).toEqual([0x12, 0x12, 0x12, 255]);
    expect(pixel(decoded!.rows, 0, 2)).toEqual([0x00, 0x00, 0x00, 255]);
  });

  it("refuses a 16-bit PALETTE image — PNG palettes are 8-bit by definition, so this is a corrupt header", () => {
    const bytes = encodePng({ width: 2, height: 1, colorType: 3, rows: [[0, 0]], palette: [10, 20, 30] });
    const tampered = Uint8Array.from(bytes);
    tampered[24] = 16; // IHDR bit depth
    expect(decodePngRows(tampered, () => undefined)).toBeUndefined();
  });

  it("16-bit greyscale+alpha (type 4) keeps the two channels apart", () => {
    const rows = [[0xabcd, 0x1122], [0x3344, 0x5566]];
    const decoded = collect(encodePng({ width: 1, height: 2, colorType: 4, bitDepth: 16, rows, filters: [3, 1] }));
    expect(decoded).toBeDefined();
    expect(pixel(decoded!.rows, 0, 0)).toEqual([0xab, 0xab, 0xab, 0x11]);
    expect(pixel(decoded!.rows, 0, 1)).toEqual([0x33, 0x33, 0x33, 0x55]);
  });

  it("visits every row exactly once, in order, and reuses the row buffer", () => {
    const rows = gradientRows(3, 7, 3);
    const seen: number[] = [];
    const identities = new Set<Uint8Array>();
    const header = decodePngRows(encodePng({ width: 3, height: 7, colorType: 2, rows, filters: ALL_FILTERS }), (row, y) => {
      seen.push(y);
      identities.add(row);
    });
    expect(header?.height).toBe(7);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // ONE buffer for seven rows: the documented contract that a visitor
    // keeping a row must copy it.
    expect(identities.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Refusals — undefined, never a partial answer
// ─────────────────────────────────────────────────────────────────────────

describe("decodePngRows refuses rather than guesses", () => {
  it("refuses an interlaced PNG", () => {
    const bytes = encodePng({ width: 4, height: 4, colorType: 2, rows: gradientRows(4, 4, 3), interlace: 1 });
    expect(decodePngRows(bytes, () => undefined)).toBeUndefined();
  });

  it("refuses a truncated IDAT and delivers NO rows at all", () => {
    const rows: Uint8Array[] = [];
    const bytes = encodePng({ width: 40, height: 40, colorType: 2, rows: gradientRows(40, 40, 3), filters: ALL_FILTERS, truncateIdatBy: 30 });
    const header = decodePngRows(bytes, (row) => {
      rows.push(Uint8Array.from(row));
    });
    expect(header, "a truncated stream is unreadable, not partially readable").toBeUndefined();
    // The refusal happens before the first visit: `inflateSync` fails on the
    // whole stream, so a caller's fold is never fed half a frame.
    expect(rows).toEqual([]);
  });

  it("refuses a PNG whose header declares more than PNG_MAX_PIXELS", () => {
    // 5000 x 4000 = 20 M > 16 M. The IDAT holds a single tiny row, so the
    // refusal has to come from the DECLARED size, before any inflate.
    const bytes = encodePng({
      width: 1,
      height: 1,
      colorType: 2,
      rows: [[1, 2, 3]],
      declareSize: { width: 5000, height: 4000 },
    });
    expect(5000 * 4000).toBeGreaterThan(PNG_MAX_PIXELS);
    expect(decodePngRows(bytes, () => undefined)).toBeUndefined();
  });

  it("refuses a sub-byte bit depth rather than unpacking it", () => {
    const bytes = encodePng({ width: 1, height: 1, colorType: 0, rows: [[1]], bitDepth: 8 });
    // Rewrite the declared bit depth to 4 in place (IHDR data starts at byte 16).
    const tampered = Uint8Array.from(bytes);
    tampered[24] = 4;
    expect(decodePngRows(tampered, () => undefined)).toBeUndefined();
  });

  it("refuses a non-PNG buffer, an empty buffer and a header-only file", () => {
    expect(decodePngRows(new Uint8Array(0), () => undefined)).toBeUndefined();
    expect(decodePngRows(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), () => undefined)).toBeUndefined();
    expect(decodePngRows(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), () => undefined)).toBeUndefined();
  });

  it("refuses a chunk whose declared length runs past the end of the buffer", () => {
    const bytes = encodePng({ width: 2, height: 2, colorType: 2, rows: gradientRows(2, 2, 3) });
    const tampered = Uint8Array.from(bytes);
    // IHDR length field lives at bytes 8..11; claim a gigabyte.
    tampered[8] = 0x40;
    expect(decodePngRows(tampered, () => undefined)).toBeUndefined();
  });

  it("refuses an unknown filter byte", () => {
    // Hand-build the IDAT with filter type 9 on the single row.
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    const bytes = new Uint8Array(
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(Buffer.from([9, 10, 20]))),
        chunk("IEND", Buffer.alloc(0)),
      ]),
    );
    expect(decodePngRows(bytes, () => undefined)).toBeUndefined();
  });

  it("refuses a palette image with no PLTE chunk", () => {
    const bytes = encodePng({ width: 2, height: 1, colorType: 3, rows: [[0, 0]], palette: [1, 2, 3] });
    // Strip the PLTE chunk by rewriting its type to a private, ignorable one.
    const tampered = Buffer.from(bytes);
    const plte = tampered.indexOf(Buffer.from("PLTE", "ascii"));
    expect(plte).toBeGreaterThan(0);
    tampered.write("pLTx", plte, "ascii");
    expect(decodePngRows(new Uint8Array(tampered), () => undefined)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The buffered convenience
// ─────────────────────────────────────────────────────────────────────────

describe("decodePngPixels", () => {
  it("returns the whole frame as RGBA8 matching the row-by-row decode", () => {
    const rows = gradientRows(9, 5, 4);
    const bytes = encodePng({ width: 9, height: 5, colorType: 6, rows, filters: ALL_FILTERS });
    const buffered = decodePngPixels(bytes);
    const streamed = collect(bytes);
    expect(buffered).toBeDefined();
    expect(buffered!.pixels.byteLength).toBe(9 * 5 * 4);
    for (let y = 0; y < 5; y++) {
      expect(Array.from(buffered!.pixels.subarray(y * 9 * 4, (y + 1) * 9 * 4)), `row ${y}`).toEqual(Array.from(streamed!.rows[y]!));
    }
  });

  it("returns undefined for an unreadable buffer", () => {
    expect(decodePngPixels(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
