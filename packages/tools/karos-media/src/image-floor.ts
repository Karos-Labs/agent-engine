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
 * ## Size is measured. Size is not a refusal.
 *
 * It was one, briefly, and the owner overruled it on 2026-09-18 after two
 * prep runs showed what it actually did: a generated 896x1200 frame was
 * refused six times across the two runs, each refusal AFTER the image charge
 * had been paid, and in one run the retries walked into a 429. The slide
 * ended up with no photograph at all. Against a 1080 canvas, 896 is a 1.21x
 * enlargement — a difference nobody sees on a phone, traded for a picture
 * nobody gets.
 *
 * The owner's own framing is the rule now: a mark, a logo or a figure sitting
 * in part of the plate never needed 1080 in the first place, because it is
 * never asked to cover 1080. So what the measurement decides is PLACEMENT,
 * not admission. `placementFor` answers "how large a job can this image
 * hold", and the answer is always at least `accent` — there is no size at
 * which this function throws the picture away.
 *
 * ## What still refuses
 *
 * Two things, neither of them a size.
 *
 * **Unreadable bytes.** Not an image at all: an HTML error page served as
 * image/jpeg, a truncated download, something we should not be decoding.
 * Placing it would mean inventing its dimensions.
 *
 * **A CMYK profile.** A print separation renders with shifted, often
 * inverted colour in a browser, and every renderer's conversion is a guess.
 * That is a broken slide rather than a soft one, and a broken slide is the
 * one case where no picture is the better outcome.
 *
 * ## What "no upscaling" can honestly mean here
 *
 * It cannot mean "this file was never enlarged by whoever made it". That is
 * not recoverable from the bytes: a 640px photo resampled to 2000px and
 * re-encoded is, byte for byte, a 2000px photo. Claiming to detect it would
 * be a guess wearing a measurement's clothes.
 *
 * What it now means is that the pipeline never enlarges one PAST
 * `MAX_UPSCALE`, and where it enlarges at all it says so — `fullBleedUpscale`
 * travels on the facts, so a reviewer reads "1.21x" rather than guessing why
 * one slide looks softer than the rest.
 */

import { readImageSize, type ImageColourSpace, type ImageFormat } from "@agent-engine/tool-common";

/**
 * The canvas an image is measured against.
 *
 * 1080 is the platform's own number and also the width of the plate.
 * Deliberately NOT scaled by the render's 2x device ratio: the platform
 * states its floor against canvas pixels, and holding sources to 2160 would
 * disqualify most of the correctly-licensed photography that exists from
 * covering a frame it covers perfectly well.
 */
export const CANVAS_SHORT_SIDE_PX = 1080;

/**
 * Retained under its old name because the platform's published floor is still
 * a real number worth reporting against. It no longer gates anything.
 */
export const MIN_IMAGE_SHORT_SIDE_PX = CANVAS_SHORT_SIDE_PX;

/**
 * How far this pipeline will enlarge a picture before the softness is worth
 * mentioning rather than ignoring.
 *
 * 1.4 is a judgement, and it is the honest kind: below roughly 1.4x on a
 * phone-sized frame the resampling is not visible at arm's length, and above
 * it the edges start to smear. It is not a refusal threshold — nothing here
 * refuses on size — it is where `placementFor` stops calling an image good
 * for the whole frame and starts calling it good for part of one.
 */
export const MAX_UPSCALE = 1.4;

/**
 * The largest job an image's pixels can hold.
 *
 * `full-bleed` covers the plate. `inset` fills a card, a figure or a panel,
 * which the layouts size at roughly 45% of the frame. `accent` is a mark, a
 * logo or a badge — the owner's case, and the reason there is no rung below
 * it: an image that has survived download and measurement always has a job.
 */
export type ImagePlacement = "full-bleed" | "inset" | "accent";

/** The share of the frame an inset is laid out against. */
export const INSET_FRAME_SHARE = 0.45;

export const FULL_BLEED_MIN_SHORT_SIDE_PX = Math.ceil(CANVAS_SHORT_SIDE_PX / MAX_UPSCALE);
export const INSET_MIN_SHORT_SIDE_PX = Math.ceil((CANVAS_SHORT_SIDE_PX * INSET_FRAME_SHARE) / MAX_UPSCALE);

/**
 * The largest role these pixels can carry without visible enlargement.
 *
 * Total, by construction: every size maps to a placement and the lowest rung
 * has no lower bound. A caller can always place what it is handed.
 */
export function placementFor(shortSide: number): ImagePlacement {
  if (shortSide >= FULL_BLEED_MIN_SHORT_SIDE_PX) return "full-bleed";
  if (shortSide >= INSET_MIN_SHORT_SIDE_PX) return "inset";
  return "accent";
}

/** What was measured, flattened onto a candidate so the decision is auditable after the fact. */
export interface ImagePixelFacts {
  format: ImageFormat;
  width: number;
  height: number;
  shortSide: number;
  colourSpace: ImageColourSpace;
  profileName?: string;
  /** The largest job these pixels can hold. Never absent: see `placementFor`. */
  placement: ImagePlacement;
  /**
   * What covering the whole frame would cost in enlargement, to two decimals.
   * At or below 1 the image is being reduced, which is free.
   */
  fullBleedUpscale: number;
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
 * An unreadable container is refused, and so is a CMYK separation. Size is
 * not consulted for the decision at all — it sets `facts.placement`, which is
 * advice about where the picture goes, not permission for it to exist.
 *
 * A caller that genuinely wants to keep an unreadable file can look at
 * `facts === undefined` and decide for itself.
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

  const placement = placementFor(size.shortSide);
  const facts: ImagePixelFacts = {
    format: size.format,
    width: size.width,
    height: size.height,
    shortSide: size.shortSide,
    colourSpace: size.colourSpace,
    ...(size.profileName === undefined ? {} : { profileName: size.profileName }),
    placement,
    fullBleedUpscale: Math.round((CANVAS_SHORT_SIDE_PX / size.shortSide) * 100) / 100,
  };

  const reasons: string[] = [];
  const warnings: string[] = [];

  // Recorded, never refused. The warning exists so a reviewer looking at a
  // soft slide finds the number instead of guessing, and so the sourcing
  // step has something to PREFER on when it holds several candidates.
  if (placement !== "full-bleed") {
    warnings.push(
      `${size.width}x${size.height} — too small to cover the frame without a ${facts.fullBleedUpscale}x enlargement, so it is placed as ${placement} rather than full-bleed`,
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
