/**
 * The intrinsic pixel size of an encoded image, read from its own container
 * header — plus whatever that header states about colour.
 *
 * WHY IT LIVES HERE. `png.ts` next door already decodes a PNG's *pixels* for
 * callers that need to measure ink. This module answers a much smaller
 * question that several callers need and none of them should answer twice:
 * how big is this file, really, and is it a format a feed will accept. It
 * covers the five containers an image actually arrives in — PNG, JPEG, WebP,
 * GIF and AVIF — where `png.ts` covers one, and it never inflates anything.
 *
 * WHY IT IS NEEDED AT ALL. The alternative to reading the container is
 * trusting a declared number: a provider's `width` field, a model's
 * description, a filename. Providers round, resize on delivery and sometimes
 * report the ORIGINAL's size for a scaled URL; a model cannot count pixels at
 * all. A check against a claim is not a check. Instagram's floor is a
 * property of the delivered bytes, so the delivered bytes are what gets
 * measured.
 *
 * NO DEPENDENCY IS ADDED FOR THIS. Every format here states its size in the
 * first few hundred bytes, in fixed-width fields, and the parsing is
 * arithmetic on a `Uint8Array`. An image-decoding dependency would pull a
 * native build chain into a package whose job is to read eight bytes.
 *
 * DELIBERATELY NARROW, AND NEVER A GUESS. An unrecognised signature, a
 * truncated header, a size of zero or a size past `IMAGE_MAX_PIXELS` returns
 * `undefined`. `undefined` means UNREADABLE, which is a fact a caller can
 * report; a guessed dimension would be a lie with the shape of a measurement.
 * Interlaced, animated and multi-frame files report their FIRST frame's
 * canvas, which is the size a feed renders.
 */

/** The containers this reader knows. Anything else is unreadable rather than assumed. */
export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "avif";

/**
 * What the container itself says about colour — never what the pixels look
 * like, which would need a decode and a reference.
 *
 * `"unstated"` is the overwhelmingly common case for web imagery and is NOT a
 * defect: an image with no embedded profile is sRGB by every browser's
 * default and by the PNG and JPEG specifications' own advice. Treating it as
 * suspect would fail almost every correct image.
 *
 * `"cmyk"` is a real, detectable defect — a print-workflow JPEG that will
 * render with inverted or muddied colour in a feed. `"other-profile"` (Adobe
 * RGB, Display P3, a camera profile) is a conversion the pipeline cannot
 * perform without a codec, so it is reported for a caller to decide about
 * rather than silently accepted or silently refused.
 */
export type ImageColourSpace = "srgb" | "cmyk" | "other-profile" | "unstated";

export interface ImageSize {
  format: ImageFormat;
  width: number;
  height: number;
  /** The shorter of the two sides — the dimension every platform floor is stated against. */
  shortSide: number;
  colourSpace: ImageColourSpace;
  /**
   * The embedded profile's own name, where the container states it in plain
   * text (PNG's `iCCP` chunk). JPEG carries the name inside the ICC body's
   * tag table, which this reader does not walk, so a JPEG with a profile
   * reports its colour space without a name.
   */
  profileName?: string;
}

/**
 * Above this a header is refused rather than believed. 100 megapixels is far
 * past any photograph a feed will accept and far past anything this pipeline
 * renders, so a container claiming more is corrupt or hostile. Deliberately
 * looser than `PNG_MAX_PIXELS`, which bounds an actual decode's memory; this
 * reader allocates nothing per pixel and only needs the number to be sane.
 */
export const IMAGE_MAX_PIXELS = 100_000_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function u32be(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function u24le(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[at + i]!);
  return out;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

/** A size is only returned when both sides are positive and the product is sane. */
function finish(
  format: ImageFormat,
  width: number,
  height: number,
  colourSpace: ImageColourSpace,
  profileName?: string,
): ImageSize | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  if (width * height > IMAGE_MAX_PIXELS) return undefined;
  return {
    format,
    width,
    height,
    shortSide: Math.min(width, height),
    colourSpace,
    ...(profileName === undefined ? {} : { profileName }),
  };
}

/**
 * PNG. `IHDR` is required by the specification to be the first chunk, so
 * width and height sit at fixed offsets 16 and 20. Colour comes from the
 * ancillary chunks, which may appear in any order before `IDAT`: `sRGB`
 * settles the question outright, `iCCP` names a profile in latin-1 up to a
 * NUL, and neither being present means unstated.
 */
function readPng(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24) return undefined;
  if (ascii(bytes, 12, 4) !== "IHDR") return undefined;

  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);

  let colourSpace: ImageColourSpace = "unstated";
  let profileName: string | undefined;

  // Walk the chunk list only until the pixel data starts — everything that
  // describes colour is required to precede `IDAT`.
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32be(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    if (type === "IDAT" || type === "IEND") break;
    const dataAt = at + 8;
    if (type === "sRGB") {
      colourSpace = "srgb";
      break;
    }
    if (type === "iCCP" && dataAt + length <= bytes.length) {
      let end = dataAt;
      while (end < dataAt + length && bytes[end] !== 0x00) end += 1;
      profileName = ascii(bytes, dataAt, end - dataAt).trim() || undefined;
      // A profile whose own name says sRGB is sRGB; anything else is a
      // conversion this pipeline cannot perform, and says so.
      colourSpace = profileName !== undefined && /srgb/i.test(profileName) ? "srgb" : "other-profile";
    }
    // 4 length + 4 type + data + 4 CRC. A length that overflows the buffer
    // means the file is truncated, and the walk stops rather than wrapping.
    const next = dataAt + length + 4;
    if (next <= at) break;
    at = next;
  }

  return finish("png", width, height, colourSpace, profileName);
}

