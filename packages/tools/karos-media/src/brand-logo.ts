/**
 * Fetches a client's brand logo for embedding into rendered slide templates.
 *
 * A separate downloader from `downloadImage` (the hero-image path),
 * deliberately: the hero downloader's `EXTENSION_BY_TYPE` refuses SVG and
 * must keep refusing it — an SVG in the photo-candidate pool would reach
 * contexts where it isn't a plain decoded image. A LOGO is different: it is
 * embedded as a data URI inside an `<img>` (an image-decoding context where
 * scripts never execute), and real client logos are very often SVG —
 * karosCMO's own upload route accepts them. Widening the hero whitelist to
 * accommodate logos would fix one path by weakening another.
 *
 * Returns `undefined` on ANY failure (bad status, unexpected content type,
 * over the size cap, network error): a logo is brand furniture, and brand
 * furniture must never be able to hold a run — the caller composes the
 * document without it and the slide ships.
 *
 * The one exception to "just returns undefined": a non-`https://` URL
 * (SCRUM-383). That used to be a bare, silent `return undefined` on this
 * function's first line — indistinguishable from every other failure, and
 * indistinguishable from "no logoUrl at all" once it propagated. Callers
 * that derive a `logoUrl` themselves (`deriveBrandRenderTokens`, currently
 * this module's only real caller upstream) reject a non-https URL before it
 * ever reaches here and report why through their own trace; the `console.warn`
 * below is the fallback diagnostic for any caller — present or future — that
 * reaches this function directly with an unfiltered URL, so the refusal is
 * never silent even when nothing upstream already reported it.
 */

import { decodePngRows } from "@agent-engine/tool-common";

/** Logos are small; anything past this is not a logo, whatever it claims to be. Data URIs also count against the rendered document's size. */
export const BRAND_LOGO_MAX_BYTES = 1_500_000;

const LOGO_MIME_WHITELIST = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

export interface BrandLogoDownload {
  bytes: Uint8Array;
  /** The verified content type, parameter-stripped — safe to use in a data URI. */
  mime: string;
}

export async function downloadBrandLogo(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number = BRAND_LOGO_MAX_BYTES,
): Promise<BrandLogoDownload | undefined> {
  if (!/^https:\/\//i.test(url)) {
    console.warn(
      `[karos-media.downloadBrandLogo] refusing non-https brand logo URL "${url}" — only https:// is ever fetched; ` +
        "the caller proceeds without a logo rather than holding the run on brand furniture.",
    );
    return undefined;
  }
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return undefined;
    const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!LOGO_MIME_WHITELIST.has(mime)) return undefined;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The declared length is advisory; the actual byte count is the check
    // that holds.
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return undefined;
    return { bytes, mime };
  } catch {
    return undefined;
  }
}

/** The data-URI form the templates embed. Base64 never contains `{{`, so `fillTemplate`'s slot-stripping cannot touch it. */
export function brandLogoDataUri(download: BrandLogoDownload): string {
  return `data:${download.mime};base64,${Buffer.from(download.bytes).toString("base64")}`;
}

/**
 * The inverse of `brandLogoDataUri`, for the callers that persist the logo as
 * its data URI (the run's own `.media-cache/<runId>/brand/logo.datauri`) and
 * later need the BYTES back to read the mark's colors. Returns `undefined`
 * for anything that isn't one of `LOGO_MIME_WHITELIST`'s base64 data URIs —
 * the same refusal the downloader applies, so a cache file someone edited
 * cannot widen what this pipeline will decode.
 */
export function parseBrandLogoDataUri(uri: string): BrandLogoDownload | undefined {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(uri.trim());
  if (match === null) return undefined;
  const mime = match[1]!.toLowerCase();
  if (!LOGO_MIME_WHITELIST.has(mime)) return undefined;
  const bytes = new Uint8Array(Buffer.from(match[2]!, "base64"));
  return bytes.byteLength === 0 ? undefined : { bytes, mime };
}

