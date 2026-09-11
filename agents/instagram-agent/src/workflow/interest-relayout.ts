import { MIN_CLAIM_MATCH, type ImageSelection, type InstagramCopyOutput, type InstagramSlideCopy, type InstagramSlideLayout } from "./types.js";
import { fallbackArchetypePreferences, type SlideStyleOverride } from "./slides-data.js";
import type { InterestFailureKind, InterestFinding } from "./interest-floor.js";

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
 * The one device shape a free remedy can build: a figure, its label, and the
 * source that figure came from.
 *
 * Structurally a `SlideDevice`'s `figure` member (item M's
 * `SlideDeviceSchema`), declared here so this module does not have to wait on
 * that schema to typecheck — the workflow's own assignment of this object
 * onto the slide is where the two shapes actually have to agree, and that is
 * the call site the compiler checks.
 *
 * The caps are item M's schema caps, enforced here so a plan can never carry
 * a value the schema would reject: a figure never breaks mid-number, so a
 * 13-character "value" is not a figure, it is a sentence.
 */
export interface RelayoutFigureDevice {
  kind: "figure";
  /** ≤ 12 chars, verbatim from the source text — "42%", "4.2x", "$1.8B". */
  value: string;
  /** ≤ 80 chars. Wraps beneath the figure, in the text face. */
  label: string;
  /** ≤ 120 chars. Item M's rule: every figure names its source. */
  source: string;
}

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
// Reading figures out of prose
// ─────────────────────────────────────────────────────────────────────────

/**
 * A figure token anywhere in a sentence, captured VERBATIM so it can be set
 * as a device value unchanged.
 *
 * Local rather than reusing `LEADS_WITH_FIGURE` (`visual-qa-pre-checks.ts`):
 * that regex is `^`-anchored and exists to answer a different question ("does
 * this slide OPEN with a number"), and it carries no `g` flag on purpose. And
 * local rather than reusing `claimFigures` (`fact-cards.ts`): that one works
 * on NORMALISED text and returns lossy identity keys ("42 pct"), which is
 * right for deduping claims and wrong for typesetting — a device value has to
 * be the string a reader sees.
 *
 * `(?:19|20)\d{2}` with no unit is skipped below for the reason
 * `claimFigures` skips it: "2026 was the year…" is a date, not a statistic.
 * The digit run cannot END on a separator (`\d(?:[\d.,]*\d)?`), so "2," in
 * "5 rounds to 2, a 60% drop" yields the figure `2` and not `2,` — a device
 * value is typeset verbatim, and a trailing comma would ship.
 */
const FIGURE_IN_TEXT = /(?:[$€£₪]\s?)?\d(?:[\d.,]*\d)?\s?(?:%|[kKmM]\b|x\b|million|billion|bn\b|אלף|מיליון|מיליארד)?/gu;

/** Item M's schema cap on a device value: past 12 characters it is not a figure. */
export const MAX_DEVICE_VALUE_LENGTH = 12;
/** Item M's schema cap on a device label. */
export const MAX_DEVICE_LABEL_LENGTH = 80;
/** Item M's schema cap on a device source. */
export const MAX_DEVICE_SOURCE_LENGTH = 120;

interface FoundFigure {
  /** The verbatim token, trimmed — what gets typeset. */
  value: string;
  /** The match exactly as it appeared, including a trailing space the unit group did not consume. Used to cut the figure out of its sentence by POSITION. */
  raw: string;
  /** Where `raw` started in the text it was found in. */
  index: number;
  /** A figure carrying a unit is a stronger device than a bare count. */
  hasUnit: boolean;
}

/**
 * Every usable figure in `text`, strongest first: units before bare counts,
 * then first occurrence. Years without a unit and tokens over
 * `MAX_DEVICE_VALUE_LENGTH` are dropped rather than truncated — half a number
 * is worse than no device.
 */