/**
 * JPEG. The size lives in whichever Start-Of-Frame marker the encoder chose,
 * so the marker list is walked until one appears. `FFC4` (Huffman tables),
 * `FFC8` (JPEG extensions) and `FFCC` (arithmetic conditioning) share the
 * `C0-CF` range without being frame headers and are skipped by name.
 *
 * Colour is read from an `APP2` segment carrying `ICC_PROFILE\0`: the ICC
 * header's data colour space sits at offset 16 of the profile body, which is
 * enough to separate a CMYK print file from an RGB one without walking the
 * tag table.
 */
function readJpeg(bytes: Uint8Array): ImageSize | undefined {
  let colourSpace: ImageColourSpace = "unstated";
  let at = 2;

  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      // Not on a marker boundary: resynchronise rather than trusting the
      // next two bytes as a length.
      at += 1;
      continue;
    }
    const marker = bytes[at + 1]!;
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image, or entropy-coded data begins
    const length = u16be(bytes, at + 2);
    if (length < 2) return undefined;
    const payloadAt = at + 4;

    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (payloadAt + 5 > bytes.length) return undefined;
      // precision (1 byte), height (2), width (2).
      const height = u16be(bytes, payloadAt + 1);
      const width = u16be(bytes, payloadAt + 3);
      return finish("jpeg", width, height, colourSpace);
    }

    if (marker === 0xe2 && payloadAt + 12 <= bytes.length && ascii(bytes, payloadAt, 11) === "ICC_PROFILE") {
      // 12 bytes of `ICC_PROFILE\0`, then a 2-byte chunk counter, then the
      // profile body whose colour space sits 16 bytes in.
      const profileAt = payloadAt + 14;
      if (profileAt + 20 <= bytes.length) {
        const space = ascii(bytes, profileAt + 16, 4);
        colourSpace = space === "CMYK" ? "cmyk" : "other-profile";
      }
    }

    // Adobe's `APP14` transform byte is the other reliable CMYK signal, and
    // the only one present when a print JPEG carries no ICC profile at all.
    if (marker === 0xee && payloadAt + 12 <= bytes.length && ascii(bytes, payloadAt, 5) === "Adobe") {
      const components = bytes[payloadAt + 11];
      if (components === 2) colourSpace = "cmyk"; // YCCK
    }

    at = payloadAt + length - 2;
  }

  return undefined;
}

/**
 * WebP. Three sub-formats state their size three different ways, and all
 * three are in use: `VP8 ` (lossy) after a three-byte frame tag and the
 * `9d 01 2a` sync code, `VP8L` (lossless) as two 14-bit fields packed across
 * four bytes, and `VP8X` (extended — the container an animated or
 * alpha-bearing WebP uses) as two 24-bit canvas fields, each stored minus one.
 */
function readWebp(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 30) return undefined;
  if (ascii(bytes, 8, 4) !== "WEBP") return undefined;
  const chunk = ascii(bytes, 12, 4);

  if (chunk === "VP8X") {
    return finish("webp", u24le(bytes, 24) + 1, u24le(bytes, 27) + 1, "srgb");
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return undefined; // the lossless signature byte
    const packed = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return finish("webp", (packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1, "srgb");
  }
  if (chunk === "VP8 ") {
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) return undefined;
    // The two 16-bit fields carry the size in their low 14 bits; the top two
    // are a scale factor the renderer applies, not part of the intrinsic size.
    const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
    return finish("webp", width, height, "srgb");
  }
  return undefined;
}

/** GIF. Logical screen width and height, little-endian, immediately after the six-byte version string. */
function readGif(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 10) return undefined;
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  return finish("gif", width, height, "srgb");
}

/**
 * AVIF (and the HEIF family it shares a container with). The size lives in an
 * `ispe` box — image spatial extents — somewhere inside the nested `meta`
 * box hierarchy. Rather than walking that hierarchy, which differs between
 * encoders and between still and sequence files, the box is found by
 * scanning for its four-character type: `ispe` is a fixed 20-byte box whose
 * payload is version/flags then width then height, so a match is
 * self-validating.
 *
 * The FIRST `ispe` is the primary item's in every file this pipeline has
 * seen; a file with several (a thumbnail, an alpha plane) lists the primary
 * item first. Where that assumption is wrong the reader reports a smaller
 * size than the truth, which fails safe against a resolution floor.
 */
function readAvif(bytes: Uint8Array): ImageSize | undefined {
  const limit = Math.min(bytes.length - 12, 65_536);
  for (let at = 0; at < limit; at += 1) {
    if (bytes[at] !== 0x69) continue; // 'i'
    if (ascii(bytes, at, 4) !== "ispe") continue;
    const width = u32be(bytes, at + 8);
    const height = u32be(bytes, at + 12);
    const size = finish("avif", width, height, "srgb");
    if (size !== undefined) return size;
  }
  return undefined;
}

/**
 * Read an encoded image's intrinsic size and stated colour space.
 *
 * Returns `undefined` for anything this reader cannot answer for certain —
 * an unknown container, a truncated header, a nonsensical size. See the
 * module comment for why that is never softened into a guess.
 */
export function readImageSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 12) return undefined;
  if (startsWith(bytes, PNG_SIGNATURE)) return readPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes);
  if (ascii(bytes, 0, 4) === "RIFF") return readWebp(bytes);
  if (ascii(bytes, 0, 3) === "GIF") return readGif(bytes);
  // An ISOBMFF file names its brand in the `ftyp` box at offset 4. `avif`,
  // `avis`, `heic`, `heix`, `mif1` and `msf1` all carry an `ispe`.
  if (ascii(bytes, 4, 4) === "ftyp") return readAvif(bytes);
  return undefined;
}
