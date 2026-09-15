import { markColourDistance } from "./emphasis-marks.js";

/**
 * THE MATERIAL GROUND (RFC-20 §5.1, Phase 7) — a full-bleed layer that is
 * invisible to the instrument.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────
 *
 * The owner's founding complaint is a mostly-grey slide nobody saves, and
 * Phase 2 built a pixel interest floor to refuse exactly that. It refuses a
 * BARE grey plate. It does not refuse a DECORATED one: measured through the
 * real `measureSlidePng`, a grey screen carrying a Phase-2 decoration reports
 * `largestEmptyRectShare` 0.0148 against a 0.22 ceiling and `occupiedShare`
 * 0.4217 against a floor — so clauses C and D are disarmed by our own painted
 * grounds, and the owner's original grey screen PASSES today.
 *
 * The structural fact behind it, read out of `slide-metrics.ts:866-919`:
 * `covered` (48/64 samples) implies `carriesInk` (4/64), so
 * `imageryOrDeviceShare ⊆ contentOccupiedShare ⊆ occupiedShare`, cell for
 * cell. **There is no amplitude, pitch, tint or grain at which paint is
 * visible to clause E and invisible to clauses C and D.** The only free
 * variable is WHERE the paint is, which is why RFC-20 §5.0's Ground Rule is
 * spatial: every painted layer is either MATERIAL (below `FLAT_TOL`,
 * contributing zero to every share, and therefore allowed to be full-bleed)
 * or AN OBJECT (bounded by the content, guarded off when the content is
 * absent). Nothing in between.
 *
 * This module is the MATERIAL half. It is what the reference accounts
 * actually do: rf-05 and rf-11 share one light paper with a fine tooth and a
 * soft cloudiness, and under our instrument it measures zero everywhere.
 *
 * ── WHY TURBULENCE AND NOT A GAUSSIAN GRAIN ──────────────────────────────
 *
 * `feTurbulence` is bounded in [0,1] by construction, so an alpha-scaled tint
 * is hard-clamped and the peak deviation is a number we SET. A Gaussian has
 * an unbounded tail: the grain sweep (MEASURED-EDGE, RFC-20 §5.1) showed
 * σ=4 taking `largestEmptyRectShare` from 100.00 to 41.11 while contributing
 * 0.00 to everything else — the worst possible failure, disarming clause C
 * and paying for nothing.
 *
 * ── WHY THE AMPLITUDE IS COMPUTED AND NEVER CHOSEN ───────────────────────
 *
 * `rgba()`/`color-mix(in srgb, …)` compositing is a channel-wise lerp in
 * gamma-encoded sRGB, so `markColourDistance(painted, ground) = alpha ·
 * markColourDistance(tint, ground)` EXACTLY. Therefore the alpha that puts a
 * layer at a stated metric deviation is `alpha = delta / distance(tint,
 * ground)` — about 5.1% ink-on-ground for the bundled dark kit
 * (`#17181C`/`#F4F2EC`, distance 215.4) and 5.0% for a paper kit
 * (`#F0EAE6`/`#12100E`, distance 218.2). That is the amplitude real paper
 * tooth sits at, and it falls out of the kit rather than out of taste.
 *
 * A useful identity, pinned by `ground-material.test.ts`: for an achromatic
 * deviation `d` on all three channels, `sqrt(2d²+4d²+3d²)/3 = d`. A neutral
 * grain's metric distance is EXACTLY its 8-bit level deviation, so this
 * module specifies in metric units and reads back in levels with no
 * conversion.
 *
 * ── WHY TWO OPPOSED TEETH ────────────────────────────────────────────────
 *
 * The material is SYMMETRIC about the ground: one tooth toward the ink, one
 * tooth away from it, driven by the SAME turbulence with its alpha inverted,
 * so the two can never co-peak in one pixel and their means cancel. Without
 * that, the modal cell colour drifts and `backgroundHex` eventually flips to
 * the ink — the failure that invalidated every grain-sweep row above σ≈14,
 * after which every share is measured against a wrong anchor and
 * `backgroundMatchesBrandGround` is only a warning.
 *
 * ── MEASURED-HERE (`scratchpad/material-probe.mjs`, hand-painted 2160×2880
 *    plates through the REAL shipped `measureSlidePng`) ────────────────────
 *
 * | kit          | ink    | occ    | COCC   | iod    | LER    | flat   | bgHex    |
 * |--------------|--------|--------|--------|--------|--------|--------|----------|
 * | bundled dark | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 1.0000 | 1.0000 | = ground |
 * | paper        | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 1.0000 | 1.0000 | = ground |
 * | mono         | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 1.0000 | 1.0000 | = ground |
 * | pale accent  | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 1.0000 | 1.0000 | = ground |
 *
 * And the same painter with every alpha DOUBLED (realised peak 22, past
 * `tol.ink = 18`): `inkShare` 0.1506 / `occupiedShare` 0.3100 / `LER` 0.0694
 * on the bundled kit. The floor can see a loud material perfectly well; what
 * it cannot see is this one. **That pair is the whole claim**, and both
 * halves are re-measured by `ground-material.test.ts` on every run, with no
 * Chromium involved.
 *
 * ── WHAT IS CI's ALONE ───────────────────────────────────────────────────
 *
 * The alpha arithmetic and the measurement above are Chromium-free and are
 * this machine's to prove. **What Chromium's `feTurbulence` actually paints
 * is not**: the tests stand in a bounded [0,1] noise field for it, which is
 * the only property the amplitude argument rests on, and RFC-20 §5.8.2's
 * band sweep is the authority on the real filter.
 */

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/**
 * The material's peak deviation from the ground, in metric units — which for
 * a neutral grain are 8-bit levels (the achromatic identity above).
 *
 * MEASURED-HERE (RFC-20 §5.1a, and re-measured by this module's own test):
 * every share is byte-identical to a bare plate from 6 through 13;
 * `flatBackgroundShare` moves first at ~16 and `inkShare`/`LER` break between
 * 16 and 20 — at `tol.ink = 18`, the correct and predictable place, because a
 * material whose peak deviation is under 18 produces no ink pixel at all. 11
 * therefore sits mid-plateau with 7 units of headroom, not on an edge.
 *
 * CHOSEN AT THE *FLAT* LINE (`FLAT_TOL = 12`) RATHER THAN THE *INK* LINE,
 * DELIBERATELY: a material in the 12-18 band would take
 * `flatBackgroundShare` under the 0.70 ceiling and disarm clause D's first
 * limb on every plate that wears it — defect 1 again, one clause over.
 */
