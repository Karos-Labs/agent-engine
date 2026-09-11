import type { AgentContext, AgentToolRegistry, GateVerdict } from "@agent-engine/core";
import { WorkflowToolingFailure } from "@agent-engine/workflow";
import type { RenderCarouselInput, Slide } from "@agent-engine/tool-karos-publish";
import { templateFileName } from "@agent-engine/tool-karos-templates";
import { contrastRatio, paletteForSlide } from "./brand-render-tokens.js";
import { buildDeviceFragment, deviceFigureValues, validateDevice, type SlideDevice } from "./slide-devices.js";
import { imageTreatmentFields, type ImageTreatment } from "./style-lock.js";
import type {
  BrandTokens,
  ImageSelection,
  InstagramCopyOutput,
  InstagramSlideCopy,
  InstagramSlideLayout,
  ResearchOutput,
  SlidesDataSelfCheck,
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
export const HERO_IMAGE_LAYOUTS: ReadonlySet<InstagramSlideLayout> = new Set<InstagramSlideLayout>(["photo", "cover"]);

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
 */
const DEVICE_SLOT_LAYOUTS: ReadonlySet<InstagramSlideLayout> = new Set<InstagramSlideLayout>(["cover", "headline_focus"]);

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
  axis: "groundFg" | "accent";
  used: boolean;
  /** Present only when `used` is false AND there's a specific reason to name — never invented for the ordinary "nothing to report" case. */
  reason?: "ring=1" | "accent-fails-inverted-ground" | "directive-pinned" | "no-ground-pair";
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
}): VariationPlanEntry[] {
  const plan: VariationPlanEntry[] = [];
  for (const n of params.slideNs) {
    const { accent, rotates } = resolveSlideAccent(n, params.accentRing, params.paletteSeed, params.brandAccentFallback);
    plan.push({ slide: n, axis: "accent", used: rotates, ...(rotates ? {} : { reason: "ring=1" as const }) });

    const groundFg = decideGroundFgInversion(n, params.paletteSeed, accent, params.groundFgInversion);
    plan.push({ slide: n, axis: "groundFg", used: groundFg.used, ...(groundFg.reason !== undefined ? { reason: groundFg.reason } : {}) });
  }
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
export function buildListRows(items: readonly { title: string; note?: string | undefined }[]): string {
  return items
    .map(
      (item) =>
        `<div class="me-row"><span class="diamond"></span><div>` +
        `<div class="me-title">${esc(item.title)}</div>` +
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

/** Whether the content a `cover` needs is there: a photograph, or a device to carry the frame instead. */
function coverContentAvailable(slide: InstagramSlideCopy, position: SlidePosition | undefined): boolean {
  if (slide.device !== undefined) return true;
  return position?.hasHeroImage !== false;
}

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
  if (position !== undefined && position.index === 0 && coverContentAvailable(slide, position)) preferences.push("cover");
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
    case "cover":
      // A cover carries a photograph or a device. Neither, and it is the
      // headline-on-flat-ground slide `cover.html` exists to make
      // impossible — so it degrades rather than rendering the defect under
      // a better name.
      return coverContentAvailable(slide, position) ? { layout: slide.layout } : missing("hero image or device");
    case "closer":
      return closerContentAvailable(slide, position) ? { layout: slide.layout } : missing("recap, device, or closing line");
    case "photo":
    case "text_only":
    case "headline_focus":
      // These three need nothing beyond `headline`/`body`, which the schema
      // already requires on every slide.
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
      // so a hero-less cover lands on `cover` when it carries a device and on
      // the ground-reworked `headline_focus` otherwise. `text_only` is
      // reached only through `degradeTo`'s floor above — a client whose
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
  },
): { fields: Record<string, string>; htmlFragments: Record<string, string> } {
  const base: Record<string, string> = {
    accentColor,
    dir,
    fontScale: style?.fontScale ?? "m",
    textAlign: style?.textAlign ?? "start",
    // Layout metadata, never prose: the code-picked ground treatment and the
    // slide's own number (which the glyph ground sets as a giant numeral).
    // Both are in `LAYOUT_FIELD_KEYS`, so nothing that counts or reads a
    // slide's CONTENT ever sees them.
    groundStyle: context?.groundStyle ?? "grid",
    slideIndex: String(slide.n).padStart(2, "0"),
    ...(slide.kicker ? { kicker: slide.kicker } : {}),
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
    if (!validateDevice(slide.device).ok) return undefined;
    return {
      device: buildDeviceFragment(slide.device, dir, context?.targetLanguage),
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
  const withDevice = (
    result: { fields: Record<string, string>; htmlFragments: Record<string, string> },
  ): { fields: Record<string, string>; htmlFragments: Record<string, string> } => {
    if (!DEVICE_SLOT_LAYOUTS.has(layout)) return result;
    const built = deviceFragment();
    if (built === undefined) return result;
    return {
      fields: { ...result.fields, deviceFigures: built.deviceFigures, deviceKind: built.deviceKind },
      htmlFragments: { ...result.htmlFragments, device: built.device },
    };
  };

  switch (layout) {
    case "stat_callout":
      return {
        fields: {
          ...base,
          figure: slide.stat!.figure,
          subLabel: slide.stat!.subLabel,
          body: slide.body,
          sourceLine: slide.stat!.source,
        },
        htmlFragments: {},
      };
    case "quote_card":
      return {
        fields: { ...base, quoteText: slide.quote!.text, attribution: slide.quote!.attribution },
        htmlFragments: {},
      };
    case "comparison_card":
      return {
        fields: {
          ...base,
          headline: slide.headline,
          body: slide.body,
          leftLabel: slide.comparison!.leftLabel,
          leftBody: slide.comparison!.leftBody,
          rightLabel: slide.comparison!.rightLabel,
          rightBody: slide.comparison!.rightBody,
        },
        htmlFragments: {},
      };
    case "list_takeaway":
      return {
        fields: { ...base, headline: slide.headline },
        htmlFragments: { itemRows: buildListRows(slide.items!) },
      };
    case "cover": {
      // `eyebrow` is fed from the copy's own `kicker` rather than a new copy
      // field: it is the same editorial object (a short mono line above the
      // title) and one element renders it, so a cover cannot end up with two
      // competing eyebrows.
      return withDevice({
        fields: {
          ...base,
          ...(slide.kicker ? { eyebrow: slide.kicker } : {}),
          title: slide.headline,
          subtitle: slide.body,
        },
        htmlFragments: {},
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
          ...(slide.kicker ? { eyebrow: slide.kicker } : {}),
          takeaway: slide.headline,
          // A question is set as an invitation in the display face, a CTA as
          // a line in the text face — two different typographic jobs, so the
          // body goes to whichever slot matches what it actually is, and the
          // other collapses.
          ...(closes && /[?؟]/u.test(slide.body) ? { question: slide.body } : { cta: slide.body }),
          ...(built !== undefined && fragment === built.device ? { deviceFigures: built.deviceFigures, deviceKind: built.deviceKind } : {}),
        },
        htmlFragments: fragment.length > 0 ? { recap: fragment } : {},
      };
    }
    case "custom":
      // Model-authored slot values are substituted through the SAME escaped
      // `{{key}}` path as every other archetype's fields — no raw/`html:`
      // form exists for this content (see `SlideCustomArchetypeSchema`'s own
      // doc comment).
      return { fields: { ...base, ...slide.customArchetype!.fields }, htmlFragments: {} };
    case "photo":
    case "text_only":
    case "headline_focus":
      return withDevice({ fields: { ...base, headline: slide.headline, body: slide.body }, htmlFragments: {} });
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
): Promise<SlidesDataSelfCheck> {
  const { canvas, banned_words: bannedWords, banned_chars: bannedChars, compliance } = styleConfig;

  // The slide count is held to the FORMAT (2026-09): a single-image post is
  // exactly one slide, a carousel stays inside the client's configured range.
  if (copy.format === "single") {
    if (copy.slides.length !== 1) {
      return { ok: false, reason: `a single-image post carries exactly one slide, this draft carries ${copy.slides.length}` };
    }
  } else if (copy.slides.length < canvas.slides_min || copy.slides.length > canvas.slides_max) {
    return {
      ok: false,
      reason: `slide count ${copy.slides.length} is outside the configured range [${canvas.slides_min}, ${canvas.slides_max}]`,
    };
  }

  // "slide count matches step 06" (RFC-03 §3 step 07) — every copy slide must
  // have exactly one corresponding vetted image selection, no more, no fewer.
  if (selections.length !== copy.slides.length) {
    return {
      ok: false,
      reason: `image selection count (${selections.length}) does not match slide count (${copy.slides.length})`,
    };
  }
  const selectionNs = new Set(selections.map((s) => s.n));
  for (const slide of copy.slides) {
    if (!selectionNs.has(slide.n)) {
      return { ok: false, reason: `slide ${slide.n} has no corresponding image selection` };
    }
  }

  // "every claim traces to a source" (RFC-03 §3 step 07) — sourceRef must
  // name a step-04 fact's claim verbatim, not a paraphrase.
  const factClaims = new Set(research.facts.map((f) => f.claim));
  for (const slide of copy.slides) {
    if (!factClaims.has(slide.sourceRef)) {
      return {
        ok: false,
        reason: `slide ${slide.n}'s sourceRef does not match any research fact's claim verbatim: "${slide.sourceRef}"`,
      };
    }
  }

  const brandComplianceTool = tools["gate.brandCompliance"];
  if (!brandComplianceTool) {
    throw new WorkflowToolingFailure(`"gate.brandCompliance" is not registered — step 07's banned-word/char and compliance checks cannot run without it`);
  }
  const runBrandCompliance = async (text: string, forbiddenTerms: string[], requiredDisclaimer?: string): Promise<GateVerdict> => {
    const outcome = await brandComplianceTool.execute({ text, forbiddenTerms, ...(requiredDisclaimer !== undefined ? { requiredDisclaimer } : {}) }, { ctx });
    if (outcome.status !== "success") {
      throw new WorkflowToolingFailure(`gate.brandCompliance failed: ${outcome.status}`);
    }
    return outcome.result as GateVerdict;
  };

  for (const slide of copy.slides) {
    const slideText = `${slide.headline} ${slide.body}`;
    const verdict = await runBrandCompliance(slideText, [...bannedWords, ...bannedChars]);
    if (verdict.verdict === "content_fail") {
      return { ok: false, reason: `slide ${slide.n} failed the banned word/character check (gate.brandCompliance): ${verdict.reason}` };
    }
  }

  if (compliance.regulated) {
    const combinedText = copy.slides.map((s) => `${s.headline}\n${s.body}`).join("\n");

    for (const phrase of compliance.required_framing) {
      const verdict = await runBrandCompliance(combinedText, [], phrase);
      if (verdict.verdict === "content_fail") {
        return { ok: false, reason: `regulated client's required framing phrase is missing from the post: "${phrase}"` };
      }
    }

    if (compliance.never_say.length > 0) {
      const verdict = await runBrandCompliance(combinedText, compliance.never_say);
      if (verdict.verdict === "content_fail") {
        return { ok: false, reason: `regulated client's post contains a "never say" phrase (gate.brandCompliance): ${verdict.reason}` };
      }
    }
  }

  return { ok: true };
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
   * Phase 3, item S — the run's ONE frozen image treatment (`04k`).
   *
   * Reporting and trace only: the grade itself is applied by the stylesheet
   * `imageTreatmentCssBlock` splices into every document through the
   * `extraHeadHtml` channel, so a template that never reads this field still
   * renders the treatment. Absent (or `"none"`) emits nothing, which is what
   * keeps every existing slides-data fixture byte-identical.
   */
  imageTreatment?: ImageTreatment | undefined;
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
    const { fields, htmlFragments } = contentFor(
      layout,
      slide,
      slideAccentColor,
      direction,
      {
        handle: params.brandHandle,
        seriesBadge: params.brandTokens.seriesBadge,
      },
      params.slideStyleOverrides?.get(slide.n),
      {
        position,
        // Item M.3 — which token-driven ground this slide paints, on the
        // EXISTING seeded low-discrepancy walk under its own namespace. No
        // new randomness mechanism: same seed and index always agree, a
        // different run starts the walk at a different phase.
        groundStyle: isVariationSlot(slide.n, GROUND_VARIATION_MIX, `${params.paletteSeed ?? ""}:ground`) ? "glyph" : "grid",
        ...(params.targetLanguage !== undefined ? { targetLanguage: params.targetLanguage } : {}),
      },
    );
    // Only `photo` and `cover` consume a hero image (`HERO_IMAGE_LAYOUTS`).
    // Every other archetype is typographic by design, so attaching one would
    // either be ignored by its template or — worse, for a template that did
    // grow a background slot later — quietly reintroduce the "every slide
    // needs a picture" coupling this set exists to break.
    const imagePath = HERO_IMAGE_LAYOUTS.has(layout) ? (selection?.imagePath ?? undefined) : undefined;
    const primaryTemplate = templateForLayout(layout, slide, params.brandTokens.slideTemplate);
    // IGSTYLE-10, §10a/10c — this slide's ground/fg pairing: the inverted
    // sibling file when the seeded walk lands here AND the accent still
    // clears the floor against the ground that inversion would produce;
    // the primary file (unchanged from before this ticket) otherwise.
    const { used: inverted } = decideGroundFgInversion(slide.n, params.paletteSeed, slideAccentColor, params.groundFgInversion);
    return {
      n: slide.n,
      template: inverted ? invertedTemplateFileName(primaryTemplate) : primaryTemplate,
      fields: { ...fields, ...imageTreatmentFields({ treatment: params.imageTreatment ?? "none" }) },
      images: imagePath ? { hero: imagePath } : {},
      htmlFragments,
    };
  });

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