export function figuresInText(text: string): FoundFigure[] {
  const found: FoundFigure[] = [];
  // A fresh regex per call: a module-level `g` regex carries `lastIndex`
  // between calls, which is the classic every-other-call miss.
  const pattern = new RegExp(FIGURE_IN_TEXT.source, "gu");
  for (const match of text.matchAll(pattern)) {
    const value = match[0].trim();
    if (value.length === 0 || value.length > MAX_DEVICE_VALUE_LENGTH) continue;
    const hasUnit = /[%$€£₪xkKmM]|million|billion|bn|אלף|מיליון|מיליארד/u.test(value);
    if (!hasUnit && /^(?:19|20)\d{2}$/u.test(value)) continue;
    found.push({ value, raw: match[0], index: match.index, hasUnit });
  }
  return found.sort((a, b) => Number(b.hasUnit) - Number(a.hasUnit) || a.index - b.index);
}

/**
 * The sentences of `text` with the offset each one starts at.
 *
 * Offsets, not just strings, because the figure has to be cut out of its
 * label by POSITION. Cutting it by `String.replace(value, …)` looked
 * equivalent and was not: on "In 2024 we saved 4 hours a week" the figure is
 * `4`, and replacing the first `"4"` mangles the year into `202` and leaves
 * the real figure in the label.
 */
function sentencesWithOffsets(text: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let cursor = 0;
  for (const piece of sentencesOf(text)) {
    const start = text.indexOf(piece, cursor);
    if (start < 0) continue;
    out.push({ text: piece, start });
    cursor = start + piece.length;
  }
  return out;
}

/** Sentence boundaries that hold for both Latin and Hebrew copy — `.`/`!`/`?` plus the Arabic-script question mark `؟` (Hebrew copy uses Latin punctuation), and the line break the writer's bodies often use. */
const SENTENCE_SPLIT = /(?<=[.!?؟])\s+|\n+/u;

function sentencesOf(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Trim to `max` characters at a word boundary, so a label never ends mid-word. */
function clampWords(text: string, max: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/u, "");
}

/**
 * A device built from one figure found in `text`, labelled with the rest of
 * that figure's own sentence and sourced from `source`.
 *
 * Returns `undefined` rather than a partial device whenever any of the three
 * fields cannot be filled honestly: no figure, nothing left to label it with,
 * or no source. Item M's rule is that every figure names its source, and a
 * device with a manufactured label is exactly the "technically correct and
 * empty" this whole item exists to refuse.
 */
export function deviceFromText(text: string, source: string): RelayoutFigureDevice | undefined {
  const figure = figuresInText(text)[0];
  if (figure === undefined) return undefined;
  // The label is the figure's own sentence with the figure cut out BY
  // POSITION — see `sentencesWithOffsets` for the defect that made positions
  // necessary.
  const sentence = sentencesWithOffsets(text).find((s) => figure.index >= s.start && figure.index < s.start + s.text.length);
  const scope = sentence ?? { text, start: 0 };
  const localIndex = figure.index - scope.start;
  const label = clampWords(`${scope.text.slice(0, localIndex)} ${scope.text.slice(localIndex + figure.raw.length)}`, MAX_DEVICE_LABEL_LENGTH);
  if (label.length === 0) return undefined;
  const trimmedSource = clampWords(source, MAX_DEVICE_SOURCE_LENGTH);
  if (trimmedSource.length === 0) return undefined;
  return { kind: "figure", value: figure.value, label, source: trimmedSource };
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
const KIND_PRIORITY: readonly InterestFailureKind[] = ["render-integrity", "clipped", "no-device", "dead-space", "empty", "text-wall"];

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
      if (device !== undefined && DEVICE_SLOT_ARCHETYPES.has(current)) {
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

/** `no-device` on the cover: an image, then a figure, then a graphic ground. */
function coverRemedy(
  slide: InstagramSlideCopy,
  copy: InstagramCopyOutput,
  selections: readonly ImageSelection[],
  factCards: readonly RelayoutFactCard[],
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
  return {
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