export const MATERIAL_PEAK_DELTA = 11;

/**
 * The tile, in design px. Rasterised once by Chromium at this size rather
 * than at the full 2160×2880 device canvas. At the stock ladder's base
 * frequencies the feature size is at most ~2.4px, and a 256px `stitch`ed
 * repeat is not perceptible at feed size.
 */
export const MATERIAL_TILE_PX = 256;

/**
 * Below this peak there is no material — there is nothing. A ground with
 * almost no room on one side of the ink axis (a near-white plate, whose lift
 * is white) cannot carry a symmetric tooth, and half a tooth is an
 * ASYMMETRIC material, which is the one failure mode this module exists to
 * avoid. So it emits nothing instead, and the plate renders exactly as it
 * does today.
 */
export const MATERIAL_MIN_PEAK_DELTA = 3;

/**
 * No layer may paint its tint at more than this alpha. A layer at alpha 1.0
 * replaces the ground with its own tint at the noise peak, which is a painted
 * field with extra steps; capping at 0.9 keeps every pixel a MIX of ground
 * and tint and costs nothing, since the peak is capped far below this on
 * every kit with real contrast.
 */
export const MATERIAL_ALPHA_CAP = 0.9;

/**
 * The material's mean must not move the ground. This bounds
 * `|E[composite] - ground|` as a metric distance.
 *
 * MEASURED-HERE over the kit corpus: 0.59 (bundled dark), 1.00 (paper), 0.00
 * (mono — achromatic, exact), 1.10 (pale accent). The residue is pure
 * gamut clamping: the lift is the ink mirrored across the ground and clamped
 * into sRGB, so on a warm paper the lift is a pure white that is not exactly
 * opposite a warm ink. 2.0 is a 1.8× margin over the worst corpus row, and it
 * is six times under `tol.flat = 12`, where `backgroundMatchesBrandGround`
 * would start to care.
 *
 * NOT a threshold that may be relaxed to admit a layer: a plan that fails it
 * is asymmetric, and an asymmetric material is refused outright.
 */
export const MATERIAL_MEAN_DRIFT_MAX = 2.0;