// ─────────────────────────────────────────────────────────────────────────
// AU38 (SCRUM-322) — enforced logo contrast and deterministic placement
// ─────────────────────────────────────────────────────────────────────────

/**
 * Everything below is PURE and DETERMINISTIC on purpose, and it is code
 * rather than prompt text on purpose.
 *
 * Where the logo goes and whether it is legible where it went are not
 * judgement calls handed to a model. A model asked to "place the logo
 * legibly" is right most of the time, and the residue of that "most" is a
 * client opening a carousel whose mark has vanished into its own background.
 * So: the mark's actual pixels are read, WCAG 2.2 relative luminance is
 * computed from them, the ratio against the slide's `--bg` token is a real
 * number, and the corner is chosen by a rule with no free parameters.
 *
 * Nothing here reads a clock, a random source, or a model. Same inputs, same
 * plan, every time — which is the only way a "the logo is illegible on this
 * client's ground" regression can ever be caught by a test rather than by
 * the client.
 */

/**
 * WCAG 2.2 SC 1.4.11 (non-text contrast) — 3:1. A logo is a graphical
 * object, not body copy, so 4.5:1 (SC 1.4.3, normal text) is the wrong
 * floor; 3:1 is the published requirement for the thing this actually is.
 *
 * (WCAG exempts logotypes from its contrast requirements entirely. That
 * exemption is about conformance claims, not about whether a client's mark
 * can be seen — this pipeline holds itself to the graphical-object floor
 * regardless.)
 */
export const BRAND_LOGO_CONTRAST_FLOOR = 3;

/**
 * The share of a mark's visible mass a color must hold before it counts as
 * one of the mark's colors. Below this it is an antialiasing fringe or a
 * one-pixel accent, and letting a fringe satisfy the contrast floor would
 * make the floor meaningless.
 */
const SIGNIFICANT_MASS = 0.05;

/** 4 bits per channel: the histogram bins that decide what "one of the mark's colors" means. */
const QUANT_BITS = 4;

/** At most this many pixels are sampled, on a fixed stride. Deterministic, and bounds the work for a large mark. */
const MAX_SAMPLES = 100_000;

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` → `#RRGGBB`. Alpha digits are dropped:
 * the ground and fg tokens are opaque by design, and a mark's own alpha is
 * already accounted for by the mass weighting below. Anything else (a named
 * color, `rgb()`, a five-digit hex) is `undefined` — never repaired, never
 * guessed.
 */
export function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!HEX.test(trimmed)) return undefined;
  let digits = trimmed.slice(1);
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map((c) => c + c).join("");
  return `#${digits.slice(0, 6).toUpperCase()}`;
}

