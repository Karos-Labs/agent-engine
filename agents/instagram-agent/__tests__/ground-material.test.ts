import { describe, expect, it } from "vitest";
import * as zlib from "node:zlib";
import { measureSlidePng } from "@agent-engine/tool-karos-publish";
import { markColourDistance } from "../src/workflow/emphasis-marks.js";
import {
  groundMaterialCssBlock,
  groundMaterialPlan,
  liftForGround,
  MATERIAL_ALPHA_CAP,
  MATERIAL_LAYER_SHARES,
  MATERIAL_MEAN_DRIFT_MAX,
  MATERIAL_MIN_PEAK_DELTA,
  MATERIAL_PEAK_DELTA,
  MATERIAL_STOCKS,
  MATERIAL_TILE_PX,
  type GroundMaterialLayer,
  type GroundMaterialPlan,
} from "../src/workflow/ground-material.js";

/**
 * GUARDS G3 AND G4 (RFC-20 §5.7) — the material ground is invisible to the
 * instrument, and its amplitude is arithmetic rather than taste.
 *
 * ── BOTH GUARDS ARE CHROMIUM-FREE, AND THAT IS THE POINT ─────────────────
 *
 * Every pixel claim this agent makes is otherwise CI's alone, because the
 * Chromium-gated suites self-skip on the authoring machine. These two do not
 * skip anywhere: the plates are hand-painted from the alphas
 * `groundMaterialPlan` actually emits and run through the REAL shipped
 * `measureSlidePng` — the same instrument, the same tolerances, the same
 * 2160×2880 device canvas the renderer screenshots at. **A skip here is a
 * defect, not a machine property.**
 *
 * ── WHAT THE PAINTER STANDS IN FOR, AND WHAT IT DOES NOT ─────────────────
 *
 * Chromium's `feTurbulence` is not reproduced here and could not be. What is
 * reproduced is the ONE property the whole amplitude argument rests on: the
 * filter's alpha output is bounded in [0,1], so a tint painted at `alpha ·
 * A_out` is hard-clamped at `alpha · distance(tint, ground)`. The painter
 * substitutes a bounded [0,1] field keyed to each layer's OWN emitted seed
 * and base frequency — white noise for the teeth (whose features are ≤ 2.4px,
 * i.e. per-pixel at this canvas) and a smoothed lattice for the cloud (whose
 * features are 20-50px). White noise is the CONSERVATIVE stand-in: real
 * turbulence is spatially correlated, so its per-cell standard deviation is
 * lower than this painter's, and `flatCellStddev` is the one tolerance a
 * grain could plausibly trip. RFC-20 §5.8.2's band sweep on real Chromium is
 * the authority on the real filter; these guards are the authority on the
 * arithmetic and on the instrument's response to it.
 *
 * Two facts the painter inherits from the plan rather than assuming:
 * the two teeth share a seed and a base frequency, so the painter's field
 * function returns the SAME `n` for both and the `feComponentTransfer`
 * inversion makes them strictly opposed. If a future edit decorrelated them
 * (different seeds), they could co-peak at 22 metric units — past `tol.ink`
 * — and G3 would go red on `inkShare`. The guard covers that identity
 * without asserting it separately, and G4 asserts it anyway.
 */

// ─────────────────────────────────────────────────────────────────────────
// The kit corpus
// ─────────────────────────────────────────────────────────────────────────

/**
 * Four kits, chosen for where they sit on the ink axis rather than for
 * variety: the bundled dark pair every client we run today renders on, the
 * paper pair RFC-20 moves light clients toward, a strictly achromatic pair
 * (where the metric distance IS the level deviation, so the arithmetic can be
 * read by eye), and a near-white pale-accent pair whose LIFT side is almost
 * out of gamut — the case that decides whether a kit with no room gets a
 * quieter material or a one-sided one.
 */
const KITS: ReadonlyArray<{ name: string; ground: string; fg: string }> = [
  { name: "bundled dark", ground: "#17181C", fg: "#F4F2EC" },
  { name: "paper", ground: "#F0EAE6", fg: "#12100E" },
  { name: "mono", ground: "#202020", fg: "#E8E8E8" },
  { name: "pale accent", ground: "#FDFBF7", fg: "#1B1B1B" },
];