/**
 * How the peak is split between the layers, PER DIRECTION.
 *
 * ── WHY PER DIRECTION AND NOT AS ONE SUM ─────────────────────────────────
 *
 * RFC-20 §5.1 states the emit-time bound as `Σ_layers alpha_L ·
 * distance(tint_L, ground) ≤ MATERIAL_PEAK_DELTA`, "summed because two layers
 * can co-peak in one pixel". That justification is a REALISABILITY argument,
 * and it is the right one — but the plain sum is not the realisable bound
 * here, because the two teeth are driven by ONE turbulence with its alpha
 * inverted for the second (`1 - n`), so they provably cannot co-peak. The
 * RFC's own layer alphas (`alpha/2`, `alpha/2`, `alpha/3`) sum to
 * `1.33 × MATERIAL_PEAK_DELTA` and violate the bound as written, which is how
 * the inconsistency surfaced.
 *
 * So the bound enforced here is the EXACT realisable one: the sum within each
 * co-peakable group — the ink-side layers, which are independent and can
 * co-peak, and the lift-side layer — each at most `MATERIAL_PEAK_DELTA`. It
 * is never looser than the truth (compositing is a lerp, so the triangle
 * inequality makes a group's sum an upper bound on its realisable deviation),
 * and it is what §5.1a's plateau table actually measured: a plate whose
 * WORST PIXEL sits at peak 11. Enforcing the plain sum instead would ship a
 * material at half the measured amplitude and put the calibration on numbers
 * nobody took.
 */
export const MATERIAL_LAYER_SHARES = {
  /** The tooth toward the ink — paper's own fibre, the thing you see when you tilt a page. */
  toothInk: 0.75,
  /** The uneven pulp density that stops the plate reading as screen noise (rf-11's visible cloudiness). */
  cloud: 0.25,
  /** The tooth away from the ink. Alone on its side, because it is the whole counterweight. */
  toothLift: 1,
} as const;

/** A physical stock. Four of them, none a pattern — the base frequencies are all above the pitch at which a repeat is visible. */
export interface MaterialStock {
  readonly id: "laid" | "wove" | "board" | "canvas";
  /** The tooth's `baseFrequency`, in 1/px of the tile's user space. */
  readonly toothBaseFrequency: number;
  readonly toothOctaves: number;
  /** The cloud's `baseFrequency` — RFC-20 §5.1's 0.02-0.05 band, i.e. a feature every 20-50px. */
  readonly cloudBaseFrequency: number;
  readonly cloudOctaves: number;
}

/**
 * The stock ladder, picked by `fnv1a32(clientSlug) % 4`.
 *
 * CONSTANT ACROSS THE CAROUSEL, and this is the one place in this agent where
 * variation is deliberately REFUSED: rf-11 and rf-05 both keep one stock
 * across eight slides, and a paper that changed between slides reads as a
 * rendering bug rather than as craft. The same hash also seeds the
 * turbulence, so one client always gets the same paper and two clients very
 * rarely share one (the seed space is 16 bits per field, so a collision is a
 * collision of paper, never of anything a client can see).
 */
export const MATERIAL_STOCKS: readonly MaterialStock[] = [
  { id: "laid", toothBaseFrequency: 0.9, toothOctaves: 3, cloudBaseFrequency: 0.05, cloudOctaves: 2 },
  { id: "wove", toothBaseFrequency: 0.75, toothOctaves: 3, cloudBaseFrequency: 0.04, cloudOctaves: 2 },
  { id: "board", toothBaseFrequency: 0.55, toothOctaves: 3, cloudBaseFrequency: 0.028, cloudOctaves: 2 },
  { id: "canvas", toothBaseFrequency: 0.42, toothOctaves: 4, cloudBaseFrequency: 0.02, cloudOctaves: 2 },
];

/**
 * The bundled templates' own `:root` pair (`assets/templates/default/*.html`).
 * A client with no derivable kit renders on exactly these, so the material's
 * arithmetic has to be done against them rather than skipped — the brandless
 * client is the one `extraHeadHtml` exists for in the first place.
 */
const DEFAULT_GROUND = "#17181C";
const DEFAULT_INK = "#F4F2EC";

// ─────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────

export type MaterialLayerRole = "tooth-ink" | "cloud" | "tooth-lift";

