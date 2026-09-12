/**
 * A real PNG decoder over `node:zlib` alone — chunk walk, `inflateSync`,
 * per-scanline unfilter with all five filter types.
 *
 * WHY IT LIVES HERE. This code was written once, privately, inside
 * `karos-media/src/brand-logo.ts` (`decodePngSamples`) to read a client
 * logo's own colours, and it was fused to that caller's 4-bit colour binning
 * at a fixed sampling stride. A second caller now needs the same physics for
 * a different question — `karos-publish`'s `measureSlidePng` reads the
 * rendered slide's pixels — and the honest way to have two callers is one
 * decoder, not two. Nothing here knows about logos, slides, or Instagram.
 *
 * NO DEPENDENCY IS ADDED FOR THIS. `node:zlib` is the only import. The
 * alternative to decoding is trusting declared numbers (a "logo colour"
 * field no BrandKit ships, a "this slide is interesting" boolean a model
 * writes), and a check against a claim is not a check.
 *
 * MEMORY PROFILE — stated plainly, because a previous design claimed
 * something much better than the truth. `inflateSync(Buffer.concat(idat))`
 * materialises the ENTIRE inflated scanline stream up front: at 2160x2880
 * RGB that buffer is ~18.7 MB, and it exists before any unfilter output
 * does. What the row-callback API removes is the ~24.9 MB RGBA *output*
 * copy `decodePngPixels` would otherwise hold — a real saving of about
 * 25 MB, not "17 KB live against 24.9 MB". Live memory during
 * `decodePngRows` is therefore roughly the inflate buffer, two scanline
 * buffers and one RGBA row (~26 KB at that size).
 *
 * DELIBERATELY NARROW. 8- and 16-bit non-interlaced PNGs, colour types
 * 0/2/3/4/6 — which is what Chromium's screenshotter and every logo
 * exporter emit. Everything else (Adam7 interlace, sub-byte bit depths, a
 * truncated IDAT, a declared size past `PNG_MAX_PIXELS`) returns
 * `undefined`. Never a partial answer, never a guess: a caller that gets
 * `undefined` reports "unreadable", which is a fact, where a half-decoded
 * frame would be a lie with the shape of a measurement.
 */

import zlib from "node:zlib";

/**
 * Above this the decode is refused rather than attempted. 16 megapixels is
 * far past anything this pipeline renders (a 2160x2880 slide is 6.2 M) and
 * far past any logo, so a header claiming more is either corrupt or hostile.
 * Inherited verbatim from `brand-logo.ts`'s `MAX_LOGO_PIXELS`, which this
 * constant replaces.
 */
export const PNG_MAX_PIXELS = 16_000_000;

/** The five PNG colour types this decoder reads. Type 1/5 do not exist; anything else is refused. */
export type PngColorType = 0 | 2 | 3 | 4 | 6;

export interface PngHeader {
  width: number;
  height: number;
  /** 8 or 16. Sub-byte depths (1/2/4) are refused rather than unpacked — see the module comment. */
  bitDepth: 8 | 16;
  colorType: PngColorType;
  /** Samples per pixel in the ENCODED data: 1 grey / 1 palette index / 2 grey+alpha / 3 RGB / 4 RGBA. */
  channels: number;
  /** True when the source can carry per-pixel transparency (colour type 4 or 6, or a palette with a `tRNS` chunk). */
  hasAlpha: boolean;
}

/**
 * Called once per scanline, top to bottom, with that row as **RGBA8**:
 * `width * 4` bytes, palette expanded, greyscale replicated across the three
 * channels, 16-bit samples reduced to their high byte, alpha defaulted to
 * 255 where the source carries none.
 *
 * `row` IS REUSED between rows. A visitor that needs a row after it returns
 * must copy it — retaining the argument is how a streaming decoder silently
 * becomes a buffering one.
 */
export type PngRowVisitor = (row: Uint8Array, y: number, header: PngHeader) => void;

