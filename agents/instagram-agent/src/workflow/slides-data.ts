import type { AgentContext, AgentToolRegistry, GateVerdict } from "@agent-engine/core";
import { WorkflowToolingFailure } from "@agent-engine/workflow";
import type { RenderCarouselInput, Slide } from "@agent-engine/tool-karos-publish";
import { templateFileName } from "@agent-engine/tool-karos-templates";
import { isolateForeignRuns } from "./bidi-isolate.js";
import { contrastRatio, paletteForSlide } from "./brand-render-tokens.js";
import { noteGateOutage } from "./craft-hygiene.js";
import {
  buildMarkRing,
  buildMarkedRuns,
  collectEmphasisIssues,
  assignSpansToFields,
  normaliseEmphasis,
  resolveSlideMarks,
  ringIndexesFor,
  slideMarkKinds,
  slideMarkSeed,
  type EmphasisIssue,
  type MarkDrop,
  type MarkField,
  type MarkKind,
  type MarkRing,
} from "./emphasis-marks.js";
import { buildDeviceFragment, deviceFigureValues, validateDevice, type SlideDevice } from "./slide-devices.js";
import { imageTreatmentFields, type ImageTreatment } from "./style-lock.js";
import type {
  BrandTokens,
  ImageSelection,
  InstagramCopyOutput,
  InstagramSlideCopy,
  InstagramSlideLayout,
  ResearchOutput,
  StyleConfig,
} from "./types.js";

/**
 * Which template file each archetype renders through.
 *
 * `photo` and `text_only` both resolve to the client's own configured
 * `slideTemplate` — that file renders correctly with or without a hero image
 * (see its doc comment), and it is the guaranteed-delivery floor, so it stays
 * exactly where it was. The five ported archetypes have their own files in the
 * same `templateDir`, so a client with a bespoke `templateDir` needs the whole
 * set present to use them; `LAYOUT_TEMPLATE_FILES` is the list to copy.
 */
const LAYOUT_TEMPLATE_FILES: Record<Exclude<InstagramSlideLayout, "photo" | "text_only" | "custom">, string> = {
  stat_callout: "stat-callout.html",
  quote_card: "quote-card.html",
  comparison_card: "comparison-card.html",
  list_takeaway: "list-takeaway.html",
  headline_focus: "headline-focus.html",
  // Phase 2, item M. Adding them here extends `ARCHETYPE_TEMPLATE_FILES`
  // (and therefore every "does this client's templateDir hold the archetype
  // set" check) automatically, which is the point of deriving that list from
  // this record rather than declaring it twice.
  cover: "cover.html",
  closer: "closer.html",
};

/**
 * RFC-17 §5.4 — the archetypes that paint NO marks, whatever the copy
 * declares.
 *
 * Their content is a figure and two labels, or two short columns under a pair
 * of one-word headings. A highlighter stroke on furniture is not emphasis; it
 * is decoration pretending to be meaning, and both plates are already the
 * densest in the set. `contentFor` returns `htmlFragments: {}` for both, so
 * `markRuns` is never reached — this constant is what lets the loss be
 * REPORTED instead of merely happening, and it is read by
 * `__tests__/emphasis-archetype-coverage.test.ts`, which pins the gap so it
 * cannot widen silently.
 */
const UNMARKED_LAYOUTS: ReadonlySet<string> = new Set(["stat_callout", "comparison_card"]);

function templateForLayout(layout: InstagramSlideLayout, slide: InstagramSlideCopy, clientTemplate: string): string {
  if (layout === "photo" || layout === "text_only") return clientTemplate;
  if (layout === "custom") return templateFileName(slide.customArchetype!.archetypeId);
  return LAYOUT_TEMPLATE_FILES[layout];
}

/** The seven archetype template filenames, for a caller checking which of them a `templateDir` actually holds. */
export const ARCHETYPE_TEMPLATE_FILES: readonly string[] = Object.values(LAYOUT_TEMPLATE_FILES);

/**
 * The layouts that consume a hero photograph.
 *
 * `cover` joins `photo` here (Phase 2, item M) and this set is the single
 * source of truth for it, because the same fact is read in two places that
 * must never disagree: the workflow's `photoSlideNs` (which decides whether
 * a slide is worth paying to source an image for) and `assembleSlidesData`
 * below (which decides whether to attach the sourced path). A cover that was
 * missing from the first list would never be offered a photograph, and would
 * then degrade for want of one — a self-fulfilling downgrade.
 *
 * `cover.html` still renders correctly with no hero (a graphic ground takes
 * over), so membership here buys image SOURCING, never a dependency on the
 * sourcing succeeding.
 */
/**
 * ── WIDENED 2026-09-15 (RFC-21 Part 2): PANELS CARRY PICTURES NOW. ──
 *
 * This was `photo` and `cover` — the only two archetypes whose templates
 * declared an `{{image:hero}}` slot — and the consequence was measured on
 * `thepitchbydeel` pubsub-21559620763659451: **8 slides, 0 images**, because a
 * draft that reaches for structured panels sourced nothing at all. The owner:
 * *add image slots and sometimes use striking images in other layouts too, so
 * we are not limited to cover and slide.html.*
 *
 * `stat_callout` and `quote_card` now declare `.sc-figure-band` — a BOUNDED
 * band, not a background. The distinction is the whole design: a full-bleed
 * photograph behind a panel puts its type on an uncontrolled ground (the
 * contrast gate can promise nothing over a picture) and re-introduces the
 * full-frame layer RFC-20 §11.1 spent a phase removing. A band sits beside the
 * content and owns every share it moves.
 *
 * ── AND THEN COMPARISON AND LIST JOINED THEM. ──
 *
 * They were left out on the argument that two columns need two pictures to
 * stay symmetrical and a rows panel has no room. **That was about taste, not
 * about possibility**, and the measurement settled it: at the cover role with
 * their textures deleted these two report a hole exactly as `quote_card` did
 * (CI 34996343379, `quote_card @ first`: `LER` 23.9% against a 22% ceiling,
 * `iod` 2.7% against 10%). A band ABOVE the columns or above the rows is the
 * same bounded object the other two carry, in the same place, and it answers
 * the hole with a picture rather than with a lower ceiling.
 *
 * `headline_focus` and `text_only` stay out: they carry the bounded OBJECT
 * instead (RFC-20 §11.4) and a photograph would compete with it.
 */
export const HERO_IMAGE_LAYOUTS: ReadonlySet<InstagramSlideLayout> = new Set<InstagramSlideLayout>([
  "photo",
  "cover",
  "stat_callout",
  "quote_card",
  "comparison_card",
  "list_takeaway",
]);

/**
 * Which layouts declare a `{{html:device}}` slot, so a device on a slide
 * actually reaches the pixels.
 *
 * `closer` is deliberately absent: it declares `{{html:recap}}` instead, and
 * `contentFor` routes a closer's device into that slot when there is no
 * recap to build (see `buildRecapFragment`) — one elastic middle, two
 * possible code-built fragments, rather than two slots competing for the
 * same space. Every OTHER bundled archetype is absent because its own
 * template has no device slot, and emitting a fragment nothing renders would
 * let `default:numbers-are-devices` pass on a figure the reader never sees.
 *
 * ── `text_only` JOINED THIS SET WITH THE BOUNDED OBJECT (RFC-20 §11.4). ──
 *
 * `slide.html` now declares a `.sl-device` slot on its HEROLESS path, which
 * is the path `text_only` always takes, and `bounded-object.ts` composes the
 * figure that fills it. Before that this archetype had no way to carry a
 * subject at all: RFC-20 §11.2 measured it at `occupiedShare` 0.0383–0.0942
 * with `flatBackgroundShare` 0.92–0.97, which is type on ground and nothing
 * else, and the phase covered for it with a full-plate hatch instead of an
 * object (§11.1 is what that cost).
 *
 * **`photo` is NOT in the set even though it renders the same file**, and the
 * asymmetry is the point rather than an oversight: a `photo` slide's subject
 * is its photograph. Its device slot would sit under a hero that covers the
 * frame, which is the "fragment nothing renders" case above, one archetype
 * over. A `photo` slide that loses its picture is reassigned to `text_only`
 * before assembly (`InstagramSlideLayoutSchema`), so the heroless plate gets
 * its object through the membership that names it.
 */
const DEVICE_SLOT_LAYOUTS: ReadonlySet<InstagramSlideLayout> = new Set<InstagramSlideLayout>(["cover", "headline_focus", "text_only"]);

/**
 * How many earlier slides a `closer` needs before its recap strip is worth
 * building. Two plates is the smallest thing that reads as a recap; one is
 * just a repeated slide.
 */
export const MIN_RECAP_PLATES = 2;
/** The most plates the strip holds — four 240px plates across a 952px content column, which is where they stop being readable. */
export const MAX_RECAP_PLATES = 4;
/** Where a recap plate's title is cut. Longer than this and the plate stops being a glance. */
export const MAX_RECAP_PLATE_CHARS = 40;

/**
 * The ground treatment a token-driven archetype paints behind its copy
 * (Phase 2, item M.3).
 *
 * `"grid"` is an accent geometric field (a hairline grid plus one solid
 * accent block on a frame edge); `"glyph"` is a very-low-contrast
 * display-face numeral bleeding off the top-inline-start corner. The grid is
 * the CSS DEFAULT in the templates, so a checkpoint written before this
 * field existed — where `{{groundStyle}}` strips to nothing — still paints a
 * ground rather than reverting to the bare plate this item exists to kill.
 */
export type SlideGroundStyle = "grid" | "glyph";

/**
 * The share of ground-bearing slides that take the glyph field rather than
 * the grid.
 *
 * Half, not `VARIATION_MIX`'s 25%: this axis is a choice between two equally
 * good grounds rather than a departure from a default, so an even split is
 * what makes two consecutive runs of the same client look different. The
 * walk itself is `isVariationSlot`'s — deterministic per run, phase-shifted
 * per seed — under its own `:ground` namespace so it does not coincide with
 * the accent or ground/fg axes over the same seed. Adjacency is not a
 * concern here: `resolveLayout` allows `cover` and `headline_focus` once per
 * carousel each, so at most two slides in a post paint a ground at all.
 */
export const GROUND_VARIATION_MIX = 0.5;

// ─────────────────────────────────────────────────────────────────────────
// IGSTYLE-10, §10a/10b/10c/10e — smart template & palette variation.
//
// Two independent axes decide, per slide, whether it renders with the
// client's PRIMARY ground/fg pairing (the common case) or an ALTERNATIVE one:
//
//   groundFg — swap which derived neutral is the ground. Safe for text
//     legibility by construction (`contrastRatio` is symmetric — an inverted
//     pair has EXACTLY the primary pair's text contrast), but can break the
//     accent's OWN legibility against the new ground, so it is checked
//     per slide against that slide's already-resolved accent (see
//     `decideGroundFgInversion` below). Works for any client with a derived
//     ground/fg pair — 7 of 7 real clients, per the ticket's own fleet audit.
//
//   accent — `paletteForSlide` (7a) already walks the ring every slide; nothing
//     new is decided here, this section only REPORTS its `rotates` outcome
//     into the same `variationPlan` shape, so a one-colour-ring client's
//     "nothing to vary here" is as visible as the groundFg axis's own.
//
// Both axes are pure functions of (index, seed) — see `paletteForSlide`'s own
// "SEEDED, NOT RANDOM" contract, which this generalises from a ring position
// to a proportion.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The target share of slides that render with the ALTERNATIVE pairing rather
 * than the client's primary one. 75/25 is the ticket's own stated ratio
 * (§10b) — named so nobody mistakes it for a tunable knob at a call site.
 */
export const VARIATION_MIX = 0.25;

/**
 * (sqrt(5)-1)/2 — the golden ratio's conjugate, the real number classically
 * used to build a low-discrepancy (Weyl/additive-recurrence) sequence: adding
 * it modulo 1 on every step equidistributes over any window (so a long
 * carousel's alternate rate converges on `VARIATION_MIX`) and, by the
 * three-distance theorem, the gaps between any two "alternative" hits take
 * only two nearby sizes — for a mix at or below 0.5 that rules out two
 * alternates landing back to back, which is exactly §10b's "spread out, not a
 * per-slide coin flip" requirement. `paletteForSlide`'s ring walk is a
 * simpler case of the same idea (a seeded position per index); this
 * generalises it to a seeded PROPORTION.
 */
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;

/**
 * FNV-1a 32-bit — a byte-identical copy of `brand-render-tokens.ts`'s own
 * private hash, duplicated rather than imported so this ticket's diff stays
 * inside the files IGSTYLE-10 actually needs to touch (its own §2.1 file
 * list does not include `brand-render-tokens.ts`). Pure, no clock, no
 * randomness — the seed is the only input, same contract as the original.
 */