export interface GroundMaterialLayer {
  readonly role: MaterialLayerRole;
  /** Which side of the ground this layer pulls toward. Layers on one side can co-peak; the two sides cannot. */
  readonly direction: "ink" | "lift";
  /** The literal tint. NOT a `var()`: it is baked into an SVG data URI, which cannot read a custom property — see `groundMaterialCssBlock` on inversion. */
  readonly tintHex: string;
  /** The peak alpha, computed from the kit: `share · peak / distance(tint, ground)`. */
  readonly alpha: number;
  /** `feComponentTransfer` maps the turbulence alpha to `1 - n`, which is what makes the two teeth opposed. */
  readonly invertAlpha: boolean;
  readonly baseFrequency: number;
  readonly octaves: number;
  readonly seed: number;
  /** `alpha · distance(tint, ground)` — this layer's realisable peak deviation, in metric units. */
  readonly peakDelta: number;
}

export interface GroundMaterialPlan {
  readonly groundHex: string;
  readonly inkHex: string;
  /** The ink mirrored across the ground and clamped into sRGB — the direction "away from the ink", which is what keeps the material symmetric. */
  readonly liftHex: string;
  readonly stock: MaterialStock;
  readonly tilePx: number;
  readonly layers: readonly GroundMaterialLayer[];
  /** The peak this plan actually paints, after the gamut and alpha caps. `MATERIAL_PEAK_DELTA` on every kit with real contrast. */
  readonly effectivePeakDelta: number;
  /** Σ peak over the INK-side layers, and over the LIFT-side layer. Each is the exact realisable bound for its side and each must be ≤ `MATERIAL_PEAK_DELTA`. */
  readonly peakDeltaByDirection: { readonly ink: number; readonly lift: number };
  /** RFC-20 §5.1's literal sum over all layers, reported so the deviation is visible rather than argued. Bounded by `2 · MATERIAL_PEAK_DELTA`. */
  readonly peakDeltaSum: number;
  /** `|E[composite] - ground|` as a metric distance. The symmetry invariant; see `MATERIAL_MEAN_DRIFT_MAX`. */
  readonly meanDriftDelta: number;
  /** True when every invariant holds. `groundMaterialCssBlock` emits nothing when it is false. */
  readonly ok: boolean;
  /** Why not, when `ok` is false. Every refusal names its own number. */
  readonly refusal?: string;
}

