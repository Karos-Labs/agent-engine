/**
 * The resolution and colour floor every image must clear before it is allowed
 * onto a slide.
 *
 * ## Why this exists
 *
 * Nothing in this package measured an image's actual pixels. A candidate's
 * size was whatever the provider's URL happened to serve, and the only
 * judgement applied to it was a model reading a description — which cannot
 * count pixels and has never once said "this is 640 wide". The result is the
 * defect the owner named directly: a picture that looks soft or blocky on a
 * 1080-wide plate, sitting next to type rendered at 2x.
 *
 * The platform spec states the floor as **≥1080 px on the short side, sRGB,
 * no upscaling, no watermark**. Three of those four are properties of the
 * bytes and are settled here, deterministically, by `readImageSize` reading
 * the container's own header. The fourth is a judgement about what the
 * picture DEPICTS and stays where it was — with the vetting agent, which can
 * see the image.
 *
 * ## What "no upscaling" can honestly mean here
 *
 * It cannot mean "this file was never enlarged by whoever made it". That is
 * not recoverable from the bytes: a 640px photo resampled to 2000px and
 * re-encoded is, byte for byte, a 2000px photo. Claiming to detect it would
 * be a guess wearing a measurement's clothes.
 *
 * What it does mean is that **this pipeline never enlarges one**. An image
 * below the floor is refused here rather than stretched to fill a plate,
 * which is the only point in the path where an upscale was ever going to
 * happen and the only one we control. `belowFloor` is therefore the
 * no-upscale rule, enforced where it is enforceable.
 *
 * ## Refusal, not repair
 *
 * A verdict never rewrites anything. It reports, with the measured number in
 * the reason string, and the caller decides — which in practice means the
 * candidate becomes an `unmet` entry naming its real size, so the next
 * provider in the chain gets a turn. A silent drop would leave a slide
 * picture-less with no way to find out why, which is how "there are no
 * images" happened in the first place.
 */

import { readImageSize, type ImageColourSpace, type ImageFormat } from "@agent-engine/tool-common";

/**
 * The short side an image must reach.
 *
 * 1080 is the platform's own floor and also, not coincidentally, the width of
 * the plate: an image narrower than the canvas cannot fill it without being
 * enlarged. Deliberately NOT scaled by the render's 2x device ratio — the
 * platform states its floor against canvas pixels, and holding sources to
 * 2160 would refuse most of the correctly-licensed photography that exists.
 */
export const MIN_IMAGE_SHORT_SIDE_PX = 1080;

/** What was measured, flattened onto a candidate so the decision is auditable after the fact. */
export interface ImagePixelFacts {
  format: ImageFormat;
  width: number;
  height: number;
  shortSide: number;
  colourSpace: ImageColourSpace;
  profileName?: string;
}

/**
 * Findings that do NOT refuse the image but are worth recording: an embedded
 * profile we cannot convert, a format the feed will re-encode.
 */
interface ImageFloorWarnings {
  warnings: string[];
}

/**
 * A union rather than a flat interface with an optional `facts`, because the
 * two states really are different shapes: a PASS has necessarily measured the
 * image, so its facts are not optional, and a caller that narrowed on `ok`
 * should not have to re-check. A refusal may or may not have got far enough
 * to measure anything — unreadable bytes are refused before there is
 * anything to report.
 */
export type ImageFloorVerdict =
  | ({
      ok: true;
      facts: ImagePixelFacts;
      /** Empty by construction: a verdict with a reason is not a pass. */
      reasons: readonly [];
    } & ImageFloorWarnings)
  | ({
      ok: false;
      /** Absent when the bytes were not a readable container at all. */
      facts?: ImagePixelFacts;
      /**
       * Why it was refused, in the voice an `unmet` entry is written in —
       * always naming the measured number, never just "too small".
       */
      reasons: string[];
    } & ImageFloorWarnings);

/**
 * Measure an encoded image and decide whether it may be placed.
 *
 * An unreadable container is refused. That is deliberate and it is the
 * conservative direction: this pipeline downloads from open image search, and
 * bytes that no standard container parser recognises are either corrupt, an
 * error page served with an image content type, or something we should not be
 * decoding. A caller that genuinely wants to keep an unreadable file can look
 * at `facts === undefined` and decide for itself.
 */
export function assessImageFloor(bytes: Uint8Array): ImageFloorVerdict {
  const size = readImageSize(bytes);
  if (size === undefined) {
    return {
      ok: false,
      reasons: [
        `the downloaded bytes are not a readable PNG, JPEG, WebP, GIF or AVIF (${bytes.byteLength} bytes) — refused rather than placed unmeasured`,
      ],
      warnings: [],
    };
  }

  const facts: ImagePixelFacts = {
    format: size.format,
    width: size.width,
    height: size.height,
    shortSide: size.shortSide,
    colourSpace: size.colourSpace,
    ...(size.profileName === undefined ? {} : { profileName: size.profileName }),
  };

  const reasons: string[] = [];
  const warnings: string[] = [];

  if (size.shortSide < MIN_IMAGE_SHORT_SIDE_PX) {
    reasons.push(
      `${size.width}x${size.height} — the short side is ${size.shortSide}px, under the ${MIN_IMAGE_SHORT_SIDE_PX}px floor; placing it would mean enlarging it`,
    );
  }

  // CMYK is the one colour state that is simply wrong for a feed: it is a
  // print separation, and every renderer's conversion of it is a guess.
  if (size.colourSpace === "cmyk") {
    reasons.push(`${size.format.toUpperCase()} carries a CMYK profile — a print separation, which renders with shifted colour in a feed`);
  }
  if (size.colourSpace === "other-profile") {
    warnings.push(
      `carries an embedded ${size.profileName ?? "non-sRGB"} profile; the platform expects sRGB and will convert it with its own assumptions`,
    );
  }
  if (size.format === "gif") {
    warnings.push("GIF — a palette format the feed will re-encode; a PNG or JPEG of the same picture will hold up better");
  }

  return reasons.length === 0 ? { ok: true, facts, reasons: [], warnings } : { ok: false, facts, reasons, warnings };
}

/**
 * The verdict as one sentence, for an `unmet` entry or a step note.
 *
 * Several reasons are joined rather than the first being reported alone,
 * because "too small AND CMYK" is two different things to fix and a caller
 * that only hears one will fix one and try again.
 */
export function describeImageFloorRefusal(verdict: ImageFloorVerdict): string {
  return verdict.reasons.join("; ");
}
