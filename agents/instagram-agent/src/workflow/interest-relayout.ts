import { MIN_CLAIM_MATCH, type ImageSelection, type InstagramCopyOutput, type InstagramSlideCopy, type InstagramSlideLayout } from "./types.js";
import { fallbackArchetypePreferences, type SlideStyleOverride } from "./slides-data.js";
import type { InterestFailureKind, InterestFinding } from "./interest-floor.js";
import { clampWords, deviceFromText, figuresInText, MAX_DEVICE_LABEL_LENGTH, sentencesOf, type RelayoutFigureDevice } from "./bounded-object.js";

/**
 * The free re-layout — RFC-14 item L, stage 1 of the interest floor's remedy.
 *
 * ## Why this exists
 *
 * A Chromium render is **$0**. A Sonnet redraft is **$0.126** (`copyAttempt`
 * $0.12 + `vetCall` $0.006, `run-budget.ts`). When the pixels say a slide is
 * empty, the answer is very often something code already has in its hands —
 * a vetted image no slide ended up using, a figure sitting in the slide's own
 * body text, a content block the writer filled but the archetype it chose
 * does not display. Spending a paid redraft to be told that back is the
 * expensive way to fix a cheap mistake, and at a run target of $1.00 the
 * difference between one free re-layout and two paid attempts is a fifth of
 * the whole budget.
 *
 * So: one pass, bounded, deterministic, at most ONE change per failing slide,
 * taken from the fixed table below. Then re-render (free) and re-check
 * (free). Only if it still fails does the attempt cost a redraft.
 *
 * ## The table
 *
 * | Failure | Free remedy, in priority order |
 * |---|---|
 * | `no-device` on the cover | promote a vetted-but-unused image to the cover → else a device from the strongest `kind: "stat"` fact card (moved onto `cover` when the slide's archetype paints none) → else the `colour-block` cover ground |
 * | `no-device` on the closer | a recap strip built from earlier slides' figures/titles → else a question block lifted from the post's own words |
 * | `dead-space` on a COVER, in `.cov-field` | the cover's own device remedy — a vetted-but-unused image, else a figure from the post's strongest sourced statistic — because the hole IS the empty device slot (RFC-20 §5.5) |
 * | `dead-space` / `empty` | a device from a figure already in that slide's own text (only where it paints) → else switch `headline_focus`/`text_only` down the real degrade ladder, carrying the device when the target can render one → else raise `fontScale` one step |
 *
 * ## A remedy must be able to take effect
 *
 * Every change here is checked against what the slide can actually RENDER,
 * not only against what the copy schema accepts. Only three archetypes paint
 * a `device` (`DEVICE_SLOT_ARCHETYPES`), and `contentFor` drops the fragment
 * for the rest without a word — so an `attach-device` on a `text_only` or a
 * `stat_callout` re-rendered byte-identically, failed the re-check on the
 * same numbers, and spent the attempt's one free chance for nothing. A remedy
 * that cannot move a pixel is worse than no remedy: it looks like one in the
 * trace.
 * | `text-wall` | drop `fontScale` one step → else move the body's last sentence to the caption |
 * | `clipped` | drop `fontScale` one step |
 * | `render-integrity` | re-render once; a second failure is a `WorkflowToolingFailure`, not a content verdict |
 *
 * ## What it will never do
 *
 * Invent copy. Every remedy here moves, promotes or re-frames something that
 * already exists: an image that was already vetted, a figure that is already
 * in the text, a question the writer already wrote, a source a fact card
 * already names. A "question block" with a question this module made up would
 * be placeholder data with a nicer name — so when the post contains no
 * question, that remedy simply does not exist and the finding goes to the
 * paid redraft, which is the step whose job authoring is.
 *
 * Nothing here is applied: `planInterestRelayout` returns a description and
 * the workflow applies it. That keeps this module pure and testable, and
 * keeps the one place that mutates `copy`/`selections` mid-attempt in the
 * workflow where every other mutation of them already lives.
 */

// ─────────────────────────────────────────────────────────────────────────
// The change vocabulary
// ─────────────────────────────────────────────────────────────────────────

/**
 * An archetype a change can name.
 *
 * `"cover"` and `"closer"` are RFC-14 item M's two new archetypes; the union
 * widens `InstagramSlideLayout` here rather than waiting for the enum, and
 * collapses to a plain `InstagramSlideLayout` the moment item M lands. Typed
 * as a union rather than `string` so a typo cannot reach the renderer.
 */
export type RelayoutArchetype = InstagramSlideLayout | "cover" | "closer";

/** The reviewer's three per-slide type sizes (`SlideStyleOverride`). */
export type FontScale = "s" | "m" | "l";

/** The order the two `fontScale` remedies step through. */
const FONT_SCALE_LADDER: readonly FontScale[] = ["s", "m", "l"];

/**
 * ── THE FIGURE READERS MOVED, AND THIS IS WHERE THEY WENT. ──
 *
 * `RelayoutFigureDevice`, `figuresInText`, `deviceFromText` and the
 * word-boundary guard the `B2B` incident bought now live in
 * `bounded-object.ts`, because RFC-20 §11.4's compose-time limb needs them
 * and `slides-data.ts` cannot import THIS module back (it is imported by it).
 *
 * They are re-exported unchanged so every caller and every test that named
 * them here still resolves: a module split is a place to put code, not a
 * reason to rewrite call sites.
 */