/** WCAG 2.2 relative luminance of an sRGB triple, channels 0..255. */
function luminanceOfChannels(r: number, g: number, b: number): number {
  const linear = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * WCAG 2.2 relative luminance of a hex color. `undefined` for anything that
 * is not a hex color — the caller decides what an unreadable token means, and
 * no default is invented here.
 */
export function relativeLuminance(hex: string): number | undefined {
  const norm = normalizeHex(hex);
  if (norm === undefined) return undefined;
  return luminanceOfChannels(parseInt(norm.slice(1, 3), 16), parseInt(norm.slice(3, 5), 16), parseInt(norm.slice(5, 7), 16));
}

/**
 * WCAG 2.2 contrast ratio, `(L1 + 0.05) / (L2 + 0.05)`, in `[1, 21]`.
 *
 * This is the real formula, not a threshold helper: `contrastRatio("#000000",
 * "#FFFFFF")` is exactly 21, `#767676` on white is 4.54 and `#777777` on
 * white is 4.48 (the published AA boundary pair). Returns `NaN` if either
 * argument is not a hex color, so a caller cannot mistake an unparsed token
 * for a passing comparison — `NaN >= FLOOR` is `false`.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === undefined || lb === undefined) return Number.NaN;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── Reading the mark's own colors ────────────────────────────────────────

/** One color mass inside a mark. */
export interface BrandLogoInkSample {
  /** Representative sRGB hex for this mass. */
  hex: string;
  /** Share of the mark's total visible mass, `(0, 1]`. */
  weight: number;
}

/**
 * The colors a mark is actually made of — read from the asset's bytes, never
 * declared by anybody.
 */
export interface BrandLogoInkProfile {
  source: "png" | "svg";
  /** Heaviest first, never empty. */
  samples: BrandLogoInkSample[];
}

/**
 * The colors a PNG mark is made of — a 4-bit-per-channel histogram over an
 * alpha-weighted sample of the asset's own pixels.
 *
 * THE DECODER USED TO LIVE HERE. Chunk walk, `zlib.inflateSync`, the
 * five-filter unfilter and the 16-megapixel cap are now `decodePngRows` in
 * `@agent-engine/tool-common` — same physics, same refusals, lifted verbatim
 * so a second caller (`karos-publish`'s `measureSlidePng`, which reads the
 * rendered slide's pixels) uses one decoder instead of a second copy. What
 * remains here is the part that was always specific to a logo: the binning
 * fold below.
 *
 * The fold is deliberately unchanged, down to the sampling stride and the
 * bin key, because `brand-logo-*.test.ts` asserts real hex values read out
 * of real PNGs and those assertions are the regression pin for the lift. A
 * decoder returning `undefined` (not a PNG, interlaced, sub-byte depth,
 * truncated, over the pixel cap) still means "unreadable ink", which the
 * placement plan reports rather than papers over.
 */
function decodePngSamples(bytes: Uint8Array): BrandLogoInkSample[] | undefined {
  const bins = new Map<number, { weight: number; r: number; g: number; b: number }>();
  let totalWeight = 0;
  // A fixed stride, so the same PNG always samples the same pixels. It
  // depends on the frame's size, which is only known once the decoder hands
  // over the first row — hence the lazy initialisation rather than a
  // separate header-reading pass.
  let step: number | undefined;
  const shift = 8 - QUANT_BITS;

  const header = decodePngRows(bytes, (row, y, hdr) => {
    step ??= Math.max(1, Math.ceil(Math.sqrt((hdr.width * hdr.height) / MAX_SAMPLES)));
    if (y % step !== 0) return;
    for (let x = 0; x < hdr.width; x += step) {
      const px = x * 4;
      const alpha = row[px + 3]!;
      if (alpha === 0) continue; // fully transparent: not part of the mark
      const r = row[px]!;
      const g = row[px + 1]!;
      const b = row[px + 2]!;
      const key = ((r >> shift) << (2 * QUANT_BITS)) | ((g >> shift) << QUANT_BITS) | (b >> shift);
      const bin = bins.get(key) ?? { weight: 0, r: 0, g: 0, b: 0 };
      bin.weight += alpha;
      bin.r += r * alpha;
      bin.g += g * alpha;
      bin.b += b * alpha;
      bins.set(key, bin);
      totalWeight += alpha;
    }
  });

  if (header === undefined) return undefined;
  if (totalWeight === 0) return undefined; // fully transparent: no mark to check
  return finalizeSamples(
    [...bins.entries()].map(([key, bin]) => ({
      key,
      weight: bin.weight / totalWeight,
      hex: rgbHex(Math.round(bin.r / bin.weight), Math.round(bin.g / bin.weight), Math.round(bin.b / bin.weight)),
    })),
  );
}

function rgbHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, "0").toUpperCase();
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

/**
 * Drops the fringe bins, sorts heaviest-first, and guarantees a non-empty
 * result: a mark whose every bin sits under `SIGNIFICANT_MASS` (a photographic
 * gradient) still reports its single heaviest mass rather than reporting
 * "no ink", which would silently disable the contrast check.
 *
 * Ties are broken on the bin key so the ordering is total — two masses of
 * identical weight must not sort differently between runs.
 */
