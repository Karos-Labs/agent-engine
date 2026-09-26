/**
 * MARKED EMPHASIS — RFC-17 (Phase 5), the mark engine.
 *
 * ── WHAT THE REFERENCE PIXELS ACTUALLY DO ────────────────────────────────
 *
 * Read directly off the owner's reference slides, not inferred from a brief:
 *
 * - `rf-05/slide-01`: FOUR marks in FOUR colours and at least THREE kinds on
 *   one plate — a lilac swatch behind `Anti-AI`, a red pencil rule under
 *   `clients`, a cyan swatch behind `human,`, a green rule under `AI slop`.
 *   What never repeats is the colour of two CONSECUTIVE marks.
 * - `rf-11-terms/slide-01`: ten rows, yellow → chartreuse → cyan → lilac,
 *   the swatch sitting LOW — covering the baseline and roughly the lower
 *   60% of the cap, with ascenders standing clear above it. This is not a
 *   centred `background-color`.
 * - `rf-6/slide-01`: a near-BLACK ground carrying NO swatch behind any word.
 *   The emphasis is a yellow→orange gradient IN THE GLYPHS of `FOLDABLE` and
 *   `DUOLINGO JUST JUMPED IN`. **Our default ground is `#17181C`, so this is
 *   our case, not an exotic one** — which is the whole reason mark KIND is
 *   computed here from ground luminance rather than chosen by the model.
 *
 * What this module refuses to take from those accounts is their SUBJECT
 * MATTER (RFC-17 Part 1). Nothing here touches topic selection; it decides
 * only how words the client's own brief already produced are painted.
 *
 * ── THE SPLIT OF AUTHORITY ───────────────────────────────────────────────
 *
 * The copy model says WHICH WORDS matter (`SlideEmphasisSchema`, verbatim
 * substrings). Code says everything else — which colour, which kind, whether
 * the mark is legible at all, and whether it is drawn. That is the same split
 * `slide-devices.ts` established for number devices, and finding 2 of the
 * RFC's adjudication is why: the model cannot see the ground, and `rf-6`
 * proves the ground decides.
 *
 * ── NOTHING HERE CAN HOLD OR FAIL A RUN ──────────────────────────────────
 *
 * Every failure in this module degrades to plain type and is REPORTED as a
 * fact (`collectEmphasisIssues`), never gated. A span that no longer occurs
 * is dropped. An illegible ring means no marks this run. A template with no
 * `*Runs` slot renders the plain field. That posture is the binding owner
 * decision ("budgets adapt, never hold") applied to furniture, and it is the
 * same one `collectDeviceIssues` takes.
 *
 * Model cost: $0.00 — this module makes no model call. The only cost this
 * phase carries is the `emphasis` array the copy prompt now emits.
 */

import { isolateForeignRuns } from "./bidi-isolate.js";
import { contrastRatio } from "./brand-render-tokens.js";
import { MAX_MARK_CHARS, type SlideEmphasis } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────
// Constants — the resolution budget
// ─────────────────────────────────────────────────────────────────────────

/**
 * How many marks one slide may actually PAINT.
 *
 * Five, against `SlideEmphasisSchema`'s `.max(8)`, and the gap is deliberate
 * (RFC-17 §5.1). The schema is the CONTRACT with a model that costs $0.181
 * per attempt; a ninth mark must degrade, never reject the draft. This is the
 * furniture budget, enforced here where a drop is free.
 */
export const MAX_MARKS_PER_SLIDE = 5;

/** How many marks one FIELD may paint. Three is `rf-11`'s own per-row ceiling and `rf-05 S1`'s per-block ceiling. */
export const MAX_MARKS_PER_FIELD = 3;

/** A mark longer than this is not emphasis, it is a second sentence. `rf-05 S1`'s longest is `AI slop` at two. */
export const MAX_MARK_WORDS = 6;

/** A mark covering more than this share of its field marks nothing — the eye reads an evenly-painted line as unmarked. */
export const MAX_MARKED_SHARE = 0.35;

/**
 * Two colours this far apart on `slide-metrics.ts`'s own weighted-RGB scale
 * (0-255) are separable by the MEASUREMENT, not merely by eye.
 *
 * The number matters because `markColourCount` counts distinct 5-bit bins
 * among marked cells: a ring whose members land in one bin would report "one
 * colour" for a plate carrying four, and the metric would be a guard that
 * cannot fail. Measurability is a SELECTION CRITERION here, not an
 * afterthought.
 */
export const MARK_TOL = 20;

/**
 * How far a mark colour must sit from the slide's accent.
 *
 * `2 x MARK_TOL`. A mark colour pixel-indistinguishable from accent furniture
 * would make `markedShare`/`markColourCount` report "the mark painted" on a
 * slide where the accent rule, the badge or the device ink painted instead.
 * The exclusion is checked against EVERY accent the run can rotate through
 * (see `buildMarkRing`), not just slide 1's, because the ring walks.
 */
export const ACCENT_EXCLUSION = 2 * MARK_TOL;

/** Pairwise separability inside the ring itself, same scale and same reason. */
export const MARK_SEPARATION = 2 * MARK_TOL;

/** Matches `ACCENT_RING_MAX` in `brand-render-tokens.ts`, and therefore the six `.mk-c*` classes `markCssBlock` emits. */
export const MARK_RING_MAX = 6;

/**
 * Below this, a mark is invisible against the ground for every kind that draws
 * NEXT TO the glyphs.
 *
 * EXPORTED since RFC-20 §6.2 so the guards pin the CONSTANT rather than a
 * literal `3` they happen to agree with. A test that writes `>= 3` cannot see
 * this number move; a test that writes `>= MARK_GROUND_CONTRAST_FLOOR` can.
 */
export const MARK_GROUND_CONTRAST_FLOOR = 3;

/** Above this, a mark may carry the glyphs themselves (`ink`) or stand behind them (`block`). WCAG AA for normal text. Exported for the same reason as its sibling. */
export const MARK_TEXT_CONTRAST_FLOOR = 4.5;

/**
 * THE ALPHA THE BUNDLED TEMPLATES ACTUALLY PAINT THEIR BODY INK AT, and why
 * `block` admission has to know about it.
 *
 * `block` is admitted on `contrastRatio(fgHex, hex) >= 4.5` — the INK on the
 * swatch. But no bundled template paints `var(--fg)` neat in a mark-bearing
 * run. Every one of them softens it:
 *
 *   `.body-text`  cover.html, headline-focus.html, slide.html   `--fg` at 92%
 *   `.cl-cta`     closer.html                                   `--fg` at 94%
 *   `.body-text`  stat-callout.html                             `--fg` at 90%
 *
 * `color-mix(in srgb, var(--fg) N%, transparent)` over a `block` swatch
 * composites channel-wise in gamma sRGB, so the glyphs a reader actually sees
 * are `N%` of the ink lerped toward THE SWATCH — never toward the page ground,
 * because the swatch is what is behind them. The ink therefore moves TOWARD
 * the thing it has to contrast with, and the shipped ratio is strictly below
 * the one admission measured.
 *
 * MEASURED, a 3-step RGB sweep of every `block`-capable candidate on the paper
 * kit `#F0EAE6`/`#12100E`: **22,876 of 379,493** render below 4.5 on a 92%
 * host. Worst case `#8A7B3C`, admitted at 4.501:1, renders at **4.16:1**. On
 * `#FAF7F2`/`#3A3632`, `#A5A254` is admitted at 4.503:1 and renders at 3.95:1.
 * PIXEL-CONFIRMED through the real `markCssBlock` + `buildMarkedRuns` output:
 * a `#FFEB3B` block's glyphs render `rgb(37,33,18)` on a 92% host rather than
 * `rgb(18,16,14)`, and measured contrast falls 15.55:1 -> 13.18:1.
 *
 * 0.90 is the MINIMUM over the bundled set, not the median, because admission
 * runs once per RUN and does not know which archetype will host the run. A
 * per-host value would be more precise and would also be a second source of
 * truth for a number that lives in CSS; the minimum is the only value that is
 * safe for every host at once. `template-mark-slots.test.ts` scans the
 * templates and fails if any mark-bearing host paints its ink below this, so
 * the constant cannot silently stop being the worst case.
 *
 * **This is not a threshold move.** 4.5 is untouched. What changes is the
 * COLOUR the 4.5 is measured on: the ink the reader gets rather than the token
 * the kit declares.
 */
export const MARK_HOST_INK_ALPHA = 0.9;

/**
 * The ink a reader actually sees inside a `block` run: the host's softened
 * `--fg` composited over the swatch.
 *
 * Falls back to the bare token when either hex is unparseable, which is the
 * same posture `parseHex`'s callers take everywhere else in this file — a
 * colour we cannot read is never repaired or guessed at.
 */
function effectiveInkOnMark(fgHex: string, markHex: string): string {
  return mixSrgb(fgHex, markHex, MARK_HOST_INK_ALPHA * 100) ?? fgHex;
}

/**
 * Whether the ground is LIGHTER than the ink — the one fact the whole kind
 * system turns on (RFC-17 finding 2).
 *
 * A lighter ground is paper: a highlighter swatch sits BEHIND dark glyphs and
 * what has to be readable is the ink ON the swatch. A darker ground is ours
 * (`#17181C`): a pastel swatch behind near-white ink is illegible, `rf-6`
 * shows the correct answer is a gradient IN the glyphs, and `block` is
 * refused by computation rather than by taste.
 */
export function groundIsLighterThanInk(groundHex: string, fgHex: string): boolean {
  // `contrastRatio(x, "#FFFFFF")` is monotonically DECREASING in x's
  // luminance, so the lighter colour is the one with the smaller ratio.
  return contrastRatio(groundHex, "#FFFFFF") < contrastRatio(fgHex, "#FFFFFF");
}

/** The tint ladder a one-hue kit falls back to — `color-mix(in srgb, <member> N%, var(--bg))`. */
const TINT_STEPS = [92, 74, 55] as const;

/** Below this many separable hues, the ring falls back to tints of what it has. */
const MIN_HUE_RING = 3;

// ─────────────────────────────────────────────────────────────────────────
// Kinds
// ─────────────────────────────────────────────────────────────────────────

/**
 * The five ways a mark is drawn. Chosen by CODE from ground luminance
 * (RFC-17 finding 2) — the model never sees this vocabulary.
 *
 * | id          | what it is                                    | precondition                                |
 * |-------------|-----------------------------------------------|---------------------------------------------|
 * | `block`     | a highlighter swatch behind the run, sitting low | contrast(ink, mark) >= 4.5 AND ground lighter than ink |
 * | `underline` | a 2-3px pencil rule                           | contrast(mark, ground) >= 3                 |
 * | `swish`     | a marker stroke, thick in the middle, overshooting both ends | contrast(mark, ground) >= 3 |
 * | `double`    | two rules of different weight                 | contrast(mark, ground) >= 3                 |
 * | `ink`       | the run's glyphs take the mark colour (`rf-6`) | contrast(mark, ground) >= 4.5              |
 */