export interface GroundMaterialTokens {
  /** The effective kit's `--bg`. Absent means a brandless client, which renders on the bundled `:root`. */
  readonly ground?: string | undefined;
  /** The effective kit's `--fg`. */
  readonly fg?: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Small local utilities
// ─────────────────────────────────────────────────────────────────────────

/** `#abc`/`#aabbcc` -> an RGB triple. `undefined` for anything else — never repaired, never guessed. Mirrors `emphasis-marks.ts`'s `parseHex`, which is private there. */
function parseHex(value: string | undefined): [number, number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) return undefined;
  let h = trimmed.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/**
 * `markColourDistance`'s own weighted-RGB formula, evaluated on a FLOAT
 * channel difference.
 *
 * Not a second metric — the same one, reached without a round-trip through an
 * 8-bit hex. The mean drift this module bounds is a sub-level quantity
 * (0.00-1.30 over the kit corpus), and rounding the drifted colour to a hex
 * before measuring it quantises the invariant to whole levels: it reported
 * the pale-accent kit's ASYMMETRIC drift as exactly 2.00 against a 2.00
 * bound, i.e. the break-the-guard case landed precisely on the boundary and
 * the guard did not fire. `ground-material.test.ts` pins this against
 * `markColourDistance` on an integer pair so the two cannot drift apart.
 */
function weightedDelta(dr: number, dg: number, db: number): number {
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3;
}

/**
 * FNV-1a 32 — the seed hash every seeded choice in this agent already uses
 * (`paletteForSlide`, `isVariationSlot`, `slideMarkSeed`). Re-declared for the
 * same reason those three each declare their own: it is six lines, and the
 * alternative is exporting a hash from a module whose public surface is
 * colours, or from one whose public surface is paper.
 */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The ink mirrored across the ground, clamped into sRGB: `2·ground - ink`.
 *
 * This is "the lift" — the direction away from the ink along the axis the ink
 * itself defines. On any kit with real contrast it clamps to black or to
 * white, which is correct and is what a paper's highlight actually is; on a
 * mid-ground kit it is a real colour and the material's symmetry is exact
 * rather than approximate. Deriving it from the pair rather than choosing
 * black-or-white by a luminance test is what makes it survive a kit whose ink
 * is chromatic.
 */
export function liftForGround(inkHex: string, groundHex: string): string | undefined {
  const ink = parseHex(inkHex);
  const ground = parseHex(groundHex);
  if (ink === undefined || ground === undefined) return undefined;
  return toHex([2 * ground[0] - ink[0], 2 * ground[1] - ink[1], 2 * ground[2] - ink[2]]);
}

// ─────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────

/**
 * The material this kit and this client get, as numbers — every alpha, every
 * frequency, every seed, and every invariant computed rather than asserted.
 *
 * Exported because the guard has to be able to measure what the CSS actually
 * emits: `ground-material.test.ts` hand-paints its plates from THESE alphas,
 * so a change to the emitter that the arithmetic does not survive shows up as
 * a moved pixel rather than as a passing test on a stale constant.
 *
 * Cost: one hash and about twenty multiplications. $0.00, no model call, no
 * prompt string — the copy model never sees this vocabulary.
 */
export function groundMaterialPlan(tokens: GroundMaterialTokens, seedKey: string): GroundMaterialPlan | undefined {
  const groundHex = parseHex(tokens.ground) !== undefined ? tokens.ground!.trim() : DEFAULT_GROUND;
  const inkHex = parseHex(tokens.fg) !== undefined ? tokens.fg!.trim() : DEFAULT_INK;
  const liftHex = liftForGround(inkHex, groundHex);
  if (liftHex === undefined) return undefined;

  const hash = fnv1a32(seedKey);
  const stock = MATERIAL_STOCKS[hash % MATERIAL_STOCKS.length]!;
  const toothSeed = hash % 65536;
  const cloudSeed = fnv1a32(`${seedKey}|material|cloud`) % 65536;

  const inkDistance = markColourDistance(inkHex, groundHex);
  const liftDistance = markColourDistance(liftHex, groundHex);

  // The peak the KIT can actually carry on BOTH sides. A near-white ground
  // has almost no room on its lift side, and the honest answer there is a
  // quieter material, never a one-sided one.
  const effectivePeakDelta = Math.min(MATERIAL_PEAK_DELTA, MATERIAL_ALPHA_CAP * inkDistance, MATERIAL_ALPHA_CAP * liftDistance);

  const layer = (
    role: MaterialLayerRole,
    direction: "ink" | "lift",
    tintHex: string,
    share: number,
    invertAlpha: boolean,
    baseFrequency: number,
    octaves: number,
    seed: number,
  ): GroundMaterialLayer => {
    const distance = markColourDistance(tintHex, groundHex);
    const alpha = distance > 0 ? (share * effectivePeakDelta) / distance : 0;
    return { role, direction, tintHex, alpha, invertAlpha, baseFrequency, octaves, seed, peakDelta: alpha * distance };
  };

  const layers: readonly GroundMaterialLayer[] = [
    layer("tooth-ink", "ink", inkHex, MATERIAL_LAYER_SHARES.toothInk, false, stock.toothBaseFrequency, stock.toothOctaves, toothSeed),
    // The SAME turbulence as the tooth above — same seed, same frequency,
    // same octaves, same tile — with its alpha inverted. That identity is
    // what makes the two teeth strictly opposed rather than merely opposite
    // in tint, and `ground-material.test.ts` pins it.
    layer("tooth-lift", "lift", liftHex, MATERIAL_LAYER_SHARES.toothLift, true, stock.toothBaseFrequency, stock.toothOctaves, toothSeed),
    layer("cloud", "ink", inkHex, MATERIAL_LAYER_SHARES.cloud, false, stock.cloudBaseFrequency, stock.cloudOctaves, cloudSeed),
  ];

  const sumWhere = (direction: "ink" | "lift"): number =>
    layers.filter((l) => l.direction === direction).reduce((total, l) => total + l.peakDelta, 0);
  const peakDeltaByDirection = { ink: sumWhere("ink"), lift: sumWhere("lift") };
  const peakDeltaSum = layers.reduce((total, l) => total + l.peakDelta, 0);

  // `E[composite] - ground`, per channel. A turbulence alpha has mean 0.5 and
  // so does its inversion, so each layer's expected contribution is
  // `alpha/2 · (tint - ground)` — which is exactly what the opposed teeth are
  // sized to cancel.
  const ground = parseHex(groundHex)!;
  const drift: [number, number, number] = [0, 0, 0];
  for (const l of layers) {
    const tint = parseHex(l.tintHex)!;
    for (let c = 0; c < 3; c++) drift[c] = drift[c]! + (l.alpha / 2) * (tint[c]! - ground[c]!);
  }
  const meanDriftDelta = weightedDelta(drift[0], drift[1], drift[2]);

  const refusal =
    effectivePeakDelta < MATERIAL_MIN_PEAK_DELTA
      ? `ground/ink pair carries only ${effectivePeakDelta.toFixed(2)} of peak, under MATERIAL_MIN_PEAK_DELTA ${MATERIAL_MIN_PEAK_DELTA}`
      : layers.some((l) => l.alpha > MATERIAL_ALPHA_CAP + 1e-9)
        ? `a layer alpha exceeds MATERIAL_ALPHA_CAP ${MATERIAL_ALPHA_CAP}`
        : peakDeltaByDirection.ink > MATERIAL_PEAK_DELTA + 1e-9 || peakDeltaByDirection.lift > MATERIAL_PEAK_DELTA + 1e-9
          ? `a direction's peak (${peakDeltaByDirection.ink.toFixed(2)}/${peakDeltaByDirection.lift.toFixed(2)}) exceeds MATERIAL_PEAK_DELTA ${MATERIAL_PEAK_DELTA}`
          : meanDriftDelta > MATERIAL_MEAN_DRIFT_MAX
            ? `mean drift ${meanDriftDelta.toFixed(2)} exceeds MATERIAL_MEAN_DRIFT_MAX ${MATERIAL_MEAN_DRIFT_MAX} — the material is asymmetric`
            : undefined;

  return {
    groundHex,
    inkHex,
    liftHex,
    stock,
    tilePx: MATERIAL_TILE_PX,
    layers,
    effectivePeakDelta,
    peakDeltaByDirection,
    peakDeltaSum,
    meanDriftDelta,
    ok: refusal === undefined,
    ...(refusal !== undefined ? { refusal } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Emission
// ─────────────────────────────────────────────────────────────────────────

/**
 * One turbulence layer as a tiled `data:image/svg+xml`.
 *
 * `color-interpolation-filters="sRGB"` is LOAD-BEARING, not tidiness: SVG
 * filters default to linearRGB, and under that default the tint this module
 * computed in gamma-encoded sRGB is not the tint that lands on the plate, so
 * the whole `alpha = delta / distance` argument would be arithmetic about a
 * different number. The filter region is pinned to the tile exactly
 * (`filterUnits="userSpaceOnUse"`, no default -10%/120% bleed) because
 * `stitchTiles="stitch"` stitches across the REGION, and a region larger than
 * the tile makes the repeat visible as a seam.
 */
function turbulenceLayerUri(layer: GroundMaterialLayer, tilePx: number): string {
  const tint = parseHex(layer.tintHex)!;
  const channel = (c: number): string => (c / 255).toFixed(4);
  const invert = layer.invertAlpha ? `<feComponentTransfer><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>` : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tilePx}" height="${tilePx}" viewBox="0 0 ${tilePx} ${tilePx}">` +
    `<filter id="m" filterUnits="userSpaceOnUse" x="0" y="0" width="${tilePx}" height="${tilePx}" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${layer.baseFrequency}" numOctaves="${layer.octaves}" seed="${layer.seed}" stitchTiles="stitch"/>` +
    invert +
    // RGB becomes the constant tint; alpha becomes `layer.alpha · A_in`. The
    // matrix is applied to NON-premultiplied RGBA, so this is exactly the
    // "paint `tintHex` at `alpha·n`" the plan's arithmetic assumes.
    `<feColorMatrix type="matrix" values="0 0 0 0 ${channel(tint[0])} 0 0 0 0 ${channel(tint[1])} 0 0 0 0 ${channel(tint[2])} 0 0 0 ${layer.alpha.toFixed(5)} 0"/>` +
    `</filter>` +
    `<rect width="${tilePx}" height="${tilePx}" fill="#000" filter="url(#m)"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * The material stylesheet, as a complete `<style>` element — the same shape
 * and the same channel as `deviceCssBlock()` and `markCssBlock()`, spliced
 * through `extraHeadHtml` at materialisation time.
 *
 * ── WHY `.ground::after` AND NOT `.ground` ───────────────────────────────
 *
 * Every bundled archetype carries `<div class="ground">`, which is why this
 * is one shared sheet rather than eight template edits — and it is also why
 * the studio and custom-archetype paths get the material for free. But
 * `.ground` already carries a `background-image` (the tonal wash), and
 * `extraHeadHtml` is spliced AFTER the template's own `<style>`, so writing
 * `background-image` on `.ground` here would silently delete that wash. The
 * wash is a KNOWN live defect (RFC-20 Part 8 item 4: it sits in the 12-18
 * band and is what takes `flatBackgroundShare` under 0.70), and it is
 * deliberately NOT fixed in this phase, because pulling it under 12 would
 * move the very band §5.6 is calibrating. Removing it here by accident would
 * be the same change, made silently, inside the phase that is measuring
 * against it. So the material rides its own pseudo-element and touches
 * nothing.
 *
 * `.ground` itself is never restyled — in particular its `position` is left
 * alone, because a template whose `.ground` is `position: absolute; inset: 0`
 * collapses if a later sheet makes it `relative`.
 *
 * ── INVERSION ────────────────────────────────────────────────────────────
 *
 * The tints are literal hexes baked into a data URI, which cannot read
 * `var(--fg)`. A ground/fg-inverted slide renders from a sibling template
 * file that appends its own `:root` swap, so the material for THAT pair is
 * appended to that file too, by the same code that writes it
 * (`ensureTemplatesOnDisk`). Same selector, later block, later wins — so an
 * inverted slide gets a material computed for the pair it actually renders
 * on. Without that, the lift tint (computed against the primary ground) would
 * land on the inverted ground at roughly 100 metric units and the "invisible"
 * claim would invert into a black noise field.
 *
 * Returns "" when the plan refuses — a client whose kit cannot carry a
 * symmetric material renders exactly as it does today. Budgets adapt; nothing
 * here can hold a run.
 */
/**
 * ── THE MATERIAL GROUND IS BUILT, MEASURED AND MOUNTED NOWHERE. ──
 *
 * RFC-20 Part 11. The rule this phase converged on, stated once so it does not
 * have to be re-derived per template:
 *
 * > **An archetype gets the material ground only when its own composition
 * > clears the floor without paint. Any plate with an unearned hole keeps
 * > today's behaviour, byte-identical to `origin/main`, and comes back with
 * > §11.4.**
 *
 * Applied to the eight bundled archetypes on CI renders, it reaches all of
 * them. `headline_focus` and heroless `slide` measure `occ` 0.0383-0.1252 at
 * `flat` 0.92-0.97 with their screens gone — below the neglected controls.
 * `stat-callout` holds a 0.2750 rectangle at `(0,0)` and `closer` 0.2278/0.2306
 * at the same corner, and `comparison-card` sits at `occ` 0.2857, 0.95x its
 * floor. **The holes were always there; the deleted screens were painting over
 * them.** That is the same sentence as the hatch and as the plinth, for the
 * fourth time in one phase, and the answer is the same: the plate is the bug.
 *
 * That leaves `quote-card` and `list-takeaway` as the only plates whose
 * composition clears without paint — and **a material that ships on two plates
 * because those two happen not to have a hole yet is not a material ground, it
 * is a coincidence.** So it mounts nowhere and this constant says so in one
 * place rather than becoming a list of templates that rots.
 *
 * Nothing here is deleted or weakened. `groundMaterialPlan`,
 * `groundMaterialCssBlock` and their nineteen Chromium-free guards (G3, G4, the
 * alpha invariant, the achromatic identity, the `backgroundHex` anchor) all run
 * and all pass; the three call sites keep their plumbing so the mount is proven
 * wiring rather than unwritten code. **Flip this to `true` in the same PR that
 * gives those archetypes a bounded object (§11.4), and re-run the A/B case at
 * its unchanged 0.0005 bound** — which is also where
 * `body:not(:has(.copy-art))` below comes out.
 *
 * ── 2026-09-15: THAT PR IS THIS ONE, AND THE CONSTANT IS `true`. ──
 *
 * The two archetypes named above have a bounded object now
 * (`bounded-object.ts`) and their screens are deleted, so the condition the
 * rule states is met by the composition rather than waived. `.copy-art` no
 * longer exists in any bundled template, which is why the selector below is
 * gone rather than negated: a guard whose subject cannot occur is not a
 * guard, it is a sentence about the past, and the past is in the comment
 * where it belongs.
 *
 * **The 0.0005 A/B bound is UNCHANGED and is what arbitrates this.** It was
 * never widened to let the material through — the coupling it caught was
 * real, its cause was the hatch putting tens of thousands of cells on a
 * threshold boundary, and the hatch is what went. If the bound fires again
 * on this tree then some plate still carries a screen and the right move is
 * to find it, not to raise the number.
 *
 * ── IT FIRED, AND THE ANSWER IS THE ONE THE PARAGRAPH ABOVE PROMISED. ──
 *
 * CI 34956752073, on the de-decorated tree, `headline_focus`:
 *
 *     flatBackgroundShare   0.9248716 bare   0.9266884 with the material
 *     moved                 0.0018168        against a 0.0005 bound
 *
 * **The bound is not widened. The mount comes off.** The cause is not a
 * surviving screen — it is the opposite of the hatch, and that is the part
 * worth writing down. A hatch tipped cells because it put tens of thousands
 * of them ON `tol.ink`; a bare plate at `flat` **0.925** has tens of
 * thousands of cells sitting exactly on `tol.flat` instead, and a sub-ink
 * grain moves that boundary just as easily. **Quieting the tree did not
 * remove the coupling; it moved which threshold the coupling acts on.**
 *
 * So the rule in this comment stands unchanged and simply reaches a
 * different conclusion than it did an hour ago: an archetype gets the
 * material ground only when its own composition clears the floor without
 * paint, and "clears" now has to include this A/B case. The plan, the
 * emitter and their nineteen Chromium-free guards all still run and pass;
 * the three call sites keep their plumbing. What is withheld is the mount.
 *
 * `body:not(:has(.copy-art))` does NOT come back — that selector's subject no
 * longer exists in any bundled template, and a guard whose subject cannot
 * occur is a sentence about the past.
 */
export const GROUND_MATERIAL_MOUNTED: boolean = false;

export function groundMaterialCssBlock(tokens: GroundMaterialTokens, seedKey: string): string {
  const plan = groundMaterialPlan(tokens, seedKey);
  if (plan === undefined || !plan.ok) return "";
  const uris = plan.layers.map((l) => turbulenceLayerUri(l, plan.tilePx));
  const size = plan.layers.map(() => `${plan.tilePx}px ${plan.tilePx}px`).join(", ");
  return `<style>
/* instagram-agent MATERIAL GROUND (RFC-20 §5.1) — built by ground-material.ts.
   stock=${plan.stock.id} ground=${plan.groundHex} ink=${plan.inkHex} lift=${plan.liftHex}
   peak=${plan.effectivePeakDelta.toFixed(2)} (ink ${plan.peakDeltaByDirection.ink.toFixed(2)} / lift ${plan.peakDeltaByDirection.lift.toFixed(2)}), mean drift=${plan.meanDriftDelta.toFixed(2)}
   alphas=${plan.layers.map((l) => `${l.role}:${l.alpha.toFixed(4)}`).join(" ")}
   Sub-ink by construction: peak ${plan.effectivePeakDelta.toFixed(2)} < FLAT_TOL 12 < INK_DELTA 18, so this
   layer contributes 0 to inkShare, occupiedShare, contentOccupiedShare and
   imageryOrDeviceShare and removes nothing from the empty-rectangle mask.

   ── THE WITHHOLDING GUARD IS GONE, AND THIS IS WHY IT WAS HERE. ──
   It read \`body:not(:has(.copy-art))\` — not a template allowlist but the
   Ground Rule's own condition, asked of the document. "Sub-ink by
   construction" above is a statement about a BARE ground and it stopped
   being true over a screen: measured on CI 34804038775, splicing this sheet
   onto a plate wearing \`.copy-art\`'s 22% hatch moved \`flatBackgroundShare\`
   0.123 points (0.7962 against 0.7974) where the A/B case bounds it at
   0.0005. The cause is the same boundary-tipping RFC-20 §5.1a records for
   \`iod\` on a flat fill — a sub-ink grain changes no pixel's ink status but
   can tip a cell whose mean sits exactly on \`tol.ink\`, and a hatch puts
   tens of thousands of cells on that boundary. On a bare ground there is no
   boundary to tip and every share is identical to 3 dp.
   \`headline-focus.html\` and \`slide.html\` were the two files carrying a
   screen. RFC-20 §11.4 deleted both in the same PR that gave those plates a
   bounded object, so the guard's subject cannot occur and the selector comes
   out unnegated. **The 0.0005 bound is unchanged**, and it is now measured
   over a tree with nothing for the grain to tip. */
.ground::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: ${uris.join(",\n    ")};
  background-size: ${size};
  background-position: 0 0;
  background-repeat: repeat;
}
</style>`;
}