const SEED_KEY = "karoslabs";

/** The production device canvas: `DEFAULT_DESIGN_CANVAS` 1080×1440 at `canvas.scale: 2`, which is what `publish.renderCarousel` screenshots. */
const PLATE_W = 2160;
const PLATE_H = 2880;
const SCALE = 2;

// ─────────────────────────────────────────────────────────────────────────
// The painter
// ─────────────────────────────────────────────────────────────────────────

function parseHex(hex: string): [number, number, number] {
  let s = hex.slice(1);
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/** A bounded [0,1] hash field. The stand-in for one `feTurbulence` sample, keyed by the layer's own seed. */
function hashField(x: number, y: number, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  h = Math.imul(h ^ x, 0x01000193) >>> 0;
  h = Math.imul(h ^ y, 0x01000193) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}

/** The cloud's field: the same hash on a lattice of `1 / baseFrequency` px, smoothstep-interpolated, so its feature size is the one the plan asked for. */
function latticeField(x: number, y: number, seed: number, cellPx: number): number {
  const gx = Math.floor(x / cellPx);
  const gy = Math.floor(y / cellPx);
  const fx = x / cellPx - gx;
  const fy = y / cellPx - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hashField(gx, gy, seed);
  const b = hashField(gx + 1, gy, seed);
  const c = hashField(gx, gy + 1, seed);
  const d = hashField(gx + 1, gy + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

function layerAlphaAt(layer: GroundMaterialLayer, dx: number, dy: number, alphaScale: number): number {
  // Features ≤ ~2.4px are per-pixel at the design canvas; anything coarser
  // gets the lattice. The boundary is the plan's own base frequency, so a
  // stock's ladder position decides which field it draws from.
  const n =
    layer.baseFrequency >= 0.25
      ? hashField(dx, dy, layer.seed)
      : latticeField(dx, dy, layer.seed, 1 / layer.baseFrequency);
  const bounded = layer.invertAlpha ? 1 - n : n;
  // A real CSS alpha cannot exceed 1. The break-the-guard variants scale the
  // emitted alpha, and clamping here keeps the broken plate a plate Chromium
  // could actually paint.
  return Math.min(1, layer.alpha * alphaScale) * bounded;
}

/**
 * Hand-paints the plate the plan describes: the ground, then each layer
 * composited over it as `c = c·(1-a) + tint·a`, which is what
 * `background-image` compositing in gamma-encoded sRGB does.
 */
function paintMaterialPlate(plan: GroundMaterialPlan, options: { alphaScale?: number; onlyDirection?: "ink" | "lift" } = {}): Buffer {
  const ground = parseHex(plan.groundHex);
  const tints = plan.layers.map((l) => parseHex(l.tintHex));
  const alphaScale = options.alphaScale ?? 1;
  const raw = Buffer.alloc(PLATE_H * (1 + PLATE_W * 3));
  for (let y = 0; y < PLATE_H; y++) {
    const rowStart = y * (1 + PLATE_W * 3);
    const dy = Math.floor(y / SCALE);
    for (let x = 0; x < PLATE_W; x++) {
      const dx = Math.floor(x / SCALE);
      let r = ground[0];
      let g = ground[1];
      let b = ground[2];
      for (let i = 0; i < plan.layers.length; i++) {
        const layer = plan.layers[i]!;
        if (options.onlyDirection !== undefined && layer.direction !== options.onlyDirection) continue;
        const a = layerAlphaAt(layer, dx, dy, alphaScale);
        if (a <= 0) continue;
        const tint = tints[i]!;
        r = r * (1 - a) + tint[0] * a;
        g = g * (1 - a) + tint[1] * a;
        b = b * (1 - a) + tint[2] * a;
      }
      const offset = rowStart + 1 + x * 3;
      raw[offset] = Math.max(0, Math.min(255, Math.round(r)));
      raw[offset + 1] = Math.max(0, Math.min(255, Math.round(g)));
      raw[offset + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  return encodePng(raw, PLATE_W, PLATE_H);
}

/**
 * A minimal filter-free truecolour PNG encoder.
 *
 * Duplicated from `synthetic-photograph.ts` rather than imported: that file's
 * encoder is private to it, its public surface is a PHOTOGRAPH, and this file
 * needs the opposite fixture. Both are eight lines of chunk framing around
 * `zlib.deflateSync`, and neither has a behaviour to keep in step.
 */
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

function encodePng(raw: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function planFor(kit: { ground: string; fg: string }, seedKey = SEED_KEY): GroundMaterialPlan {
  const plan = groundMaterialPlan({ ground: kit.ground, fg: kit.fg }, seedKey);
  expect(plan).toBeDefined();
  return plan!;
}

const PAINT_TIMEOUT_MS = 120_000;

// ─────────────────────────────────────────────────────────────────────────
// G3 — the material is sub-ink, measured by the real instrument
// ─────────────────────────────────────────────────────────────────────────

describe("G3 — the material ground measures as nothing", () => {
  for (const kit of KITS) {
    it(
      `${kit.name}: every share is exactly zero and the empty rectangle is the whole plate`,
      () => {
        const plan = planFor(kit);
        expect(plan.ok).toBe(true);
        const png = paintMaterialPlate(plan);
        const outcome = measureSlidePng(png, { expected: { ground: kit.ground, ink: kit.fg } });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const m = outcome.metrics;

        // The five shares RFC-20 §5.0's Ground Rule requires a MATERIAL layer
        // to contribute nothing to, and the empty-rectangle mask it must
        // remove nothing from. Exact equality, not a tolerance: a material
        // that is "nearly" invisible is a material whose amplitude was
        // chosen rather than computed.
        expect(m.inkShare).toBe(0);
        expect(m.occupiedShare).toBe(0);
        expect(m.contentOccupiedShare).toBe(0);
        expect(m.imageryOrDeviceShare).toBe(0);
        expect(m.largestEmptyRectShare).toBe(1);

        // The plate is still FLAT. A material that took `flatBackgroundShare`
        // under 0.70 would disarm clause D's first limb on every plate that
        // wore it — defect 1 again, one clause over — which is why
        // MATERIAL_PEAK_DELTA is set at the flat line and not the ink line.
        expect(m.flatBackgroundShare).toBe(1);

        // And the ANCHOR holds. A loud material flips `backgroundHex` to the
        // ink or to the lift, after which every share above is measured
        // against a wrong ground and `backgroundMatchesBrandGround` is only a
        // warning.
        expect(m.backgroundHex.toUpperCase()).toBe(kit.ground.toUpperCase());
        expect(m.backgroundMatchesBrandGround).toBe(true);
      },
      PAINT_TIMEOUT_MS,
    );
  }

  it(
    "BREAK THE GUARD: the same painter and the same instrument DO see a material twice as loud",
    () => {
      // Without this, every assertion above is a guard that cannot fail: a
      // measurement of zero proves nothing unless the same measurement can
      // produce a non-zero from the same code path. The break is the one
      // RFC-20 §5.7 names — multiply the emitted alpha by 2, which puts each
      // direction's realised peak at 22, past `tol.ink` (18).
      //
      // MEASURED-HERE at ×2, with alphas clamped to a paintable 1.0:
      //
      //   kit            inkShare   occupiedShare   LER      unanchored drift
      //   bundled dark   0.0742     0.2326          0.0611   5.57 (from 2.24)
      //   paper          0.0652     0.2074          0.0639   4.40 (from 3.09)
      //   mono           0.0565     0.1889          0.0667   4.00 (from 3.00)
      //
      // The comparison against the unanchored drift of the SHIPPED material
      // is what makes the ≤ `tol.flat` bound below a reachable bound rather
      // than a decorative one.
      for (const kit of KITS) {
        const plan = planFor(kit);
        // TWO plates per kit, each measured twice. A 2160×2880 plate costs
        // about two seconds to paint and 14 MB to hold, so the anchored and
        // unanchored readings share one buffer rather than repainting it —
        // which is also why the `tol.flat` claim below lives in this test
        // rather than in one of its own.
        const quietPng = paintMaterialPlate(plan);
        const loudPng = paintMaterialPlate(plan, { alphaScale: 2 });
        const quiet = measureSlidePng(quietPng, { expected: { ink: kit.fg } });
        const loud = measureSlidePng(loudPng, { expected: { ground: kit.ground, ink: kit.fg } });
        const loudFree = measureSlidePng(loudPng, { expected: { ink: kit.fg } });
        expect(quiet.ok && loud.ok && loudFree.ok).toBe(true);
        if (!quiet.ok || !loud.ok || !loudFree.ok) continue;

        // `backgroundHex` in the G3 tests above is allowed to snap to the
        // supplied token when the modal flat cell agrees within `tol.flat`
        // (12). Measured with NO expectation, the mode is the raw modal flat
        // cell — so this is the condition under which that snap is available
        // at all, read straight off the pixels.
        //
        // MEASURED-HERE, drift from the ground: 2.24 (bundled dark), 3.09
        // (paper), 3.00 (mono), 1.25 (pale accent) — a fifth of the
        // tolerance. The residue is the cloud, whose features are 20-50px: a
        // low-frequency layer moves whole CELLS together, so the modal cell
        // is a cloud patch's mean rather than the plate's.
        //
        // REPORTED HONESTLY: this bound does NOT fire on the asymmetry break
        // (MEASURED-HERE, lift tooth removed: 5.00 / 5.00 / 5.00 / 2.00 — all
        // inside 12). Symmetry is guarded in the arithmetic, in G4, where it
        // is decidable; see that test's own note.
        expect(markColourDistance(quiet.metrics.backgroundHex, kit.ground)).toBeLessThan(12);

        if (plan.effectivePeakDelta < MATERIAL_PEAK_DELTA) {
          // A GAMUT-LIMITED KIT CANNOT BE MADE LOUD, and that is a fact about
          // the kit rather than a hole in the guard. The pale-accent kit's
          // lift is white and sits 5.4 metric units from its ground, so no
          // alpha — not 1.0, not 10 — can push its lift side past `tol.ink`.
          // Its material is already quieter by the same arithmetic (peak
          // 4.87), which is why the zero above still means something.
          expect(loud.metrics.inkShare).toBe(0);
          continue;
        }

        expect(loud.metrics.inkShare).toBeGreaterThan(0);
        expect(loud.metrics.occupiedShare).toBeGreaterThan(0);
        expect(loud.metrics.largestEmptyRectShare).toBeLessThan(1);
        // And the anchor starts to move, which is the failure mode the two
        // opposed teeth exist to prevent: at ×4 (MEASURED-HERE, first probe)
        // the unanchored mode lands 19-31 units off the ground and
        // `backgroundHex` flips outright to the lift.
        expect(markColourDistance(loudFree.metrics.backgroundHex, kit.ground)).toBeGreaterThan(
          markColourDistance(quiet.metrics.backgroundHex, kit.ground),
        );
      }
    },
    PAINT_TIMEOUT_MS,
  );

});

// ─────────────────────────────────────────────────────────────────────────
// G4 — the alpha invariant
// ─────────────────────────────────────────────────────────────────────────

describe("G4 — the amplitude is computed, not chosen", () => {
  it("the achromatic identity: a neutral deviation's metric distance IS its 8-bit level deviation", () => {
    // `sqrt(2d² + 4d² + 3d²)/3 = d`. This is why MATERIAL_PEAK_DELTA can be
    // stated in metric units and read back in levels with no conversion, and
    // why the mono kit's arithmetic can be checked by eye.
    for (const d of [1, 3, 7, 11, 18, 32, 64]) {
      const base = 96;
      const a = `#${base.toString(16).padStart(2, "0").repeat(3)}`;
      const b = `#${(base + d).toString(16).padStart(2, "0").repeat(3)}`;
      expect(markColourDistance(a, b)).toBeCloseTo(d, 10);
    }
  });

  it("every layer's peak is exactly its share of the effective peak", () => {
    for (const kit of KITS) {
      const plan = planFor(kit);
      for (const layer of plan.layers) {
        const share = MATERIAL_LAYER_SHARES[layer.role === "tooth-ink" ? "toothInk" : layer.role === "cloud" ? "cloud" : "toothLift"];
        // The identity the whole module rests on: compositing is a
        // channel-wise lerp, so `distance(painted, ground) = alpha ·
        // distance(tint, ground)` exactly.
        expect(layer.alpha * markColourDistance(layer.tintHex, plan.groundHex)).toBeCloseTo(share * plan.effectivePeakDelta, 9);
        expect(layer.peakDelta).toBeCloseTo(share * plan.effectivePeakDelta, 9);
        expect(layer.alpha).toBeLessThanOrEqual(MATERIAL_ALPHA_CAP + 1e-9);
      }
    }
  });

  it("each DIRECTION's peak is at most MATERIAL_PEAK_DELTA, which is the exact realisable bound", () => {
    for (const kit of KITS) {
      const plan = planFor(kit);
      expect(plan.peakDeltaByDirection.ink).toBeLessThanOrEqual(MATERIAL_PEAK_DELTA + 1e-9);
      expect(plan.peakDeltaByDirection.lift).toBeLessThanOrEqual(MATERIAL_PEAK_DELTA + 1e-9);
      // Strictly under `FLAT_TOL` (12) — the line RFC-20 chose over the ink
      // line (18) so the material cannot disarm clause D's flat limb.
      expect(plan.peakDeltaByDirection.ink).toBeLessThan(12);
      expect(plan.peakDeltaByDirection.lift).toBeLessThan(12);
      // RFC-20 §5.1 states the bound as a plain sum over layers. The two
      // teeth are driven by ONE turbulence with the second's alpha inverted
      // and therefore cannot co-peak, so the plain sum is not realisable and
      // is recorded rather than enforced. It is still bounded.
      expect(plan.peakDeltaSum).toBeLessThanOrEqual(2 * MATERIAL_PEAK_DELTA + 1e-9);
      expect(plan.peakDeltaSum).toBeCloseTo(plan.peakDeltaByDirection.ink + plan.peakDeltaByDirection.lift, 9);
    }
  });

  it("the material is SYMMETRIC about the ground: the two teeth share one turbulence, opposed", () => {
    for (const kit of KITS) {
      const plan = planFor(kit);
      const toothInk = plan.layers.find((l) => l.role === "tooth-ink")!;
      const toothLift = plan.layers.find((l) => l.role === "tooth-lift")!;
      // Same field, inverted alpha — the identity that makes them opposed
      // rather than merely opposite in tint. Decorrelate them and both sides
      // could peak in one pixel at 22 metric units, past `tol.ink`.
      expect(toothLift.seed).toBe(toothInk.seed);
      expect(toothLift.baseFrequency).toBe(toothInk.baseFrequency);
      expect(toothLift.octaves).toBe(toothInk.octaves);
      expect(toothInk.invertAlpha).toBe(false);
      expect(toothLift.invertAlpha).toBe(true);
      expect(toothInk.direction).toBe("ink");
      expect(toothLift.direction).toBe("lift");
      // And the means cancel. MEASURED-HERE: 0.59 / 1.00 / 0.00 / 1.10 over
      // the corpus; the residue is gamut clamping on a chromatic ink.
      expect(plan.meanDriftDelta).toBeLessThanOrEqual(MATERIAL_MEAN_DRIFT_MAX);
    }
  });

  it("BREAK THE GUARD: an asymmetric material fails the symmetry invariant and emits nothing", () => {
    // The break RFC-20 §5.7 asks for — "set the light-tooth alpha to 0" —
    // reproduced by asking the plan what it would compute without the lift
    // side's counterweight.
    //
    // REPORTED HONESTLY: this break does NOT move `backgroundHex` at peak 11.
    // MEASURED-HERE, an asymmetric material shifts the modal cell by ~5 metric
    // units, and `measureSlidePng` snaps `backgroundHex` to a supplied ground
    // within `tol.flat` = 12, so the anchored assertion in G3 still passes.
    // The symmetry claim therefore has to be guarded where it is decidable —
    // in the arithmetic, here, and on the unanchored mode in G3 — and the
    // §5.7 wording is corrected rather than repeated.
    for (const kit of KITS) {
      const plan = planFor(kit);
      const ground = parseHex(plan.groundHex);
      const inkSideOnly = plan.layers.filter((l) => l.direction === "ink");
      const drift: [number, number, number] = [0, 0, 0];
      for (const l of inkSideOnly) {
        const tint = parseHex(l.tintHex);
        for (let c = 0; c < 3; c++) drift[c] = drift[c]! + (l.alpha / 2) * (tint[c]! - ground[c]!);
      }
      // `markColourDistance`'s formula on the FLOAT difference — the same
      // thing `ground-material.ts` computes, and for the same reason: rounding
      // this through an 8-bit hex first reported the pale-accent kit's
      // asymmetric drift as exactly 2.00 against a 2.00 bound, so the break
      // landed on the boundary and the guard did not fire. MEASURED-HERE
      // after the fix: 5.50 / 5.49 / 5.50 / 2.44 against a 2.0 bound.
      const asymmetric = Math.sqrt(2 * drift[0] * drift[0] + 4 * drift[1] * drift[1] + 3 * drift[2] * drift[2]) / 3;
      expect(asymmetric).toBeGreaterThan(MATERIAL_MEAN_DRIFT_MAX);
    }
  });

  it("a kit with no room on its lift side gets a QUIETER material, never a one-sided one", () => {
    // The pale-accent kit's lift is white and sits ~5.4 metric units from its
    // ground, so `MATERIAL_ALPHA_CAP · distance` caps the peak below 11. Both
    // sides still carry the same peak; the material just gets quieter.
    const pale = planFor(KITS[3]!);
    expect(pale.effectivePeakDelta).toBeLessThan(MATERIAL_PEAK_DELTA);
    expect(pale.peakDeltaByDirection.ink).toBeCloseTo(pale.peakDeltaByDirection.lift, 9);
    expect(pale.ok).toBe(true);

    // And a pair with no room at all gets NO material rather than a
    // half-material. A pure-white ground's lift is itself.
    const none = groundMaterialPlan({ ground: "#FFFFFF", fg: "#000000" }, SEED_KEY)!;
    expect(none.effectivePeakDelta).toBeLessThan(MATERIAL_MIN_PEAK_DELTA);
    expect(none.ok).toBe(false);
    expect(none.refusal).toContain("MATERIAL_MIN_PEAK_DELTA");
    expect(groundMaterialCssBlock({ ground: "#FFFFFF", fg: "#000000" }, SEED_KEY)).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Determinism, and what the stylesheet actually says
// ─────────────────────────────────────────────────────────────────────────

describe("the stock is a property of the client, and constant across the carousel", () => {
  it("one client always gets the same paper", () => {
    const a = groundMaterialPlan({ ground: "#17181C", fg: "#F4F2EC" }, "acme-dental");
    const b = groundMaterialPlan({ ground: "#17181C", fg: "#F4F2EC" }, "acme-dental");
    expect(a!.stock.id).toBe(b!.stock.id);
    expect(a!.layers.map((l) => l.seed)).toEqual(b!.layers.map((l) => l.seed));
    expect(groundMaterialCssBlock({ ground: "#17181C", fg: "#F4F2EC" }, "acme-dental")).toBe(
      groundMaterialCssBlock({ ground: "#17181C", fg: "#F4F2EC" }, "acme-dental"),
    );
  });

  it("the ladder is actually walked — a sample of clients lands on more than one stock", () => {
    const seen = new Set(
      ["acme-dental", "karoslabs", "northwind", "bluebird-law", "orchard-bakery", "vela-fitness", "hanan-studio", "tikva-clinic"].map(
        (slug) => groundMaterialPlan({ ground: "#17181C", fg: "#F4F2EC" }, slug)!.stock.id,
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
    for (const id of seen) expect(MATERIAL_STOCKS.map((s) => s.id)).toContain(id);
  });

  it("the lift is the ink mirrored across the ground, clamped into sRGB", () => {
    expect(liftForGround("#F4F2EC", "#17181C")).toBe("#000000");
    expect(liftForGround("#12100E", "#F0EAE6")).toBe("#FFFFFF");
    // A mid-ground kit's lift is a real colour, and the mirror is exact.
    expect(liftForGround("#404040", "#808080")).toBe("#C0C0C0");
    expect(liftForGround("not-a-colour", "#808080")).toBeUndefined();
  });
});

describe("the emitted stylesheet", () => {
  const css = groundMaterialCssBlock({ ground: "#17181C", fg: "#F4F2EC" }, SEED_KEY);
  const plan = planFor(KITS[0]!);

  it("is a complete <style> element on `.ground::after`, and never restyles `.ground` itself", () => {
    expect(css.startsWith("<style>")).toBe(true);
    expect(css.trimEnd().endsWith("</style>")).toBe(true);
    expect(css).toContain(".ground::after {");
    // FIVE of the eight bundled templates still carry a tonal wash as
    // `.ground`'s own `background-image` — `cover`, `closer`, `list-takeaway`,
    // `stat-callout`, `comparison-card` — and `extraHeadHtml` is spliced
    // AFTER the template's `<style>`. A rule on `.ground` here would delete
    // that wash silently.
    //
    // ── CORRECTED 2026-09-14, integration. ── This comment used to say
    // `.ground` "already carries the tonal wash" flatly, and RFC-20 Part 8
    // item 4 to leave the wash standing. Both are now false for
    // `headline-focus.html` and `slide.html`: P2 DELETED their washes, because
    // once those files grew a plinth the graded wash split the ground's vote
    // across `backgroundHex`'s 5-bit bins, the plinth won it, and the
    // untouched ground was re-labelled ink at `clippedEdgeShare` 1.37%
    // against a 0.4% ceiling. `quote-card.html` never had one.
    //
    // The ASSERTION is unaffected and stays exactly as strict: it is a
    // property of this emitter (never restyle a selector the template owns),
    // not a claim about how many templates happen to use it today. Which is
    // why the count above is documentation and the `expect` below is not.
    expect(/^\.ground\s*\{/m.test(css)).toBe(false);
    // No `deg`, no `left`/`right`: the material is direction-free and holds
    // in RTL without a mirror (RFC-20 §5.9).
    expect(css).not.toMatch(/\d+deg/);
    expect(css).not.toMatch(/\b(left|right)\s*:/);
  });

  it("carries one tiled turbulence per layer, with the plan's own alphas and seeds", () => {
    for (const layer of plan.layers) {
      expect(css).toContain(encodeURIComponent(`seed="${layer.seed}"`));
      expect(css).toContain(encodeURIComponent(`baseFrequency="${layer.baseFrequency}"`));
      expect(css).toContain(encodeURIComponent(`${layer.alpha.toFixed(5)} 0`));
    }
    expect(css.match(/feTurbulence/g)?.length).toBe(plan.layers.length);
    expect(css.match(/feComponentTransfer/g)?.length).toBe(2 * plan.layers.filter((l) => l.invertAlpha).length);
    expect(css).toContain(`${MATERIAL_TILE_PX}px ${MATERIAL_TILE_PX}px`);
    expect(css).toContain(encodeURIComponent(`stitchTiles="stitch"`));
    // Load-bearing: SVG filters default to linearRGB, under which the tint
    // that lands is not the tint this module computed in gamma-encoded sRGB
    // and the alpha arithmetic is about a different number.
    expect(css.match(new RegExp(encodeURIComponent(`color-interpolation-filters="sRGB"`), "g"))?.length).toBe(plan.layers.length);
  });

  it("each data URI decodes to well-formed SVG whose filter region is the tile exactly", () => {
    const uris = [...css.matchAll(/url\("data:image\/svg\+xml,([^"]+)"\)/g)].map((m) => decodeURIComponent(m[1]!));
    expect(uris.length).toBe(plan.layers.length);
    for (const svg of uris) {
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      // Every opened element is closed — a malformed URI renders as nothing
      // at all, which would be a silently missing material.
      const opened = (svg.match(/<[a-zA-Z]/g) ?? []).length;
      const closed = (svg.match(/(\/>|<\/)/g) ?? []).length;
      expect(opened).toBe(closed);
      // `stitchTiles` stitches across the filter REGION, so a region wider
      // than the tile shows the repeat as a seam.
      expect(svg).toContain(`filterUnits="userSpaceOnUse" x="0" y="0" width="${MATERIAL_TILE_PX}" height="${MATERIAL_TILE_PX}"`);
    }
  });
});