export const MARK_KINDS = ["block", "underline", "swish", "double", "ink"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

/** One failed capability test, in the form a ring note quotes it. */
interface CapabilityMiss {
  kinds: string;
  why: string;
}

/**
 * WHAT ONE COLOUR IS LEGIBLE AS, against ONE ground/ink pair — RFC-20 §6.2.
 *
 * ── THE DEFECT THIS FUNCTION EXISTS TO END ───────────────────────────────
 *
 * `buildMarkRing` used to cull every candidate on `contrastRatio(hex, ground)
 * >= 3` BEFORE any kind existed, and `block` — a highlighter swatch BEHIND the
 * word — then needed the ink at 4.5:1 ON that swatch. On paper those two
 * squeeze from opposite ends of one luminance axis: a highlighter works by
 * sitting CLOSE to the paper in luminance and far from it in hue, so the very
 * colours `block` is for were refused before `block` was ever considered.
 * MEASURED (RFC-20 §6.4, and re-measured for this build on the paper kit
 * `#F0EAE6`/`#12100E`): `#FFEB3B` scores **1.02:1** against the paper and
 * **15.55:1** for the ink on it. The first number is the wrong test; the
 * second is the right one, and it is STRICTER.
 *
 * ── THIS IS A CHANGE OF QUANTIFIER, NOT OF THRESHOLD ─────────────────────
 *
 * Every number below is the number that shipped: 3:1 for the three kinds that
 * draw NEXT TO the glyphs, 4.5:1 (WCAG AA) for the two that ARE the glyphs or
 * sit under them, and `groundIsLighterThanInk` for `block` exactly as before.
 * Nothing is relaxed. What changes is WHICH test a candidate is judged by:
 * the test belonging to the kind it would actually be drawn as.
 *
 * ── ONE IMPLEMENTATION, FOUR CALLERS, SO THEY CANNOT DISAGREE ────────────
 *
 * Admission (`buildRingAgainstGrounds`), the per-slide narrowing
 * (`slideMarkKinds`, `ringIndexesFor`), the reporting union (`markKindsFor`)
 * and the emission-point re-assertion (`resolveSlideMarks`) all call THIS.
 * Four copies of a legibility rule is how a ring comes to admit a pair its own
 * renderer refuses, which is the class of defect this phase is repairing.
 *
 * It deliberately does NOT apply the `MARK_TOL` separability cull: that is a
 * RUN-level fact about every ground the member can land on, it is the metric's
 * own test rather than a legibility one, and it stays where it is — ahead of
 * everything, in `buildRingAgainstGrounds`.
 */
export function markCapabilitiesFor(
  hex: string,
  groundHex: string,
  fgHex: string,
  options?: { refuseBlock?: boolean | undefined },
): MarkKind[] {
  return capabilitiesWithMisses(hex, groundHex, fgHex, options).kinds;
}

/** `markCapabilitiesFor` plus the reason EVERY refused kind was refused — so a drop note can name all of them, not just the first. */
function capabilitiesWithMisses(
  hex: string,
  groundHex: string,
  fgHex: string,
  options?: { refuseBlock?: boolean | undefined },
): { kinds: MarkKind[]; misses: CapabilityMiss[] } {
  const kinds: MarkKind[] = [];
  const misses: CapabilityMiss[] = [];

  // `block` — the swatch sits BEHIND the glyphs, so what must be readable is
  // the INK ON THE MARK, and the swatch only reads as a highlighter when it is
  // lighter than the type it sits under. Both conjuncts as they shipped.
  // The ink measured here is the host's EFFECTIVE ink, not the kit token — see
  // `MARK_HOST_INK_ALPHA` for the measurement. Admitting on the neat token
  // admits a mark the reader never gets.
  const inkOnMark = effectiveInkOnMark(fgHex, hex);
  const onMark = contrastRatio(inkOnMark, hex);
  if (options?.refuseBlock === true) {
    misses.push({ kinds: "block", why: "this archetype refuses block outright — an italic run's background box is a parallelogram the CSS cannot follow" });
  } else if (!groundIsLighterThanInk(groundHex, fgHex)) {
    // A DARK GROUND FLIPS THE RUN'S INK (2026-09-23). The Karos Labs feed's
    // signature is exactly this case: a #1a1a1a ground, an orange block over
    // the phrase that carries the surprise, and the phrase itself in the
    // GROUND colour on the block. `body[data-tone="dark"] .mk-k-block` sets
    // the run's colour to `--bg`, so what must read is the ground on the mark.
    const groundOnMark = contrastRatio(groundHex, hex);
    if (groundOnMark >= MARK_TEXT_CONTRAST_FLOOR) kinds.push("block");
    else misses.push({ kinds: "block", why: `on the dark ground ${groundHex} the run's ink flips to the ground, which reads at only ${groundOnMark.toFixed(2)}:1 on ${hex}, below the ${MARK_TEXT_CONTRAST_FLOOR}:1 text floor` });
  } else if (onMark < MARK_TEXT_CONTRAST_FLOOR) {
    misses.push({
      kinds: "block",
      why:
        `the ink ${fgHex} renders as ${inkOnMark} at this archetype's ${(MARK_HOST_INK_ALPHA * 100).toFixed(0)}% and reads at only ` +
        `${onMark.toFixed(2)}:1 ON the mark, below the ${MARK_TEXT_CONTRAST_FLOOR}:1 text floor`,
    });
  } else {
    kinds.push("block");
  }

  // The three that draw NEXT TO the glyphs — they need luminance contrast
  // against the GROUND, which is genuinely what `contrastRatio` measures.
  const onGround = contrastRatio(hex, groundHex);
  if (onGround >= MARK_GROUND_CONTRAST_FLOOR) kinds.push("underline", "swish", "double");
  else misses.push({ kinds: "underline/swish/double", why: `${onGround.toFixed(2)}:1 against the ground ${groundHex} is below the ${MARK_GROUND_CONTRAST_FLOOR}:1 mark floor` });

  // `ink` — the glyphs THEMSELVES take the mark colour (`rf-6`'s mechanism),
  // so the mark IS the text and needs text contrast against the ground.
  if (onGround >= MARK_TEXT_CONTRAST_FLOOR) kinds.push("ink");
  else misses.push({ kinds: "ink", why: `${onGround.toFixed(2)}:1 against the ground ${groundHex} is below the ${MARK_TEXT_CONTRAST_FLOOR}:1 text floor` });

  return { kinds, misses };
}

/** Keep a kind list in `MARK_KINDS` order and free of repeats, whatever order it was accumulated in. */
function orderedKinds(kinds: Iterable<MarkKind>): MarkKind[] {
  const present = new Set(kinds);
  return MARK_KINDS.filter((k) => present.has(k));
}

// ─────────────────────────────────────────────────────────────────────────
// Small local utilities — mirrored, not imported, and each says why
// ─────────────────────────────────────────────────────────────────────────

/**
 * `slide-metrics.ts`'s weighted-RGB distance, re-declared here rather than
 * imported from `@agent-engine/tool-karos-publish`.
 *
 * Mirrored deliberately: this module runs in the COMPOSITION path, which must
 * not take a dependency on the renderer package to decide a colour, and the
 * formula is the published one (`colourDistance`, `slide-metrics.ts:227`).
 * It is re-derived here so that the number this module selects on is the same
 * number the pixel measurement will later report on — that identity is the
 * whole accent-exclusion argument, so a test pins it (`emphasis-marks.test.ts`).
 */
export function markColourDistance(a: string, b: string): number {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (pa === undefined || pb === undefined) return 0;
  const dr = pa[0] - pb[0];
  const dg = pa[1] - pb[1];
  const db = pa[2] - pb[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3;
}

/** `#abc`/`#aabbcc` -> an RGB triple. `undefined` for anything else — never repaired, never guessed. */
function parseHex(value: string | undefined): [number, number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) return undefined;
  let h = trimmed.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * What `color-mix(in srgb, <a> N%, <b>)` actually resolves to.
 *
 * `in srgb` mixes in GAMMA-ENCODED sRGB, so it is a plain channel-wise lerp
 * of the 0-255 values — which is why this can be computed here and reported
 * as the measurable hex while the stylesheet keeps the `color-mix()` form.
 */
function mixSrgb(a: string, b: string, percentA: number): string | undefined {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (pa === undefined || pb === undefined) return undefined;
  const t = percentA / 100;
  return toHex([pa[0] * t + pb[0] * (1 - t), pa[1] * t + pb[1] * (1 - t), pa[2] * t + pb[2] * (1 - t)]);
}

/**
 * FNV-1a 32, the seed hash every seeded choice in this agent already uses
 * (`paletteForSlide`, `isVariationSlot`). Re-declared for the same reason
 * those two each declare their own: it is six lines, and the alternative is
 * exporting a hash from a module whose public surface is colours.
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
 * Escapes a value for interpolation into a `{{html:...}}` fragment.
 *
 * Mirrors `escapeHtmlText` in `karos-publish` — and `slides-data.ts`'s own
 * `esc` — rather than importing either, for the reason that file already
 * records: the `{{html:}}` substitution form is deliberately NOT escaped by
 * the renderer, which makes escaping HERE the only thing standing between a
 * model-authored mark and live markup in a rendered slide.
 */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ─────────────────────────────────────────────────────────────────────────
// The ring
// ─────────────────────────────────────────────────────────────────────────

/** The colours one RUN may mark with, and how they were arrived at. */
export interface MarkRing {
  /** In-kit hexes, pairwise separable, none confusable with the run's accent. Empty means NO MARKS THIS RUN. */
  hexes: readonly string[];
  /**
   * The CSS value for each member, positionally.
   *
   * Identical to `hexes` on the hue path. On the tint path this carries the
   * `color-mix(in srgb, <member> N%, var(--bg))` form so the tint tracks a
   * template that repaints `--bg`, while `hexes` carries what that mix
   * resolves to against the kit's own ground — the value the pixel
   * measurement is told to expect.
   */
  readonly cssValues: readonly string[];
  /**
   * WHAT EACH MEMBER IS LEGIBLE AS — positional, parallel to `hexes`, computed
   * ONCE at admission where both the colour and the grounds are known (RFC-20
   * §6.2 item 3).
   *
   * This is the field that makes the ring's promise checkable. Before it, the
   * ring promised only "these colours are far enough from the ground", the
   * kind was chosen separately, and a (colour, kind) pair could exist that the
   * colour could not carry. A member is in `hexes` only when this entry is
   * non-empty.
   *
   * IT IS A UNION ACROSS THE GROUNDS THE RING WAS BUILT AGAINST, and therefore
   * an INVENTORY rather than a licence. On an inverting run a member may carry
   * `block` on the paper ground and `underline` on the dark one; both appear
   * here. The BINDING set is the per-slide one — `slideMarkKinds` recomputes
   * against the slide's own effective (post-inversion) pair, `ringIndexesFor`
   * drops a member whose set is empty for that slide, and `resolveSlideMarks`
   * re-asserts the pair at the point of emission. Reading this field straight
   * into `markRotation` would skip all three.
   */
  readonly kindsByIndex: readonly (readonly MarkKind[])[];
  /** `hue` — genuinely different colours. `tint` — one hue at three strengths. `none` — nothing legible survived. */
  rotation: "hue" | "tint" | "none";
  /** Every candidate that did not make it, and why. Reported, never gated. */
  notes: readonly string[];
}

/**
 * The colours this run may mark with, derived IN CODE from the kit's own
 * accent ring (RFC-17 finding 7).
 *
 * Why not let an art director or the copy model name a mark palette: a
 * palette invented outside the accent ring is stripped by
 * `filterLearnedStyleToRing` and then fails `checkPaletteWithinKit` three
 * attempts later — a recorded $0.30 hold for a worse result. Deriving here
 * costs $0.00 and cannot produce an out-of-kit hex by construction.
 *
 * ── WHY THE ACCENT EXCLUSION IS NOT APPLIED HERE ─────────────────────────
 *
 * The candidate pool IS the kit's accent ring — `brandAccent` plus
 * `palette[]` is exactly what `deriveBrandRenderTokens` hands the accent
 * rotation. Excluding "anything near the accent" at RUN level would therefore
 * annihilate the ring: every candidate is an accent on some slide.
 *
 * The accent a slide paints ROTATES (`paletteForSlide`'s seeded walk), so the
 * exclusion is a PER-SLIDE fact and lives in `ringIndexesFor`. This function
 * builds the positional 6-slot ring — the one the six `.mk-c*` classes carry,
 * emitted once per run — and each slide then marks with the members its own
 * accent is not using. That is a better design than a filtered pool as well
 * as a workable one: a slide's marks are the kit colours its accent furniture
 * has left free, which is precisely what makes `markColourCount` able to tell
 * the two apart on the pixels.
 *
 * `accentHex` is still taken, and applied, for the one case where an accent
 * IS constant across the whole run: a client whose ring has a single member
 * paints `ring[0]` on every slide (`resolveSlideAccent`'s `rotates: false`),
 * and excluding it once here produces better trace notes than excluding it
 * eight times downstream. Callers with a rotating ring pass `[]`.
 */
export function buildMarkRing(
  tokens: { brandAccent?: string | undefined; palette?: readonly string[] | undefined },
  groundHex: string,
  fgHex: string,
  accentHex: string | readonly string[],
  options?: {
    /**
     * True when IGSTYLE-10's ground/fg inversion is live this round, so some
     * slides render with `fgHex` AS the ground. A ring member then has to be
     * legible on BOTH members of the pair, or a quarter of the carousel
     * carries an invisible mark.
     */
    groundMayInvert?: boolean | undefined;
  },
): MarkRing {
  // ── THE BOTH-GROUNDS PASS MUST NEVER BE THE LAST WORD (review finding 1). ─
  //
  // `groundMayInvert` intersects two legibility sets, and on a kit with any
  // real contrast the intersection is EMPTY, not merely smaller. `--fg` is
  // near-white on every dark kit we ship, so a saturated brand accent that
  // clears 3:1 against a `#17181C` ground cannot also clear 3:1 against a
  // near-white one — the two floors pull in opposite directions. Measured on
  // this suite's own canonical dark kit (`#FF6B2C` + `#4ADE80` + `#38BDF8` +
  // `#C084FC` on `#17181C`/`#F5F3EF`): the strict pass accepts NOTHING, the
  // four candidates scoring 2.56, 1.57, 1.93 and 2.38 against the ink. The
  // whole emphasis system then paints nothing and reports every declared span
  // as a drop, which is what shipped before this fallback existed.
  //
  // So: try the intersection, and when it is empty fall back to the PRIMARY
  // ground alone. This is safe, not a relaxation, because the per-slide half
  // of the decision already re-checks against the slide's EFFECTIVE
  // (post-inversion) ground: since RFC-20 that is `slideMarkKinds`, which
  // recomputes each member's capabilities against the pair the slide really
  // renders on, plus `ringIndexesFor`'s narrowing and the emission-point
  // re-assertion. An inverted slide whose ring fails there gets an empty
  // capability set per member and marks nothing — a degraded slide, never an
  // illegible mark. The failure mode we trade away (a quarter of the carousel
  // unmarked) is strictly better than the one we had (the whole carousel
  // unmarked).
  //
  // ── WHAT RFC-20 §6.2 ITEM 8 CHANGES HERE, AND WHAT IT DOES NOT ───────────
  //
  // The pairs below are (GROUND, INK), not two grounds: on an inverted slide
  // the kit's `--fg` IS the ground and its `--bg` is the ink, and `block`'s
  // whole test is about which of the pair is lighter. Passing two bare grounds
  // and one fixed ink — which is what "two membership sets" amounted to —
  // cannot express that, and it is why the strict pass used to be empty on
  // every kit with real contrast.
  //
  // The intersection is now taken over CAPABILITY: a member survives when it
  // is legible as at least one kind on EVERY pair, and it KEEPS the union of
  // what it can do on each. MEASURED for this build on the shipped
  // `#17181C`/`#F4F2EC` kit, all four of `#FF6B2C`/`#4ADE80`/`#38BDF8`/
  // `#C084FC` now clear the strict pass (underline-family on the dark ground,
  // `block` on the inverted paper one) where none did before — so the ring is
  // IDENTICAL to the fallback ring it used to reach the long way round, and
  // the fallback below now fires only when a member really is illegible on one
  // of the two. The fallback stays because "far less often" is not "never".
  const strict =
    options?.groundMayInvert === true
      ? buildRingAgainstGrounds(tokens, groundHex, fgHex, accentHex, [
          { ground: groundHex, ink: fgHex },
          { ground: fgHex, ink: groundHex },
        ])
      : undefined;
  if (strict !== undefined && strict.hexes.length > 0) return strict;
  const ring = buildRingAgainstGrounds(tokens, groundHex, fgHex, accentHex, [{ ground: groundHex, ink: fgHex }]);
  if (strict === undefined) return ring;
  if (ring.hexes.length === 0) return strict;
  return {
    ...ring,
    notes: [
      ...strict.notes,
      "no candidate cleared the floor against BOTH the ground and the ink, so the ring was rebuilt against the ground alone — inverted slides fall back to no marks via `markKindsFor`",
      ...ring.notes,
    ],
  };
}

/** `buildMarkRing`'s body, with the (ground, ink) pairs a member must be legible on made explicit. */
function buildRingAgainstGrounds(
  tokens: { brandAccent?: string | undefined; palette?: readonly string[] | undefined },
  groundHex: string,
  fgHex: string,
  accentHex: string | readonly string[],
  pairs: readonly { ground: string; ink: string }[],
): MarkRing {
  const notes: string[] = [];
  /** Every surface a member can land on — the `MARK_TOL` cull's own domain, unchanged. */
  const surfaces = [...new Set(pairs.flatMap((p) => [p.ground, p.ink]))];

  /**
   * Per-capability admission — RFC-20 §6.2 item 2.
   *
   * `undefined` means "legible as nothing here"; the note that comes back
   * names EVERY test it failed, because a note naming only the first sends the
   * next reader to fix one of three things.
   */
  const admit = (hex: string): { kinds: MarkKind[] } | { note: string } => {
    const perPair = pairs.map((p) => ({ pair: p, ...capabilitiesWithMisses(hex, p.ground, p.ink) }));
    const dead = perPair.find((r) => r.kinds.length === 0);
    if (dead !== undefined) {
      return {
        note:
          `${hex} was dropped — no kind is legible on the ground ${dead.pair.ground}: ` +
          dead.misses.map((m) => `${m.kinds} (${m.why})`).join("; "),
      };
    }
    // The member survives every pair, and KEEPS the union of what it can do on
    // each. See `MarkRing.kindsByIndex` for why a union is safe here and where
    // it is narrowed.
    return { kinds: orderedKinds(perPair.flatMap((r) => r.kinds)) };
  };
  const accents = (typeof accentHex === "string" ? [accentHex] : [...accentHex]).filter((h) => parseHex(h) !== undefined);

  const raw = [tokens.brandAccent, ...(tokens.palette ?? [])].filter((h): h is string => typeof h === "string" && parseHex(h) !== undefined);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const hex of raw) {
    const key = hex.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(hex);
  }

  const accepted: string[] = [];
  const acceptedKinds: MarkKind[][] = [];
  /** Legible members refused ONLY for sitting on the accent; the ring falls back to them when nothing else survives. */
  const accentOnly: Array<{ hex: string; kinds: MarkKind[] }> = [];
  for (const hex of candidates) {
    if (accepted.length >= MARK_RING_MAX) break;
    // ── THE HONEST CULL, AND IT IS DELIBERATELY UNCHANGED (RFC-20 §6.2 item 1).
    //
    // The ground and the ink themselves are not mark colours: a "mark" the
    // same colour as what it sits on is nothing at all. This is the
    // MEASUREMENT's own test — `markColourDistance` is byte-for-byte
    // `slide-metrics.ts`'s `colourDistance`, the number that will later decide
    // whether a marked cell counts — so a colour inside it is one the pixel
    // instrument could not see either.
    //
    // Keeping it exactly as it was is what stops this phase being a general
    // loosening. MEASURED for this build: `#E8D4F0`, rf-11's own lilac, sits
    // at 16.2 from the paper `#F0EAE6` and stays refused, even though the ink
    // reads on it at 13.66:1 and `block` would otherwise admit it.
    if (surfaces.some((s) => markColourDistance(hex, s) <= MARK_TOL)) {
      notes.push(`${hex} was dropped — it is within ${MARK_TOL} of the ground or the ink`);
      continue;
    }
    // Legibility, per capability rather than by one pre-kind ratio.
    const verdict = admit(hex);
    if ("note" in verdict) {
      notes.push(verdict.note);
      continue;
    }
    // Accent exclusion — see ACCENT_EXCLUSION.
    const clash = accents.find((a) => markColourDistance(hex, a) < ACCENT_EXCLUSION);
    if (clash !== undefined) {
      notes.push(`${hex} was dropped — it is within ${ACCENT_EXCLUSION} of the accent ${clash} and a mark must never be pixel-confused with accent furniture`);
      accentOnly.push({ hex, kinds: verdict.kinds });
      continue;
    }
    // Pairwise separability: the LATER member drops, so the ring's order is
    // the kit's own order and the result is stable under re-derivation.
    const near = accepted.find((prev) => markColourDistance(hex, prev) < MARK_SEPARATION);
    if (near !== undefined) {
      notes.push(`${hex} was dropped — it is within ${MARK_SEPARATION} of ${near}, already in the ring`);
      continue;
    }
    accepted.push(hex);
    acceptedKinds.push(verdict.kinds);
  }

  // ── A ONE-COLOUR BRAND MARKS IN ITS OWN COLOUR (2026-09-26). ──
  //
  // The exclusion above keeps a mark apart from accent furniture. On a kit
  // whose ring is the accent alone it removed EVERY candidate: prep batch 8
  // painted a marked word on 1 of 11 carousels (the one multi-colour kit)
  // although the copy declared emphasis on 8 of 8 slides of every post, and
  // the owner's verdict on karoslabs was "missing the orange". The owner's
  // own reference sets the orange kicker and the orange highlight block in
  // the same colour. When nothing but the accent survives, the accent is the
  // mark colour; a kit with any other legible colour is unchanged.
  const accentIsTheMark = accepted.length === 0 && accentOnly.length > 0;
  if (accentIsTheMark) {
    const only = accentOnly[0]!;
    accepted.push(only.hex);
    acceptedKinds.push(only.kinds);
    notes.push(`${only.hex} marks after all — it is the kit's only legible colour, and a brand with one colour emphasises in it`);
  }

  if (accepted.length >= MIN_HUE_RING) {
    return { hexes: accepted, cssValues: accepted, kindsByIndex: acceptedKinds, rotation: "hue", notes };
  }

  // ── Tint fallback: a one-hue kit still gets a rotation (RFC-17 §5.2).
  //
  // Same hue, in-kit by construction. The extremes (92% and 55%) are what has
  // to clear `MARK_SEPARATION`; consecutive steps need not, and any step that
  // collapses into one already accepted is simply not added — so a kit whose
  // accent sits close to its own ground yields a SHORTER ring rather than a
  // ring of colours the measurement cannot tell apart.
  const tintHexes = [...accepted];
  const tintCss = [...accepted];
  const tintKinds = [...acceptedKinds];
  for (const member of accepted.length > 0 ? accepted : []) {
    for (const step of TINT_STEPS) {
      if (tintHexes.length >= MARK_RING_MAX) break;
      const resolved = mixSrgb(member, groundHex, step);
      if (resolved === undefined) continue;
      // THE `MARK_TOL` CULL APPLIES HERE TOO, AND IT DID NOT BEFORE. A tint is
      // a lerp TOWARD the ground, so the 55% step is the one member of this
      // ring that can genuinely land inside the metric's own resolution. The
      // old code never checked it because the 3:1 contrast cull it is
      // replacing happened to imply separability; per-capability admission
      // does not, since `block` asks nothing about the ground at all. Adding
      // it is what keeps "no admitted colour is ever within MARK_TOL of a
      // surface" true of the WHOLE ring rather than of the hue path alone.
      if (surfaces.some((s) => markColourDistance(resolved, s) <= MARK_TOL)) continue;
      const verdict = admit(resolved);
      if ("note" in verdict) continue;
      if (!accentIsTheMark && accents.some((a) => markColourDistance(resolved, a) < ACCENT_EXCLUSION)) continue;
      if (tintHexes.some((prev) => markColourDistance(resolved, prev) < MARK_SEPARATION)) continue;
      tintHexes.push(resolved);
      tintCss.push(`color-mix(in srgb, ${member} ${step}%, var(--bg))`);
      tintKinds.push(verdict.kinds);
    }
  }

  if (tintHexes.length === 0) {
    notes.push("no candidate survived — this run marks nothing and every field renders plain");
    return { hexes: [], cssValues: [], kindsByIndex: [], rotation: "none", notes };
  }
  if (tintHexes.length === accepted.length) {
    // Nothing was added: the ring is what the hues gave, however short.
    return { hexes: tintHexes, cssValues: tintCss, kindsByIndex: tintKinds, rotation: "hue", notes };
  }
  notes.push(`the kit offered ${accepted.length} separable hue(s), so the ring rotates through tints of them instead`);
  return { hexes: tintHexes, cssValues: tintCss, kindsByIndex: tintKinds, rotation: "tint", notes };
}

/**
 * Which of the run ring's slots THIS SLIDE may mark with — the accent
 * exclusion, applied where the accent is actually known.
 *
 * A mark colour pixel-indistinguishable from this slide's accent would make
 * `markedShare` / `markColourCount` report "the mark painted" on a slide
 * where the accent rule, the badge or the device ink painted instead: the
 * metric would be a guard that cannot fail. **Measurability is a selection
 * criterion, not an afterthought.**
 *
 * Returns INDEXES rather than hexes so the caller keeps the positional
 * relationship with the six `.mk-c*` classes, which are emitted once per run
 * and cannot vary per slide.
 *
 * An empty result means this slide marks nothing — reported, never gated.
 *
 * ── AND, SINCE RFC-20 §6.2 ITEM 7, THIS SLIDE'S KIND CONSTRAINTS ─────────
 *
 * `slide` is optional because the inventory callers (a trace, the studio's
 * kind listing) genuinely have no slide. **Every production call site passes
 * it**, and a source scan in `emphasis-marks.test.ts` pins that, because
 * omitting it is silent: the slot is admitted and the narrowing simply does
 * not happen.
 *
 * It is LOAD-BEARING rather than tidy. On `quote_card`, `refuseBlock` strips
 * `block`, and on a paper kit a highlighter yellow's ONLY capability is
 * `block` — so without this limb that member is selected for a slide on which
 * it can be drawn as nothing at all, and `markRotation` returns `undefined`
 * for a colour the caller was told it could use. Before RFC-20 the question
 * could not arise, because kinds were a single per-slide set shared by every
 * member; per-member capabilities make "allowed colour" and "drawable colour"
 * two different facts, and this is where they are reconciled.
 */
export function ringIndexesFor(
  ring: MarkRing,
  accentHex: string | undefined,
  slide?: { groundHex: string; fgHex: string; refuseBlock?: boolean | undefined } | undefined,
): number[] {
  // THE PARSE CHECK IS LOAD-BEARING, and its absence was a silent
  // feature-killer. `markColourDistance` returns 0 — the value that means
  // "identical" — when either side does not parse, and every caller compares
  // it with `<` against a tolerance. So an accent of `""`, `"rgb(196,85,47)"`
  // or any other non-hex string put EVERY ring member inside
  // `ACCENT_EXCLUSION`, emptied `allowedIndexes`, and sent `resolveSlideMarks`
  // down its `plain()` path: the whole slide rendered unmarked while
  // reporting "no legible mark colour survived this slide's kit and accent",
  // which names the kit rather than the malformed accent that actually did it.
  // An empty string is a very ordinary value for an unset brand accent.
  //
  // An unparseable accent now means "there is no accent to keep clear of",
  // which is what `undefined` already meant, and is the same guard
  // `buildMarkRing` applies to its own accent argument above.
  //
  // NOT fixed inside `markColourDistance` on purpose: `buildMarkRing` relies
  // on the 0 to DROP an unparseable candidate, and returning `Infinity` there
  // would admit garbage into the ring instead. The two callers want opposite
  // fallbacks, so the check belongs at the call site.
  const accent = accentHex !== undefined && parseHex(accentHex) !== undefined ? accentHex : undefined;
  const pass = (excludeAccent: boolean): number[] => {
    const allowed: number[] = [];
    ring.hexes.forEach((hex, index) => {
      if (excludeAccent && accent !== undefined && markColourDistance(hex, accent) < ACCENT_EXCLUSION) return;
      if (slide !== undefined && markCapabilitiesFor(hex, slide.groundHex, slide.fgHex, slide).length === 0) return;
      allowed.push(index);
    });
    return allowed;
  };
  const allowed = pass(true);
  // 2026-09-26: when the slide's accent is the only colour the ring holds
  // (a one-colour brand, see `buildMarkRing`), the accent marks too rather
  // than the slide marking nothing.
  return allowed.length > 0 ? allowed : pass(false);
}

/**
 * What each ring slot may be drawn as on ONE slide, and the union for the
 * trace — the per-slide half of RFC-20 §6.2.
 *
 * THE RING'S OWN `kindsByIndex` IS NOT THIS. That one is a union over the
 * grounds the RUN may render on, and on an inverting run it deliberately keeps
 * a `block` a dark slide cannot draw. This recomputes against the pair THIS
 * slide actually renders — `assembleSlidesData` resolves the inversion before
 * it composes, for exactly this reason — and applies the archetype's own
 * `refuseBlock`.
 *
 * Returns both halves because they answer different questions and must not be
 * confused again: `kindsByIndex` BINDS the rotation, `kinds` is the union that
 * `SlideMarkResult.kinds` carries so `interest-floor.ts` knows whether
 * `markedShare` can be non-zero at all.
 */
export function slideMarkKinds(
  ring: MarkRing,
  groundHex: string,
  fgHex: string,
  options?: { refuseBlock?: boolean | undefined },
): { kindsByIndex: MarkKind[][]; kinds: MarkKind[] } {
  const kindsByIndex = ring.hexes.map((hex) => markCapabilitiesFor(hex, groundHex, fgHex, options));
  return { kindsByIndex, kinds: orderedKinds(kindsByIndex.flat()) };
}

/**
 * Which of the five kinds are legible for this ground/ink pair and this ring —
 * the UNION over its members. **Reporting and inventory only since RFC-20.**
 *
 * ── `every()` IS GONE, AND IT WAS THE SECOND HALF OF THE SQUEEZE ─────────
 *
 * This function used to be the GATE: a kind was admitted only when its
 * precondition held for EVERY member, so that any (colour, kind) pairing the
 * rotation produced was legible. The reasoning was sound and the consequence
 * was not. MEASURED for this build on the paper kit `#F0EAE6`/`#12100E`: a
 * kind-aware admission ALONE still leaves `block` unusable, because one dark
 * navy member — `#1D4ED8`, which the ink reads on at only 2.83:1 — vetoes
 * `block` for the whole run, however many highlighters sit beside it in the
 * ring. Re-arming the ring without removing the universal quantifier fixes
 * nothing; removing the quantifier without the ring fix admits pairs the ring
 * never checked. The two defects had to be repaired together, and RFC-20 §6.1
 * is where that is argued.
 *
 * The bound moved to where the PAIRING is made instead: `slideMarkKinds`
 * computes a set per member, `markRotation` draws a kind from the selected
 * colour's OWN set, and `resolveSlideMarks` re-asserts at emission. No
 * (colour, kind) pair can exist that the colour cannot carry — which is a
 * STRONGER guarantee than `every()` gave, since `every()` only protected
 * pairings drawn from one shared set.
 *
 * What survives here unchanged: the name, the signature, the `refuseBlock`
 * option, and the answers on a dark kit. On our bundled `#17181C` ground
 * against a light ink `block` is still refused — for every colour there is,
 * not merely for this ring — because `groundIsLighterThanInk` is false and no
 * mark colour can make it true. `interest-floor.ts` and `SlideMarkResult`
 * read this union to decide whether `markedShare` can be non-zero at all, and
 * a union is the right answer to that question.
 */
export function markKindsFor(
  groundHex: string,
  fgHex: string,
  ring: readonly string[],
  options?: {
    /**
     * `quote_card` sets this. `.quote-text` is italic at 84px, and an italic
     * run's background box is a PARALLELOGRAM the CSS cannot follow — a
     * rectangular swatch behind slanted glyphs reads as a printing error.
     * Refused regardless of ground (RFC-17 §5.4).
     */
    refuseBlock?: boolean | undefined;
  },
): MarkKind[] {
  if (ring.length === 0) return [];
  return orderedKinds(ring.flatMap((hex) => markCapabilitiesFor(hex, groundHex, fgHex, options)));
}

// ─────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────

/** One piece of a field: the text, and the mark painted on it (absent for the prose between marks). */
export interface MarkRun {
  text: string;
  mark?: { /** Position in the slide's rotation, 0-based. */ ordinal: number; colourIndex: number; kind: MarkKind };
}

/** A declared mark this module refused, and the reason — for `collectEmphasisIssues`. */
export interface MarkDrop {
  field: string;
  text: string;
  reason: string;
}

/** Everything the rotation needs that is fixed for one SLIDE. */
export interface SlideMarkContext {
  dir: "rtl" | "ltr";
  /** The run ring's slots THIS slide may use, from `ringIndexesFor`. Empty means this slide marks nothing. */
  allowedIndexes: readonly number[];
  /** The UNION of what this slide's allowed slots can be drawn as. Reporting only — `kindsByIndex` is what binds. */
  kinds: readonly MarkKind[];
  /**
   * What each RING SLOT may be drawn as on this slide — positional, parallel
   * to `hexes`, from `slideMarkKinds`. **This is the binding constraint.**
   *
   * ── WHY IT IS OPTIONAL, WHICH IS A DECISION AND NOT AN OVERSIGHT ─────────
   *
   * Omitting it falls back to `kinds` for every slot, which is EXACTLY the
   * pre-RFC-20 shape: one set shared by the whole ring. That fallback exists
   * for one reason — `emphasis-marks-rtl.test.ts` composes this context by
   * hand to exercise Phase 4's bidi isolation, and RFC-20 §5.9 states that if
   * that file needs editing, the change was wrong. The bidi rules under test
   * there have nothing to do with colour legibility, and forcing a colour
   * model onto them would be a phase leaking into a phase.
   *
   * It is safe because the fallback cannot be LOOSER than what it replaces:
   * `kinds` is the same union the old code fed `markRotation` directly. It is
   * kept honest because **both production call sites pass it**, and a source
   * scan in `emphasis-marks.test.ts` pins that — the one thing an optional
   * field cannot do for itself.
   */
  kindsByIndex?: readonly (readonly MarkKind[])[] | undefined;
  /**
   * The ring's hexes and this slide's EFFECTIVE (post-inversion) pair, so the
   * emission point can re-assert the pairing it is about to write.
   *
   * Absent means the re-assertion is skipped — the admission-time bound still
   * holds, and this is the belt over those braces. Same source scan.
   */
  hexes?: readonly string[] | undefined;
  groundHex?: string | undefined;
  fgHex?: string | undefined;
  refuseBlock?: boolean | undefined;
  /** `fnv1a32(`${paletteSeed}|mk|${slide.n}`)`, computed once per slide by `slideMarkSeed`. */
  seed: number;
}

/** The per-slide seed the rotation walks. Separate so a caller can compute it once and a test can pin it. */
export function slideMarkSeed(paletteSeed: string | undefined, slideN: number): number {
  return fnv1a32(`${paletteSeed ?? ""}|mk|${slideN}`);
}

/**
 * The (colour, kind) one mark takes, by ORDINAL within the slide.
 *
 * Seeded, never random — the `paletteForSlide` contract. Two invariants the
 * formula is built to give, both tested:
 *
 * - **Consecutive marks never share a colour** when the slide has >= 2
 *   allowed slots (`allowed[(b + k) mod R]` steps by exactly one each time).
 *   With a single allowed slot they necessarily do, and the KIND alternation
 *   below is what still keeps two adjacent marks from being identical.
 * - **At least two kinds appear** whenever at least two marks do, when the two
 *   selected colours share a kind set of >= 2 members: `kindB`'s offset is
 *   drawn from `[1, K-1]`, so it can never land back on `kindA`. The
 *   qualifier is new in RFC-20 and it is honest rather than weaker — see below.
 *
 * ── THE KIND COMES FROM THE SELECTED COLOUR'S OWN SET (RFC-20 §6.2 item 5) ─
 *
 * `kindsByIndex` is indexed by RING SLOT, not by rotation position. The colour
 * is chosen first, exactly as before, and the kind is then drawn from what
 * THAT colour can carry on THIS slide.
 *
 * **This is the bound.** The pairing is what has to be legible, so the pairing
 * is checked at the point it is made, and no (colour, kind) pair can exist
 * that the colour cannot carry. The old design kept colour and kind as
 * independent axes and paid for it with `markKindsFor`'s `every()`, which
 * meant one dark ring member could veto `block` for a carousel full of
 * highlighters.
 *
 * The cost is the second invariant's qualifier: when two consecutive marks
 * draw colours with DIFFERENT capability sets, the "two kinds" guarantee comes
 * from the sets differing rather than from the offset, and when both sets are
 * a single identical kind the two marks necessarily share it. That is correct
 * — legibility outranks variety, and a kit whose members can each be drawn one
 * way has one way to draw them. When the sets are equal, which is every slide
 * of every dark kit we ship, the old guarantee holds verbatim.
 *
 * `undefined` when this slide has no allowed slot at all, or when the slot the
 * rotation landed on can be drawn as nothing — the caller renders the field
 * plain and reports it.
 */
export function markRotation(
  seed: number,
  ordinal: number,
  allowedIndexes: readonly number[],
  kindsByIndex: readonly (readonly MarkKind[])[],
): { colourIndex: number; kind: MarkKind } | undefined {
  const r = allowedIndexes.length;
  if (r === 0) return undefined;
  const colourIndex = allowedIndexes[(seed + ordinal) % r]!;
  const kinds = kindsByIndex[colourIndex];
  if (kinds === undefined || kinds.length === 0) return undefined;
  const k = kinds.length;
  const kindA = kinds[seed % k]!;
  const kindB = k >= 2 ? kinds[(seed + 1 + ((seed >>> 3) % (k - 1))) % k]! : kindA;
  return { colourIndex, kind: ordinal % 2 === 0 ? kindA : kindB };
}

/**
 * Where each FOREIGN RUN sits in `text`, as `bidi-isolate.ts` itself defines
 * a foreign run — derived by CALLING `isolateForeignRuns` and reading back
 * where it put its isolates, never by re-declaring its pattern here.
 *
 * That indirection is the point. `foreignRunPattern` is private, it has
 * already been wrong once (the `⁨API⁩ ⁨v2⁩` regression its own doc comment
 * records), and a second copy of it in this file would drift the moment
 * anyone fixes the first. Reading the output of the real function cannot
 * drift.
 */
function foreignRunRanges(text: string): { start: number; end: number }[] {
  const isolated = isolateForeignRuns(text, "rtl");
  const ranges: { start: number; end: number }[] = [];
  let original = 0;
  let open = -1;
  for (const ch of isolated) {
    if (ch === "⁨") {
      open = original;
      continue;
    }
    if (ch === "⁩") {
      if (open >= 0) ranges.push({ start: open, end: original });
      open = -1;
      continue;
    }
    original += ch.length;
  }
  return ranges;
}

/** A boundary is INSIDE a run when it splits it — touching either edge is fine. */
function splitsAForeignRun(ranges: readonly { start: number; end: number }[], at: number): { start: number; end: number } | undefined {
  return ranges.find((r) => at > r.start && at < r.end);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The first occurrence of `needle` in `haystack` bounded on BOTH sides by a
 * non-word character or a string edge, or `-1`.
 *
 * Without the bounds, `"AI"` marks the middle of `"SAID"` — which is this
 * rule's falsification test and the reason the search is written out rather
 * than delegated to `indexOf`.
 */
export function boundedFirstOccurrence(haystack: string, needle: string, searchFrom = 0): number {
  if (needle.length === 0) return -1;
  let from = searchFrom;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return -1;
    const before = at > 0 ? haystack[at - 1]! : "";
    const after = at + needle.length < haystack.length ? haystack[at + needle.length]! : "";
    // A boundary only has to hold on a side where the MARK ITSELF is a word
    // character: a span that legitimately starts with `(` or ends with `.`
    // must not be refused because its neighbour is a letter.
    const startOk = before === "" || !WORD_CHAR.test(before) || !WORD_CHAR.test(needle[0]!);
    const endOk = after === "" || !WORD_CHAR.test(after) || !WORD_CHAR.test(needle[needle.length - 1]!);
    if (startOk && endOk) return at;
    from = at + 1;
  }
}

/**
 * Resolve one FIELD's declared marks into alternating runs.
 *
 * Pure, deterministic and total: every input produces runs whose joined text
 * is byte-identical to `text`, and any span that cannot be marked honestly is
 * dropped with a reason.
 *
 * THE ORDER OF OPERATIONS IS LOAD-BEARING (RFC-17 §5.2):
 *
 * 1. **Bounded first occurrence in the ORIGINAL string, before `iso()`.**
 *    `isolateForeignRuns` inserts two `\p{Cf}` characters per foreign run, so
 *    any position authored against the model's own string is wrong by the
 *    time the field reaches the document. This is also why the contract is
 *    verbatim TEXT and not offsets (finding 6).
 * 2. **Order by POSITION, not by the model's array order** — "consecutive
 *    marks differ" is meaningless against an arbitrary order.
 * 3. **Drop** on overlap, on more than `MAX_MARK_WORDS` words, or once the
 *    total marked share would pass `MAX_MARKED_SHARE`.
 * 4. **Cap** at `MAX_MARKS_PER_FIELD`, and at `MAX_MARKS_PER_SLIDE` across
 *    the slide (via `alreadyAccepted`).
 * 5. **The RTL foreign-run boundary rule, which is what protects Phase 4.**
 *    A span edge falling INSIDE a foreign run would split that run across two
 *    spans, each isolated separately — precisely the `⁨API⁩ ⁨v2⁩` regression
 *    `bidi-isolate.ts` documents. The span is EXTENDED to the run's own
 *    boundary when it still fits, and DROPPED otherwise.
 *
 * Splitting happens here; isolating and escaping happen per-run in
 * `buildMarkedRuns`, in that order. Isolating BEFORE splitting would put an
 * FSI on one side of a span boundary and its PDI on the other.
 */
export function resolveSlideMarks(
  field: string,
  text: string,
  declared: readonly { text: string }[],
  ctx: SlideMarkContext & { alreadyAccepted: number },
): { runs: MarkRun[]; accepted: number; drops: MarkDrop[] } {
  const drops: MarkDrop[] = [];
  const plain = (): { runs: MarkRun[]; accepted: number; drops: MarkDrop[] } => ({ runs: [{ text }], accepted: 0, drops });

  if (text.length === 0) return plain();
  if (declared.length === 0) return plain();
  // Since RFC-20 a slot can be ALLOWED (far enough from this slide's accent)
  // and still be drawable as NOTHING here — a paper kit's highlighter on a
  // `quote_card`, whose only capability is `block` and whose `block` that
  // archetype refuses. `ringIndexesFor` already drops those when it is given
  // the slide, and this re-filters rather than trusting it: the narrowing
  // argument is optional, and a resolver that assumed its input had been
  // filtered would be a guard that cannot fail.
  const kindsAt = (index: number): readonly MarkKind[] => (ctx.kindsByIndex === undefined ? ctx.kinds : (ctx.kindsByIndex[index] ?? []));
  /** Dense and positional, so `markRotation` can index it by RING SLOT. */
  const rotationKinds: readonly MarkKind[][] = Array.from({ length: Math.max(0, ...ctx.allowedIndexes.map((i) => i + 1)) }, (_, i) => [...kindsAt(i)]);
  const usable = ctx.allowedIndexes.filter((i) => kindsAt(i).length > 0);
  if (usable.length === 0) {
    for (const d of declared) drops.push({ field, text: d.text, reason: "no legible mark colour survived this slide's kit and accent, so nothing is marked" });
    return plain();
  }

  const ranges = ctx.dir === "rtl" ? foreignRunRanges(text) : [];
  const totalWordChars = [...text].filter((c) => WORD_CHAR.test(c)).length;

  // ── Locate every declared span, then order by position (step 2).
  //
  // LONGEST FIRST, AND EACH AT ITS FIRST *FREE* OCCURRENCE. Both halves are
  // load-bearing and neither is tidiness:
  //
  //   - Longest first, because two spans that start at the same character are
  //     always an overlap and the accept loop keeps whichever it reaches
  //     first. Locating `AI` before `AI slop` marks two letters out of the
  //     middle of the phrase the model actually meant — the `SAID` defect one
  //     level up.
  //   - First FREE occurrence, because a term that genuinely appears twice in
  //     one field should be marked at its second appearance rather than
  //     dropped. With `AI slop is real, and AI wins` and both spans declared,
  //     scanning from 0 every time finds `AI` inside `AI slop`, and the
  //     standalone `AI` later in the line is lost to an overlap drop that
  //     names the wrong cause.
  //
  // The rule is written down here because implicit tie-breaking in a resolver
  // that also has to survive Hebrew is a bug waiting for a string nobody
  // tested.
  interface Located { start: number; end: number; declaredText: string }
  const located: Located[] = [];
  /** Character ranges already claimed by a longer span, so a later one skips past them. */
  const taken: { start: number; end: number }[] = [];
  const longestFirst = declared.map((d, index) => ({ d, index })).sort((a, b) => b.d.text.length - a.d.text.length || a.index - b.index);
  for (const { d } of longestFirst) {
    const needle = d.text;
    if (needle.trim().length === 0) {
      drops.push({ field, text: needle, reason: "the span is blank" });
      continue;
    }
    // The first occurrence no longer span has already taken — the same rule
    // the cross-field walk used to promise this span to this field.
    const at = freeOccurrence(text, needle, taken);
    if (at < 0) {
      // Two different failures, and they must not share a message. A span
      // that is ABSENT means the model invented a word — the one fact this
      // channel exists to report. A span whose every occurrence is already
      // inside a longer mark is a healthy overlap, and reporting it as
      // "does not occur" would send a reader looking for a typo that is not
      // there.
      const occursAtAll = boundedFirstOccurrence(text, needle) >= 0;
      drops.push({
        field,
        text: needle,
        reason: occursAtAll
          ? `every occurrence of the span in "${field}" overlaps a longer span that is already marked`
          : `the span does not occur in "${field}" on a word boundary — copy it verbatim out of the field`,
      });
      continue;
    }
    let start = at;
    let end = at + needle.length;

    // Step 5 — the RTL foreign-run boundary rule.
    if (ranges.length > 0) {
      const splitStart = splitsAForeignRun(ranges, start);
      const splitEnd = splitsAForeignRun(ranges, end);
      if (splitStart !== undefined) start = splitStart.start;
      if (splitEnd !== undefined) end = splitEnd.end;
      if (start !== at || end !== at + needle.length) {
        const extended = text.slice(start, end);
        if (wordCount(extended) > MAX_MARK_WORDS) {
          drops.push({
            field,
            text: needle,
            reason: `the span cuts a Latin run in "${field}" and extending it to that run's own boundary would pass ${MAX_MARK_WORDS} words — marking it would split one bidi isolate across two spans`,
          });
          continue;
        }
      }
    }

    if (wordCount(text.slice(start, end)) > MAX_MARK_WORDS) {
      drops.push({ field, text: needle, reason: `the span is longer than ${MAX_MARK_WORDS} words — a mark that long is a second sentence, not emphasis` });
      continue;
    }
    located.push({ start, end, declaredText: needle });
    taken.push({ start, end });
  }
  // Position order, and on a TIE the LONGER span first (RFC-17 §6.4's
  // "longest span first"). Two spans that start at the same character are
  // always an overlap, and the loop below keeps whichever it reaches first —
  // so `a.end - b.end` would keep `AI` out of `AI slop` and drop the span the
  // model actually meant. This is the `SAID` defect one level up.
  located.sort((a, b) => a.start - b.start || b.end - a.end);

  // ── Accept in position order, enforcing overlap / share / caps.
  const chosen: Located[] = [];
  let markedWordChars = 0;
  let accepted = 0;
  for (const span of located) {
    if (ctx.alreadyAccepted + accepted >= MAX_MARKS_PER_SLIDE) {
      drops.push({ field, text: span.declaredText, reason: `the slide already carries ${MAX_MARKS_PER_SLIDE} marks` });
      continue;
    }
    if (accepted >= MAX_MARKS_PER_FIELD) {
      drops.push({ field, text: span.declaredText, reason: `"${field}" already carries ${MAX_MARKS_PER_FIELD} marks` });
      continue;
    }
    const last = chosen[chosen.length - 1];
    if (last !== undefined && span.start < last.end) {
      drops.push({ field, text: span.declaredText, reason: `the span overlaps "${text.slice(last.start, last.end)}", which is already marked` });
      continue;
    }
    const spanWordChars = [...text.slice(span.start, span.end)].filter((c) => WORD_CHAR.test(c)).length;
    if (totalWordChars > 0 && (markedWordChars + spanWordChars) / totalWordChars > MAX_MARKED_SHARE) {
      drops.push({
        field,
        text: span.declaredText,
        reason: `marking it would take "${field}" past ${Math.round(MAX_MARKED_SHARE * 100)}% marked — a mark covering everything marks nothing`,
      });
      continue;
    }
    markedWordChars += spanWordChars;
    chosen.push(span);
    accepted++;
  }

  if (chosen.length === 0) return plain();

  // ── Split into alternating runs (step 6's first half), re-asserting each
  //    pairing at the point of emission.
  //
  // ── WHY A SECOND CHECK, WHEN ADMISSION ALREADY BOUND THE PAIR ────────────
  //
  // Belt and braces, grafted into RFC-20 from the competing spec. The
  // admission-time bound (`kindsByIndex` + `markRotation` drawing from the
  // selected colour's own set) is what makes an illegible pair impossible;
  // this is what makes it OBSERVABLE if it ever becomes possible again. The
  // two are separated by four function boundaries and a per-slide
  // recomputation of the ground, and the failure they guard against — a mark
  // painted at 1.02:1 — is exactly the kind that renders, ships and is noticed
  // by a client rather than by a test.
  //
  // A FAILURE HERE IS A DROP, NEVER A HOLD. It degrades that one span to plain
  // type and reports the fact through `collectEmphasisIssues`, which is the
  // posture the whole module takes ("budgets adapt, never hold"): a mark is
  // furniture, and furniture must not be able to fail a $1.00 run.
  const runs: MarkRun[] = [];
  let cursor = 0;
  /** Ordinals count marks actually PAINTED, so a drop here does not leave a hole in the rotation. */
  let painted = 0;
  for (const span of chosen) {
    if (span.start > cursor) runs.push({ text: text.slice(cursor, span.start) });
    const ordinal = ctx.alreadyAccepted + painted;
    const rotated = markRotation(ctx.seed, ordinal, usable, rotationKinds);
    const refusal = rotated === undefined ? "the rotation found no drawable slot for this slide" : pairRefusal(ctx, rotated);
    if (rotated === undefined || refusal !== undefined) {
      drops.push({ field, text: span.declaredText, reason: `${refusal} — the span renders as plain type` });
      runs.push({ text: text.slice(span.start, span.end) });
    } else {
      runs.push({ text: text.slice(span.start, span.end), mark: { ordinal, ...rotated } });
      painted++;
    }
    cursor = span.end;
  }
  if (painted === 0) return plain();
  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return { runs, accepted: painted, drops };
}

/**
 * `undefined` when this (colour, kind) pair clears its OWN kind's floor
 * against the ground the slide actually renders on; otherwise the reason it
 * does not, in the form a `MarkDrop` quotes.
 */
function pairRefusal(ctx: SlideMarkContext, rotated: { colourIndex: number; kind: MarkKind }): string | undefined {
  // No hexes and no pair means the caller did not ask for this check — see
  // `SlideMarkContext.hexes`. The admission-time bound is unaffected.
  if (ctx.hexes === undefined || ctx.groundHex === undefined || ctx.fgHex === undefined) return undefined;
  const hex = ctx.hexes[rotated.colourIndex];
  if (hex === undefined) return `ring slot ${rotated.colourIndex} has no colour`;
  const capable = markCapabilitiesFor(hex, ctx.groundHex, ctx.fgHex, { refuseBlock: ctx.refuseBlock });
  if (capable.includes(rotated.kind)) return undefined;
  return `${hex} cannot be drawn as \`${rotated.kind}\` on ${ctx.groundHex}/${ctx.fgHex} (it carries ${capable.length > 0 ? capable.join(", ") : "no kind at all"})`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter((w) => w.length > 0).length;
}

// ─────────────────────────────────────────────────────────────────────────
// The fragment
// ─────────────────────────────────────────────────────────────────────────

/**
 * The runs of one field as one `{{html:...}}` fragment.
 *
 * ── EVERY RUN IS WRAPPED. THIS IS MANDATORY, NOT TIDINESS. ───────────────
 *
 * `probePage` counts a text-bearing LEAF as an element with words and no
 * element children (`render-carousel.ts:455-462`). Wrapping only the marked
 * runs would leave
 *
 *     <h1 class="headline">Plot <span class="mk ...">twist</span>.</h1>
 *
 * where the `h1` has an element child and is no longer a leaf, while `Plot `
 * and `.` sit in no leaf at all. Two things then break silently: the `h1`'s
 * box stops counting toward `textBoxShare` (clause G limb 2, floor 0.01), and
 * its family stops entering `fontFamiliesUsed` — which is the ONLY proof a
 * Phase 0 script font actually loaded. Wrapping every run puts every text
 * node back inside a leaf and both measurements recover.
 *
 * The classes are split so the probe can count what it means to count: a
 * MARKED run carries `.mk`, an unmarked one carries `.mk-t` and paints
 * nothing. If both carried `.mk`, then `markRuns > 0 && markRunsPainted === 0`
 * — the `marks-missing` clause — would fire on every slide whose fields
 * happen to be wrapped but unmarked, which is most of them.
 *
 * Order inside each run: split (already done) → ISOLATE → ESCAPE. Isolating
 * the whole field before splitting would put an FSI on one side of a span
 * boundary and its PDI on the other; escaping before isolating would let the
 * isolate characters land inside an entity.
 */
export function buildMarkedRuns(runs: readonly MarkRun[], dir: "rtl" | "ltr"): string {
  if (runs.length === 0) return "";
  if (!runs.some((r) => r.mark !== undefined)) return "";
  return runs
    .map((run) => {
      const inner = esc(isolateForeignRuns(run.text, dir));
      if (run.mark === undefined) return `<span class="mk-t">${inner}</span>`;
      return `<span class="mk mk-c${run.mark.colourIndex + 1} mk-k-${run.mark.kind}">${inner}</span>`;
    })
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────
// The stylesheet
// ─────────────────────────────────────────────────────────────────────────

/** `script-fonts.ts`'s own name for the one script whose mark geometry differs. Imported read-only; this module never edits that file. */
const HEBREW_SCRIPT = "Hebrew";

/**
 * The shared mark stylesheet, delivered through `extraHeadHtml` — the same
 * channel `deviceCssBlock()` uses, so it reaches a brandless client too.
 *
 * ── EVERY SIZE IS IN `em`, NEVER `px` ────────────────────────────────────
 *
 * `--ts` scales `font-size` on every template, so an `em`-based mark scales
 * at `s`, `m` and `l` for free and there is no second ladder to keep in sync
 * with the type ladder. A source scan pins this.
 *
 * ── THE MARK DOES NOT BLEED, AND THAT IS WHY THE MEASURE CANNOT MOVE ──────
 *
 * This block used to carry `padding-inline: .06em` against
 * `margin-inline: -.06em` and the claim that the pair "returns exactly what
 * the padding took". It does — FOR A MARK THAT DOES NOT WRAP, which is the
 * one case the claim did not consider.
 *
 * `box-decoration-break: clone`, immediately below, is mandatory and it
 * duplicates the padding onto EVERY line fragment, while the margins apply
 * only at the box's two outer edges. A mark broken across a line break
 * therefore keeps `2 x bleed` of measure that nothing gives back, once per
 * wrap — and that is enough to tip a full line. Measured on real Chromium:
 * a three-mark headline at fontScale `l` took one line MORE than the same
 * copy unmarked on `cover.html` and `slide.html`, and the extra line pushed
 * the block past its column — a HARD `clipped` finding from interest-floor
 * clause B, not a warning. Shrinking the bleed only moved the cliff: at
 * `.03em` the same defect reappeared on `slide.html` with the LONG fixture at
 * `textAlign: end`. There is no value that is both non-zero and safe, because
 * the liability is proportional to how full the line already was.
 *
 * So the bleed is GONE, and almost nothing goes with it. Four of the five
 * kinds set `background-size: 100%` against a `content-box` origin, so they
 * never painted into that padding at all — the pair was doing nothing for
 * them but adding width. Only `swish` used it, and only as a clipped sliver
 * of its 112% ellipse; `swish` now sizes its ellipse to 100%, so its taper
 * falls inside the run and reads as a stroke thinning at both ends, which is
 * what `rf-05 S8` actually shows. What `block` loses is a ~5px side overshoot
 * on a pale kit — the one real cost, and it is worth paying for a mark that
 * can never change the layout it was only supposed to decorate.
 *
 * ── `box-decoration-break: clone` IS THE WHOLE TRICK ──────────────────────
 *
 * `rf-05 S3`'s chartreuse runs across `Messy,` at the end of one line and
 * resumes on `crossed out` at the start of the next. Without `clone` the mark
 * is ONE box spanning the wrap and paints straight through the gutter.
 *
 * ── LOGICAL PROPERTIES ONLY, AND NO `text-decoration` ────────────────────
 *
 * No `left`/`right` anywhere, so `dir="rtl"` mirrors every mark on its own
 * and there is no second stylesheet for Hebrew to drift from this one — the
 * rule `slide-devices-rtl.test.ts` already pins for devices.
 *
 * WITH ONE EXCEPTION THAT THE SCAN USED TO MISS: a gradient ANGLE is a
 * physical direction too, and `left:`/`right:` scans do not see it. `ink`'s
 * two-stop ramp carried a literal `100deg`, so on a Hebrew run every
 * glyph-fill mark ramped in the Latin reading direction — and `ink` is
 * precisely the kind the bundled `#17181C` ground is forced onto, `block`
 * being refused there. The angle is now `var(--mk-ink-angle)`, flipped to its
 * reflection under `[dir="rtl"]`, and the source scan refuses any literal
 * `deg` outside that one property's two declarations. `text-decoration`
 * is deliberately unused for every kind: its skip-ink and offset behaviour
 * differs across scripts, and it cannot draw the swish or the double at all.
 *
 * ── NO INLINE `style=` ───────────────────────────────────────────────────
 *
 * `assertSafeMarkup` refuses it, correctly. The ring's values reach the
 * document through the six `.mk-c*` classes this block emits.
 */
export function markCssBlock(script?: string | undefined, ring?: MarkRing | undefined): string {
  const isHebrew = script === HEBREW_SCRIPT;
  const values = ring?.cssValues ?? [];
  const colourClasses = Array.from({ length: MARK_RING_MAX }, (_, i) =>
    // `var(--accent)` is the fallback ONLY so this block is well-formed with
    // no ring. It is unreachable in a render: an empty ring emits no marks at
    // all, so no element ever carries a `.mk-c*` class in that case.
    `.mk-c${i + 1} { --mk-c: ${values[i] ?? "var(--accent)"}; }`,
  ).join("\n");

  return `<style>
/* instagram-agent marked emphasis (RFC-17 §5.3) — built by emphasis-marks.ts. */
:root {
  /* The swatch's height, and how far its top sits below the em box's top.
     Latin ascenders stand clear above it — the reference's own geometry
     (rf-11: the swatch covers the baseline and roughly the lower 60% of the
     cap). Starting values, calibrated in CI by the band sweep. */
  --mk-block-h: .50em;
  --mk-block-y: .56em;
  /* WHERE THE BASELINE ACTUALLY IS, MEASURED, because every offset here is
     measured from an INLINE box's content-box top (that is what
     background-origin: content-box gives) and that is NOT the top of a 1em
     box. The content area is the font's ascent+descent — 1.225 to 1.242em for
     Fraunces across the four display hosts, measured in Chromium with the
     real webfonts loaded — and the baseline sits 0.975 to 0.985em down it.
     The comment that used to sit here said "just under the baseline of a 1em
     box", and the constant below it was chosen against that wrong model. */
  --mk-rule-y: .92em;
  /* The marker stroke, and the one constant the wrong model actually broke.
     At .78em the .20em band ran [.78em, .98em] — it ENDED at the baseline and
     covered the bottom fifth of the letterforms, so on the cover and the
     closer it read as a smear THROUGH the type rather than a stroke under it.
     Measured on the rendered PNG before this change: the band occupied
     y=1776..1808 while that line's ink ran y=1684..1809, with ZERO pixels
     below the baseline. At .96em the band runs [.96em, 1.16em] and the
     ellipse's solid core (opaque to 60% of a .10em radius, transparent by
     74%) runs [1.00em, 1.12em] — entirely BELOW the 0.978em baseline, which
     is what rf-05 S8's pink and blue strokes do. */
  --mk-swish-y: .96em;
  /* THE ONE PHYSICAL DIRECTION IN THIS BLOCK, and it is a custom property so
     it can be flipped rather than duplicated. \`ink\`'s two-stop ramp runs
     across the glyphs, so it has a reading direction; a \`deg\` angle does NOT
     mirror under \`dir="rtl"\` the way every logical property here does, and
     \`ink\` is the kind our default #17181C ground is forced onto — so without
     the flip below EVERY glyph-fill mark on a Hebrew run ramps in the LATIN
     reading direction. 260deg is 100deg reflected about the vertical axis
     (360 - 100), which is the same ramp read right-to-left. */
  --mk-ink-angle: 100deg;
  /* The twin host's block-start bleed, as a PROPERTY rather than a literal so
     the Hebrew branch can move it without needing a second selector that
     would then have to win a specificity race against the copy each bundled
     template carries. Latin (Fraunces) overshoots its block by at most
     0.0865em; Heebo and Assistant reach 0.1926em, which .14em does not cover
     — measured, 18 renders a script. See the rule further down. */
  --mk-twin-bleed: .14em;
}
[dir="rtl"] { --mk-ink-angle: 260deg; }
${isHebrew ? HEBREW_GEOMETRY : ""}/* ── THE TWIN HOST'S BLOCK-START BLEED, AND IT IS NOT COSMETIC. ──
   The mirror of the \`padding-block-end: .22em\` every display host in
   \`assets/templates/default\` already carries, and it is here for the same
   measured reason, one axis over.

   An INLINE box's border box is the FONT's content area (ascent + descent),
   not its line box. Fraunces' content area measures ~1.25em while these hosts
   set line-height 1.04-1.30, so a \`<span>\` wrapping a display line starts
   ABOVE its block's content box — and \`probePage\`'s block-start limb
   (\`render-carousel.ts:521\`, \`rect.top < parentRect.top - 2\`) correctly
   reports that as an overflowing element, which interest-floor clause B turns
   into a HARD \`clipped\` finding. Before RFC-17 the copy was a bare text node,
   so there was no element to ask; the twin pair made it an element and, with
   it, made cover, headline_focus and closer fail the floor on the plain
   production path with no fragment involved at all. Measured: 20 of 36
   renders (6 templates x s/m/l x ltr/rtl) spilled, 0 of 36 with this rule.

   THE VALUE IS PER-SCRIPT AND IT IS A PROPERTY, not a literal. Fraunces
   overshoots at most 0.0865em, so Latin takes .14em (1.6x). The Phase-0
   Hebrew faces, Heebo and Assistant, reach 0.1926em — measured over the same
   six templates x s/m/l with the script sheet actually loaded — and at .14em
   12 of those 18 renders spilled. Hebrew therefore takes .22em, set on
   \`--mk-twin-bleed\` in \`HEBREW_GEOMETRY\` rather than through a second
   selector that would have to out-specify the copy each template carries.

   THE var() FALLBACK IS .22em, NOT .14em, AND THE ASYMMETRY IS THE POINT. A
   document composed without this sheet has no \`--mk-twin-bleed\` and no way to
   know its own script, so the fallback has to be the value that is safe for
   BOTH — and that is the larger one. \`bidi-isolation.test.ts\` renders exactly
   that document (a Hebrew cover through the script-font head alone) and it is
   what found this: a .14em fallback put \`span.mk-runs, span.mk-plain\` back in
   \`probe.overflowing\`. In production this sheet is always spliced, so Latin
   is always pulled back down to .14em and pays nothing for the safer default.
   In \`em\` throughout, so it tracks \`--ts\` like everything else here.

   NOT paired with a negative \`margin-block-start\`: that was tried, and
   it simply moves the escape up one level — the HOST's own border box then
   starts above ITS parent and \`div.hf-headline\` spills instead of
   \`span.mk-runs\`. The tolerance is deliberately not widened: the limb is
   reporting a true geometric fact, and it is the limb that caught the
   headline-focus 155px escape.

   THIS COPY IS THE SAFETY NET, NOT THE HOME. Each of the six bundled
   templates carries the identical rule in its own stylesheet, because a
   template has to be correct WITHOUT this sheet: \`template-mark-slots.test.ts\`
   renders a marked document with no mark stylesheet at all — that is how it
   proves a marked plate is pixel-identical to an unmarked one — and with the
   rule living only here, 22 of those renders came back overflowing. Real
   Chromium said so; the sheet-only version looked fine in every probe that
   spliced the sheet. What this copy buys is the studio and custom-archetype
   path, where a template nobody in this repo wrote may adopt the twin pair.
   Same property, same value, so the two can never disagree — and if they ever
   do, the template's own rule wins on specificity, which is the right way
   round.

   On the host of the PLAIN twin, so it applies whether or not a mark fragment
   arrived: the unmarked render spilled too. */
:has(> span.mk-plain) { padding-block-start: max(var(--mk-twin-bleed, .22em), var(--mk-face-bleed, 0em)); }
/* An UNMARKED run. It paints nothing and changes no metric — it exists only
   so that no text node is ever stranded outside a text-bearing leaf. See
   buildMarkedRuns. */
.mk-t { }
/* A MARKED run. This is the class the probe counts. */
.mk {
  /* One mark may span a line break. */
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  /* NO inline padding and no negative margin to cancel it. See the header:
     an inline-axis bleed cannot be made measure-neutral under \`clone\`, and
     it was buying almost nothing. A mark's box is now exactly the glyph
     advance, so a marked field occupies the same measure as an unmarked one,
     always, and not merely when no mark wraps. */
  /* Every kind draws with a background IMAGE, never a background shorthand:
     the probe's painted limb reads \`backgroundImage !== "none"\`, and a
     gradient is the only way to place a band at a chosen height. */
  background-repeat: no-repeat;
  background-origin: content-box;
}
${colourClasses}
/* block — a highlighter swatch behind the run, sitting LOW over the baseline.
   Refused in code on a ground darker than the ink, and on quote_card's
   italic, where the background box is a parallelogram the CSS cannot follow. */
.mk-k-block {
  background-image: linear-gradient(var(--mk-c), var(--mk-c));
  background-size: 100% var(--mk-block-h);
  background-position-y: var(--mk-block-y);
}
/* On a DARK ground the block is the whole run and the run's ink is the
   ground: the Karos Labs feed's orange slab with the phrase in black. The
   admission check measures exactly this pair (the ground on the mark). */
body[data-tone="dark"] .mk-k-block {
  color: var(--bg);
  background-size: 100% 92%;
  background-position-y: 55%;
}
/* underline — one pencil rule, UNDER THE BASELINE OF WHATEVER FACE DREW IT.
   2026-09-23: it used to be a background band at \`--mk-rule-y\` below the
   inline box's top, calibrated on Fraunces and Heebo. On Geektime's Inter
   heading with Hebrew falling back to Heebo (prep \`pubsub-21770129683022110\`)
   the same offset landed 80% of the way down the letters, and "נעלמו"
   ("disappeared") read as struck through, which says the opposite. A text
   decoration is placed from the BASELINE by the browser, in every face. */
.mk-k-underline {
  text-decoration-line: underline;
  text-decoration-color: var(--mk-c);
  text-decoration-thickness: .07em;
  text-underline-offset: .12em;
  text-decoration-skip-ink: none;
}
/* swish — a marker stroke, thick in the middle, TAPERING at both ends.
   Centred on both axes so it mirrors under dir="rtl" without a second rule.
   100%, not 112%: with the inline bleed gone there is no padding for the
   extra 12% to paint into, so it was clipped square at the run's own edges —
   the ellipse's fade was the part being thrown away. At 100% the taper is
   inside the run and visible, which is the reference's own shape. */
.mk-k-swish {
  background-image: radial-gradient(ellipse 60% 100% at 50% 50%, var(--mk-c) 60%, transparent 74%);
  background-size: 100% .20em;
  background-position: center var(--mk-swish-y);
}
/* double — two rules, baseline-relative for the reason underline is. */
.mk-k-double {
  text-decoration-line: underline;
  text-decoration-style: double;
  text-decoration-color: var(--mk-c);
  text-decoration-thickness: .05em;
  text-underline-offset: .12em;
  text-decoration-skip-ink: none;
}
/* ink — the run's GLYPHS take the mark colour, as a two-stop gradient.
   This is rf-6's mechanism and our default #17181C ground's answer: a pastel
   swatch behind near-white ink is illegible, and the reference set already
   shows what a dark ground does instead. The second stop is a same-hue lift
   toward the ink, in-kit by construction. */
.mk-k-ink {
  background-image: linear-gradient(var(--mk-ink-angle), var(--mk-c), color-mix(in srgb, var(--mk-c) 68%, var(--fg)));
  background-size: 100% 100%;
  background-position-y: 0;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
}
</style>`;
}

/**
 * Hebrew geometry, SET rather than inherited.
 *
 * Hebrew has no ascenders and a full-height letter body, so a Latin block at
 * `.50em/.56em` would cover the glyphs rather than sit under them, and the
 * underline family has to come up to meet a baseline that carries the whole
 * letter. **Hebrew keeps all five kinds** — first-class, not degraded.
 *
 * These are STARTING VALUES, to be corrected by the CI band sweep against
 * measured cap height, not guessed once and left (RFC-17 §5.3, test 12).
 */
const HEBREW_GEOMETRY = `/* Hebrew (Phase 0 script fonts): no ascenders, full-height letter body — so
   the BLOCK swatch, which is sized to the letter body, is shorter and sits
   lower. The two BASELINE-relative constants are deliberately NOT restated:
   a rule and a marker stroke sit under the baseline, and the baseline
   measures 0.976em from the inline content-box top in Hebrew exactly as it
   does in Latin (measured in Chromium on all four display hosts). Restating
   them was how --mk-swish-y came to carry TWO wrong values instead of one:
   .82em put the Hebrew stroke [.82em, 1.02em], the same smear-through-the-
   type the Latin .78em produced. Inheriting is the fix and the guard. */
:root {
  --mk-block-h: .44em;
  --mk-block-y: .60em;
  /* Measured over six templates x s/m/l with the Phase-0 Hebrew faces actually
     loaded: the worst twin overshoot is 0.1926em (list-takeaway at s, Heebo)
     against 0.0865em for Fraunces, because these faces carry far more ascent
     and descent than their line-heights allow for. At the Latin .14em, 12 of
     those 18 renders spilled and the Hebrew calibration case failed on
     cover.html with a hard clipped finding. */
  --mk-twin-bleed: .22em;
}
`;

// ─────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────

/** One reportable fact about this run's emphasis. Facts, never findings. */
export interface EmphasisIssue {
  slide: number;
  field: string;
  text: string;
  reason: string;
}

/**
 * Everything this run's emphasis could not do, as facts.
 *
 * The same posture `collectDeviceIssues` takes, and for the same reason: a
 * mark is FURNITURE, and a redraft loop over furniture would spend the whole
 * self-check budget on a slide whose copy was fine. `resolveSlideMarks`
 * drops; this is how the drop becomes visible on the gate payload and in the
 * run trace instead of being silent.
 *
 * **This never gates.** A drop reported here raises no finding, fails no
 * clause, and cannot hold a run.
 */
export function collectEmphasisIssues(
  perSlide: readonly { slide: number; drops: readonly MarkDrop[] }[],
  ringNotes: readonly string[] = [],
): EmphasisIssue[] {
  const issues: EmphasisIssue[] = [];
  for (const note of ringNotes) issues.push({ slide: 0, field: "ring", text: "", reason: note });
  for (const row of perSlide) {
    for (const drop of row.drops) issues.push({ slide: row.slide, field: drop.field, text: drop.text, reason: drop.reason });
  }
  return issues;
}


// -------------------------------------------------------------------------
// The wire form: a flat array of verbatim spans, and the walk that routes it
// -------------------------------------------------------------------------

/**
 * One field of a slide, as the span search sees it.
 *
 * `field` is the REPORTING name (`"headline"`, `"body"`, `"quote"`,
 * `"item[2]"`) and is what a drop is reported against; `text` is the model's
 * ORIGINAL string for that field, before `iso()` and before `esc()`.
 */
export interface MarkField {
  field: string;
  text: string;
}

/**
 * The first bounded occurrence of `needle` in `haystack` that does not overlap
 * a range already claimed, or `-1`.
 *
 * ONE rule, called from BOTH the cross-field walk and `resolveSlideMarks`, so
 * the field that promises a span and the resolver that places it can never
 * disagree about which occurrence they meant. Two copies of this scan is the
 * drift `foreignRunRanges` refuses to introduce for the same reason.
 */
function freeOccurrence(haystack: string, needle: string, claimed: readonly { start: number; end: number }[]): number {
  let at = boundedFirstOccurrence(haystack, needle);
  while (at >= 0 && claimed.some((c) => at < c.end && at + needle.length > c.start)) {
    at = boundedFirstOccurrence(haystack, needle, at + 1);
  }
  return at;
}

/**
 * Validate the declared spans, dropping -- never failing on -- anything
 * unusable, and de-duplicating.
 *
 * The wire form is a FLAT ARRAY OF VERBATIM SPANS (RFC-17 6.4):
 * `["Business", "Founder", "Know"]`. No field name, no row index, no tag.
 *
 * ## WHY THERE IS NO FIELD NAME HERE, AND WHY THAT IS A CORRECTNESS WIN
 *
 * The schema carried `{field, itemIndex?, text}` until the design-system
 * phase, and a tagged string form (`"h:Anti-AI"`) was written and then
 * refused. Both are recorded in `SlideEmphasisSchema`'s own comment because
 * this is where the next reader will propose bringing one back. The short
 * version: **a field the model can name is a field it can get WRONG, and the
 * failure is SILENT.** `{"field":"body","text":"Runway"}` when `Runway` sits
 * in `item[2]` resolves to nothing -- the mark is simply absent, no gate
 * fires, because marks are furniture and furniture never holds a run. A
 * SEARCH cannot name the wrong field. The tag form is the same defect at a
 * lower price, and a Latin tag in front of a Hebrew span is new bidi surface
 * on every RTL mark besides.
 *
 * It is also what keeps a cold Hebrew run at three drafting attempts
 * (`copyAttempt` 0.181, not 0.184) -- but that is the fourth reason, not the
 * first.
 *
 * DE-DUPLICATION is not tidiness. A span is claimed by exactly one field, at
 * exactly one position, so a repeated declaration could only ever produce a
 * drop ("overlaps something already marked") that says nothing useful. The
 * repeat is silently collapsed instead, because the model asking twice for
 * the same emphasis is asking for the emphasis it already has.
 */
export function normaliseEmphasis(emphasis: SlideEmphasis | undefined): { spans: string[]; drops: MarkDrop[] } {
  const spans: string[] = [];
  const drops: MarkDrop[] = [];
  if (emphasis === undefined) return { spans, drops };

  const seen = new Set<string>();
  for (const raw of emphasis) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text.length < 2) {
      drops.push({ field: "emphasis", text: String(raw), reason: "the span is blank or a single character" });
      continue;
    }
    if (text.length > MAX_MARK_CHARS) {
      drops.push({ field: "emphasis", text, reason: `the span is ${text.length} characters -- a mark longer than ${MAX_MARK_CHARS} is a sentence, not emphasis` });
      continue;
    }
    if (seen.has(text)) continue;
    seen.add(text);
    spans.push(text);
  }
  return { spans, drops };
}