function fnv1a32ForVariation(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Whether slide `index` draws the ALTERNATIVE pairing under the seeded
 * low-discrepancy walk described above. A pure function of `(index, mix,
 * seed)` — same seed and index always agree; a different seed (a different
 * run) starts the walk at a different phase, so WHICH slides land in the
 * mix varies across posts without ever varying within a re-render of the
 * same one (determinism, acceptance criterion 2; cross-run variety,
 * criterion 3).
 */
export function isVariationSlot(index: number, mix: number, seed: string): boolean {
  if (mix <= 0) return false;
  if (mix >= 1) return true;
  const phase = seed.length > 0 ? fnv1a32ForVariation(seed) / 0x100000000 : 0;
  const i = Number.isFinite(index) ? index : 0;
  const position = (phase + i * GOLDEN_RATIO_CONJUGATE) % 1;
  return position < mix;
}

/**
 * The floor an accent must clear against whatever ground it actually renders
 * on. A byte-identical copy of `brand-render-tokens.ts`'s own private
 * `ACCENT_GROUND_CONTRAST_FLOOR` — duplicated for the same "stay inside
 * IGSTYLE-10's own file list" reason as `fnv1a32ForVariation` above. §10c-2:
 * this is the constraint that actually bites on inversion — flipping the
 * ground changes accent contrast even though text contrast (checked by
 * construction, see the module doc comment above) cannot regress.
 */
const INVERTED_ACCENT_GROUND_CONTRAST_FLOOR = 3;

/**
 * The suffix an inverted-variant template file carries, inserted before the
 * extension. Exported so `create-instagram-agent-workflow.ts`'s own
 * materialization step can recognise (and skip re-inverting) a file this
 * naming already produced, without duplicating the literal string.
 */
export const INVERTED_TEMPLATE_SUFFIX = "-inv";

/**
 * The filename an archetype's ground/fg-INVERTED variant materializes as,
 * sibling to the primary file in the same `templateDir` — `Slide.template`
 * is a path resolved against ONE shared `templateDir` for the whole
 * carousel (`publish.renderCarousel`'s own contract), so an inverted variant
 * has to live beside the primary file, not in a different directory.
 */
export function invertedTemplateFileName(primaryFile: string): string {
  const dot = primaryFile.lastIndexOf(".");
  return dot === -1 ? `${primaryFile}${INVERTED_TEMPLATE_SUFFIX}` : `${primaryFile.slice(0, dot)}${INVERTED_TEMPLATE_SUFFIX}${primaryFile.slice(dot)}`;
}

/** §10a — this round's derived ground/fg pair, and whether variation is even on the table this round. */
export interface GroundFgInversionConfig {
  /** The effective kit's `--bg` — what an inverted slide's fg becomes. */
  ground: string;
  /** The effective kit's `--fg` — what an inverted slide's ground becomes. */
  fg: string;
  /**
   * §10c-4 — true when THIS round's active reviewer directive (Layer 2)
   * pinned any colour at all. Suppresses inversion entirely for the round:
   * a person who just said "make it dark" must not get 25% light slides.
   * Never suppresses the accent axis (7a) — that shipped, unconditional,
   * before this ticket and IGSTYLE-10 does not revisit it.
   */
  directivePinned: boolean;
}

/** One axis's status for one slide, for the gate payload's `variationPlan` (§10e). */
export interface VariationPlanEntry {
  slide: number;
  axis: "groundFg" | "accent" | "textAlign";
  used: boolean;
  /** Present only when `used` is false AND there's a specific reason to name — never invented for the ordinary "nothing to report" case. */
  reason?: "ring=1" | "accent-fails-inverted-ground" | "directive-pinned" | "no-ground-pair" | "reviewer-pinned";
  /** The alignment this slide actually renders with. Only on the `textAlign` axis. */
  value?: "start" | "center" | "end";
}

// ─────────────────────────────────────────────────────────────────────────
// RFC-17 §5.5 — the composition walk
// ─────────────────────────────────────────────────────────────────────────

export type SlideTextAlign = "start" | "center" | "end";

/**
 * ── WITHDRAWN 2026-09-14: THE WALK SUBSTITUTED THE WRONG AXIS ──
 *
 * This used to cycle `["start","start","center","end","center","center","start","center"]`,
 * and the owner's read of a real prep render is what retired it: on run
 * `pubsub-21839432908803804`, four of seven slides shipped centred body copy
 * and one shipped **right-aligned body copy in an LTR document**. Verbatim:
 * *"the templates had too many effects, it did not look professional at all."*
 *
 * ## The reasoning that produced it, and where it went wrong
 *
 * Its own comment said the reference sets vary by *"(a) type-block vertical
 * position, (b) ALIGNMENT, (c) mark colour and (d) imagery"*, and then chose
 * (b) on the stated grounds that it *"is the only one that is free today"* —
 * vertical migration being "its own phase".
 *
 * But the reference analysis this cites says something different
 * (`instagram-quality-reference-accounts`): *"within one carousel the type
 * block MIGRATES — top-left, bottom-left, bottom-right, top-centre, dead
 * centre — and the object cluster counterbalances it."* **That is the
 * POSITION of the block on the plate, not the RAGGING of the text inside it.**
 * Editorial design moves the block and leaves the copy ranged left; centring
 * and right-ragging multi-line body copy is the opposite move, and it is the
 * single clearest amateur tell in a layout.
 *
 * So the cheap axis was substituted for the right one BECAUSE it was cheap,
 * and the cheap axis is the one that reads as unprofessional. That is the same
 * shape as every other defect this project has recorded: a proxy adopted for
 * its availability rather than for what it measures.
 *
 * ## Why removing it costs no variety
 *
 * It was added because *"an eight-slide carousel shipped eight left-aligned
 * type blocks, which is exactly the repetition the owner called
 * machine-made"*. That was true when it was written and is not true now: the
 * series layer (RFC-21 Part 3) gives each post a different ordered layout
 * family, and holds a format out for two runs. Variety comes from the
 * composition, which is where the reference accounts get it.
 *
 * Alignment is back to what it was before: `start`, and a reviewer's explicit
 * `textAlign` override still wins. A DELIBERATE centred plate remains
 * available; a seeded one does not.
 */
const TEXT_ALIGN_WALK: readonly SlideTextAlign[] = ["start"];

/**
 * This run's default alignment per slide — seeded, never random, on the same
 * contract as every other seeded choice in this module: the same seed and the
 * same carousel always produce the same walk, and a different run starts it
 * at a different phase.
 *
 * The cover is PINNED to `start` or `center`. A cover set to `end` reads as a
 * mistake rather than a choice: it is the one slide with a masthead, a badge
 * and (usually) a hero, all of which are anchored to the start edge.
 *
 * Returned as a plain array indexed by POSITION, not by `slide.n`, so it is
 * the same shape for a six-, seven- or eight-slide post.
 */
export function planTextAlign(slideCount: number, paletteSeed: string | undefined): SlideTextAlign[] {
  // The seed is still read and still phases the walk, so the contract is
  // unchanged and a future walk with more than one entry needs no caller
  // change. With a one-entry walk every slide ranges to the script's own
  // start edge, which is what body copy does.
  const phase = paletteSeed !== undefined && paletteSeed.length > 0 ? fnv1a32ForVariation(`${paletteSeed}:textAlign`) % TEXT_ALIGN_WALK.length : 0;
  const out: SlideTextAlign[] = [];
  for (let i = 0; i < Math.max(0, slideCount); i++) {
    const picked = TEXT_ALIGN_WALK[(phase + i) % TEXT_ALIGN_WALK.length]!;
    out.push(i === 0 && picked === "end" ? "start" : picked);
  }
  return out;
}

/**
 * The accent one slide actually renders with, and whether that came from a
 * genuine rotation — shared by `assembleSlidesData` and `buildVariationPlan`
 * so the two can never disagree about what a slide's accent is.
 *
 * THE RING IS THE SINGLE SOURCE OF TRUTH whenever it has any member: a
 * multi-member ring walks (`paletteForSlide`'s seeded rotation), a one-member
 * ring paints `ring[0]` on every slide (`rotates: false`, reported as
 * `"ring=1"` by `buildVariationPlan` exactly as before). `fallbackAccent` is
 * consulted ONLY when there is no ring at all — a client with no derivable
 * kit accent, where the legacy `brandTokens.accentColor ?? brand accent ??
 * #C4552F` ladder is the only thing left to paint with.
 *
 * This used to fall back for a one-member ring too, and that is the exact
 * mechanism behind prep run `pubsub-21634455753345065`'s three-attempt hold:
 * `buildAccentRing` anchored the ring on `client/brand.json`'s `#d95f2b`
 * while this fallback painted the config's `#ff6b2c`, so every slide carried
 * a hex the kit's own ring did not contain and `checkPaletteWithinKit` failed
 * three times over a disagreement no human made. With the ring painting its
 * own anchor there is no second opinion left to disagree; the palette gate
 * stays as the belt, not the mechanism.
 */
function resolveSlideAccent(
  index: number,
  accentRing: readonly string[] | undefined,
  paletteSeed: string | undefined,
  fallbackAccent: string,
): { accent: string; rotates: boolean } {
  if (accentRing === undefined || accentRing.length === 0) return { accent: fallbackAccent, rotates: false };
  // `paletteForSlide` returns `undefined` only for an empty ring, excluded above.
  const slidePalette = paletteForSlide({ palette: [...accentRing] }, { index, ...(paletteSeed !== undefined ? { seed: paletteSeed } : {}) })!;
  return { accent: slidePalette.accent, rotates: slidePalette.rotates };
}

/**
 * §10a/10c — whether slide `index` inverts its ground/fg pairing, and why
 * not when it doesn't. The walk is seeded from `paletteSeed`, namespaced
 * (`:groundFg`) so this axis's phase needn't coincide with the accent axis's
 * own walk over the same seed.
 */
function decideGroundFgInversion(
  index: number,
  paletteSeed: string | undefined,
  slideAccent: string,
  config: GroundFgInversionConfig | undefined,
): { used: boolean; reason?: VariationPlanEntry["reason"] } {
  if (config === undefined) return { used: false, reason: "no-ground-pair" };
  if (config.directivePinned) return { used: false, reason: "directive-pinned" };
  // §10c-2: the constraint that actually bites — the accent must still clear
  // the floor against what BECOMES the ground once inverted (today's fg).
  // Checked BEFORE the walk (not after): the accent itself can vary per
  // slide (7a's own ring walk), so whether inversion is even legal is a
  // per-slide fact, and a slide whose accent genuinely can't clear the
  // floor should say so regardless of whether the walk would have picked it
  // — the walk deciding "not this slide's turn" is the only case honestly
  // reported as no reason at all.
  if (contrastRatio(slideAccent, config.fg) < INVERTED_ACCENT_GROUND_CONTRAST_FLOOR) {
    return { used: false, reason: "accent-fails-inverted-ground" };
  }
  if (!isVariationSlot(index, VARIATION_MIX, `${paletteSeed ?? ""}:groundFg`)) return { used: false };
  return { used: true };
}

/**
 * The gate payload's own §10e report: which axis each slide used, and why
 * not when it didn't. Deliberately standalone rather than folded into
 * `assembleSlidesData`'s return value — `RenderCarouselInput` is
 * `publish.renderCarousel`'s exact input contract (RFC-03 §1), not a place
 * to smuggle reporting metadata — but built from the SAME pure per-slide
 * decisions `assembleSlidesData` itself uses, so the two can never drift
 * apart on what a slide actually rendered with.
 */
export function buildVariationPlan(params: {
  slideNs: readonly number[];
  accentRing?: readonly string[] | undefined;
  paletteSeed?: string | undefined;
  /** The same fallback `assembleSlidesData` resolves to when there is no ring at all (see `resolveSlideAccent`). */
  brandAccentFallback: string;
  groundFgInversion?: GroundFgInversionConfig | undefined;
  /**
   * RFC-17 §5.5 — the reviewer's own per-slide typography, so the alignment
   * axis reports what the slide RENDERS with rather than what the walk would
   * have picked. A reviewer override still wins, unchanged; this is only how
   * the gate payload says so.
   */
  slideStyleOverrides?: ReadonlyMap<number, SlideStyleOverride> | undefined;
}): VariationPlanEntry[] {
  const plan: VariationPlanEntry[] = [];
  const alignments = planTextAlign(params.slideNs.length, params.paletteSeed);
  params.slideNs.forEach((n, index) => {
    const { accent, rotates } = resolveSlideAccent(n, params.accentRing, params.paletteSeed, params.brandAccentFallback);
    plan.push({ slide: n, axis: "accent", used: rotates, ...(rotates ? {} : { reason: "ring=1" as const }) });

    const groundFg = decideGroundFgInversion(n, params.paletteSeed, accent, params.groundFgInversion);
    plan.push({ slide: n, axis: "groundFg", used: groundFg.used, ...(groundFg.reason !== undefined ? { reason: groundFg.reason } : {}) });

    // RFC-17 §5.5. `used` means "the seeded walk decided this slide's
    // alignment" — false when a reviewer pinned it, which is not a failure of
    // the axis but the axis correctly standing aside.
    const pinned = params.slideStyleOverrides?.get(n)?.textAlign;
    plan.push({
      slide: n,
      axis: "textAlign",
      used: pinned === undefined,
      ...(pinned !== undefined ? { reason: "reviewer-pinned" as const } : {}),
      value: pinned ?? alignments[index] ?? "start",
    });
  });
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────
// IGSTYLE-10, §10d — template/layout variation, drawing on the SAME
// distribution as §10a/10b (`VARIATION_MIX`, the same low-discrepancy walk)
// but applied to WHICH registry row an archetype renders through, reusing
// the template registry's own `qualityScore` rather than inventing a
// separate mechanism.
// ─────────────────────────────────────────────────────────────────────────

/** The one field this axis needs from a `TemplateDefinition` row — kept minimal so this file doesn't need to import the registry's own type. */
export interface TemplateScoreCandidate {
  templateId: string;
  qualityScore: number;
}

/**
 * Which of an archetype's OTHER rows the variation budget may draw from:
 * every candidate at or above the mean score of every row the registry
 * offered for this archetype, excluding whichever row is already the
 * primary (`resolveBest`'s own winner). A reviewer's down-score moves both
 * the row's own score AND the mean it's compared against, but never lets a
 * downgraded row back in just because the whole set fell with it — it must
 * still clear the (possibly-lowered) bar on its own merits.
 */
export function eligibleAlternateTemplates(allCandidates: readonly TemplateScoreCandidate[], primaryTemplateId: string): TemplateScoreCandidate[] {
  if (allCandidates.length === 0) return [];
  const mean = allCandidates.reduce((sum, c) => sum + c.qualityScore, 0) / allCandidates.length;
  return allCandidates.filter((c) => c.templateId !== primaryTemplateId && c.qualityScore >= mean);
}

/**
 * Seeded pick among the eligible pool — deterministic, never random, same
 * contract as every other seeded choice in this module. `undefined` when
 * there is nothing eligible (a single-row archetype, or every other row
 * already below the mean), which the caller reads as "this archetype has no
 * alternative to offer" and keeps the primary row for every slide.
 */
export function pickAlternateTemplate(eligible: readonly TemplateScoreCandidate[], seed: string): TemplateScoreCandidate | undefined {
  if (eligible.length === 0) return undefined;
  const idx = fnv1a32ForVariation(`${seed}:template-alt`) % eligible.length;
  return eligible[idx];
}

/**
 * Hebrew, Arabic, and their presentation-form/extended Unicode blocks — the
 * RTL scripts a client's copy has actually shown up in (prep job
 * `9qkTWlg7e9ZLiVIZUok4`: a Hebrew brand-voice client whose carousel rendered
 * left-to-right). Every template is LTR by default and `{{dir}}` only ever
 * adds `dir="rtl"`, never overrides to `dir="ltr"` explicitly, so detection
 * only has to answer "is this RTL", not classify every script by name.
 */
const RTL_SCRIPT = /[\p{Script=Hebrew}\p{Script=Arabic}]/gu;
const LATIN_LETTER = /[A-Za-z]/g;

/**
 * The carousel's language is whatever the copy model actually wrote, not a
 * client-config field nobody threads through here — the same reasoning
 * `buildClientVoiceContext`'s "write entirely in that language" prompt rule
 * rests on. Counting characters rather than testing "contains any RTL
 * character at all" avoids a false positive from one Hebrew brand name or
 * hashtag sitting inside an otherwise-English post.
 */
function detectDirection(text: string): "rtl" | "ltr" {
  const rtl = text.match(RTL_SCRIPT)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  return rtl > latin ? "rtl" : "ltr";
}

/** Every user-visible string one device carries, for `collectSlideText`'s direction sample. */
function deviceTextOf(device: SlideDevice): string[] {
  switch (device.kind) {
    case "figure":
      return [device.value, device.label, device.source];
    case "figure_pair":
      return [device.before.value, device.before.label, device.after.value, device.after.label, device.source];
    case "bars":
      return [...device.rows.flatMap((row) => [row.label, row.display]), device.source];
    case "timeline":
      return device.points.flatMap((point) => [point.at, point.what]);
    case "versus":
      return [device.left.label, device.left.body, device.right.label, device.right.body];
    case "unit_grid":
      return [device.label];
  }
}

/** Every user-visible string a slide can carry, across every archetype — the corpus `detectDirection` reads. */
function collectSlideText(slide: InstagramSlideCopy): string {
  return [
    slide.headline,
    slide.body,
    slide.kicker,
    slide.quote?.text,
    slide.quote?.attribution,
    slide.stat?.figure,
    slide.stat?.subLabel,
    slide.stat?.source,
    slide.comparison?.leftLabel,
    slide.comparison?.leftBody,
    slide.comparison?.rightLabel,
    slide.comparison?.rightBody,
    ...(slide.items?.flatMap((item) => [item.title, item.note]) ?? []),
    ...(slide.customArchetype ? Object.values(slide.customArchetype.fields) : []),
    // A device's labels are rendered copy like any other, so they count
    // towards which direction the carousel is written in — a Hebrew post
    // whose only long strings are its device labels must still resolve rtl.
    ...(slide.device ? deviceTextOf(slide.device) : []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

/**
 * Escapes a value for interpolation into a `{{html:...}}` fragment.
 *
 * Mirrors `escapeHtmlText` in `karos-publish` rather than importing it, so
 * this file's own fragment builders cannot silently lose escaping if that
 * export moves. The `{{html:}}` substitution form is deliberately NOT escaped
 * by the renderer — that is the whole point of it — which makes escaping here
 * the only thing standing between model-authored takeaway text and live markup
 * in a rendered slide.
 */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Builds `list_takeaway`'s rows as one markup fragment.
 *
 * `publish.renderCarousel` substitutes flat strings and has no loop
 * construct, so a variable number of rows has to be assembled by the caller.
 * The row shape matches `list-takeaway.html`'s CSS exactly (`.me-row` >
 * `.diamond` + div > `.me-title` + `.me-note`), and the separator rules come
 * from `border-top` with `:first-child` zeroed, so nothing conditional is
 * needed per row.
 */
/**
 * A device with its LABELS bidi-isolated for an RTL render (Phase 4, RFC-15
 * §7.3), and nothing else touched.
 *
 * Labels are rendered slide text and reorder exactly like a headline does —
 * `שימוש ב-API v2` in a bar row is the same defect as the same phrase in a
 * body line, and device labels were never covered by anything.
 *
 * The FIGURES are deliberately untouched (`value`, `display`, a timeline's
 * `at`): a bare numeral in a figure lockup is the same designed relationship
 * as `stat.figure`, it is a lone run with nothing to reorder against inside
 * its own element, and `deviceFigureValues` reads those same strings as
 * LAYOUT METADATA (`deviceFigures`, which `default:numbers-are-devices`
 * matches against the copy). A control character in that field would silently
 * stop that rule matching. `source` is left alone for the same reason
 * `sourceRef` is: it is a verbatim attribution, usually Latin in its
 * entirety, and it is checked by eye against the research fact it names.
 */
function isolateDeviceLabels(device: SlideDevice, dir: "rtl" | "ltr"): SlideDevice {
  const iso = (text: string): string => isolateForeignRuns(text, dir);
  switch (device.kind) {
    case "figure":
      return { ...device, label: iso(device.label) };
    case "figure_pair":
      return { ...device, before: { ...device.before, label: iso(device.before.label) }, after: { ...device.after, label: iso(device.after.label) } };
    case "bars":
      return { ...device, rows: device.rows.map((row) => ({ ...row, label: iso(row.label) })) };
    case "timeline":
      return { ...device, points: device.points.map((point) => ({ ...point, what: iso(point.what) })) };
    case "versus":
      return {
        ...device,
        left: { ...device.left, label: iso(device.left.label), body: iso(device.left.body) },
        right: { ...device.right, label: iso(device.right.label), body: iso(device.right.body) },
      };
    case "unit_grid":
      return { ...device, label: iso(device.label) };
  }
}

/**
 * `list_takeaway`'s rows as one markup fragment.
 *
 * `titleRuns` is RFC-17's `rf-11` case, and it costs the template nothing:
 * this builder already owns `.me-title`'s markup, so a row's marked runs go
 * straight in where the escaped title used to, and `list-takeaway.html` needs
 * no new slot at all. That is why `SLOTS_BY_ARCHETYPE.list_takeaway` gains
 * none of the eight `*Runs` names.
 *
 * The runs fragment is ALREADY escaped and isolated by `buildMarkedRuns`
 * (which is the only thing licensed to build it); an absent or empty one
 * falls back to the escaped plain title, so a row whose marks were all
 * dropped is byte-identical to today's output.
 */
export function buildListRows(items: readonly { title: string; note?: string | undefined; titleRuns?: string | undefined }[]): string {
  return items
    .map(
      (item) =>
        `<div class="me-row"><span class="diamond"></span><div>` +
        `<div class="me-title">${item.titleRuns !== undefined && item.titleRuns.length > 0 ? item.titleRuns : esc(item.title)}</div>` +
        `<div class="me-note">${item.note ? esc(item.note) : ""}</div>` +
        `</div></div>`,
    )
    .join("");
}

/**
 * One recap plate's text: the shortest true thing the slide already said.
 *
 * A figure first (a stat's `figure`, then a device's own painted value),
 * because a strip of numbers is what a recap is for; the headline otherwise,
 * cut at a word boundary. Never invents a summary — every plate is a
 * verbatim fragment of a slide the reader has already seen, which is what
 * makes a recap a recap rather than a second draft of the post.
 */
function recapTextFor(slide: InstagramSlideCopy): string {
  const figure = slide.stat?.figure ?? (slide.device ? deviceFigureValues(slide.device)[0] : undefined);
  if (figure !== undefined && figure.trim().length > 0) return figure.trim();
  const headline = slide.headline.trim();
  if (headline.length <= MAX_RECAP_PLATE_CHARS) return headline;
  const cut = headline.slice(0, MAX_RECAP_PLATE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > MAX_RECAP_PLATE_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Which earlier slides a `closer`'s recap strip draws on.
 *
 * At most `MAX_RECAP_PLATES`, in carousel order, spread evenly across the
 * post rather than taken from the front: a recap of slides 2, 3, 4 and 5 of
 * an eight-slide carousel would silently drop the second half of the
 * argument. Slides whose only text is a cover headline are still eligible —
 * every slide said something, and the plate is that something.
 */
export function recapSourceSlides(earlier: readonly InstagramSlideCopy[]): InstagramSlideCopy[] {
  if (earlier.length <= MAX_RECAP_PLATES) return [...earlier];
  const step = (earlier.length - 1) / (MAX_RECAP_PLATES - 1);
  const picked: InstagramSlideCopy[] = [];
  for (let i = 0; i < MAX_RECAP_PLATES; i++) {
    const slide = earlier[Math.round(i * step)];
    if (slide !== undefined && !picked.includes(slide)) picked.push(slide);
  }
  return picked;
}

/**
 * The `closer`'s recap strip, as one markup fragment.
 *
 * Built by code from the carousel's own earlier slides for the same reason
 * `buildListRows` is: `publish.renderCarousel` substitutes flat strings and
 * has no loop construct, and the `{{html:}}` form it does have is
 * deliberately unescaped — so a variable number of plates has to be
 * assembled here, with every interpolated value escaped on the way in.
 *
 * The plate number is the slide's own `n`, zero-padded, so a reader can map
 * a plate back to the slide it recaps. Returns `""` when there is nothing
 * worth recapping, and the template's `:empty` rule collapses the slot.
 */
export function buildRecapFragment(earlier: readonly InstagramSlideCopy[]): string {
  const sources = recapSourceSlides(earlier);
  if (sources.length < MIN_RECAP_PLATES) return "";
  const plates = sources
    .map(
      (slide) =>
        `<div class="rc-plate">` +
        `<div class="rc-n">${esc(String(slide.n).padStart(2, "0"))}</div>` +
        `<div class="item-title">${esc(recapTextFor(slide))}</div>` +
        `</div>`,
    )
    .join("");
  return `<div class="rc-strip">${plates}</div>`;
}

/**
 * Whether a slide's own copy closes the post — a question the reader can
 * answer, or an invitation to act.
 *
 * A deliberately small lexicon, and a deliberate duplicate of
 * `visual-qa-pre-checks.ts`'s own `CTA_LEXICON_*`: that module imports THIS
 * one (for `INVERTED_TEMPLATE_SUFFIX`), so importing its lexicons back would
 * close a cycle between two modules that already share a direction of
 * dependency. The two ask different questions of different inputs anyway —
 * that one reads the RENDERED prose fields of the last slide to decide
 * whether to hand the closer rule to the judge; this one reads the slide
 * COPY to decide whether the `closer` archetype has anything to close with.
 * A miss here degrades the archetype, exactly as a missing `stat` degrades
 * `stat_callout`; it never fails a draft.
 */
function hasCloserVoice(slide: InstagramSlideCopy): boolean {
  const text = `${slide.headline} ${slide.body}`;
  return /[?؟]/u.test(text) || /\b(save|share|comment|tell us|try|download|book|sign up|follow|dm|reply)\b/i.test(text) || /(שמרו|שתפו|ספרו|נסו|הורידו|עקבו|מה דעתכם|כתבו לנו)/u.test(text);
}

/** Where a slide sits in the carousel, and what the pipeline already knows about it — the inputs the two POSITIONAL archetypes need. */
export interface SlidePosition {
  /** Zero-based index in carousel order. */
  index: number;
  /** Zero-based index of the last slide, so "is this the closer" is answerable without the whole array. */
  lastIndex: number;
  /**
   * Whether this slide will actually carry a photograph.
   *
   * Three-valued on purpose. `undefined` means image sourcing has not run
   * yet (the workflow's `photoSlideNs` calls `resolveLayout` before it knows
   * what it can find), and a `cover` must survive that call or it would
   * never be offered an image at all. `false` is a KNOWN absence, at
   * assembly time, and is the only state that degrades a cover.
   */
  hasHeroImage?: boolean | undefined;
  /** The slides before this one, for a `closer`'s recap strip. */
  earlier?: readonly InstagramSlideCopy[] | undefined;
}

/*
 * ── WHY THERE IS NO `coverContentAvailable` ANY MORE ─────────────────────
 *
 * There was one, and it read "a cover needs a photograph or a device;
 * neither, and it is the headline-on-flat-ground slide `cover.html` exists to
 * make impossible". That premise was true of the `cover.html` that shipped
 * with item M — whose two gradient stops both sat inside `INK_DELTA`, i.e.
 * invisible on purpose — and it is false of the one in the tree now.
 *
 * Measured through real 2160x2880 renders of the bundled templates
 * (`.local/probe-template.mjs`, 2026-09-11), for a slide 1 with no hero and
 * no device, against the cover role's own floors:
 *
 *   plate                    imagery+device   occupied   largest empty rect
 *   cover.html                   20.6%          37.9%          9.8%     passes
 *   slide.html (client base)      6.1%          54.9%          1.5%     fails clause E
 *   headline-focus.html           4.5%          50.9%          7.8%     fails clause E
 *   ── the cover role's floors ─  10.0%          42.0%         22.0%
 *
 * (Re-measured 2026-09-11 after the archetypes stopped painting a full-plate
 * texture and bound every ink-bearing layer to the content that justifies it;
 * the shape of the table is the same and the conclusion is unchanged.
 * `occupied` reads below the cover floor on all three now because the floor's
 * clause is a CONJUNCTION with `flatBackgroundShare > 0.70`, which none of
 * them trips.)
 *
 * So the gate was routing slide 1 away from the only plate that clears the
 * role it is about to be judged at, and toward one the floor is deliberately
 * built to reject (`IMAGERY_OR_DEVICE_FLOOR`'s own note: "`headline_focus`
 * judged at the cover role still reports `no-device`"). Four other modules
 * had already reached the opposite conclusion — `DEVICE_TEMPLATE_BASENAMES`
 * (visual-qa-pre-checks) and `DEVICE_BEARING_ARCHETYPES` (scene-brief) both
 * list `cover` as an archetype that carries the frame on its own,
 * `IMAGERY_OR_DEVICE_FLOOR`'s measured band table records the cover's colour
 * field, and `interest-relayout`'s `colour-block-ground` remedy spends the
 * one free re-layout moving slide 1 onto `cover` for exactly this finding.
 * This function was the lone dissenter, and it ran FIRST, so the pipeline
 * rendered the bad plate, measured it, and then paid a second render to reach
 * the answer it could have had — except when `07a` marked the slide
 * `downgradedForImages`, which WAIVES clause E, so no finding fired, no
 * re-layout ran, and the type-only plate shipped.
 *
 * ── WHAT THAT WAIVED PATH IS AND IS NOT, EXACTLY ─────────────────────────
 *
 * Removing this gate closes the waived path for any client whose
 * `templateDir` carries the bundled archetype set: slide 1 lands on `cover`,
 * the plate clears clause E on its own, and there is nothing for the waiver
 * to hide. It does NOT close it for a legacy `templateDir` with no
 * `cover.html` in it, and that is a live configuration rather than a
 * hypothetical — `availableTemplates` is read from the client's own directory
 * (`create-instagram-agent-workflow.ts`'s `ensureTemplatesOnDisk` plus
 * `materializeBrandedClientDir`, which copies the client's files and never
 * adds the bundled archetypes). For such a client `resolveLayout`'s
 * availability check still drops slide 1 to `headline_focus` (or to
 * `text_only`), that plate still measures under the cover role's device
 * floor, and `downgradedForImages` still waives the finding — as does
 * `COVER_WAIVED_RULE_IDS` for `default:cover-carries-device` in the same
 * breath. `__tests__/slides-data.test.ts` and `image-sourcing.test.ts` both
 * pin that route, deliberately.
 *
 * What HAS changed for that client, and it is the half that mattered, is what
 * the waived plate looks like: `headline-focus.html` is no longer a statement
 * in the lower third of a plate whose ground was tuned to be invisible. It
 * carries a visible textured field bound to its own statement, 50.9% occupied
 * against 47.2%, and a real largest empty rectangle (7.8%, where the old
 * full-plate texture pinned every plate in the directory at 1.5% whatever was
 * on it). So the waiver no longer hides a grey screen; it hides a designed
 * typographic plate that is not a cover. Closing the remaining gap needs
 * either a bundled-cover fallback in `materializeBrandedClientDir` or a
 * narrower waiver, and neither belongs in this function.
 *
 * What is given up is real and worth naming: a bare `cover` request used to
 * degrade to `headline_focus` and come back as a `default:cover-carries-device`
 * failure, which sent the draft to a redraft that could add a figure device.
 * That lever is gone for slide 1. It bought a redraft's worth of cost to turn
 * a 20.6% plate into a 27.4% plate that also carries a number — a real
 * improvement, but not one worth shipping 4.5% whenever it cannot be had.
 * Prompt @14 §7 and §19 still ask for the picture and the device in words,
 * and the interest floor still steers a cover that measures thin.
 */

/** Whether the content a `closer` needs is there: a recap to build, a device, or copy that actually closes. */
function closerContentAvailable(slide: InstagramSlideCopy, position: SlidePosition | undefined): boolean {
  if (slide.device !== undefined) return true;
  if (recapSourceSlides(position?.earlier ?? []).length >= MIN_RECAP_PLATES) return true;
  return hasCloserVoice(slide);
}

/**
 * The archetypes this slide's CONTENT could fill, best first — the degrade
 * ladder (Phase 2, item M).
 *
 * Every degrade path used to converge on `text_only`, which routes to the
 * client's own base template with no photograph: a headline in the lower
 * third of an otherwise empty plate. That is the exact slide the owner
 * pointed at ("מסך אפור ברובו"), so a degrade landing there means the
 * failure mode of every content mismatch IS the defect. This ladder degrades
 * to the best archetype the slide can actually fill instead.
 *
 * Order is content-shape first (a slide with a stat is a stat callout
 * wherever it sits), then POSITION (slide 1 is a cover, the last slide is a
 * closer), then `headline_focus` as the typographic floor. `text_only`
 * appears nowhere in this list: it is reached only when the client's own
 * `templateDir` holds none of these files, which `resolveLayout` decides —
 * that is what "text_only remains only when there is nothing else" means in
 * practice.
 */
export function fallbackArchetypePreferences(slide: InstagramSlideCopy, position?: SlidePosition): InstagramSlideLayout[] {
  const preferences: InstagramSlideLayout[] = [];
  if (slide.stat) preferences.push("stat_callout");
  if (slide.quote) preferences.push("quote_card");
  if (slide.comparison) preferences.push("comparison_card");
  if (slide.items && slide.items.length >= 2) preferences.push("list_takeaway");
  if (position?.hasHeroImage === true) preferences.push("photo");
  // SLIDE 1 IS A COVER, WITH OR WITHOUT A PHOTOGRAPH — see the note above
  // `closerContentAvailable` for the measurements that removed the
  // hero-or-device condition this entry used to carry.
  if (position !== undefined && position.index === 0) preferences.push("cover");
  if (position !== undefined && position.index === position.lastIndex && position.index > 0 && closerContentAvailable(slide, position)) {
    preferences.push("closer");
  }
  preferences.push("headline_focus");
  return preferences;
}

/**
 * The single best archetype this slide's content can fill, ignoring what the
 * client's `templateDir` holds and what earlier slides already used —
 * `fallbackArchetypePreferences`'s head. This is the table the tests assert;
 * `resolveLayout` walks the whole list because availability and repeats can
 * rule the head out.
 */
export function fallbackArchetypeFor(slide: InstagramSlideCopy, position?: SlidePosition): InstagramSlideLayout {
  return fallbackArchetypePreferences(slide, position)[0]!;
}

/**
 * The archetype this slide can actually be rendered as, which is not always
 * the one it asked for.
 *
 * The copy model picks `layout` and fills the matching content block, and
 * those are two independent chances to be inconsistent — it can name
 * `stat_callout` and then omit `stat`. Rendering that as requested produces a
 * slide with an empty 300px figure, which is worse than any honest
 * alternative, so a request whose content is missing falls back to
 * `text_only`: the one archetype whose inputs (`headline`, `body`) every
 * slide is schema-guaranteed to have.
 *
 * Returning the reason alongside it, rather than logging and discarding it,
 * is what lets the workflow checkpoint WHY a slide it asked to be a quote card
 * came out as plain type — otherwise that difference is invisible in the trace
 * and reads as the model never having chosen an archetype at all.
 */
export function resolveLayout(
  slide: InstagramSlideCopy,
  /**
   * Which template files the run's `templateDir` actually contains. Omit to
   * skip the check entirely (every caller that only cares about content
   * completeness, and every test that is not about a bespoke templateDir).
   *
   * This exists because a client configured before the archetype set shipped
   * has a `templateDir` holding only its own `slide.html`. Routing a slide to
   * `stat-callout.html` there is a `tooling_error` from the renderer ("a
   * missing template is a tooling failure, not a content one") that fails the
   * WHOLE run — so the archetypes would have turned every such client's next
   * carousel into an outage the first time the model picked one. Degrading to
   * the client's own template instead keeps the run shipping, which is the
   * same guaranteed-delivery rule the rest of this pipeline follows.
   */
  availableTemplates?: ReadonlySet<string>,
  /**
   * Which structured archetypes an earlier slide in THIS carousel already
   * used. `stat_callout`/`quote_card`/`comparison_card`/`list_takeaway`/
   * `headline_focus` each has one fixed visual template — a second slide in
   * the same carousel choosing one reads as the same slide shown twice, not
   * two designed slides (a real prep run shipped two `stat_callout`s and two
   * `comparison_card`s in one 8-slide post). `photo`/`text_only` are
   * exempt: several photo slides, or several quiet typographic ones, are
   * the normal, expected case, not a repeated design.
   *
   * A prompt rule alone ("aim for a mix") already asked for this and did not
   * hold, so this degrades the REPEAT rather than holding or re-drafting —
   * the same "downgrade, never hold" rule `06f`/`07a` already apply to a
   * missing image, applied here to a repeated layout instead.
   *
   * Keyed by string rather than `InstagramSlideLayout`, because two DIFFERENT
   * `custom` archetypes in one carousel are two different designs (not a
   * repeat) — the key for a custom slide is its own `archetypeId`, not the
   * literal `"custom"`.
   */
  usedLayouts?: ReadonlySet<string>,
  /**
   * Which `custom` archetypeIds passed `assertSafeMarkup` (and the
   * collision check against the five real archetype ids) THIS attempt.
   * Unlike the five structured archetypes, a custom archetype's
   * availability is never about the client's own `templateDir` — it is
   * whatever the model just authored, re-validated fresh every attempt (see
   * `create-instagram-agent-workflow.ts`'s `ensureTemplatesOnDisk`) — so it
   * gets its own, separate presence check rather than reusing
   * `availableTemplates`.
   */
  validatedCustomArchetypeIds?: ReadonlySet<string>,
  /**
   * Where this slide sits, and whether it has a photograph — needed only by
   * the two POSITIONAL archetypes (`cover`, `closer`) and by the degrade
   * ladder's position-aware entries. OPTIONAL, so every existing caller
   * keeps working: the workflow's `photoSlideNs` legitimately asks "is this
   * a photo slide" before image sourcing has run, and at that point there is
   * no honest answer to "does it have a hero" — see `SlidePosition`.
   */
  position?: SlidePosition,
): { layout: InstagramSlideLayout; downgradedFrom?: string } {
  /**
   * Walks the degrade ladder (`fallbackArchetypePreferences`) and takes the
   * first archetype this client's `templateDir` actually holds and no
   * earlier slide has claimed. `text_only` is the floor, not the target —
   * see `fallbackArchetypePreferences`'s doc comment for why that
   * distinction is the whole point of this change.
   */
  const degradeTo = (reason: string): { layout: InstagramSlideLayout; downgradedFrom: string } => {
    for (const candidate of fallbackArchetypePreferences(slide, position)) {
      if (candidate === slide.layout) continue; // whatever just failed cannot be the remedy
      const file = LAYOUT_TEMPLATE_FILES[candidate as Exclude<InstagramSlideLayout, "photo" | "text_only" | "custom">] as string | undefined;
      if (file !== undefined && availableTemplates !== undefined && !availableTemplates.has(file)) continue;
      if (file !== undefined && usedLayouts?.has(candidate)) continue;
      return { layout: candidate, downgradedFrom: `${reason}; rendering as ${candidate}` };
    }
    return { layout: "text_only", downgradedFrom: `${reason}; rendering as text_only` };
  };
  const missing = (what: string) => degradeTo(`${slide.layout} (no ${what} supplied)`);

  if (slide.layout === "custom") {
    const archetype = slide.customArchetype;
    if (!archetype) return missing("customArchetype");
    if (!validatedCustomArchetypeIds?.has(archetype.archetypeId)) {
      return degradeTo(`custom (${archetype.archetypeId} failed its markup safety check)`);
    }
    if (usedLayouts?.has(archetype.archetypeId)) {
      return degradeTo(`custom (${archetype.archetypeId} already used earlier in this carousel)`);
    }
    return { layout: "custom" };
  }

  // Checked before content, because an absent template makes the content
  // question moot: it cannot render as that archetype either way.
  if (slide.layout !== "photo" && slide.layout !== "text_only" && availableTemplates !== undefined) {
    const file = LAYOUT_TEMPLATE_FILES[slide.layout];
    if (!availableTemplates.has(file)) {
      return degradeTo(`${slide.layout} (this client's templateDir has no ${file})`);
    }
  }

  if (slide.layout !== "photo" && slide.layout !== "text_only" && usedLayouts?.has(slide.layout)) {
    return degradeTo(`${slide.layout} (already used earlier in this carousel)`);
  }

  switch (slide.layout) {
    case "stat_callout":
      return slide.stat ? { layout: slide.layout } : missing("stat");
    case "quote_card":
      return slide.quote ? { layout: slide.layout } : missing("quote");
    case "comparison_card":
      return slide.comparison ? { layout: slide.layout } : missing("comparison");
    case "list_takeaway":
      return slide.items && slide.items.length >= 2 ? { layout: slide.layout } : missing("items");
    case "closer":
      return closerContentAvailable(slide, position) ? { layout: slide.layout } : missing("recap, device, or closing line");
    case "cover":
    case "photo":
    case "text_only":
    case "headline_focus":
      // These four need nothing beyond `headline`/`body`, which the schema
      // already requires on every slide. `cover` joined them when its own
      // ground layer stopped being invisible — see the note above
      // `closerContentAvailable`. A hero is still ATTACHED when one exists
      // (`HERO_IMAGE_LAYOUTS`); what changed is that its absence is no longer
      // a reason to render something else.
      //
      // An EXPLICITLY REQUESTED `text_only` is honoured rather than sent
      // through the ladder above: a request is a statement about the slide,
      // and re-shaping it on suspicion would sometimes make it worse.
      //
      // What that boundary must NOT be used for is a downgrade.
      // `07a-downgrade-unfillable-slides` used to assign `text_only` to a
      // slide that lost its photograph, and because this case honours it the
      // slide went straight out through the client's own un-reworked
      // `slide.html` — the mostly-grey plate item M exists to remove, reached
      // by the one path nothing downstream can recover (07h waives the cover
      // rule for a lost photograph, and clause E of the interest floor is
      // waived for the same reason). `07a` now picks its target with
      // `fallbackArchetypeFor(slide, { hasHeroImage: false, ... })` instead,
      // so a hero-less slide 1 lands on `cover`, whose colour-block ground is
      // purpose-built for the no-photograph case, and an interior or closing
      // slide takes the best archetype its own content can fill. `text_only`
      // is reached only through `degradeTo`'s floor above — a client whose
      // `templateDir` holds nothing else — or by a writer who asked for it.
      //
      // The slide that MEASURES empty is re-laid-out on evidence separately,
      // by item L's free `planInterestRelayout` pass, which reads this
      // module's own `fallbackArchetypeFor` to do it.
      return { layout: slide.layout };
  }
}

/**
 * The `fields`/`htmlFragments` pair one archetype needs.
 *
 * Every archetype gets `accentColor`, `dir`, and `kicker`; the rest is
 * per-archetype. A template asking for a slot this returns nothing for
 * renders it as empty (`fillTemplate` strips unfilled slots), which is why
 * the optional lines — a stat's source, a headline's kicker — need no
 * conditional here.
 */
/** The reviewer's discrete per-slide typography controls — see `SlideEditSchema` in packages/core. */
export interface SlideStyleOverride {
  fontScale?: "s" | "m" | "l" | undefined;
  textAlign?: "start" | "center" | "end" | undefined;
}

/** Everything one slide's marks need that is fixed before `contentFor` runs (RFC-17 §5.2). */
export interface SlideMarkPlan {
  /** The RUN's derived mark ring, positional — its members are the six `.mk-c*` classes `markCssBlock` emits. An empty ring means this run marks nothing. */
  ring: MarkRing;
  /** Which of the ring's slots THIS slide may use, after the accent exclusion (`ringIndexesFor`). Empty means this slide marks nothing. */
  allowedIndexes: readonly number[];
  /** This slide's EFFECTIVE ground and ink, after IGSTYLE-10's ground/fg inversion — the pair the kind set is computed from. */
  groundHex: string;
  fgHex: string;
  /**
   * RFC-20 — whether THIS slide's archetype refuses `block` outright
   * (`quote_card`'s italic, whose background box is a parallelogram the CSS
   * cannot follow).
   *
   * Carried on the plan rather than re-derived from `layout` in two places.
   * Since RFC-20 it is an input to `ringIndexesFor` as well as to the kind
   * sets — a member whose ONLY capability is `block` must not be handed to a
   * slide that refuses `block` — and two spellings of `layout === "quote_card"`
   * that could drift are how a colour comes to be allowed with no kind at all.
   */
  refuseBlock: boolean;
  /** `slideMarkSeed(paletteSeed, slide.n)`. */
  seed: number;
}

/** What one slide's marks actually did, for the trace and for the pixel measurement's `expected.marks`. */
export interface SlideMarkResult {
  /** The distinct hexes this slide actually painted, in rotation order. Empty when nothing was marked. */
  hexes: string[];
  /** Every declared span this slide could not mark, and why. Facts, never findings. */
  drops: MarkDrop[];
  /**
   * The UNION of the kinds `slideMarkKinds` admitted for THIS slide's
   * effective ground, over every member of the ring.
   *
   * Carried so the pixel instrument knows what it is allowed to expect.
   * `markedShare` / `markColourCount` count cells that are COVERED (48 of 64
   * samples non-ground) and FLAT — a definition only `block`, the highlighter
   * swatch, can ever satisfy. `underline` (.07em), `swish` (.20em), `double`
   * (.09em + .04em) and `ink` (glyph-clipped) structurally cannot, so on any
   * ground darker than its ink — where `block` is refused for every colour
   * there is, `groundIsLighterThanInk` being false — both
   * numbers are 0 on every slide no matter how well the marks painted. Without
   * this field `interest-floor.ts`'s `marks-not-visible` warning fires on
   * every marked slide of every dark-kit run, which is a warning reviewers
   * learn to ignore.
   */
  kinds: MarkKind[];
}

function contentFor(
  layout: InstagramSlideLayout,
  slide: InstagramSlideCopy,
  accentColor: string,
  dir: "rtl" | "ltr",
  /** Standing brand furniture — the SAME on every slide of the carousel, unlike the model-authored per-slide `kicker`. */
  brand?: { handle?: string | undefined; seriesBadge?: string | undefined },
  /** Reviewer typography for THIS slide. Defaults always emitted — a stripped `{{fontScale}}` class token is harmless, but emitting the default keeps every rendered document explicit. */
  style?: SlideStyleOverride,
  /** Position, the earlier slides (for a closer's recap), the ground pick and the target language (for a device's illustrative note). */
  context?: {
    position?: SlidePosition | undefined;
    groundStyle?: SlideGroundStyle | undefined;
    targetLanguage?: string | undefined;
    /**
     * Phase 4, RFC-15 §7.2 — the run's language as a BCP-47 tag, for the
     * document's own `lang` attribute. INJECTED rather than derived here: the
     * resolution lives with the language brief (`bcp47For`), and a second
     * spelling table owned by the renderer is precisely the drift
     * `scriptTypographyFor` refuses to introduce. Absent means `"en"`, which
     * is byte-identical to the literal every template carried before.
     */
    bcp47?: string | undefined;
    /** RFC-17 (Phase 5) — this slide's mark ring, ground pair and seed. Absent means no marks at all, and every field renders exactly as it did before this phase. */
    marks?: SlideMarkPlan | undefined;
  },
): { fields: Record<string, string>; htmlFragments: Record<string, string>; marks: SlideMarkResult } {
  /**
   * Phase 4, RFC-15 §7.3 — every RENDERED text field goes through this, and
   * nothing else does.
   *
   * A no-op for an LTR carousel, so an English post's fields are byte-identical
   * to before. For an RTL one it wraps each Latin/digit run in FSI…PDI so a
   * product name, a parenthesised acronym or a `2020-2024` range does not drag
   * the punctuation around it onto the wrong side of the line.
   *
   * WHAT IT MUST NEVER REACH, and why the call sites are explicit rather than
   * a blanket map over `fields`: the published caption, `sourceRef`,
   * `visualNeed`, `checkCraftHygiene`'s input, `07d`'s dedupe corpus and the
   * language judge's fields all read the model's ORIGINAL copy — this runs at
   * composition time, on the way into the document, and the copy object itself
   * is never mutated. And it must never reach `stat.figure` or any
   * `LAYOUT_FIELD_KEY`: a figure is a bare numeral inside a `line-height: 0.95`
   * lockup (the same designed relationship that keeps `.num-figure` out of
   * `DISPLAY_SELECTORS`), and a layout key is matched by code, not read by a
   * person.
   */
  const iso = (text: string): string => isolateForeignRuns(text, dir);

  /**
   * RFC-17 (Phase 5) — the ONE place a copy field is routed to a marked-runs
   * fragment, and the reason the emphasis contract names the COPY's fields
   * rather than template slots.
   *
   * `markRuns("headline", slide.headline)` produces the fragment that fills
   * `{{html:titleRuns}}` on a cover, `{{html:takeawayRuns}}` on a closer and
   * `{{html:headlineRuns}}` everywhere else — one mapping, here, so a layout
   * downgrade keeps the marks working.
   *
   * TWIN SLOTS, NEVER A SWAP. The plain escaped field is ALWAYS emitted
   * alongside the fragment and is always the fallback (`fillTemplate` erases
   * any slot nobody filled, and a run resumed across a deploy carries
   * checkpointed slides data with no fragment at all — a straight swap would
   * render an empty headline). It also keeps `fields` byte-identical for
   * `proseFieldsOf`, `contentElementCount`, the dedupe corpus and the
   * reviewer's editable view.
   *
   * Returns `undefined` — no fragment, so the template's `:has()` collapse
   * rule never fires and the plain field shows — whenever there is no plan,
   * no ring, no declared span, or nothing survived resolution.
   */
  const markDrops: MarkDrop[] = [];
  const markColourIndexes: number[] = [];
  let marksAccepted = 0;
  const plan = context?.marks;
  // The kind set is a per-SLIDE computation from the slide's own effective
  // ground (finding 2: `rf-6` proves the ground decides), with one
  // archetype-level refusal: `quote_card`'s `.quote-text` is italic, and an
  // italic run's background box is a parallelogram the CSS cannot follow.
  //
  // RFC-20 — PER MEMBER, not one set shared by the whole ring. `kindsByIndex`
  // is what binds the rotation (the pairing is what has to be legible, so it
  // is checked where the pairing is made); `kinds` is the union, and is what
  // `SlideMarkResult.kinds` carries so `interest-floor.ts` can tell whether
  // `markedShare` is structurally able to be non-zero on this slide at all.
  const { kindsByIndex: markKindsByIndex, kinds: markKinds } =
    plan === undefined
      ? { kindsByIndex: [] as MarkKind[][], kinds: [] as MarkKind[] }
      : slideMarkKinds(plan.ring, plan.groundHex, plan.fgHex, { refuseBlock: plan.refuseBlock });
  /**
   * RFC-17 — the wire's two declaration forms collapsed to one, ONCE per
   * slide.
   *
   * ONCE PER SLIDE, NOT ONCE PER FIELD, AND THAT IS THE CONTRACT.
   *
   * The wire form is a flat array of verbatim spans with no field name on
   * them (RFC-17 §6.4), so routing is a SEARCH across the slide's own fields
   * in READING ORDER — headline, body, quote, then list rows. It has to
   * happen once, with every field visible at the same time: a per-field call
   * could not tell "this span belongs to a later field" from "this span is
   * not on the slide at all", and would report the second for the first on
   * every field it passed through.
   *
   * The reading-order list is built from the COPY, not from the layout,
   * which is the same reason the emphasis contract names copy fields: a
   * cover routes `headline` to `title` and a closer routes it to `takeaway`,
   * and a layout downgrade must keep the marks working.
   *
   * Guarded on `plan` for the same reason the rest of the mark system is:
   * with no plan the mark system is not running at all this render, and a
   * "that span is not on the slide" fact about a slide that was never going
   * to paint a mark is noise, not a finding.
   */
  const markFieldsInReadingOrder: MarkField[] = [
    { field: "headline", text: slide.headline },
    { field: "body", text: slide.body },
    ...(slide.quote !== undefined ? [{ field: "quote", text: slide.quote.text }] : []),
    // THE SEARCH HAS TO COVER EVERY FIELD THAT PRINTS PROSE, or the drop
    // reason is a lie. `stat.subLabel` ("of calendars stall in month two")
    // and `comparison.leftBody` / `rightBody` are rendered copy the writer
    // reads back on the plate, but they were not in this list — so a span
    // living only there matched nothing, and the writer was told `"stall"
    // does not appear on this slide on a word boundary -- copy a mark
    // verbatim out of the copy you just wrote`, which is false and advises
    // them to do exactly what they already did. Claimed here, the span is
    // reported against the real reason below (the archetype paints no marks).
    //
    // `stat.figure` is deliberately NOT here, and neither are the two
    // comparison LABELS: a figure is a bare numeral in a `line-height: 0.95`
    // lockup (the same designed relationship that keeps `.num-figure` out of
    // `DISPLAY_SELECTORS` and `figure` out of `iso`), and a one-word column
    // label is furniture. Neither is a clause, and a mark is a mark on a
    // clause.
    ...(slide.stat !== undefined ? [{ field: "stat.subLabel", text: slide.stat.subLabel }] : []),
    ...(slide.comparison !== undefined
      ? [
          { field: "comparison.leftBody", text: slide.comparison.leftBody },
          { field: "comparison.rightBody", text: slide.comparison.rightBody },
        ]
      : []),
    ...(slide.items ?? []).map((item, i) => ({ field: `item[${i}]`, text: item.title })),
  ];
  const normalised = plan === undefined ? { spans: [], drops: [] } : normaliseEmphasis(slide.emphasis);
  const assigned = plan === undefined ? { byField: new Map<string, string[]>(), drops: [] } : assignSpansToFields(markFieldsInReadingOrder, normalised.spans);
  markDrops.push(...normalised.drops, ...assigned.drops);
  // ── A SPAN THIS ARCHETYPE CANNOT PAINT IS A DROP, NOT A SILENCE. ──
  //
  // `stat_callout` and `comparison_card` return `htmlFragments: {}` — they are
  // deliberately unmarked (RFC-17 §5.4) — so `markRuns` is never called for
  // them. A span claimed against `headline` or `body` therefore produced no
  // fragment AND no drop: `collectEmphasisIssues` reported nothing,
  // `marks-missing` and `marks-not-visible` both abstain on `markRuns === 0`,
  // and the mark simply evaporated with every instrument saying it was fine.
  // The shipped prompt gives no archetype exception — §28 tells the writer a
  // slide may carry emphasis, full stop — so the writer is doing as asked and
  // deserves to be told where it went.
  //
  // Reported through `collectEmphasisIssues`, which NEVER gates: this is a
  // note in the trace, not a reason to hold a run or spend another drafting
  // attempt. Stating the exception in the prompt instead would move
  // `EMPHASIS_CHAR_DELTA` and the `copyAttempt` budget key, which sits $0.0017
  // under the rung that costs a cold Hebrew run an attempt — a far worse trade
  // than a trace note for a rare, cosmetic loss.
  if (plan !== undefined && UNMARKED_LAYOUTS.has(layout)) {
    for (const [field, texts] of assigned.byField) {
      for (const text of texts) {
        markDrops.push({
          field,
          text,
          reason: `the "${layout}" archetype paints no marks — its content is a figure and labels, not clauses, so this span renders as ordinary copy`,
        });
      }
    }
  }
  const markRuns = (field: "headline" | "body" | "quote" | "item", text: string, itemIndex?: number): string | undefined => {
    if (plan === undefined) return undefined;
    const fieldName = field === "item" ? `item[${itemIndex ?? 0}]` : field;
    const declared = (assigned.byField.get(fieldName) ?? []).map((t) => ({ text: t }));
    if (declared.length === 0) return undefined;
    const resolved = resolveSlideMarks(fieldName, text, declared, {
      dir,
      allowedIndexes: plan.allowedIndexes,
      kinds: markKinds,
      kindsByIndex: markKindsByIndex,
      // RFC-20 §6.2 item 6 — the inputs the emission point re-asserts the
      // pairing against, before it writes a `.mk` span.
      hexes: plan.ring.hexes,
      groundHex: plan.groundHex,
      fgHex: plan.fgHex,
      refuseBlock: plan.refuseBlock,
      seed: plan.seed,
      alreadyAccepted: marksAccepted,
    });
    markDrops.push(...resolved.drops);
    marksAccepted += resolved.accepted;
    for (const run of resolved.runs) if (run.mark !== undefined) markColourIndexes.push(run.mark.colourIndex);
    const fragment = buildMarkedRuns(resolved.runs, dir);
    return fragment.length > 0 ? fragment : undefined;
  };
  /** `{ titleRuns: "<span…>" }` when there is a fragment, `{}` when there is not — so the twin slot simply stays unfilled. */
  const runsSlot = (name: string, fragment: string | undefined): Record<string, string> => (fragment === undefined ? {} : { [name]: fragment });
  /** The distinct hexes this slide painted, in rotation order — `expected.marks` for the pixel measurement. */
  const markResult = (): SlideMarkResult => ({
    hexes: [...new Set(markColourIndexes)].map((i) => plan?.ring.hexes[i]).filter((h): h is string => typeof h === "string"),
    drops: markDrops,
    kinds: markKinds,
  });

  const base: Record<string, string> = {
    accentColor,
    dir,
    // The document's own language, so Chromium picks the right fallback face
    // for a glyph the declared stack does not carry — a Hebrew document that
    // declares `lang="en"` gets a LATIN fallback, which was the whole of the
    // audit's finding 6.
    lang: context?.bcp47 ?? "en",
    fontScale: style?.fontScale ?? "m",
    textAlign: style?.textAlign ?? "start",
    // Layout metadata, never prose: the code-picked ground treatment and the
    // slide's own number (which the glyph ground sets as a giant numeral).
    // Both are in `LAYOUT_FIELD_KEYS`, so nothing that counts or reads a
    // slide's CONTENT ever sees them.
    groundStyle: context?.groundStyle ?? "grid",
    slideIndex: String(slide.n).padStart(2, "0"),
    ...(slide.kicker ? { kicker: iso(slide.kicker) } : {}),
    ...(brand?.handle !== undefined ? { brandHandle: brand.handle } : {}),
    ...(brand?.seriesBadge !== undefined ? { seriesBadge: brand.seriesBadge } : {}),
  };

  /**
   * The device fragment, but only for an archetype whose template actually
   * declares a slot for it.
   *
   * A fragment nothing renders is worse than no fragment: it would let
   * `default:numbers-are-devices` pass on a figure the reader never sees.
   * An INVALID device is dropped the same way — devices are furniture, and
   * furniture must not be able to hold a run (`collectDeviceIssues` is how
   * the drop is reported).
   */
  const deviceFragment = (): { device: string; deviceFigures: string; deviceKind: string } | undefined => {
    if (slide.device === undefined) return undefined;
    // Validated on the ORIGINAL device, and `deviceFigureValues` reads the
    // ORIGINAL too: only the fragment that paints gets isolated labels.
    if (!validateDevice(slide.device).ok) return undefined;
    return {
      device: buildDeviceFragment(isolateDeviceLabels(slide.device, dir), dir, context?.targetLanguage),
      deviceFigures: deviceFigureValues(slide.device).join("|"),
      // Layout metadata, emitted so that every consumer of "did this slide
      // paint a device" reads the ASSEMBLED slide rather than the copy's
      // request. `07k`'s skeleton signature used to read
      // `copy.slides[].device?.kind`, which counted a device on an archetype
      // with no slot for it — so the variety check could be satisfied by a
      // device that never painted.
      deviceKind: slide.device.kind,
    };
  };
  const withDevice = <T extends { fields: Record<string, string>; htmlFragments: Record<string, string> }>(result: T): T => {
    if (!DEVICE_SLOT_LAYOUTS.has(layout)) return result;
    const built = deviceFragment();
    if (built === undefined) return result;
    return {
      ...result,
      fields: { ...result.fields, deviceFigures: built.deviceFigures, deviceKind: built.deviceKind },
      htmlFragments: { ...result.htmlFragments, device: built.device },
    };
  };

  switch (layout) {
    case "stat_callout":
      return {
        fields: {
          ...base,
          // `figure` alone is NOT isolated — see `iso`'s doc comment.
          figure: slide.stat!.figure,
          subLabel: iso(slide.stat!.subLabel),
          body: iso(slide.body),
          sourceLine: iso(slide.stat!.source),
        },
        // `stat_callout` is deliberately unmarked (RFC-17 §5.4): its content
        // is a figure and two labels, not clauses. `.num-figure` is outside
        // `DISPLAY_SELECTORS` for the same reason.
        htmlFragments: {},
        marks: markResult(),
      };
    case "quote_card":
      return {
        fields: { ...base, quoteText: iso(slide.quote!.text), attribution: iso(slide.quote!.attribution) },
        htmlFragments: { ...runsSlot("quoteRuns", markRuns("quote", slide.quote!.text)) },
        marks: markResult(),
      };
    case "comparison_card":
      return {
        fields: {
          ...base,
          headline: iso(slide.headline),
          body: iso(slide.body),
          leftLabel: iso(slide.comparison!.leftLabel),
          leftBody: iso(slide.comparison!.leftBody),
          rightLabel: iso(slide.comparison!.rightLabel),
          rightBody: iso(slide.comparison!.rightBody),
        },
        // `comparison_card` is deliberately unmarked (RFC-17 §5.4): labels and
        // short bodies in two columns, not clauses.
        htmlFragments: {},
        marks: markResult(),
      };
    case "list_takeaway":
      return {
        fields: { ...base, headline: iso(slide.headline) },
        htmlFragments: {
          // RFC-17's `rf-11` case, and it costs the template NOTHING: this
          // builder already owns `.me-title`, so a row's marks go where the
          // escaped title used to and `list-takeaway.html` grows no slot.
          // The headline's own marks are routed through `headlineRuns` like
          // every other archetype's.
          ...runsSlot("headlineRuns", markRuns("headline", slide.headline)),
          itemRows: buildListRows(
            slide.items!.map((item, itemIndex) => ({
              ...item,
              title: iso(item.title),
              ...(item.note !== undefined ? { note: iso(item.note) } : {}),
              ...((): { titleRuns?: string } => {
                const runs = markRuns("item", item.title, itemIndex);
                return runs === undefined ? {} : { titleRuns: runs };
              })(),
            })),
          ),
        },
        marks: markResult(),
      };
    case "cover": {
      // `eyebrow` is fed from the copy's own `kicker` rather than a new copy
      // field: it is the same editorial object (a short mono line above the
      // title) and one element renders it, so a cover cannot end up with two
      // competing eyebrows.
      return withDevice({
        fields: {
          ...base,
          ...(slide.kicker ? { eyebrow: iso(slide.kicker) } : {}),
          title: iso(slide.headline),
          subtitle: iso(slide.body),
        },
        // The cover routes the COPY's `headline`/`body` to `title`/`subtitle`
        // — which is exactly why the emphasis contract names the copy's own
        // fields and not a slot. `rf-05 S1` is a cover carrying four marks in
        // four colours across both lines.
        htmlFragments: {
          ...runsSlot("titleRuns", markRuns("headline", slide.headline)),
          ...runsSlot("subtitleRuns", markRuns("body", slide.body)),
        },
        marks: markResult(),
      });
    }
    case "closer": {
      const recap = buildRecapFragment(context?.position?.earlier ?? []);
      const built = deviceFragment();
      // ONE elastic middle, two possible code-built fragments. The recap
      // strip is the closer's own device; a slide-level `device` fills the
      // same slot when there is no recap to build, rather than the template
      // growing a second slot the two would compete for.
      const fragment = recap.length > 0 ? recap : (built?.device ?? "");
      const closes = hasCloserVoice(slide);
      return {
        fields: {
          ...base,
          ...(slide.kicker ? { eyebrow: iso(slide.kicker) } : {}),
          takeaway: iso(slide.headline),
          // A question is set as an invitation in the display face, a CTA as
          // a line in the text face — two different typographic jobs, so the
          // body goes to whichever slot matches what it actually is, and the
          // other collapses.
          // The question/CTA branch reads the RAW body — the isolate characters
          // are `\p{Cf}` and would not defeat this test, but a routing decision
          // made on composed bytes is a decision made on the wrong value.
          ...(closes && /[?؟]/u.test(slide.body) ? { question: iso(slide.body) } : { cta: iso(slide.body) }),
          ...(built !== undefined && fragment === built.device ? { deviceFigures: built.deviceFigures, deviceKind: built.deviceKind } : {}),
        },
        htmlFragments: {
          ...(fragment.length > 0 ? { recap: fragment } : {}),
          // The closer routes `headline` -> `takeaway`, and `body` -> either
          // `question` or `cta` — whichever the copy actually is. The marks
          // follow the same branch, so the fragment can never end up in the
          // slot that collapsed.
          ...runsSlot("takeawayRuns", markRuns("headline", slide.headline)),
          ...runsSlot(closes && /[?؟]/u.test(slide.body) ? "questionRuns" : "ctaRuns", markRuns("body", slide.body)),
        },
        marks: markResult(),
      };
    }
    case "custom":
      // Model-authored slot values are substituted through the SAME escaped
      // `{{key}}` path as every other archetype's fields — no raw/`html:`
      // form exists for this content (see `SlideCustomArchetypeSchema`'s own
      // doc comment).
      //
      // Isolated the same way every other archetype's prose is, with ONE
      // exception: a key `base` already emitted is passed through untouched.
      // Those keys are exactly the layout metadata and the standing furniture
      // (`STANDING_FURNITURE_SLOTS`), which Template Studio gate 2 already
      // refuses as a model-declared slot — so this branch is unreachable in a
      // validated archetype, and where it is reached the value keeps today's
      // meaning instead of quietly acquiring control characters in a field
      // that code matches on.
      return {
        fields: {
          ...base,
          ...Object.fromEntries(Object.entries(slide.customArchetype!.fields).map(([key, value]) => [key, key in base ? value : iso(value)])),
        },
        // A `custom` archetype's slot VALUES are model-authored, and no raw
        // `{{html:}}` form exists for them (see `SlideCustomArchetypeSchema`).
        // Marks would need a second model-authored channel into the
        // privileged form, which is the one thing the escaped path exists to
        // prevent — so `custom` is unmarked, deliberately.
        htmlFragments: {},
        marks: markResult(),
      };
    case "photo":
    case "text_only":
    case "headline_focus":
      return withDevice({
        fields: { ...base, headline: iso(slide.headline), body: iso(slide.body) },
        htmlFragments: {
          ...runsSlot("headlineRuns", markRuns("headline", slide.headline)),
          ...runsSlot("bodyRuns", markRuns("body", slide.body)),
        },
        marks: markResult(),
      });
  }
}

/**
 * Devices this draft carries that cannot be rendered honestly, per slide.
 *
 * Reported as FACTS, never as a gate — the same posture
 * `assessBrandAssetPresence` takes, and for the same reason: a device is
 * furniture, and a redraft loop over furniture would spend the whole
 * self-check budget on a slide whose copy was fine. `contentFor` drops the
 * fragment; this is how the drop becomes visible on the gate payload and in
 * the run trace instead of being silent.
 */
export function collectDeviceIssues(
  copy: InstagramCopyOutput,
  /**
   * The ASSEMBLED slides, when the caller has them.
   *
   * Without them this reports only devices that are invalid in themselves.
   * With them it also reports a device that was valid and was still DROPPED,
   * which is the other half of the same defect: `withDevice` only emits a
   * fragment for an archetype whose template declares a slot for it
   * (`DEVICE_SLOT_LAYOUTS`), and a `closer` whose recap strip took the
   * elastic middle drops the device too. Both drops used to be invisible —
   * the writer was told in §19 that any archetype may carry a device, the
   * device vanished, and `default:numbers-are-devices` then failed the slide
   * for leading with a figure it had in fact given a device. Reporting the
   * drop is what makes that a fact on the gate instead of a mystery.
   */
  slidesData?: { slides: readonly Slide[] } | undefined,
): Array<{ slide: number; kind: string; reason: string }> {
  const issues: Array<{ slide: number; kind: string; reason: string }> = [];
  const assembled = new Map((slidesData?.slides ?? []).map((s) => [s.n, s]));
  for (const slide of copy.slides) {
    if (slide.device === undefined) continue;
    const verdict = validateDevice(slide.device);
    if (!verdict.ok) {
      issues.push({ slide: slide.n, kind: slide.device.kind, reason: verdict.reason });
      continue;
    }
    const rendered = assembled.get(slide.n);
    if (rendered === undefined) continue;
    if (rendered.fields?.["deviceKind"] !== undefined) continue;
    issues.push({
      slide: slide.n,
      kind: slide.device.kind,
      reason:
        `the archetype this slide resolved to ("${rendered.template}") has no device slot, so the device was not rendered — ` +
        "a device paints on cover, headline_focus, and on a closer whose middle is not already taken by a recap strip",
    });
  }
  return issues;
}

/** The ledger/idempotency slug for the compliance gate's own "no opinion" warn. Exported so a test names the same string the code writes. */
export const COMPLIANCE_GATE_OUTAGE_SLUG = "brand-compliance-gate-no-opinion";

/**
 * WHY `checkSlidesData` REFUSED, as a value rather than as prose (RFC-19 §6, P2).
 *
 * The workflow has to treat two of these six differently from the other four:
 * a `compliance`/`compliance-unverified` refusal on a REGULATED client routes
 * to RFC-19 §5.5 (the finding rides the top of `selfCheck.checks` with
 * `severity: "blocking"` and `09a` is reconfigured to `{ duration: "24h",
 * onTimeout: "hold" }`, so nothing regulated can auto-approve into publication
 * while nobody is looking), while a count/pairing/source-ref/banned-term
 * refusal is mechanical and ships recorded.
 *
 * **That split is STRUCTURAL on purpose, and it is the point of this type**
 * (RFC-19 §11 item 3). The obvious alternative was to classify the refusal by
 * matching `reason` — `/never say|required framing/` — which would work today
 * and would silently reclassify a regulated refusal as mechanical the first
 * time somebody improved the wording of a sentence. A wording change must
 * break a test. It cannot be allowed to quietly downgrade a `never_say`
 * finding to "we shipped it and made a note".
 *
 * Assignable to the house `SlidesDataSelfCheck` (`{ ok: true } | { ok: false;
 * reason: string }`) — `kind` is additive, so every existing reader that only
 * reads `ok`/`reason` is untouched, and `types.ts` needs no edit.
 */
export type SlidesCheckRefusalKind = "count" | "pairing" | "source-ref" | "banned-term" | "compliance" | "compliance-unverified";

/**
 * `outage` is the one thing `{ ok: true }` cannot say: *this check did not run*. See
 * `craft-hygiene.ts`'s `CraftHygieneResult` for the full argument — for a NON-regulated client a
 * `gate.brandCompliance` outage used to return a bare `{ ok: true }`, so a post whose `banned_words` and
 * `banned_chars` were never measured looked, on every client- and reviewer-visible surface, exactly like one
 * that passed them. It rides ALONGSIDE `ok`, because an outage is not a refusal. For a REGULATED client the
 * outage is a refusal (`kind: "compliance-unverified"`) and is carried there instead — never twice.
 */
export type SlidesDataCheckResult = ({ ok: true } | { ok: false; reason: string; kind: SlidesCheckRefusalKind }) & { outage?: string };

/**
 * RFC-03 §3 step 07's self-check, run before `slides-data.json` is ever
 * handed to the renderer: "every claim traces to a source, every config
 * rule with `check: 'copy'` passes, slide count matches step 06." A failure
 * here drives the workflow's own capped "RETURN: 05" retry loop
 * (`create-instagram-agent-workflow.ts`) — this function itself never
 * retries anything; it just reports pass/fail plus a human-readable reason.
 *
 * `styleConfig.rules[]` entries with `check: "copy"` are descriptive/audit
 * labels in this Phase-1 schema — the actual checkable conditions they
 * describe live in `banned_words`/`banned_chars`/`compliance` below, which
 * this function evaluates directly rather than interpreting `rules[]` as a
 * mini rule-engine with no real semantics yet. (A prior version of this
 * comment attributed that choice to an invented RFC-03 quote — no such
 * instruction exists in RFC-03; this is this package's own Phase-1 scoping
 * decision.) `check: "render"` rules are out of scope for this function
 * entirely — those are checked post-render, against the rendered attempt's
 * structured slide data, by step 08b's `InstagramVisualQaAgent` instead.
 *
 * SCRUM-301/AU17: `banned_words`/`banned_chars`/`compliance.never_say`/
 * `compliance.required_framing` used to be a hand-rolled case-insensitive
 * substring scan duplicated right here — the exact algorithm the shared
 * `gate.brandCompliance` tool (`packages/tools/karos-gates/src/brand-compliance.ts`)
 * already implements and every other migrated content agent
 * (blog/reddit/x/linkedin/newsletter-agent's own step "verify-brand-
 * compliance") already calls for precisely this "client's own forbidden
 * terms / required disclaimer" check. This function now calls that same
 * tool instead of re-implementing the scan, so a client's `banned_words` and
 * `banned_chars` both flow through `forbiddenTerms` (a single-character
 * "banned char" is just a length-1 forbidden term to a substring scan), a
 * regulated client's `never_say` list flows through the same `forbiddenTerms`
 * parameter, and each `required_framing` phrase is checked via
 * `requiredDisclaimer` (one call per phrase, since that field is
 * single-phrase and required_framing is an array). This picks up
 * `gate.brandCompliance`'s always-on `DEFAULT_BANNED_PROMISE_PHRASES` floor
 * ("guaranteed returns", "risk-free", ...) as a side effect — the same floor
 * every other migrated agent already gets for free — which is new coverage,
 * not a behavior this function had before.
 */
export async function checkSlidesData(
  tools: AgentToolRegistry,
  ctx: AgentContext,
  copy: InstagramCopyOutput,
  selections: ImageSelection[],
  research: ResearchOutput,
  styleConfig: StyleConfig,
): Promise<SlidesDataCheckResult> {
  const { canvas, banned_words: bannedWords, banned_chars: bannedChars, compliance } = styleConfig;

  // The slide count is held to the FORMAT (2026-09): a single-image post is
  // exactly one slide, a carousel stays inside the client's configured range.
  if (copy.format === "single") {
    if (copy.slides.length !== 1) {
      return { ok: false, kind: "count", reason: `a single-image post carries exactly one slide, this draft carries ${copy.slides.length}` };
    }
  } else if (copy.slides.length < canvas.slides_min || copy.slides.length > canvas.slides_max) {
    return {
      ok: false,
      kind: "count",
      reason: `slide count ${copy.slides.length} is outside the configured range [${canvas.slides_min}, ${canvas.slides_max}]`,
    };
  }

  // "slide count matches step 06" (RFC-03 §3 step 07) — every copy slide must
  // have exactly one corresponding vetted image selection, no more, no fewer.
  if (selections.length !== copy.slides.length) {
    return {
      ok: false,
      kind: "pairing",
      reason: `image selection count (${selections.length}) does not match slide count (${copy.slides.length})`,
    };
  }
  const selectionNs = new Set(selections.map((s) => s.n));
  for (const slide of copy.slides) {
    if (!selectionNs.has(slide.n)) {
      return { ok: false, kind: "pairing", reason: `slide ${slide.n} has no corresponding image selection` };
    }
  }

  // "every claim traces to a source" (RFC-03 §3 step 07) — sourceRef must
  // name a step-04 fact's claim verbatim, not a paraphrase.
  const factClaims = new Set(research.facts.map((f) => f.claim));
  for (const slide of copy.slides) {
    if (!factClaims.has(slide.sourceRef)) {
      return {
        ok: false,
        kind: "source-ref",
        reason: `slide ${slide.n}'s sourceRef does not match any research fact's claim verbatim: "${slide.sourceRef}"`,
      };
    }
  }

  const brandComplianceTool = tools["gate.brandCompliance"];
  if (!brandComplianceTool) {
    // KEPT AS A THROW (RFC-19 §6 item 8), for the reason `checkCraftHygiene`'s
    // twin keeps its own: an UNREGISTERED tool is a deploy defect with nothing
    // to measure the draft with. The REGISTERED tool that failed is the
    // different thing, and it is handled below.
    throw new WorkflowToolingFailure(`"gate.brandCompliance" is not registered — step 07's banned-word/char and compliance checks cannot run without it`);
  }
  /**
   * ── Mechanism C, the loop half (RFC-19 §3) ──
   *
   * This used to throw `WorkflowToolingFailure` on a non-success outcome, and
   * it is called in a LOOP — once per slide, plus once per `required_framing`
   * phrase, plus once for `never_say`. On an eight-slide regulated carousel
   * that is ten-plus calls, and ONE flaky one out of ten ended a run that had
   * already paid for its draft, its images and its vetting. A provider blip is
   * not a verdict on the copy.
   *
   * `undefined` means "this call formed no view". The outage is remembered
   * rather than returned, because what it means depends on the client, and
   * only the code after the loops knows that: for an ordinary client it means
   * nothing at all (the always-on promise floor and the client's banned words
   * went unchecked this attempt, and a redraft cannot fix a provider outage);
   * for a REGULATED client it means the one thing this gate exists for could
   * not be verified, which is `kind: "compliance-unverified"` and travels to
   * §5.5's blocking finding.
   *
   * A `tooling_error` VERDICT counts as the same outage as a non-success
   * outcome. It used to fall through the `=== "content_fail"` tests below as
   * if it were a pass — silently, so a regulated client's `never_say` list
   * could go unchecked with nobody told. That is the failure this file is
   * least allowed to have.
   */
  let complianceOutage: string | undefined;
  const runBrandCompliance = async (text: string, forbiddenTerms: string[], requiredDisclaimer?: string): Promise<GateVerdict | undefined> => {
    const outcome = await brandComplianceTool.execute({ text, forbiddenTerms, ...(requiredDisclaimer !== undefined ? { requiredDisclaimer } : {}) }, { ctx });
    if (outcome.status !== "success") {
      complianceOutage ??= `outcome: ${outcome.status}`;
      return undefined;
    }
    const verdict = outcome.result as GateVerdict;
    if (verdict.verdict === "tooling_error") {
      complianceOutage ??= `verdict: tooling_error — ${verdict.reason}`;
      return undefined;
    }
    return verdict;
  };

  for (const slide of copy.slides) {
    const slideText = `${slide.headline} ${slide.body}`;
    const verdict = await runBrandCompliance(slideText, [...bannedWords, ...bannedChars]);
    if (verdict?.verdict === "content_fail") {
      return { ok: false, kind: "banned-term", reason: `slide ${slide.n} failed the banned word/character check (gate.brandCompliance): ${verdict.reason}` };
    }
  }

  if (compliance.regulated) {
    const combinedText = copy.slides.map((s) => `${s.headline}\n${s.body}`).join("\n");

    for (const phrase of compliance.required_framing) {
      const verdict = await runBrandCompliance(combinedText, [], phrase);
      if (verdict?.verdict === "content_fail") {
        return { ok: false, kind: "compliance", reason: `regulated client's required framing phrase is missing from the post: "${phrase}"` };
      }
    }

    if (compliance.never_say.length > 0) {
      const verdict = await runBrandCompliance(combinedText, compliance.never_say);
      if (verdict?.verdict === "content_fail") {
        return { ok: false, kind: "compliance", reason: `regulated client's post contains a "never say" phrase (gate.brandCompliance): ${verdict.reason}` };
      }
    }
  }

  if (complianceOutage !== undefined) {
    const message =
      `gate.brandCompliance could not form a view (${complianceOutage}) — ` +
      (compliance.regulated
        ? "this client is REGULATED, so the draft ships with a blocking compliance-unverified finding rather than an unverified clean bill of health"
        : "step 07's banned word/character check recorded NO OPINION on this draft");
    await noteGateOutage(tools, ctx, COMPLIANCE_GATE_OUTAGE_SLUG, message);
    if (compliance.regulated) {
      return {
        ok: false,
        kind: "compliance-unverified",
        reason:
          `a regulated client's compliance checks could not be run against this draft: gate.brandCompliance ${complianceOutage}. ` +
          "The gate formed no view — this is not a finding about the copy",
      };
    }
    // Non-regulated: the draft ships, and it ships SAYING the check did not run. Same sentence as the warn.
    return { ok: true, outage: message };
  }

  return { ok: true };
}

/**
 * ── Mechanism 0: ONE free repair, and only one (RFC-19 §3) ──
 *
 * A `source-ref` refusal is the one `checkSlidesData` refusal that is routinely
 * NOT a defect in the draft. `checkSlidesData` matches a slide's `sourceRef`
 * against a research fact's `claim` with `Set.has` — byte-for-byte — and a
 * model that quoted the claim correctly but wrapped it in quotation marks, put
 * a full stop on the end, or emitted a decomposed form of the same accented
 * characters fails that test while having cited exactly the right card. Today
 * that costs the whole attempt, and the redraft is told to fix a citation that
 * was already right.
 *
 * **What this can and cannot do, because the difference is the whole design.**
 * It can snap a `sourceRef` onto a claim that ALREADY EXISTS in the research
 * set, when the two are the same string modulo NFC, surrounding whitespace,
 * inner whitespace runs, one pair of wrapping quotes and one trailing `.`/`,`.
 * It cannot invent a citation, and it is never fuzzy and never nearest-match:
 * a normalised form shared by two different claims is ambiguous and is left
 * alone, because a fabricated citation is strictly worse than the refusal it
 * would have avoided. There is no edit distance anywhere in this function.
 *
 * **The patch is proved, not asserted.** The caller does not get a patched copy
 * on trust: this re-runs the REAL `checkSlidesData` over the patched draft and
 * discards the patch WHOLE if the gate still refuses — `applyNativeCorrections`'
 * `patchRefused` shape and `interest-relayout`'s rollback, in this file. So a
 * repair can only ever turn a refusal into the gate's own pass; it can never
 * turn one refusal into a different one, and it can never ship a draft the gate
 * did not clear.
 *
 * $0 and no model call: NFC normalisation plus one more free gate call.
 */
export type SourceRefRepair =
  | { outcome: "repaired"; copy: InstagramCopyOutput; patched: Array<{ slide: number; from: string; to: string }> }
  | { outcome: "discarded"; remedyNote: string };

/**
 * NFC · trim · collapse inner whitespace runs · strip ONE pair of wrapping
 * quotes · strip ONE trailing `.`/`,` · trim again.
 *
 * Deliberately does NOT case-fold and does not touch inner punctuation: every
 * step here is a difference a reader would not see, and case is not one of
 * those. Exported for the test that pins each step separately — a normaliser
 * nobody can enumerate is one nobody can argue with.
 */
export function normaliseSourceRef(value: string): string {
  let out = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  const OPENERS = `"'‘’“”«»„‚`;
  if (out.length >= 2 && OPENERS.includes(out[0]!) && OPENERS.includes(out[out.length - 1]!)) {
    out = out.slice(1, -1).trim();
  }
  out = out.replace(/[.,]$/u, "").trim();
  return out;
}

export async function repairSourceRefs(
  tools: AgentToolRegistry,
  ctx: AgentContext,
  copy: InstagramCopyOutput,
  selections: ImageSelection[],
  research: ResearchOutput,
  styleConfig: StyleConfig,
): Promise<SourceRefRepair> {
  const factClaims = new Set(research.facts.map((f) => f.claim));

  // Normalised → the ONE claim that normalises to it. A key reached by two
  // different claims is recorded as ambiguous and never snapped to.
  const byNormalised = new Map<string, string | null>();
  for (const claim of factClaims) {
    const key = normaliseSourceRef(claim);
    byNormalised.set(key, byNormalised.has(key) ? null : claim);
  }

  const patched: Array<{ slide: number; from: string; to: string }> = [];
  const slides = copy.slides.map((slide) => {
    if (factClaims.has(slide.sourceRef)) return slide;
    const match = byNormalised.get(normaliseSourceRef(slide.sourceRef));
    if (match === undefined || match === null || match === slide.sourceRef) return slide;
    patched.push({ slide: slide.n, from: slide.sourceRef, to: match });
    return { ...slide, sourceRef: match };
  });

  if (patched.length === 0) {
    return {
      outcome: "discarded",
      remedyNote:
        "no mis-cited sourceRef matched a research claim under NFC/whitespace/quote/trailing-punctuation normalisation — " +
        "the citation is not in the research set at all, and snapping it to the nearest one would fabricate a source",
    };
  }

  const candidate: InstagramCopyOutput = { ...copy, slides };
  const recheck = await checkSlidesData(tools, ctx, candidate, selections, research, styleConfig);
  if (!recheck.ok) {
    return {
      outcome: "discarded",
      remedyNote:
        `${patched.length} sourceRef(s) were snapped to the claim they normalise to, and the patch was discarded whole because ` +
        `the real step-07 self-check still refuses it (${recheck.kind}): ${recheck.reason}`,
    };
  }
  return { outcome: "repaired", copy: candidate, patched };
}

/**
 * Assembles the exact `publish.renderCarousel` input contract (RFC-03 §1
 * required-reading item 1's schema, imported straight from
 * `@agent-engine/tool-karos-publish` rather than redeclared here — one
 * schema, not two that could drift). Only ever called after
 * `checkSlidesData` has already passed. `outDir` is deterministic per
 * `(clientSlug, postId)` so re-running this on resume lands on the same
 * output directory rather than a fresh one each attempt.
 */
export function assembleSlidesData(params: {
  clientSlug: string;
  postId: string;
  repoRoot: string;
  brandTokens: BrandTokens;
  copy: InstagramCopyOutput;
  selections: ImageSelection[];
  canvas: StyleConfig["canvas"];
  /** Template filenames present in the effective template directory. See `resolveLayout`'s own note. */
  availableTemplates?: ReadonlySet<string>;
  /**
   * Overrides `brandTokens.templateDir` for this run.
   *
   * Set when the template registry materialized its winning templates into a
   * per-run directory (Approach (a)) — the renderer takes ONE `templateDir`,
   * so the materialized directory has to be the one it reads, with the
   * client's own base template copied in alongside.
   */
  templateDirOverride?: string | undefined;
  /** Which `custom` archetypeIds passed their safety check THIS attempt. See `resolveLayout`'s own note. */
  validatedCustomArchetypeIds?: ReadonlySet<string>;
  /**
   * The kit's derived accent, used — together with `brandTokens.accentColor`
   * — ONLY when `accentRing` is empty (see `resolveSlideAccent`). The accent
   * has exactly ONE channel — this per-slide field — and the brand token
   * sheet deliberately never emits `--accent` (see `buildBrandHeadHtml`), so
   * precedence stays legible: ring member > config accentColor > brand.json
   * accent > the legacy default. With a kit present the ring's anchor already
   * IS the config accentColor when one is set (`deriveBrandRenderTokens`), so
   * the two ladders name the same hex for slide 0.
   */
  brandAccentFallback?: string | undefined;
  /** The client's normalized `@handle` watermark, from the frozen brand kit. Rendered by the templates' `.brand-handle` component; absent means the slot strips clean. */
  brandHandle?: string | undefined;
  /** Reviewer typography per slide number (Phase 2 in-place edits). Absent slides keep the defaults. */
  slideStyleOverrides?: ReadonlyMap<number, SlideStyleOverride>;
  /**
   * IGSTYLE-7, §7a — the effective kit's accent ring (`BrandRenderTokens.palette`),
   * wiring `paletteForSlide`'s already-seeded rotation into the render path.
   * Any non-empty ring is the single source of truth for every slide's
   * accent: a one-member ring paints `ring[0]` everywhere, a longer one walks.
   * Only an ABSENT or EMPTY ring falls back to `brandAccentFallback` /
   * `brandTokens.accentColor` — see `resolveSlideAccent` for why a one-member
   * ring no longer does.
   */
  accentRing?: readonly string[] | undefined;
  /**
   * Seeds the ring walk (`paletteForSlide`'s own "SEEDED, NOT RANDOM" contract)
   * — the run id, per §7a. Absent is treated as phase 0 (same as an empty
   * seed), which only matters when `accentRing` actually has more than one
   * member.
   */
  paletteSeed?: string | undefined;
  /**
   * IGSTYLE-10, §10a — this round's ground/fg inversion axis. Absent means
   * unavailable this round (no derived pair, or nothing to gate against) —
   * every slide keeps the client's primary pairing, exactly as before this
   * ticket. See `GroundFgInversionConfig`'s own doc comment for what
   * suppresses it even when present.
   */
  groundFgInversion?: GroundFgInversionConfig | undefined;
  /**
   * The run's resolved target language (02d), for the one string in the
   * device library that is neither a numeral nor model-authored copy: an
   * unsourced device's "illustrative, not measured" note. Absent yields the
   * English note — never a guessed translation baked into a rendered slide.
   */
  targetLanguage?: string | undefined;
  /**
   * Phase 4, RFC-15 §7.2 — the run's language as a BCP-47 tag, for every
   * slide document's `lang` attribute (`{{lang}}`).
   *
   * Supplied by the caller (`languageBrief.bcp47`) rather than derived from
   * `targetLanguage` here: the language brief owns the resolution, and a
   * second spelling table in the renderer is exactly the drift
   * `scriptTypographyFor` exists to prevent. Absent yields `"en"` — the
   * literal every bundled template carried before this phase, so an English
   * run's document is byte-identical.
   */
  bcp47?: string | undefined;
  /**
   * Phase 3, item S — the run's ONE frozen image treatment (`04k`).
   *
   * Reporting and trace only: the grade itself is applied by the stylesheet
   * `imageTreatmentCssBlock` splices into every document through the
   * `extraHeadHtml` channel, so a template that never reads this field still
   * renders the treatment. Absent (or `"none"`) emits nothing, which is what
   * keeps every existing slides-data fixture byte-identical.
   */
  imageTreatment?: ImageTreatment | undefined;
  /**
   * RFC-17 (Phase 5) — the effective kit's `--bg` and `--fg`.
   *
   * The mark ring is derived from them: a mark has to be legible on the
   * ground it lands on, and `block` is refused outright on a ground darker
   * than the ink (finding 2 — `rf-6` is the proof, and our bundled `#17181C`
   * is that case). ABSENT MEANS NO MARKS AT ALL: a ring cannot be derived
   * without a ground to derive it against, and guessing one would be the
   * inferred-ink mistake finding 8 already measured (a reported contrast of
   * 2.54 on a plate whose real contrast is 15.84).
   */
  groundHex?: string | undefined;
  foregroundHex?: string | undefined;
  /**
   * RFC-17 — the run's mark ring, when the caller has already derived it.
   *
   * The workflow does, because the SAME ring has to reach the stylesheet
   * (`markCssBlock`, spliced into every document at materialization time) and
   * this composition, which indexes into it positionally to decide which
   * `.mk-c*` class each run carries. Deriving it twice from the same inputs
   * would agree today and is one argument away from painting slide 4's mark
   * in slide 2's colour with nothing reporting it.
   *
   * Absent, it is derived here from `groundHex`/`foregroundHex` — which is
   * what a test or any caller without a stylesheet to keep in step does.
   */
  markRing?: MarkRing | undefined;
  /**
   * OUT-PARAMETER — this run's mark report, filled as the slides are
   * assembled.
   *
   * An out-parameter rather than a return value for the reason
   * `buildVariationPlan`'s own doc comment gives about the same problem:
   * `RenderCarouselInput` is `publish.renderCarousel`'s exact input contract
   * (RFC-03 §1), not a place to smuggle reporting metadata. And the numbers
   * cannot be re-derived by a second pass either, because they depend on
   * `resolveLayout`'s per-slide walk (`quote_card` refuses `block`; a
   * downgraded `photo` marks through a different slot), so a standalone
   * planner would be a second opinion that could disagree with the one the
   * document was actually built from.
   *
   * `hexesBySlide` is what the caller forwards as `measure.markHexes`;
   * `issues` is what the gate payload and the trace report as facts;
   * `kindsBySlide` is what the caller forwards to `checkSlidesInterestFloor`
   * so the `marks-not-visible` warning knows whether the pixel instrument was
   * ever capable of seeing this slide's marks (only `block` paints an area a
   * marked CELL can hold). Optional, and an absent map simply means the
   * warning keeps its old unconditional behaviour for that caller.
   */
  markReportOut?: { hexesBySlide: Map<number, string[]>; issues: EmphasisIssue[]; kindsBySlide?: Map<number, string[]> | undefined } | undefined;
}): RenderCarouselInput {
  const selectionByN = new Map(params.selections.map((s) => [s.n, s]));

  // The default template (agents/instagram-agent/assets/templates/default/slide.html,
  // agent-engine#4) reads this as a CSS custom property — falls back to that template's
  // own legacy-palette accent (see its doc comment) when a client hasn't set one yet.
  // `logoPath` isn't threaded through here: the default template has no wordmark
  // slot (no client-name field exists anywhere in this agent's per-slide contract to
  // put next to one), so wiring it through would have nothing real to attach to.
  const accentColor = params.brandTokens.accentColor ?? params.brandAccentFallback ?? "#C4552F";

  // One direction for the whole carousel, not per slide — a post is written
  // in one language, and a stat figure or kicker (short, often just digits or
  // a brand name) is too thin a sample on its own to call reliably. See
  // `detectDirection`'s own doc comment for why this reads the copy itself
  // rather than a client-config field (prep job hcf9ymPGJC7mDS5pcEQ4: a
  // Hebrew-brand-voice client's carousel that rendered left-to-right).
  const direction = detectDirection([params.copy.caption, ...params.copy.slides.map(collectSlideText)].join(" "));

  // Tracks which structured archetypes an earlier slide already claimed, in
  // carousel order, so a repeat degrades to `text_only` instead of shipping
  // two slides in the same fixed layout — see `resolveLayout`'s own doc
  // comment on `usedLayouts`.
  const usedLayouts = new Set<string>();
  const lastIndex = params.copy.slides.length - 1;

  // ── RFC-17 (Phase 5): the run's mark ring, derived ONCE.
  //
  // Once per run rather than once per slide because the six `.mk-c*` classes
  // that carry its values are emitted once, into the shared head block. The
  // PER-SLIDE half of the decision — which of those six slots this slide's
  // accent leaves free — is `ringIndexesFor`, below.
  //
  // Costs $0.00: no model call, no new step, no setup bump. Derived from the
  // accent ring the kit already produces, which is also the only way to
  // guarantee an in-kit hex (finding 7: a mark palette invented outside the
  // ring is stripped by `filterLearnedStyleToRing` and then fails
  // `checkPaletteWithinKit` three attempts later — a recorded $0.30 hold).
  const markRing =
    params.markRing ??
    (params.groundHex !== undefined && params.foregroundHex !== undefined
      ? buildMarkRing(
          { ...(params.brandAccentFallback !== undefined ? { brandAccent: params.brandAccentFallback } : {}), palette: params.accentRing ?? [] },
          params.groundHex,
          params.foregroundHex,
          // A ring with one member paints ring[0] on EVERY slide
          // (`resolveSlideAccent`'s `rotates: false`), so that accent is a
          // run-level constant and excluding it here gives a better trace
          // note. A rotating ring's accent is a per-slide fact and is
          // excluded per slide instead — see `buildMarkRing`'s own comment.
          (params.accentRing ?? []).length === 1 ? params.accentRing![0]! : [],
          { groundMayInvert: params.groundFgInversion !== undefined && !params.groundFgInversion.directivePinned },
        )
      : undefined);
  const markDropsBySlide: { slide: number; drops: MarkDrop[] }[] = [];

  // RFC-17 §5.5 — this run's seeded alignment walk, one entry per POSITION.
  const alignments = planTextAlign(params.copy.slides.length, params.paletteSeed);

  const slides: Slide[] = params.copy.slides.map((slide, index) => {
    const selection = selectionByN.get(slide.n);
    // Phase 2, item M: the two positional archetypes need to know where the
    // slide sits, whether a photograph actually arrived, and what came
    // before it (a closer's recap strip). `hasHeroImage` is a KNOWN fact
    // here — the selections are in hand — which is the state that lets a
    // cover with no picture and no device degrade instead of rendering the
    // headline-on-flat-ground slide it exists to prevent.
    const position: SlidePosition = {
      index,
      lastIndex,
      hasHeroImage: (selection?.imagePath ?? null) !== null,
      earlier: params.copy.slides.slice(0, index),
    };
    const { layout } = resolveLayout(slide, params.availableTemplates, usedLayouts, params.validatedCustomArchetypeIds, position);
    if (layout === "custom") usedLayouts.add(slide.customArchetype!.archetypeId);
    else if (layout !== "photo" && layout !== "text_only") usedLayouts.add(layout);
    // IGSTYLE-7, §7a — a slide's accent comes from the ring whenever the kit
    // has one: the seeded walk when it can rotate, `ring[0]` on every slide
    // when it cannot (never a manufactured "variation"). Only a client with
    // no ring at all paints the shared `accentColor` ladder above — see
    // `resolveSlideAccent` for why a one-member ring is no longer a fallback.
    const { accent: slideAccentColor } = resolveSlideAccent(slide.n, params.accentRing, params.paletteSeed, accentColor);
    // IGSTYLE-10, §10a/10c — this slide's ground/fg pairing. Resolved BEFORE
    // `contentFor` now, because RFC-17's kind set is computed from the ground
    // this slide actually renders on: an inverted slide's ground is the kit's
    // `--fg`, and `block` is legal on one of the pair and refused on the
    // other.
    const { used: inverted } = decideGroundFgInversion(slide.n, params.paletteSeed, slideAccentColor, params.groundFgInversion);
    const effectiveGround = inverted ? params.foregroundHex : params.groundHex;
    const effectiveFg = inverted ? params.groundHex : params.foregroundHex;
    // RFC-20 — `refuseBlock` is resolved HERE, where `layout` already is, and
    // travels on the plan. It narrows `ringIndexesFor` as well as the kind
    // sets: on a paper kit a highlighter yellow's only capability is `block`,
    // and a `quote_card` that refuses `block` must not be offered that slot at
    // all, or the rotation selects a colour it can draw as nothing.
    const refuseBlock = layout === "quote_card";
    const markPlan: SlideMarkPlan | undefined =
      markRing !== undefined && effectiveGround !== undefined && effectiveFg !== undefined
        ? {
            ring: markRing,
            allowedIndexes: ringIndexesFor(markRing, slideAccentColor, { groundHex: effectiveGround, fgHex: effectiveFg, refuseBlock }),
            groundHex: effectiveGround,
            fgHex: effectiveFg,
            refuseBlock,
            seed: slideMarkSeed(params.paletteSeed, slide.n),
          }
        : undefined;
    const reviewerStyle = params.slideStyleOverrides?.get(slide.n);
    const { fields, htmlFragments, marks } = contentFor(
      layout,
      slide,
      slideAccentColor,
      direction,
      {
        handle: params.brandHandle,
        seriesBadge: params.brandTokens.seriesBadge,
      },
      // RFC-17 §5.5 — the seeded walk supplies this slide's DEFAULT
      // alignment; a reviewer's own `textAlign` still wins, unchanged, and
      // `fontScale` is untouched by this phase.
      {
        ...(reviewerStyle?.fontScale !== undefined ? { fontScale: reviewerStyle.fontScale } : {}),
        textAlign: reviewerStyle?.textAlign ?? alignments[index] ?? "start",
      },
      {
        position,
        ...(markPlan !== undefined ? { marks: markPlan } : {}),
        // ── ONE MATERIAL PER POST, NOT ONE PER SLIDE ──
        //
        // Tried on 2026-09-14 and REVERTED that day because it made a Hebrew
        // `closer.html` fail clause D outright; re-landed here in the same
        // change that demotes clause D's occupancy limb, which is what was
        // refusing it. The composition was never the problem.
        //
        // This used to read `isVariationSlot(slide.n, GROUND_VARIATION_MIX, …)`,
        // so HALF the slides in a carousel took the glyph field and half took
        // the grid — the ground changing under the reader every second slide.
        //
        // The reference analysis this was built from says the opposite in as
        // many words (`instagram-quality-reference-accounts`): *"their
        // anti-repetition mechanism is COMPOSITION, not ground. Within one
        // carousel the type block migrates over ONE UNCHANGING MATERIAL. Phase
        // 2 solved repetition the other way: eight archetypes each painting a
        // different KIND of ground. Theirs is cheaper and probably stronger —
        // one material, many compositions."*
        //
        // On a real prep render (`pubsub-21839432908803804`) the alternation is
        // plainly visible and it is what makes the set read as unsettled rather
        // than as one post. So the seed now picks ONE ground for the whole
        // carousel: same mechanism, same determinism, keyed on the post instead
        // of the slide.
        //
        // Variety across RUNS is unaffected — a different `paletteSeed` still
        // starts a different ground — and variety WITHIN the post is the series
        // layer's job (RFC-21 Part 3), which is where the reference accounts
        // get it.
        groundStyle: isVariationSlot(1, GROUND_VARIATION_MIX, `${params.paletteSeed ?? ""}:ground`) ? "glyph" : "grid",
        ...(params.targetLanguage !== undefined ? { targetLanguage: params.targetLanguage } : {}),
        ...(params.bcp47 !== undefined ? { bcp47: params.bcp47 } : {}),
      },
    );
    // Which archetypes consume a hero image: see `HERO_IMAGE_LAYOUTS`, which
    // is four wide since RFC-21 Part 2 — the two full-bleed ones and the two
    // panels that declare a bounded `.sc-figure-band`.
    // Every other archetype is typographic by design, so attaching one would
    // either be ignored by its template or — worse, for a template that did
    // grow a background slot later — quietly reintroduce the "every slide
    // needs a picture" coupling this set exists to break.
    const imagePath = HERO_IMAGE_LAYOUTS.has(layout) ? (selection?.imagePath ?? undefined) : undefined;
    const primaryTemplate = templateForLayout(layout, slide, params.brandTokens.slideTemplate);
    // `inverted` was resolved above, before `contentFor`, because the mark
    // kind set is computed from the ground this slide actually renders on.
    if (marks.drops.length > 0) markDropsBySlide.push({ slide: slide.n, drops: marks.drops });
    if (marks.hexes.length > 0) params.markReportOut?.hexesBySlide.set(slide.n, marks.hexes);
    // Always set, even when empty: "this slide admitted no kind at all" is
    // exactly as load-bearing as "it admitted four", and an absent entry
    // would be indistinguishable from a caller that supplied no map.
    params.markReportOut?.kindsBySlide?.set(slide.n, [...marks.kinds]);
    return {
      n: slide.n,
      template: inverted ? invertedTemplateFileName(primaryTemplate) : primaryTemplate,
      fields: { ...fields, ...imageTreatmentFields({ treatment: params.imageTreatment ?? "none" }) },
      images: imagePath ? { hero: imagePath } : {},
      htmlFragments,
    };
  });

  if (params.markReportOut !== undefined) {
    params.markReportOut.issues.push(...collectEmphasisIssues(markDropsBySlide, markRing?.notes ?? []));
  }

  return {
    client: params.clientSlug,
    postId: params.postId,
    templateDir: params.templateDirOverride ?? params.brandTokens.templateDir,
    outDir: `instagram-output/${params.clientSlug}/${params.postId}`,
    repoRoot: params.repoRoot,
    slides,
    canvas: params.canvas,
    readyFlag: "__CAROUSEL_READY__",
  };
}