function finalizeSamples(entries: { key: number; weight: number; hex: string }[]): BrandLogoInkSample[] {
  const sorted = [...entries].sort((a, b) => (b.weight - a.weight) || (a.key - b.key));
  const significant = sorted.filter((e) => e.weight >= SIGNIFICANT_MASS);
  const kept = significant.length > 0 ? significant : sorted.slice(0, 1);
  return kept.map((e) => ({ hex: e.hex, weight: e.weight }));
}

/** The named CSS colors that actually turn up in exported logo SVGs. Anything outside this is unreadable, not guessed. */
const SVG_NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  silver: "#C0C0C0",
  gray: "#808080",
  grey: "#808080",
  red: "#FF0000",
  lime: "#00FF00",
  green: "#008000",
  blue: "#0000FF",
  navy: "#000080",
  yellow: "#FFFF00",
  orange: "#FFA500",
  purple: "#800080",
  teal: "#008080",
  aqua: "#00FFFF",
  cyan: "#00FFFF",
  magenta: "#FF00FF",
  fuchsia: "#FF00FF",
  maroon: "#800000",
  olive: "#808000",
};

const SVG_PAINT = /(?:\b(?:fill|stroke|stop-color|flood-color)\s*[:=]\s*)["']?\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)/g;

function parseSvgPaint(token: string): string | undefined {
  const hex = normalizeHex(token);
  if (hex !== undefined) return hex;
  const rgb = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/.exec(token);
  if (rgb !== null) return rgbHex(Math.round(Number(rgb[1])), Math.round(Number(rgb[2])), Math.round(Number(rgb[3])));
  return SVG_NAMED_COLORS[token.toLowerCase()];
}

/**
 * An SVG has no pixels to sample, so its DECLARED paints are the mark's
 * colors. Every distinct paint counts once — an SVG cannot tell us how much
 * area each covers without rasterizing, and weighting by declaration count
 * would let a mark made of forty identical hairlines outvote its own
 * wordmark.
 */
function decodeSvgSamples(bytes: Uint8Array): BrandLogoInkSample[] | undefined {
  const text = Buffer.from(bytes).toString("utf8");
  const found: string[] = [];
  for (const match of text.matchAll(SVG_PAINT)) {
    const token = match[1];
    if (token === undefined) continue;
    const lowered = token.toLowerCase();
    if (lowered === "none" || lowered === "transparent" || lowered === "currentcolor" || lowered === "inherit") continue;
    const hex = parseSvgPaint(token);
    if (hex !== undefined && !found.includes(hex)) found.push(hex);
  }
  if (found.length === 0) return undefined;
  const weight = 1 / found.length;
  // The declaration order IS the key here, so the tie-break stays total.
  return finalizeSamples(found.map((hex, key) => ({ key, weight, hex })));
}

/**
 * The mark's own colors, read from the downloaded bytes.
 *
 * `undefined` means UNREADABLE, not "fine" — a JPEG or WebP logo (neither
 * carries the transparency a mark normally needs, and neither has a decoder
 * here) has no verifiable ink, and `planBrandLogoPlacement` says so in its
 * `reason` rather than reporting a contrast it never computed.
 */
export function readBrandLogoInk(download: BrandLogoDownload): BrandLogoInkProfile | undefined {
  if (download.mime === "image/png") {
    const samples = decodePngSamples(download.bytes);
    return samples === undefined ? undefined : { source: "png", samples };
  }
  if (download.mime === "image/svg+xml") {
    const samples = decodeSvgSamples(download.bytes);
    return samples === undefined ? undefined : { source: "svg", samples };
  }
  return undefined;
}

/**
 * The mark's contrast against one background: the BEST ratio any of its
 * significant color masses achieves.
 *
 * Best, not average, and not worst — deliberately. A dark wordmark exported
 * on an opaque white plate has two masses; averaging them would call it
 * illegible on both a white and a black ground, and taking the worst would
 * call every two-tone mark illegible everywhere. What actually decides
 * whether a viewer can see the mark is whether ANY substantial part of it
 * separates from the ground.
 */
export function logoContrastAgainst(ink: BrandLogoInkProfile, background: string): { ratio: number; hex: string } | undefined {
  let best: { ratio: number; hex: string } | undefined;
  for (const sample of ink.samples) {
    const ratio = contrastRatio(sample.hex, background);
    if (!Number.isFinite(ratio)) continue;
    if (best === undefined || ratio > best.ratio) best = { ratio, hex: sample.hex };
  }
  return best;
}

// ── The placement plan ───────────────────────────────────────────────────

/**
 * Which corner the mark occupies. `bottom-start` is never offered: the
 * `@handle` watermark owns it on every slide, and a plan that could put the
 * logo there would be a plan that could overprint the handle.
 */
export type BrandLogoCorner = "top-start" | "top-end";

/** Which surface the plan is for. */
export type BrandLogoSurface = "slide" | "cover";

export interface BrandLogoPlacementInput {
  /** The background token the mark lands on — the slide's `--bg`, or the video cover's bar color. Must be a hex color. */
  ground: string;
  /** The mark's own colors. Omit when unreadable; the plan reports that rather than assuming a pass. */
  ink?: BrandLogoInkProfile | undefined;
  /** The kit's text color, tried first as a scrim plate before the achromatic fallbacks. */
  fg?: string | undefined;
  /** True when a standing series badge occupies the start-side top corner. */
  hasSeriesBadge?: boolean;
  /** Defaults to `"slide"`. */
  surface?: BrandLogoSurface;
  /** Set false for a surface that cannot paint a plate behind the mark; a failing mark is then omitted instead. Defaults to true. */
  allowScrim?: boolean;
}

/**
 * - `place` — the mark clears the floor on the ground as-is.
 * - `scrim` — it does not, and a plate that it DOES clear goes behind it.
 * - `omit`  — no legible arrangement exists (or none can be verified), so
 *             nothing is rendered. Never a run failure: brand furniture must
 *             not be able to hold a run, so the slide ships without the mark.
 */
export type BrandLogoDecision = "place" | "scrim" | "omit";

export interface BrandLogoScrim {
  /** The plate color. */
  color: string;
  /** The measured ratio the mark achieves against that plate — always >= `BRAND_LOGO_CONTRAST_FLOOR`. */
  contrast: number;
  padPx: number;
  radiusPx: number;
}

export interface BrandLogoPlacement {
  decision: BrandLogoDecision;
  corner: BrandLogoCorner;
  /** Slide-surface geometry, in CSS px. A `cover` caller composites in its own units and reads `corner`/`scrim` only. */
  insetBlockPx: number;
  insetInlinePx: number;
  widthPx: number;
  /**
   * The MEASURED WCAG ratio of the mark against `ground`. `undefined` only
   * when the ink could not be read at all — never a stand-in for "passed".
   */
  groundContrast?: number;
  /** Which of the mark's masses produced `groundContrast`. */
  contrastingHex?: string;
  scrim?: BrandLogoScrim;
  /** Why this plan is what it is — carried into traces so "why is there no logo" has an answer. */
  reason: string;
}

/** Distance from the slide edge, matching the `.brand-handle`/`.brand-badge` furniture already on the templates. */
const SLIDE_INSET_PX = 44;
/** The mark's rendered width. Height follows the asset's own aspect ratio. */
const SLIDE_LOGO_WIDTH_PX = 150;
const SCRIM_PAD_PX = 12;
const SCRIM_RADIUS_PX = 8;

/**
 * Where the mark goes. Two inputs, one rule, no free parameters:
 *
 * - a standing series badge owns the start-side top corner, so the mark takes
 *   the end-side one;
 * - otherwise the mark takes the start side, which is where it has always been.
 *
 * A video cover always takes the start side: its series header is centred in
 * the top bar, so there is nothing in that corner to yield to.
 */
function chooseCorner(input: BrandLogoPlacementInput): BrandLogoCorner {
  if (input.surface === "cover") return "top-start";
  return input.hasSeriesBadge === true ? "top-end" : "top-start";
}

/**
 * The plate colors tried, in order: the kit's own text color first (already a
 * legible pair with this ground, so it reads as brand furniture rather than a
 * patch), then white, then black.
 *
 * White and black are not brand colors and are not pretending to be — they
 * are a legibility plate, the render-domain equivalent of the scrims the
 * templates already paint behind text over photography. One of them ALWAYS
 * works: for any color, contrast-to-white times contrast-to-black is exactly
 * 21, so both being under 3 is arithmetically impossible.
 */
function chooseScrim(ink: BrandLogoInkProfile, fg: string | undefined): BrandLogoScrim | undefined {
  const candidates = [fg, "#FFFFFF", "#000000"];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const normalized = normalizeHex(candidate);
    if (normalized === undefined) continue;
    const best = logoContrastAgainst(ink, normalized);
    if (best !== undefined && best.ratio >= BRAND_LOGO_CONTRAST_FLOOR) {
      return { color: normalized, contrast: best.ratio, padPx: SCRIM_PAD_PX, radiusPx: SCRIM_RADIUS_PX };
    }
  }
  return undefined;
}