/** The whole frame as RGBA8, for callers that genuinely need random access. `pixels.length === width * height * 4`. */
export interface DecodedPng {
  header: PngHeader;
  pixels: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function channelsForColorType(colorType: number): number | undefined {
  switch (colorType) {
    case 0:
      return 1; // greyscale
    case 2:
      return 3; // truecolour
    case 3:
      return 1; // palette index
    case 4:
      return 2; // greyscale + alpha
    case 6:
      return 4; // truecolour + alpha
    default:
      return undefined;
  }
}

/** PNG's Paeth predictor (spec 9.4), byte-exact. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface ParsedPng {
  header: PngHeader;
  palette: Uint8Array | undefined;
  paletteAlpha: Uint8Array | undefined;
  idat: Uint8Array[];
}

/**
 * Signature check plus one chunk walk. Every refusal is a `return undefined`
 * with the reason in a comment beside it; none of them is recoverable, and
 * none of them is worth a partial answer.
 *
 * CRC is deliberately NOT verified. Chromium writes these bytes and hands
 * them to us in memory — there is no transport between the encoder and this
 * decoder to corrupt them — and a CRC pass would double the read cost on
 * every slide of every attempt for a failure mode `inflateSync` already
 * catches (a corrupt IDAT does not inflate).
 */
function readPngChunks(bytes: Uint8Array): ParsedPng | undefined {
  if (bytes.byteLength < 8) return undefined;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIhdr = false;
  let palette: Uint8Array | undefined;
  let paletteAlpha: Uint8Array | undefined;
  const idat: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const start = offset + 8;
    if (!Number.isSafeInteger(length) || start + length > bytes.byteLength) return undefined; // truncated chunk
    if (type === "IHDR") {
      if (length < 13) return undefined;
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = bytes[start + 8]!;
      colorType = bytes[start + 9]!;
      interlace = bytes[start + 12]!;
      sawIhdr = true;
    } else if (type === "PLTE") {
      palette = bytes.subarray(start, start + length);
    } else if (type === "tRNS") {
      paletteAlpha = bytes.subarray(start, start + length);
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4; // + CRC
  }

  if (!sawIhdr || idat.length === 0) return undefined;
  if (interlace !== 0) return undefined; // Adam7: not emitted by Chromium or by logo exporters, not worth a wrong answer.
  if (bitDepth !== 8 && bitDepth !== 16) return undefined; // sub-byte packing: unreadable rather than guessed.
  if (width <= 0 || height <= 0 || width * height > PNG_MAX_PIXELS) return undefined;
  const channels = channelsForColorType(colorType);
  if (channels === undefined) return undefined;
  if (colorType === 3 && (palette === undefined || bitDepth !== 8)) return undefined; // a palette image with no palette is not decodable

  return {
    header: {
      width,
      height,
      bitDepth: bitDepth === 16 ? 16 : 8,
      colorType: colorType as PngColorType,
      channels,
      hasAlpha: colorType === 4 || colorType === 6 || (colorType === 3 && paletteAlpha !== undefined),
    },
    palette,
    paletteAlpha,
    idat,
  };
}

/**
 * One unfiltered scanline (in the encoded channel layout) to RGBA8.
 *
 * 16-bit samples are reduced to their HIGH byte rather than averaged or
 * scaled — big-endian MSB is the same value the previous `decodePngSamples`
 * read (`out[px]`, `out[px + sampleBytes]`, ...), so the lift is
 * behaviour-preserving for the one caller that already existed, and an
 * 8-bit-accurate reading is all any downstream colour comparison uses.
 */
function toRgbaRow(
  src: Uint8Array,
  out: Uint8Array,
  header: PngHeader,
  sampleBytes: number,
  palette: Uint8Array | undefined,
  paletteAlpha: Uint8Array | undefined,
): void {
  const bpp = header.channels * sampleBytes;
  for (let x = 0; x < header.width; x++) {
    const px = x * bpp;
    const o = x * 4;
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    switch (header.colorType) {
      case 3: {
        const index = src[px]!;
        const base = index * 3;
        if (palette === undefined || base + 2 >= palette.byteLength) {
          // An index past the declared palette has no colour. Reported as
          // fully transparent, which is what the previous implementation's
          // `continue` amounted to for its one caller, rather than invented
          // as black.
          r = 0;
          g = 0;
          b = 0;
          a = 0;
          break;
        }
        r = palette[base]!;
        g = palette[base + 1]!;
        b = palette[base + 2]!;
        a = paletteAlpha !== undefined && index < paletteAlpha.byteLength ? paletteAlpha[index]! : 255;
        break;
      }
      case 0:
        r = src[px]!;
        g = r;
        b = r;
        break;
      case 4:
        r = src[px]!;
        g = r;
        b = r;
        a = src[px + sampleBytes]!;
        break;
      case 2:
        r = src[px]!;
        g = src[px + sampleBytes]!;
        b = src[px + 2 * sampleBytes]!;
        break;
      default:
        r = src[px]!;
        g = src[px + sampleBytes]!;
        b = src[px + 2 * sampleBytes]!;
        a = src[px + 3 * sampleBytes]!;
        break;
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
}

/**
 * Decodes a PNG one scanline at a time, handing each row to `onRow` as
 * RGBA8, and returns the header — or `undefined` if the asset is not a PNG
 * this decoder reads (see the module comment for the exact list).
 *
 * The visitor is called exactly `header.height` times, in order, and the row
 * buffer is reused; only the previous scanline is retained, because that is
 * all the unfilter needs. Anything the visitor wants to keep it must copy.
 *
 * `undefined` means "unreadable", and it means it even when some rows were
 * already delivered: a caller that has folded partial rows into a counter
 * must throw that fold away rather than report it. Every refusal this
 * decoder can make is detectable BEFORE the first row except one — an
 * unknown filter byte mid-stream — and that one is a corrupt file, not a
 * variant.
 */
export function decodePngRows(bytes: Uint8Array, onRow: PngRowVisitor): PngHeader | undefined {
  const parsed = readPngChunks(bytes);
  if (parsed === undefined) return undefined;
  const { header, palette, paletteAlpha, idat } = parsed;

  const sampleBytes = header.bitDepth === 16 ? 2 : 1;
  const bpp = header.channels * sampleBytes;
  const stride = header.width * bpp;
  const expectedRaw = header.height * (stride + 1);

  let raw: Buffer;
  try {
    // `maxOutputLength` is exactly what a conformant PNG inflates to (one
    // filter byte plus one scanline per row). Without it a 1x1 header with a
    // hostile IDAT would have this process allocate whatever the stream
    // decompresses to, and the pixel cap above — which bounds only the
    // DECLARED dimensions — would not catch it.
    raw = zlib.inflateSync(
      Buffer.concat(idat.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))),
      { maxOutputLength: expectedRaw },
    );
  } catch {
    return undefined; // corrupt, truncated, or over the output cap
  }
  if (raw.byteLength < expectedRaw) return undefined; // truncated IDAT: no partial answers

  // Two scanline buffers, swapped each row. The unfilter reads only the
  // previous row, so nothing older than one line is ever held.
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  const rgba = new Uint8Array(header.width * 4);

  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const rowIn = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rowIn + x]!;
      const left = x >= bpp ? cur[x - bpp]! : 0;
      const up = y > 0 ? prev[x]! : 0;
      const upLeft = y > 0 && x >= bpp ? prev[x - bpp]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4:
          value = rawByte + paeth(left, up, upLeft);
          break;
        default:
          return undefined; // an unknown filter type is a corrupt file
      }
      cur[x] = value & 0xff;
    }
    toRgbaRow(cur, rgba, header, sampleBytes, palette, paletteAlpha);
    onRow(rgba, y, header);
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  return header;
}

/**
 * The whole frame as RGBA8. A convenience over `decodePngRows` for callers
 * that need random access (a neighbourhood, a second look at an earlier
 * row); at 2160x2880 the returned buffer is 24.9 MB, which is precisely the
 * copy the row API exists to avoid, so prefer `decodePngRows` for anything
 * that can be expressed as a fold.
 */
export function decodePngPixels(bytes: Uint8Array): DecodedPng | undefined {
  let pixels: Uint8Array | undefined;
  const header = decodePngRows(bytes, (row, y, hdr) => {
    pixels ??= new Uint8Array(hdr.width * hdr.height * 4);
    pixels.set(row, y * hdr.width * 4);
  });
  if (header === undefined || pixels === undefined) return undefined;
  return { header, pixels };
}