export {
  deviceFromText,
  figuresInText,
  MAX_DEVICE_LABEL_LENGTH,
  MAX_DEVICE_SOURCE_LENGTH,
  MAX_DEVICE_VALUE_LENGTH,
  type RelayoutFigureDevice,
} from "./bounded-object.js";

/**
 * A promoted picture can never be recorded as EVIDENCE for the cover's claim,
 * because nothing re-vetted it against the cover's headline. 3 is
 * `MIN_CLAIM_MATCH` — "compatible and generic, nothing contradicts" — so the
 * promotion stays usable (it must: a cover with no imagery is the defect item
 * L exists to fail) while the row stops asserting more than anybody checked.
 */
export const PROMOTED_CLAIM_MATCH_CEILING = MIN_CLAIM_MATCH;

/** The per-image compliance record written onto the cover's selection row by a `promote-image-to-cover`. Field-for-field a subset of `ImageSelection`, so the workflow spreads it and cannot forget one. */
export interface RelayoutPromotedImageRecord {
  license: string;
  rightsUsable: boolean;
  watermarkFree: boolean;
  claimMatch: number;
  claimMatchReason: string;
  reason: string;
}

/** One mini plate of a closer's recap strip, lifted from an earlier slide. */
export interface RelayoutRecapRow {
  /** The earlier slide this row recaps. */
  fromSlide: number;
  /** That slide's figure, when it had one. */
  value?: string;
  /** That slide's own words — a stat's sub-label, or its headline. */
  label: string;
}

/**
 * One free change. Every member names the slide it applies to and carries the
 * reason it was chosen, so the `08a1b` step output and the gate's
 * `interestRelayout` show a reviewer that CODE fixed something the writer got
 * wrong, rather than silently improving the post.
 */
export type InterestRelayoutChange =
  | {
      kind: "promote-image-to-cover";
      slide: number;
      imagePath: string;
      /** The slide whose vetting produced this image and which is not rendering it. */
      fromSlide: number;
      archetype: RelayoutArchetype;
      /**
       * The cover row's per-image record AFTER the promotion, carried with
       * the path so the two can never come apart.
       *
       * `ImageSelectionSchema` is a compliance artefact — one row per image
       * naming its licence, its rights/watermark verdict and whether the
       * picture carries that slide's claim — and there is exactly one row per
       * slide. Moving only `imagePath` therefore leaves a real third-party
       * photograph described by whatever the cover's row said before: on the
       * reachable path that row is the typographic stand-in
       * (`license: "n/a — typographic layout, no image used"`, `claimMatch: 5`,
       * "no photograph to judge"). `09b` persists `selections` on the
       * deliverable and the shipped-image ledger reads `imagePath` from the
       * same array, so the falsified row is what ships.
       *
       * `claimMatch` is capped at `PROMOTED_CLAIM_MATCH_CEILING`: the vet
       * scored this picture against slide `fromSlide`'s claim, nothing
       * re-scores it against the cover's headline (`07a`/`07-self-check` all
       * run before `08a1b`), and an uncapped 5 here is exactly the "photos of
       * one team's fans under another team's headline" defect `claimMatch`
       * was added to close — on the one slide the whole audience sees.
       */
      record: RelayoutPromotedImageRecord;
      reason: string;
    }
  | {
      kind: "attach-device";
      slide: number;
      device: RelayoutFigureDevice;
      /**
       * The archetype the slide must be switched to for the device to reach
       * the pixels, when its current one cannot paint it.
       *
       * Only three archetypes declare a device slot (`DEVICE_SLOT_ARCHETYPES`
       * — `cover` and `headline_focus` via `{{html:device}}`, `closer` via
       * its recap slot), and `contentFor` drops the fragment silently for
       * every other one: `if (!DEVICE_SLOT_LAYOUTS.has(layout)) return
       * result;`. A bare `attach-device` on a `text_only`, `photo`,
       * `stat_callout`, `quote_card`, `comparison_card` or `list_takeaway`
       * slide therefore produced a byte-identical re-render at `08a1c`, an
       * identical failure at `08a1d`, and spent the one free chance per
       * attempt for nothing — on the two commonest failure kinds. So the
       * device travels WITH the switch that makes it paint, as ONE change
       * (the "at most one change per failing slide" invariant is about
       * remedies, not about fields).
       */
      archetype?: RelayoutArchetype;
      reason: string;
    }
  | { kind: "switch-archetype"; slide: number; from: RelayoutArchetype; to: RelayoutArchetype; reason: string }
  | { kind: "build-recap"; slide: number; rows: RelayoutRecapRow[]; archetype: RelayoutArchetype; reason: string }
  | { kind: "add-question-block"; slide: number; question: string; from: "headline" | "body" | "caption"; reason: string }
  | { kind: "colour-block-ground"; slide: number; archetype: RelayoutArchetype; reason: string }
  | { kind: "font-scale"; slide: number; from: FontScale; to: FontScale; reason: string }
  | { kind: "move-sentence-to-caption"; slide: number; sentence: string; reason: string }
  | { kind: "re-render"; slide: number; reason: string };

