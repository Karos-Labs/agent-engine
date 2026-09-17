import zlib from "node:zlib";

/**
 * Real encoded images for the tests in this package.
 *
 * ## Why these had to exist
 *
 * Until Phase 5.6 nothing in this package looked at an image's pixels, so a
 * test could serve `Buffer.alloc(64, 1)` with a `content-type: image/jpeg`
 * header and every assertion downstream held. Item A8 put a resolution floor
 * on the download path, and those 64 bytes stopped being an image — correctly.
 *
 * The temptation at that point is to exempt the tests: a flag, a smaller
 * floor under NODE_ENV, an injected measurement. Every one of those makes the
 * floor untestable in the only place it matters, which is the bug class
 * `guards-that-cannot-fail` is about. So the fixtures became real instead.
 * A 1080x1350 PNG of one flat colour deflates to a few hundred bytes, which
 * costs a test nothing and means the floor is exercised by every test that
 * downloads anything, rather than mocked out of the way.
 *
 * Nothing here is shared with `image-size.test.ts` next door on purpose:
 * that file tests the READER and must build its fixtures independently of
 * anything the reader or its callers use, or it would be asserting a parser
 * against its own encoder.
 */

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * A real 8-bit RGB PNG, one flat colour, correct CRCs.
 *
 * Defaults to 1080x1350 — the platform's 4:5 plate, and comfortably over the
 * 1080px short-side floor — so a test that just needs "a usable image" can
 * call `realPng()` and not think about it.
 */
export function realPng(width = 1080, height = 1350, grey = 0x80): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  const raw = Buffer.alloc(height * (1 + width * 3), grey);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 3)] = 0; // filter type None

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A real JPEG, down to the Start-Of-Scan marker.
 *
 * The entropy-coded data is deliberately absent: nothing in this package
 * decodes a JPEG's pixels, only its frame header, so a fixture that carried
 * a real scan would be several hundred lines of Huffman tables proving
 * nothing. What it does carry is a genuine marker sequence — JFIF APP0, a
 * quantisation table, then SOF0 — so a reader that assumed the frame header
 * came first would fail against it.
 */
export function realJpeg(width = 1080, height = 1350): Buffer {
  const segment = (marker: number, payload: Buffer): Buffer => {
    const header = Buffer.alloc(4);
    header[0] = 0xff;
    header[1] = marker;
    header.writeUInt16BE(payload.byteLength + 2, 2);
    return Buffer.concat([header, payload]);
  };

  const sof = Buffer.alloc(9);
  sof[0] = 8; // sample precision
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1; // one component

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.concat([Buffer.from("JFIF\0", "ascii"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])),
    segment(0xdb, Buffer.alloc(65)),
    segment(0xc0, sof),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
  ]);
}

/** Base64 of a real PNG, for the generation stubs that hand back `inlineData.data`. */
export function realPngBase64(width = 1080, height = 1350): string {
  return realPng(width, height).toString("base64");
}

/**
 * An image that is real but TOO SMALL — for the tests that assert the floor
 * refuses one. Named so a reader of the call site can see that the smallness
 * is the point rather than an accident of the fixture.
 */
export function tooSmallPng(): Buffer {
  return realPng(640, 480);
}
