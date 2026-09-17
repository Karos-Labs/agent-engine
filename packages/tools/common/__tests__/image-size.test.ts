import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { IMAGE_MAX_PIXELS, readImageSize } from "../src/image-size.js";

/**
 * Every fixture here is a REAL file of its format, assembled byte by byte
 * from a size chosen in the test, and every assertion is that chosen size
 * read back. Nothing is mocked and nothing asserts against the reader's own
 * output — the same standard `decode-png.test.ts` next door holds itself to,
 * for the same reason: a header parser that agreed with a fixture the parser
 * itself produced would prove nothing.
 *
 * The negative cases matter as much as the positive ones. This reader's
 * contract is that `undefined` means UNREADABLE, so each way a file can be
 * unreadable — wrong signature, truncated, zero-sized, absurdly large — has
 * its own case. A reader that guessed would pass every test above and fail
 * every test below.
 */

// ─────────────────────────────────────────────────────────────────────────
// Real encoders
// ─────────────────────────────────────────────────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

interface PngOptions {
  /** `sRGB` chunk, with its rendering-intent byte. */
  srgb?: boolean;
  /** `iCCP` chunk carrying this profile name. */
  iccProfile?: string;
}

/** A real 8-bit RGB PNG of the given size, deflated, with every chunk's CRC correct. */
function png(width: number, height: number, options: PngOptions = {}): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  const ancillary: Buffer[] = [];
  if (options.srgb === true) ancillary.push(pngChunk("sRGB", Buffer.from([0])));
  if (options.iccProfile !== undefined) {
    ancillary.push(
      pngChunk(
        "iCCP",
        Buffer.concat([
          Buffer.from(options.iccProfile, "latin1"),
          Buffer.from([0x00, 0x00]), // NUL terminator, then the compression method
          zlib.deflateSync(Buffer.from([0x00])),
        ]),
      ),
    );
  }

  // One filtered scanline per row, filter type 0, mid-grey.
  const raw = Buffer.alloc(height * (1 + width * 3), 0x80);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 3)] = 0;

  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      ...ancillary,
      pngChunk("IDAT", zlib.deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/**
 * Signature + IHDR + IEND, with no pixel data at all.
 *
 * For the size bound, where the whole question is what the header CLAIMS —
 * a real frame at those dimensions is hundreds of megabytes and proves
 * nothing the 13 bytes of IHDR do not.
 */
function pngHeaderOnly(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.byteLength + 2, 2);
  return Buffer.concat([header, payload]);
}

interface JpegOptions {
  /** Which Start-Of-Frame marker carries the size: baseline `0xc0` by default. */
  sofMarker?: number;
  /** An `APP2` ICC profile whose header declares this four-character colour space. */
  iccColourSpace?: string;
  /** An Adobe `APP14` segment with this transform byte. */
  adobeTransform?: number;
}