export interface InterestRelayoutPlan {
  /** At most one per failing slide, in slide order. Never empty — an empty plan is returned as `undefined`. */
  changes: InterestRelayoutChange[];
  /**
   * Failing slides the table had no free remedy for. These are what the paid
   * redraft is actually for, and naming them keeps "we tried nothing" and
   * "there was nothing to try" distinguishable in the run trace.
   */
  unremedied: Array<{ slide: number; kind: InterestFailureKind; reason: string }>;
  /** One line per change, for the step output and the gate payload. */
  notes: string[];
  /**
   * Set by the workflow (never by `planInterestRelayout`) when `08a1c`'s
   * re-render did not succeed and the plan's copy/selection changes were
   * therefore ROLLED BACK.
   *
   * The plan still rides the gate payload in that case, because "code tried
   * this and the render refused it" is a fact a reviewer wants; the flag is
   * what stops it reading as "code fixed something the writer got wrong".
   */
  discarded?: boolean;
  discardedReason?: string;
}

/** A fact card as this module reads it — `ResearchFact` and `FactCardForPrompt` both satisfy it. */
export interface RelayoutFactCard {
  claim: string;
  source: string;
  kind?: string | undefined;
}

export interface InterestRelayoutOptions {
  /** The per-slide typography in force this attempt, as `assembleSlidesData` receives it. Absent slides are at the default `"m"`. */
  styleOverrides?: ReadonlyMap<number, SlideStyleOverride> | undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Small readers over the attempt's own state
// ─────────────────────────────────────────────────────────────────────────

/** The source NAME behind a slide's `sourceRef` — `checkSlidesData` already guarantees the ref matches a fact's claim verbatim, so this normally hits. */
function sourceForSlide(slide: InstagramSlideCopy, factCards: readonly RelayoutFactCard[]): string | undefined {
  const card = factCards.find((f) => f.claim === slide.sourceRef);
  return card?.source;
}

/**
 * A selection whose image passed every gate. The same four conditions
 * `isUnfillable` applies in the workflow, stated positively — never a
 * rights-encumbered, watermarked, or off-claim picture, regardless of how
 * badly a cover needs something in frame.
 */
function isUsableSelection(sel: ImageSelection): sel is ImageSelection & { imagePath: string } {
  return sel.imagePath !== null && sel.rightsUsable && sel.watermarkFree && sel.claimMatch >= MIN_CLAIM_MATCH;
}

/** Which archetypes other slides have already claimed. `resolveLayout` allows each structured archetype ONCE per carousel, so a switch into one already in use would degrade straight back — a no-op dressed as a remedy. */
function archetypesInUse(copy: InstagramCopyOutput, exceptSlide: number): Set<string> {
  const used = new Set<string>();
  for (const slide of copy.slides) {
    if (slide.n === exceptSlide) continue;
    const layout = slide.layout ?? "photo";
    if (layout !== "photo" && layout !== "text_only") used.add(layout);
  }
  return used;
}

/**
 * The archetypes that actually PAINT a `device`.
 *
 * Mirrors `slides-data.ts`'s `DEVICE_SLOT_LAYOUTS` (`cover`,
 * `headline_focus`) plus `closer`, whose recap slot `contentFor` fills with a
 * device when there is no recap strip to build. Kept as its own constant
 * here — with this comment — because `DEVICE_SLOT_LAYOUTS` is module-private
 * and a remedy that names a mechanism the slide cannot render is the exact
 * defect this module exists to avoid paying for.
 */
const DEVICE_SLOT_ARCHETYPES: ReadonlySet<string> = new Set(["cover", "headline_focus", "closer"]);

/**
 * `.cov-field`'s vertical extent on the 1440px design frame — the band a
 * `dead-space` finding has to sit inside for the cover limb below to claim it.
 *
 * ## Why this limb exists (RFC-20 §5.5)
 *
 * With the full-bleed hairline screen deleted, `cover.html` fails clause C at
 * `largestEmptyRectShare` 0.2361 against a 0.22 ceiling, and the failing
 * rectangle is NAMED: `{x: 0, y: 236, w: 1080, h: 376}` — a full-width band
 * between the ramp's foot and the lockup's head, which is precisely
 * `.cov-device`'s slot standing empty. MEASURED-EDGE, a real device in that
 * slot closes the band to 228px and the plate passes at 0.1583. **The cover
 * has a real hole and the screen has been painting over it**, and the legacy
 * DEAD-SPACE rule ("no empty horizontal band over 380px") and the measured
 * 376px agree with each other and disagree with the template.
 *
 * The remedy already exists — `coverRemedy` builds a figure device from the
 * strongest sourced `kind: "stat"` fact card by deterministic regex over copy
 * the run already holds, **$0.00 and no model call.** Until now it was reached
 * only from a `no-device` finding, and a cover whose ramp clears clause E at
 * 16-19% never produces one. So the plate had a free remedy sitting behind a
 * clause it could not trip.
 *
 * ## Why these two numbers, and why they live here
 *
 * `cover.html` declares `.cov-field { margin: 16px 16px 0; flex: 1 1 auto }`,
 * so the field's head is a fixed 16px and its foot is wherever the lockup
 * begins — elastic by design, measured at y≈740 on the reference render
 * (that file's own note anchors the eyebrow there). 760 carries ~20px of
 * slack for the type-scale ladder's effect on the lockup's height, and the
 * measured failing band ends at 612, so the limb has 148px of margin and
 * cannot be reached by a rectangle that lies over the LOCKUP — which is a
 * different defect (too little copy) with a different remedy (the ladder
 * below).
 *
 * Mirrored here rather than imported for the reason `DEVICE_SLOT_ARCHETYPES`
 * is: the geometry lives in an HTML file this module cannot read, and a remedy
 * that names a mechanism the slide cannot render is the exact defect this
 * module exists to avoid paying for. If `cover.html`'s field is ever re-shaped
 * the limb stops firing and the ladder below takes over — it degrades to
 * today's behaviour rather than to a wrong one.
 */
const COVER_FIELD_HEAD_Y = 16;
const COVER_FIELD_FOOT_Y = 760;

/**
 * Whether a `dead-space` finding's own failing rectangle lies inside
 * `.cov-field`'s extent.
 *
 * Reads the four scalars `checkInterestFloor` puts on the finding
 * (`largestEmptyRectY` / `largestEmptyRectH`); a caller that supplies neither
 * — a hand-built finding in a fixture, or an older gate payload replayed —
 * gets `false` and the existing ladder, which is the safe direction: this limb
 * can only ever offer a remedy the plate did not have before.
 */
function deadSpaceIsInCoverField(finding: InterestFinding | undefined): boolean {
  const y = finding?.measured["largestEmptyRectY"];
  const h = finding?.measured["largestEmptyRectH"];
  if (y === undefined || h === undefined) return false;
  return y >= COVER_FIELD_HEAD_Y && y + h <= COVER_FIELD_FOOT_Y;
}

/** The position `fallbackArchetypePreferences` needs to judge a cover or a closer. */
function positionOf(copy: InstagramCopyOutput, slideN: number): { index: number; lastIndex: number; earlier: InstagramSlideCopy[] } | undefined {
  const index = copy.slides.findIndex((s) => s.n === slideN);
  if (index < 0) return undefined;
  return { index, lastIndex: copy.slides.length - 1, earlier: copy.slides.slice(0, index) };
}

/**
 * The archetype a slide's own filled content blocks call for — the REAL
 * degrade ladder (`fallbackArchetypePreferences`), not a four-way map.
 *
 * The four-way version returned `undefined` for any slide with no
 * `stat`/`quote`/`comparison`/`items`, so a plain headline-and-body plate had
 * no structural remedy at all and fell through to a one-step `fontScale`
 * bump — which cannot move a ~0.69 empty rectangle under a 0.22/0.28 ceiling.
 * Reading the same ladder `resolveLayout` will walk at assembly time also
 * means this module can never propose a target that degrades straight back.
 *
 * `hasHeroImage` is passed as the slide's own reality so the ladder does not
 * offer `photo` to a slide with no picture. Candidates already claimed by
 * another slide, and the slide's current archetype, are skipped for the same
 * reason.
 */
function contentShapedArchetypeFor(
  slide: InstagramSlideCopy,
  copy: InstagramCopyOutput,
  current: RelayoutArchetype,
  inUse: ReadonlySet<string>,
  selections: readonly ImageSelection[],
): RelayoutArchetype | undefined {
  const position = positionOf(copy, slide.n);
  if (position === undefined) return undefined;
  const hasHeroImage = selections.some((sel) => sel.n === slide.n && isUsableSelection(sel));
  for (const candidate of fallbackArchetypePreferences(slide, { ...position, hasHeroImage })) {
    if (candidate === current) continue;
    if (candidate !== "photo" && candidate !== "text_only" && inUse.has(candidate)) continue;
    return candidate;
  }
  return undefined;
}

function scaleOf(slide: number, opts: InterestRelayoutOptions): FontScale {
  return opts.styleOverrides?.get(slide)?.fontScale ?? "m";
}

function stepScale(current: FontScale, direction: 1 | -1): FontScale | undefined {
  const index = FONT_SCALE_LADDER.indexOf(current) + direction;
  return FONT_SCALE_LADDER[index];
}

/** A question the post already asks, so the closer's question block is the writer's words and not this module's. */
function questionInPost(slide: InstagramSlideCopy, copy: InstagramCopyOutput): { question: string; from: "headline" | "body" | "caption" } | undefined {
  const candidates: Array<{ text: string; from: "headline" | "body" | "caption" }> = [
    { text: slide.headline, from: "headline" },
    { text: slide.body, from: "body" },
    { text: copy.caption, from: "caption" },
  ];
  for (const candidate of candidates) {
    const question = sentencesOf(candidate.text).find((s) => /[?؟]\s*$/u.test(s));
    if (question !== undefined) return { question, from: candidate.from };
  }
  return undefined;
}

/** 2–4 mini plates from the slides before `slide`, newest-relevant first. Figures where a slide had one, its own words otherwise. */
function recapRowsBefore(copy: InstagramCopyOutput, slideN: number): RelayoutRecapRow[] {
  const rows: RelayoutRecapRow[] = [];
  for (const slide of copy.slides) {
    if (slide.n >= slideN) continue;
    if (slide.stat !== undefined) {
      rows.push({ fromSlide: slide.n, value: slide.stat.figure, label: clampWords(slide.stat.subLabel, MAX_DEVICE_LABEL_LENGTH) });
      continue;
    }
    const figure = figuresInText(`${slide.headline} ${slide.body}`)[0];
    const label = clampWords(slide.headline, MAX_DEVICE_LABEL_LENGTH);
    if (label.length === 0) continue;
    rows.push({ fromSlide: slide.n, ...(figure !== undefined ? { value: figure.value } : {}), label });
  }
  // Item M's recap strip is 2-4 plates: one is not a recap, five do not fit
  // the 1440px column at a readable size. The LAST four before the closer,
  // because a recap reads best in the order the post made its points.
  return rows.slice(-4);
}

// ─────────────────────────────────────────────────────────────────────────
// The planner
// ─────────────────────────────────────────────────────────────────────────

/**
 * The order failure kinds are considered for one slide.
 *
 * A slide can carry several findings at once (a cover with no device usually
 * also has a hole), and only one change is allowed. Highest first, and if a
 * kind has no free remedy the next kind is tried rather than the slide being
 * abandoned — the point is to spend zero dollars where possible, and a cover
 * that cannot be given an image may still be fixable by its own archetype.
 */
/*
 * `marks-missing` sits SECOND, immediately after `render-integrity` and ahead
 * of every pixel-shaped kind, and the reason is not that it is more serious.
 * It is that when the mark stylesheet did not arrive, every OTHER finding on
 * that slide was measured against a document that is not the one the pipeline
 * meant to draw — the emphasis is unpainted, so `imageryOrDeviceShare`,
 * `occupiedShare` and the empty rectangle are all reading a plate that is
 * missing pixels it was supposed to have. Spending the attempt's one free
 * change on a `no-device` remedy here would fix a number that may not be
 * wrong once the sheet lands. The re-render is free and it re-measures
 * everything.
 */
const KIND_PRIORITY: readonly InterestFailureKind[] = ["render-integrity", "marks-missing", "clipped", "no-device", "dead-space", "empty", "text-wall"];

/**
 * At most one free change per failing slide, or `undefined` when the table
 * offers nothing for any of them.
 *
 * Bounded to ONE pass by construction: it is a pure function of this
 * attempt's state, it never calls itself, and the workflow runs it at most
 * once per attempt (`08a1b`). Two passes would be a loop with no fixed point
 * — a `fontScale` remedy that fails re-check would step again, forever.
 */
export function planInterestRelayout(
  copy: InstagramCopyOutput,
  selections: readonly ImageSelection[],
  factCards: readonly RelayoutFactCard[],
  failures: readonly InterestFinding[],
  opts: InterestRelayoutOptions = {},
): InterestRelayoutPlan | undefined {
  const bySlide = new Map<number, InterestFinding[]>();
  for (const finding of failures) {
    const list = bySlide.get(finding.slide);
    if (list) list.push(finding);
    else bySlide.set(finding.slide, [finding]);
  }

  const changes: InterestRelayoutChange[] = [];
  const unremedied: InterestRelayoutPlan["unremedied"] = [];

  for (const slideN of [...bySlide.keys()].sort((a, b) => a - b)) {
    const slideFindings = bySlide.get(slideN)!;
    const slide = copy.slides.find((s) => s.n === slideN);
    if (slide === undefined) {
      // A finding for a slide the copy does not contain means the render and
      // the copy disagree — a tooling problem, not something to re-lay-out.
      unremedied.push({ slide: slideN, kind: slideFindings[0]!.kind, reason: `slide ${slideN} is not in this attempt's copy` });
      continue;
    }

    let change: InterestRelayoutChange | undefined;
    const ordered = KIND_PRIORITY.filter((kind) => slideFindings.some((f) => f.kind === kind));
    for (const kind of ordered) {
      change = remedyFor(kind, slide, copy, selections, factCards, slideFindings, opts);
      if (change !== undefined) break;
    }

    if (change === undefined) {
      const kind = ordered[0] ?? slideFindings[0]!.kind;
      unremedied.push({
        slide: slideN,
        kind,
        reason: `no free remedy: slide ${slideN}'s ${kind} needs content this attempt does not have (${UNREMEDIED_DETAIL[kind]})`,
      });
      continue;
    }
    changes.push(change);
  }

  if (changes.length === 0) return undefined;
  return { changes, unremedied, notes: changes.map(noteFor) };
}

/** Why a kind can run out of free remedies — the writer-facing half is the steer; this is the operator-facing half. */
const UNREMEDIED_DETAIL: Readonly<Record<InterestFailureKind, string>> = {
  "render-integrity": "a re-render was already spent on it",
  // Unreachable today — the branch below always returns a `re-render` — and
  // present because the record is exhaustive over the kind union, which is
  // what makes adding a kind without a remedy a compile error rather than an
  // `undefined` in an operator's trace.
  "marks-missing": "a re-render was already spent on it, and no copy change can make a stylesheet load",
  clipped: "its type is already at the smallest scale",
  "no-device": "no unused vetted image, no sourced figure, and no colour-block ground left to try",
  "dead-space": "no figure in its own text, no unclaimed content-shaped archetype, and its type is already at the largest scale",
  empty: "no figure in its own text, no unclaimed content-shaped archetype, and its type is already at the largest scale",
  "text-wall": "its type is already at the smallest scale and its body is one sentence",
};

/** The fixed table, one branch per failure kind. */
function remedyFor(
  kind: InterestFailureKind,
  slide: InstagramSlideCopy,
  copy: InstagramCopyOutput,
  selections: readonly ImageSelection[],
  factCards: readonly RelayoutFactCard[],
  slideFindings: readonly InterestFinding[],
  opts: InterestRelayoutOptions,
): InterestRelayoutChange | undefined {
  const slideN = slide.n;
  const role = slideFindings.find((f) => f.kind === kind)?.role ?? "interior";

  switch (kind) {
    // A broken render is re-rendered once and never rewritten. The workflow
    // treats a second failure as a `WorkflowToolingFailure`, which is the
    // honest classification: no copy change can make a font load.
    case "render-integrity":
      return { kind: "re-render", slide: slideN, reason: `slide ${slideN} measured almost no ink; re-rendering once before treating it as a tooling failure` };

    // Same remedy as `render-integrity` and deliberately NOT the same
    // escalation. The workflow turns a second `render-integrity` into a
    // `WorkflowToolingFailure`, because a plate with no ink at all is
    // unshippable; a plate whose emphasis did not paint is a COMPLETE post
    // with plain type on it, so a second failure here degrades and ships with
    // the finding recorded. Nothing in RFC-17 may hold or fail a run.
    case "marks-missing":
      return {
        kind: "re-render",
        slide: slideN,
        reason: `slide ${slideN} carries emphasis runs that painted nothing; re-rendering once — the copy is right and the mark stylesheet did not arrive`,
      };

    case "clipped": {
      const from = scaleOf(slideN, opts);
      const to = stepScale(from, -1);
      return to === undefined
        ? undefined
        : { kind: "font-scale", slide: slideN, from, to, reason: `slide ${slideN}'s type overflowed its box; dropping its fontScale from ${from} to ${to}` };
    }

    case "no-device":
      return role === "closer"
        ? closerRemedy(slide, copy)
        : coverRemedy(slide, copy, selections, factCards);

    case "dead-space":
    case "empty": {
      const current = (slide.layout ?? "photo") as RelayoutArchetype;
      const inUse = archetypesInUse(copy, slideN);
      const source = sourceForSlide(slide, factCards);
      const device = source !== undefined ? deviceFromText(`${slide.headline} ${slide.body}`, source) : undefined;

      // ── 0. THE COVER LIMB (RFC-20 §5.5), AHEAD OF THE LADDER. ──
      //
      // A `dead-space` finding on a COVER whose failing rectangle lies inside
      // `.cov-field` is not "this slide has too little copy" — it is
      // `.cov-device`'s slot standing empty, which is a hole the template
      // already has a place to fill. See `COVER_FIELD_HEAD_Y` for the
      // measurement and for why the extent test is what distinguishes the two.
      //
      // It takes `coverRemedy`'s image-then-figure path, which is the same
      // remedy a `no-device` finding on the same slide would get and costs the
      // same $0.00 — and it takes it AHEAD of the ladder below, because the
      // ladder's answers to a cover-sized hole are a `switch-archetype` away
      // from the one archetype built for this case, or one step of
      // `fontScale`, which cannot close a 376px band.
      //
      // **Its step-3 `colour-block-ground` fallback is deliberately withheld**
      // — `groundFallback: false`. Audited against RFC-20 §5.0's Ground Rule:
      // that change re-renders the slide on the `cover` archetype, whose field
      // is already bound to its own content (`cover.html`'s
      // `body:not(:has(#title > span:not(:empty))) .cov-field`), so it is not
      // an unguarded full-bleed colour block and the Ground Rule does not
      // refuse it. It is withheld for the other rule this module keeps: a
      // slide that just reported a hole INSIDE `.cov-field` is a slide already
      // rendering `cover.html`, so the change is a byte-identical re-render —
      // "a remedy that cannot move a pixel is worse than no remedy: it looks
      // like one in the trace". With no image and no figure the cover fails
      // clause C and that is the correct answer: the floor is now able to tell
      // a cover that has something to say from one that does not.
      if (kind === "dead-space" && role === "cover" && deadSpaceIsInCoverField(slideFindings.find((f) => f.kind === "dead-space"))) {
        const remedy = coverRemedy(slide, copy, selections, factCards, { groundFallback: false });
        if (remedy !== undefined) return remedy;
      }

      // 1. A device from a figure the slide ALREADY carries — the cheapest
      //    real fix there is, and the one item M's `device` field exists for.
      //
      //    ONLY where it paints. `contentFor` emits `htmlFragments.device`
      //    for `cover`/`headline_focus` (and a `closer` with no recap) and
      //    silently drops it everywhere else, so an unguarded `attach-device`
      //    on a `text_only`, `photo`, `stat_callout`, `quote_card`,
      //    `comparison_card` or `list_takeaway` slide produced a
      //    byte-identical re-render at `08a1c` and an identical failure at
      //    `08a1d` — the one free chance per attempt spent for nothing, on
      //    the two commonest failure kinds. Guarding here is also what makes
      //    `KIND_PRIORITY`'s ordering safe: a device is never TRIED ahead of
      //    a switch on an archetype that cannot render it, because it is
      //    never offered there at all.
      //
      //    ── AND NEVER WHERE THE PLATE ALREADY CARRIES ONE (RFC-20 §11.4). ──
      //
      //    `bounded-object.ts` composes exactly this device, from exactly
      //    this text and exactly this source, BEFORE the first render, for
      //    `headline_focus` and `text_only`. So on those two archetypes the
      //    limb above could only ever re-offer a device the plate is already
      //    wearing — which is the byte-identical re-render the paragraph
      //    above spends six lines refusing, arrived at from the other
      //    direction. The caller passes the COMPOSED copy for this reason,
      //    so `slide.device` here is what the pixels actually carried.
      if (device !== undefined && DEVICE_SLOT_ARCHETYPES.has(current) && slide.device === undefined) {
        return { kind: "attach-device", slide: slideN, device, reason: `slide ${slideN} already states the figure ${device.value}; setting it as a device instead of prose` };
      }

      // 2. The archetype the slide's own filled content blocks call for. Only
      //    from the two shapeless archetypes — switching a quote card or a
      //    stat callout away would throw a designed plate out to fix its
      //    empty half — and only into an archetype no other slide has
      //    claimed.
      if (current === "headline_focus" || current === "text_only") {
        const target = contentShapedArchetypeFor(slide, copy, current, inUse, selections);
        if (target !== undefined) {
          // When the target CAN paint a device and this slide has one to
          // paint, the switch and the device are ONE change: the archetype
          // that makes a fragment render and the fragment itself are the same
          // remedy, and splitting them across two attempts wastes the second.
          if (device !== undefined && DEVICE_SLOT_ARCHETYPES.has(target)) {
            return {
              kind: "attach-device",
              slide: slideN,
              device,
              archetype: target,
              reason: `slide ${slideN} already states the figure ${device.value} but renders as ${current}, which paints no device; switching it to ${target} and setting the figure as a device`,
            };
          }
          return { kind: "switch-archetype", slide: slideN, from: current, to: target, reason: `slide ${slideN} carries ${target.replace("_", " ")} content but renders as ${current}; switching the archetype` };
        }
      }
      // 3. Bigger type fills more of the frame. Last, because it treats the
      //    symptom rather than the cause.
      const from = scaleOf(slideN, opts);
      const to = stepScale(from, 1);
      return to === undefined
        ? undefined
        : { kind: "font-scale", slide: slideN, from, to, reason: `slide ${slideN} left too much of the plate empty; raising its fontScale from ${from} to ${to}` };
    }

    case "text-wall": {
      const from = scaleOf(slideN, opts);
      const to = stepScale(from, -1);
      if (to !== undefined) {
        return { kind: "font-scale", slide: slideN, from, to, reason: `slide ${slideN} filled the frame with glyphs; dropping its fontScale from ${from} to ${to}` };
      }
      // Already at the smallest type, so the slide has too many words rather
      // than words that are too big. The caption is where a sentence that
      // does not fit on a plate belongs.
      const sentences = sentencesOf(slide.body);
      const last = sentences.length >= 2 ? sentences[sentences.length - 1] : undefined;
      return last === undefined
        ? undefined
        : { kind: "move-sentence-to-caption", slide: slideN, sentence: last, reason: `slide ${slideN} is already at the smallest type; moving its last sentence to the caption` };
    }
  }
}

/**
 * `no-device` on the cover: an image, then a figure, then a graphic ground.
 *
 * `groundFallback` is what the last of those three is worth to the CALLER.
 * A `no-device` finding means the cover measured no imagery and no drawn
 * device at all, and moving it onto the `cover` archetype genuinely changes
 * what paints — that is the case step 3 was written for, and it keeps it. The
 * `dead-space` cover limb passes `false`, because there the slide is already
 * on `cover` and the change would re-render it byte-identically; see the limb
 * for the full audit against RFC-20's Ground Rule.
 */
function coverRemedy(
  slide: InstagramSlideCopy,
  copy: InstagramCopyOutput,
  selections: readonly ImageSelection[],
  factCards: readonly RelayoutFactCard[],
  opts: { groundFallback?: boolean } = {},
): InterestRelayoutChange | undefined {
  const slideN = slide.n;
  const layoutByN = new Map(copy.slides.map((s) => [s.n, s.layout ?? "photo"]));

  // 1. An image that passed every gate and that no slide is rendering —
  //    `assembleSlidesData` attaches a hero only to a `photo` slide, so a
  //    vetted image on a slide that ended up typographic is going nowhere.
  //    Best claim match first: a cover is the slide the whole audience sees.
  const unused = selections
    .filter(isUsableSelection)
    .filter((sel) => sel.n !== slideN && layoutByN.get(sel.n) !== "photo")
    .sort((a, b) => b.claimMatch - a.claimMatch || a.n - b.n)[0];
  if (unused !== undefined) {
    return {
      kind: "promote-image-to-cover",
      slide: slideN,
      imagePath: unused.imagePath,
      fromSlide: unused.n,
      archetype: "cover",
      // The verdict travels with the path. See `record` on the change type.
      record: {
        license: unused.license,
        rightsUsable: unused.rightsUsable,
        watermarkFree: unused.watermarkFree,
        claimMatch: Math.min(unused.claimMatch, PROMOTED_CLAIM_MATCH_CEILING),
        claimMatchReason:
          `vetted for slide ${unused.n}'s claim at ${unused.claimMatch}/5 (${unused.claimMatchReason}), then promoted to the cover by the interest re-layout ` +
          `without a re-vet — capped at ${PROMOTED_CLAIM_MATCH_CEILING}/5, so this picture is compatible with the cover's headline but is not recorded as evidence for it`,
        reason: `promoted from slide ${unused.n} to the cover because slide ${slideN} measured no imagery; the picture's own vetting reason was: ${unused.reason}`,
      },
      reason: `slide ${slideN} had no imagery; promoting slide ${unused.n}'s vetted-but-unrendered image (claimMatch ${unused.claimMatch}/5, recorded on the cover at ${Math.min(unused.claimMatch, PROMOTED_CLAIM_MATCH_CEILING)}/5 pending a re-vet) to the cover`,
    };
  }

  // 2. A device from the strongest sourced statistic in the post. Fact cards
  //    arrive strongest-first (`factCardsForPrompt`'s primary-first order), so
  //    the first stat card carrying a figure is the strongest one.
  const current = (slide.layout ?? "photo") as RelayoutArchetype;
  for (const card of factCards) {
    if ((card.kind ?? "stat") !== "stat") continue;
    const device = deviceFromText(card.claim, card.source);
    if (device === undefined) continue;
    // The same guard as the `dead-space`/`empty` branch: a device is only
    // offered where it paints. A cover already on `cover`/`headline_focus`
    // takes it as it stands; anything else (a `photo` whose hero measured
    // empty, a `text_only`, a structured plate that landed on slide 1) is
    // moved onto `cover`, whose ground layer is the one built for the
    // no-photograph case — and which then satisfies
    // `default:cover-carries-device` by template as well as by fragment.
    return DEVICE_SLOT_ARCHETYPES.has(current)
      ? { kind: "attach-device", slide: slideN, device, reason: `slide ${slideN} had no imagery; building a figure device from the post's strongest sourced number (${device.value})` }
      : {
          kind: "attach-device",
          slide: slideN,
          device,
          archetype: "cover",
          reason: `slide ${slideN} had no imagery and renders as ${current}, which paints no device; moving it onto the cover archetype and building a figure device from the post's strongest sourced number (${device.value})`,
        };
  }

  // 3. The `cover` archetype's own colour-block ground plus keyline, which is
  //    structurally incapable of being a headline on flat ground (item M).
  //
  //    AUDITED AGAINST RFC-20 §5.0'S GROUND RULE, because "a full-bleed
  //    unguarded colour block is the same defect wearing a different name":
  //    `cover.html`'s field is NOT unguarded. It carries
  //    `body:not(:has(#title > span:not(:empty))) .cov-field { background-image: none }`
  //    and a `body:has(.hero)` branch, so the ramp paints only on a cover that
  //    has a title and no photograph — an OBJECT whose extent is a function of
  //    the content, which is limb (b) of the rule rather than limb (a)'s
  //    material. It is the cover's bounded ramp, not a screen over the plate,
  //    and it is what carries clause E at iod 0.1651-0.1880 on the ramp alone.
  //    The layer RFC-20 deletes from that file is the full-bleed HAIRLINE
  //    SCREEN over the ramp, which is a different layer and is not this
  //    remedy.
  return opts.groundFallback === false
    ? undefined
    : {
        kind: "colour-block-ground",
        slide: slideN,
        archetype: "cover",
        reason: `slide ${slideN} had no imagery and no sourced figure; rendering it on the cover archetype's colour-block ground`,
      };
}

/** `no-device` on the closer: a recap of the post's own points, then a question the post already asks. */
function closerRemedy(slide: InstagramSlideCopy, copy: InstagramCopyOutput): InterestRelayoutChange | undefined {
  const rows = recapRowsBefore(copy, slide.n);
  if (rows.length >= 2) {
    return {
      kind: "build-recap",
      slide: slide.n,
      rows,
      archetype: "closer",
      reason: `slide ${slide.n} closed on an empty plate; building a recap strip from slide(s) ${rows.map((r) => r.fromSlide).join(", ")}`,
    };
  }
  const question = questionInPost(slide, copy);
  return question === undefined
    ? undefined
    : {
        kind: "add-question-block",
        slide: slide.n,
        question: question.question,
        from: question.from,
        reason: `slide ${slide.n} closed on an empty plate and the post has too few earlier points to recap; promoting the question it already asks (from the ${question.from})`,
      };
}

/** The `08a1b` step's own output line and the gate's `interestRelayout` entry. */
function noteFor(change: InterestRelayoutChange): string {
  return `${change.kind} (slide ${change.slide}): ${change.reason}`;
}