/**
 * Route each declared span to the ONE field that will paint it.
 *
 * The whole mechanism the flat wire form buys, and the reason it is not
 * merely cheaper than a field name: this is a SEARCH, and a search cannot
 * resolve to the wrong field.
 *
 * Two rules, both load-bearing:
 *
 * 1. **LONGEST SPAN FIRST** (RFC-17 6.4). `rf-05 S1` marks both `AI slop` and
 *    (elsewhere) `AI`. Searched in the model's own order, a short span can
 *    claim the opening of a longer one and the longer one is then dropped as
 *    an overlap -- the reader gets `AI` marked out of `AI slop`, which is the
 *    `SAID` defect wearing a different hat. Claiming the longest first makes
 *    the outcome independent of the order the model happened to emit.
 *
 * 2. **READING ORDER, FIRST FIELD WINS.** `headline`, `body`, `quote`, then
 *    the list rows -- the order the eye takes them in, so a term that genuinely
 *    appears twice is marked where it is first read.
 *
 * A span that occurs in NO field is dropped here with a reason naming the
 * whole slide, which is the honest report: it is not "missing from the body",
 * it is missing from the post. Nothing here can fail a run.
 */
export function assignSpansToFields(
  fields: readonly MarkField[],
  spans: readonly string[],
): { byField: Map<string, string[]>; drops: MarkDrop[] } {
  const byField = new Map<string, string[]>();
  const drops: MarkDrop[] = [];
  for (const f of fields) byField.set(f.field, []);

  /**
   * What each field has already promised to a longer span.
   *
   * THIS SET EXISTS SO THE WALK DOES NOT POISON ITS OWN INSTRUMENT, and that
   * is worth stating because the cheap version looks equivalent. Without it,
   * routing has to ask each field in turn "is this span here?" and report a
   * drop every time the answer is no — so a perfectly healthy four-mark slide
   * spread across four fields records a dozen "not in this field" facts into
   * `collectEmphasisIssues`, which is the ONE channel that reports genuine
   * mark failures. That does not merely add noise: it buries the real drop
   * where nobody will find it.
   *
   * A span is claimed ONCE, by the first field in reading order that has a
   * free occurrence of it, and only a span claimed by NO field is reported.
   */
  const claimed = new Map<string, { start: number; end: number }[]>();

  // Longest first, ties broken by the model's own order so the walk stays
  // deterministic on two spans of equal length.
  const ordered = spans.map((text, index) => ({ text, index })).sort((a, b) => b.text.length - a.text.length || a.index - b.index);

  for (const { text } of ordered) {
    // Reading order, first field with a FREE occurrence wins. "Free" rather
    // than merely "present" so that a term a longer span already covers falls
    // through to the next field instead of being dropped as an overlap later.
    const target = fields.find((f) => freeOccurrence(f.text, text, claimed.get(f.field) ?? []) >= 0);
    if (target === undefined) {
      drops.push({ field: "slide", text, reason: `"${text}" does not appear on this slide on a word boundary -- copy a mark verbatim out of the copy you just wrote` });
      continue;
    }
    const taken = claimed.get(target.field) ?? [];
    const at = freeOccurrence(target.text, text, taken);
    taken.push({ start: at, end: at + text.length });
    claimed.set(target.field, taken);
    byField.get(target.field)!.push(text);
  }
  return { byField, drops };
}