/** A real JPEG down to the Start-Of-Scan marker — enough that a size reader must walk the segment list. */
function jpeg(width: number, height: number, options: JpegOptions = {}): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  // A JFIF APP0, so the frame header is never the first segment.
  parts.push(jpegSegment(0xe0, Buffer.concat([Buffer.from("JFIF\0", "ascii"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])));

  if (options.iccColourSpace !== undefined) {
    const profile = Buffer.alloc(132);
    profile.write(options.iccColourSpace, 16, "ascii");
    parts.push(
      jpegSegment(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0", "ascii"), Buffer.from([1, 1]), profile])),
    );
  }
  if (options.adobeTransform !== undefined) {
    const adobe = Buffer.alloc(12);
    adobe.write("Adobe", 0, "ascii");
    adobe[11] = options.adobeTransform;
    parts.push(jpegSegment(0xee, adobe));
  }

  // A quantisation table, so a reader that assumed a fixed segment order fails.
  parts.push(jpegSegment(0xdb, Buffer.alloc(65)));

  const sof = Buffer.alloc(6 + 3);
  sof[0] = 8; // sample precision
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1; // one component
  parts.push(jpegSegment(options.sofMarker ?? 0xc0, sof));

  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
  return Uint8Array.from(Buffer.concat(parts));
}

function riff(chunkType: string, body: Buffer): Uint8Array {
  const payload = Buffer.concat([Buffer.from("WEBP", "ascii"), Buffer.from(chunkType, "ascii"), lengthPrefixed(body)]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(payload.byteLength, 4);
  return Uint8Array.from(Buffer.concat([header, payload]));
}

function lengthPrefixed(body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.byteLength);
  return Buffer.concat([length, body]);
}

/** A real extended-format WebP: the container an animated or alpha-bearing WebP uses. */
function webpVp8x(width: number, height: number): Uint8Array {
  const body = Buffer.alloc(10);
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", body);
}

/** A real lossless WebP: both sizes packed as 14-bit fields across four bytes. */
function webpVp8l(width: number, height: number): Uint8Array {
  const body = Buffer.alloc(16);
  body[0] = 0x2f; // the lossless signature
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  body.writeUInt32LE(packed >>> 0, 1);
  return riff("VP8L", body);
}

/** A real lossy WebP: a three-byte frame tag, the sync code, then two 14-bit fields. */
function webpVp8(width: number, height: number): Uint8Array {
  const body = Buffer.alloc(16);
  body[3] = 0x9d;
  body[4] = 0x01;
  body[5] = 0x2a;
  body.writeUInt16LE(width & 0x3fff, 6);
  body.writeUInt16LE(height & 0x3fff, 8);
  return riff("VP8 ", body);
}

function gif(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(14);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return Uint8Array.from(bytes);
}

/** A real AVIF box tree: `ftyp`, then a `meta` box containing the `ispe` the size lives in. */
function avif(width: number, height: number, extra: { alsoCarriesAThumbnail?: boolean } = {}): Uint8Array {
  const ispe = (w: number, h: number): Buffer => {
    const box = Buffer.alloc(20);
    box.writeUInt32BE(20, 0);
    box.write("ispe", 4, "ascii");
    box.writeUInt32BE(w, 12);
    box.writeUInt32BE(h, 16);
    return box;
  };
  const ftyp = Buffer.alloc(20);
  ftyp.writeUInt32BE(20, 0);
  ftyp.write("ftyp", 4, "ascii");
  ftyp.write("avif", 8, "ascii");
  ftyp.write("avifmif1", 12, "ascii");

  // The primary item's `ispe` first, a thumbnail's second — the order every
  // encoder this pipeline has seen writes, and the order the reader relies on.
  const boxes = extra.alsoCarriesAThumbnail === true ? [ispe(width, height), ispe(64, 64)] : [ispe(width, height)];
  const inner = Buffer.concat(boxes);
  const meta = Buffer.alloc(12);
  meta.writeUInt32BE(12 + inner.byteLength, 0);
  meta.write("meta", 4, "ascii");

  return Uint8Array.from(Buffer.concat([ftyp, meta, inner]));
}

// ─────────────────────────────────────────────────────────────────────────

describe("readImageSize: the size a feed will actually render", () => {
  it("reads a PNG's IHDR, and reports the short side rather than making the caller pick", () => {
    const size = readImageSize(png(1080, 1350));
    expect(size).toMatchObject({ format: "png", width: 1080, height: 1350, shortSide: 1080 });
  });

  it("reports the short side of a LANDSCAPE image too — the floor is a property of the smaller side", () => {
    expect(readImageSize(png(1920, 1080))?.shortSide).toBe(1080);
    expect(readImageSize(png(1080, 1920))?.shortSide).toBe(1080);
  });

  it("finds a JPEG's frame header past a JFIF segment and a quantisation table", () => {
    expect(readImageSize(jpeg(2000, 1333))).toMatchObject({ format: "jpeg", width: 2000, height: 1333 });
  });

  it("reads a PROGRESSIVE JPEG, whose size lives in a different SOF marker", () => {
    expect(readImageSize(jpeg(1600, 900, { sofMarker: 0xc2 }))).toMatchObject({ width: 1600, height: 900 });
  });

  it.each([
    ["VP8X, the extended container", webpVp8x],
    ["VP8L, lossless", webpVp8l],
    ["VP8 , lossy", webpVp8],
  ])("reads a WebP in the %s sub-format", (_name, encode) => {
    expect(encode(1440, 1800)).toBeDefined();
    expect(readImageSize(encode(1440, 1800))).toMatchObject({ format: "webp", width: 1440, height: 1800 });
  });

  it("reads a GIF's logical screen size", () => {
    expect(readImageSize(gif(480, 270))).toMatchObject({ format: "gif", width: 480, height: 270 });
  });

  it("finds an AVIF's `ispe` inside the box tree", () => {
    expect(readImageSize(avif(3000, 2000))).toMatchObject({ format: "avif", width: 3000, height: 2000 });
  });

  it("takes the FIRST ispe when a file carries several, which is the primary item's", () => {
    expect(readImageSize(avif(3000, 2000, { alsoCarriesAThumbnail: true }))).toMatchObject({ width: 3000, height: 2000 });
  });
});

describe("readImageSize: what the container says about colour", () => {
  it("calls an image with no profile UNSTATED, which is what almost every correct web image is", () => {
    expect(readImageSize(png(1080, 1080))?.colourSpace).toBe("unstated");
  });

  it("reads a PNG's sRGB chunk as settling the question", () => {
    expect(readImageSize(png(1080, 1080, { srgb: true }))?.colourSpace).toBe("srgb");
  });

  it("names a PNG's embedded profile, and calls a non-sRGB one a conversion we cannot perform", () => {
    const size = readImageSize(png(1080, 1080, { iccProfile: "Display P3" }));
    expect(size).toMatchObject({ colourSpace: "other-profile", profileName: "Display P3" });
  });

  it("does not call an embedded profile foreign when the profile's own name says sRGB", () => {
    expect(readImageSize(png(1080, 1080, { iccProfile: "sRGB IEC61966-2.1" }))?.colourSpace).toBe("srgb");
  });

  it("catches a CMYK JPEG from its ICC header — a print file that renders wrong in a feed", () => {
    expect(readImageSize(jpeg(1080, 1080, { iccColourSpace: "CMYK" }))?.colourSpace).toBe("cmyk");
  });

  it("catches a CMYK JPEG that carries no ICC profile at all, from Adobe's APP14 transform", () => {
    expect(readImageSize(jpeg(1080, 1080, { adobeTransform: 2 }))?.colourSpace).toBe("cmyk");
  });

  it("does not mistake an RGB ICC profile for CMYK", () => {
    expect(readImageSize(jpeg(1080, 1080, { iccColourSpace: "RGB " }))?.colourSpace).toBe("other-profile");
  });
});

describe("readImageSize: undefined means unreadable, never a guess", () => {
  it("refuses a format it does not know", () => {
    expect(readImageSize(Uint8Array.from(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")))).toBeUndefined();
  });

  it("refuses an empty or near-empty buffer", () => {
    expect(readImageSize(new Uint8Array(0))).toBeUndefined();
    expect(readImageSize(new Uint8Array(11))).toBeUndefined();
  });

  it("refuses a PNG whose IHDR is truncated away", () => {
    expect(readImageSize(png(100, 100).slice(0, 20))).toBeUndefined();
  });

  it("refuses a JPEG that ends before any frame header", () => {
    expect(readImageSize(jpeg(100, 100).slice(0, 12))).toBeUndefined();
  });

  it("refuses a zero dimension rather than reporting a 0-pixel image", () => {
    expect(readImageSize(png(0, 100))).toBeUndefined();
    expect(readImageSize(gif(100, 0))).toBeUndefined();
  });

  it("refuses a header claiming more than IMAGE_MAX_PIXELS", () => {
    // Header only. Encoding a real 10001x10001 PNG to test a bounds check
    // would allocate ~300 MB of scanlines to prove something the first 24
    // bytes already say — and it did, until this test timed out at five
    // seconds and said so.
    const tooBig = Math.ceil(Math.sqrt(IMAGE_MAX_PIXELS)) + 1;
    expect(readImageSize(pngHeaderOnly(tooBig, tooBig))).toBeUndefined();
    // …and accepts one just under it, so the bound is the reason and not the format.
    const justUnder = Math.floor(Math.sqrt(IMAGE_MAX_PIXELS)) - 1;
    expect(readImageSize(pngHeaderOnly(justUnder, justUnder))).toMatchObject({ width: justUnder });
  });

  it("refuses a WebP whose sub-format signature byte is wrong", () => {
    const broken = webpVp8l(100, 100);
    broken[20] = 0x00;
    expect(readImageSize(broken)).toBeUndefined();
  });

  it("refuses a RIFF file that is not a WebP at all", () => {
    const wav = Buffer.alloc(40);
    wav.write("RIFF", 0, "ascii");
    wav.write("WAVE", 8, "ascii");
    expect(readImageSize(Uint8Array.from(wav))).toBeUndefined();
  });
});