/**
 * The whole decision, in one pure function.
 *
 * Read it as the ladder it is: an unreadable ground is refused outright (a
 * contrast check against a token nobody can parse is not a check); a mark
 * that clears the floor is placed; a mark that does not gets a plate it does
 * clear; and a surface that cannot carry a plate omits the mark instead of
 * rendering it into its own background.
 *
 * The one case that renders unchecked is an UNREADABLE MARK (a JPEG/WebP
 * logo — see `readBrandLogoInk`). That is stated in `reason` and left
 * unenforced rather than enforced against a color nobody computed: inventing
 * a contrast number for an asset we cannot decode is exactly the mocked
 * "passes" this whole module exists to avoid.
 */
export function planBrandLogoPlacement(input: BrandLogoPlacementInput): BrandLogoPlacement {
  const corner = chooseCorner(input);
  const base = {
    corner,
    insetBlockPx: SLIDE_INSET_PX,
    insetInlinePx: SLIDE_INSET_PX,
    widthPx: SLIDE_LOGO_WIDTH_PX,
  } as const;

  const ground = normalizeHex(input.ground);
  if (ground === undefined) {
    return { ...base, decision: "omit", reason: `background token "${input.ground}" is not a hex color, so contrast cannot be computed` };
  }

  if (input.ink === undefined) {
    return { ...base, decision: "place", reason: "the mark's colors could not be read from its bytes, so no contrast was computed" };
  }

  const best = logoContrastAgainst(input.ink, ground);
  if (best === undefined) {
    return { ...base, decision: "place", reason: "the mark carried no readable color mass, so no contrast was computed" };
  }

  const measured = { groundContrast: best.ratio, contrastingHex: best.hex };
  if (best.ratio >= BRAND_LOGO_CONTRAST_FLOOR) {
    return {
      ...base,
      ...measured,
      decision: "place",
      reason: `mark clears ${BRAND_LOGO_CONTRAST_FLOOR}:1 on ${ground} at ${best.ratio.toFixed(2)}:1`,
    };
  }

  if (input.allowScrim === false) {
    return {
      ...base,
      ...measured,
      decision: "omit",
      reason: `mark reaches only ${best.ratio.toFixed(2)}:1 on ${ground} and this surface cannot carry a scrim`,
    };
  }

  const scrim = chooseScrim(input.ink, input.fg);
  if (scrim === undefined) {
    return {
      ...base,
      ...measured,
      decision: "omit",
      reason: `mark reaches only ${best.ratio.toFixed(2)}:1 on ${ground} and no scrim color clears the floor either`,
    };
  }

  return {
    ...base,
    ...measured,
    decision: "scrim",
    scrim,
    reason:
      `mark reaches only ${best.ratio.toFixed(2)}:1 on ${ground}; ` +
      `placed on a ${scrim.color} scrim it reaches ${scrim.contrast.toFixed(2)}:1`,
  };
}
