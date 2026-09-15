import type { InstagramCopyOutput, InstagramSlideCopy, InstagramSlideLayout } from "./types.js";

/**
 * # THE BOUNDED OBJECT — RFC-20 §11.4
 *
 * `headline_focus` and heroless `slide.html` are the two bundled archetypes
 * that carry no photograph and no structured panel. RFC-20 §11.2 measured
 * what that leaves: composed to the Ground Rule with nothing painted on them
 * they are **type on ground and nothing else**, and §11.3 stated it as
 * plainly as it can be stated —
 *
 * > *two of our eight archetypes ARE the mostly-grey screen the owner
 * > complained about, and the decoration was hiding that from our own gate.*
 *
 * The answer the phase reached for twice was PAINT — `.copy-art`'s hatch, and
 * before it `.hf-plate`'s plinth — and §11.1 is the record of what paint does
 * to the instrument:
 *
 * > *any full-frame painted layer that a plate has not earned will be scored
 * > by some clause as the evidence that clause was built to look for.*
 *
 * **This module is the other answer.** Not more ground: a bounded OBJECT,
 * derived from copy the run already holds, at **$0.00 and no model call** —
 * the same cost profile as the rest of the phase.
 *
 * ## Why an object rather than a better number
 *
 * `docs/instagram-restraint-reference.md`, harvested from the accounts that
 * ship our format and look professional doing it:
 *
 *   * `@semrush`'s statement plate is one flat near-black ground carrying a
 *     four-node diagram, and **its entire lower-left quadrant is empty**.
 *   * `@buffer`'s is one flat deep-green ground carrying a cut-out portrait,
 *     five small squares, and nothing else.
 *
 * Neither plate is low-occupancy because it is empty. **Both are low-occupancy
 * because they are confident**, and what makes the quiet read as confidence
 * rather than as neglect is the one object in frame. RFC-20 §4 recorded this
 * and did not follow it: *"the reference execution is an object on a quiet
 * ground. We took the quiet ground and skipped the object."*
 *
 * ## THE THREE SUBJECTS A STATEMENT PLATE MAY CARRY, and there is no fourth
 *
 * Ranked, and every one of them is content the plate already owns:
 *
 * 1. **A device the writer asked for** (`slide.device`) — passed through
 *    untouched. The model is allowed to compose its own object and usually
 *    should.
 * 2. **A figure device built from the slide's OWN COPY** — `deviceFromText`
 *    below, a deterministic regex over a string the run already holds.
 * 3. **The typography itself**, when the statement is set at display scale.
 *    This one is not built here; it is already true of these plates, and
 *    `interest-floor.ts`'s `plateSubject` reads it off the DOM
 *    (`displayTypeScale`) where no palette can reach it.
 *
 * **AND A PLATE WITH NONE OF THE THREE IS REFUSED, which is the floor working
 * rather than a regression.** RFC-20 §11.4 item 2 proposed a fourth limb — an
 * *"eyebrow-rail plinth fallback"* for a plate whose copy carries no figure.
 * **That limb is REFUSED here and the refusal is the whole of §11.1**: a
 * plinth is a painted panel a plate has not earned, it was measured
 * disarming clauses B, D, E and F at once, and §11.1's closing sentence is
 * that *there is no plinth that pays clause D without disarming clause E*.
 * Building one back as the fallback for the object would be the third
 * instance of the same defect in the same phase. A plate that has nothing to
 * put in frame does not need a panel behind its copy; it needs different
 * copy, and the floor saying so is the instrument doing its job.
 *
 * ## THE ONE RULE THIS MODULE MAY NOT BREAK
 *
 * Prep run `pubsub-21839432908803804` fabricated the digit `2` out of the
 * middle of the word `B2B`, labelled it with the claim minus that digit, and
 * printed `salesforce.com` under it as the source. **A fabricated statistic,
 * sourced to a real company, on the cover.** The owner's instruction after
 * reading it is the standard this module is held to:
 *
 * > *"interest comes from bold typography, excellent contrast and strong
 * > visuals — not from extra layers, random gradients or invented numbers."*
 *
 * So: every figure here is a verbatim token that was already in the slide's
 * own copy, every label is the rest of that figure's own sentence, and every
 * device names the source the slide already cited. `isStandaloneFigure` is
 * the guard that incident bought. **Nothing in this file may ever construct a
 * number, and a device that cannot be filled honestly is returned as
 * `undefined` rather than as a partial.**
 *
 * ## Why this file exists rather than a function in `interest-relayout.ts`
 *
 * The figure readers below were written there, for the REMEDY path — a plate
 * that has already failed the floor, been re-planned and re-rendered. Reaching
 * them at COMPOSE time is the difference between a plate that was designed
 * around its object and a plate that was patched into having one, and it saves
 * the render the remedy costs. `interest-relayout.ts` imports
 * `slides-data.ts`, so `slides-data.ts` cannot import it back; the primitives
 * moved here, where both can see them, and `interest-relayout.ts` re-exports
 * them so its own callers and tests are untouched.
 */

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
const FIGURE_IN_TEXT = /(?:[$€£₪]\s?)?\d(?:[\d.,]*\d)?\s?(?:%|[kKmMbB]\b|x\b|million|billion|bn\b|אלף|מיליון|מיליארד)?/gu;

/**
 * ── THE WORD-BOUNDARY GUARD, AND THE INCIDENT THAT BOUGHT IT ──
 *
 * Prep run `pubsub-21839432908803804`, 2026-09-14. The cover failed clause C,
 * the free re-layout planner reached for `deviceFromText` to fill the hole,
 * and the regex above matched the **`2` inside `B2B`**. What shipped was a
 * display numeral reading `2`, a label reading *"Inbound pipeline loss isn't a
 * product problem B B marketing teams are losing"* — the claim with the digit
 * cut out of the middle of the word — and `salesforce.com` printed under it as
 * the source.
 *
 * **A fabricated statistic, sourced to a real company, on the cover.** That is
 * worse than an ugly slide: every other defect in this system makes a post
 * look bad, and this one makes it WRONG, with a citation.
 *
 * `\d` matches a digit wherever it sits, so every alphanumeric token was a
 * candidate: `B2B`, `Web3`, `5G`, `S3`, `H1`, `GPT-4`, `COVID-19`. The regex
 * was written to find "a figure token anywhere in a sentence" and it did
 * exactly that; what it never asked is whether the digits were a NUMBER or
 * part of a NAME.
 *
 * Checked on the match's neighbours rather than folded into the pattern,
 * because the pattern is already at the limit of what a reader can verify by
 * eye, and because a rejected candidate should be explainable in one line.
 */
function isStandaloneFigure(text: string, match: RegExpMatchArray): boolean {
  const start = match.index ?? 0;
  // The END OF THE TRIMMED MATCH, not of the match. `FIGURE_IN_TEXT`'s
  // `\s?` before the unit group consumes a trailing space when no unit
  // follows, so `match[0]` for "5 rounds" is `"5 "` and the raw end lands
  // on the `r`. Read that way the guard rejected every bare count followed
  // by a word -- which is most of them -- and the unit tests caught it.
  const end = start + match[0].replace(/\s+$/u, "").length;
  const before = text.slice(Math.max(0, start - 2), start);
  const after = text.slice(end, end + 1);
  // Glued to a word on the left: `B2B`, `Web3`, `S3`, `H1`.
  if (/[\p{L}\p{N}]$/u.test(before)) return false;
  // Hyphenated onto a name: `GPT-4`, `COVID-19`. The hyphen alone is not
  // enough to reject — "5 rounds to 2 - a 60% drop" is a real figure — so the
  // letter BEFORE the hyphen is what decides.
  if (/[\p{L}\p{N}][-\u2010-\u2015]$/u.test(before)) return false;
  // A letter immediately after a figure the unit group did not claim: `5G`,
  // `3D`, `4K`. `$1.8B` and `4.2x` are unaffected — their unit is consumed by
  // the match, so `after` is whatever follows the unit.
  if (/[\p{L}\p{N}]/u.test(after)) return false;
  return true;
}

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
    // The digits have to BE a number, not sit inside a name. See the incident
    // above `isStandaloneFigure`.
    if (!isStandaloneFigure(text, match)) continue;
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

export function sentencesOf(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Trim to `max` characters at a word boundary, so a label never ends mid-word. */
export function clampWords(text: string, max: number): string {
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
// The compose-time limb — RFC-20 §11.4 items 1 and 2
// ─────────────────────────────────────────────────────────────────────────

/**
 * The archetypes that get an object composed for them, and why it is exactly
 * these two.
 *
 * `headline_focus` and `text_only` are the whole of RFC-20 §11.2's problem
 * band: the interior minimum `occupiedShare` in that sweep was **0.0383**,
 * below the neglected ceiling of 0.0562, and the rows that produced it were
 * `headline_focus` (0.0544–0.1252) and heroless `slide.html` (0.0383–0.0942).
 * Every other bundled archetype measures 0.31–0.61 and is indifferent to all
 * of this — `stat_callout`, `quote_card`, `comparison_card` and
 * `list_takeaway` are structured panels that carry their own object by
 * construction, and composing a second one onto them would be the "nine
 * element groups" cover the restraint reference was harvested to refuse.
 *
 * **`photo` is deliberately absent even though it renders the same file.** A
 * `photo` slide's object is its photograph; a device painted over it is a
 * second subject on a plate that already has one. A `photo` slide that cannot
 * be filled is reassigned to `text_only` by the workflow before it ever
 * reaches here (`InstagramSlideLayoutSchema`'s own note), so the heroless
 * path is `text_only` and nothing is lost by naming it precisely.
 */
export const BOUNDED_OBJECT_LAYOUTS: ReadonlySet<InstagramSlideLayout> = new Set<InstagramSlideLayout>(["headline_focus", "text_only"]);

/** How much copy a statement plate can carry and still hold a ~300px device. See `boundedObjectFor`. */
export const MAX_COPY_FOR_OBJECT = 200;

/*
 * 200, MEASURED DOWN FROM 300 ON CI 34982681595.
 *
 * At 300 the MEDIUM fixture (63 + 152 = 215 characters) still received an
 * object, and `headline_focus` at `fontScale l` reported `clipped` — the
 * reviewer's largest type scale makes every sibling in the field 18% taller
 * while the plate does not grow, so a ~300px device stops fitting well before
 * the copy runs out.
 *
 * SHORT is ~100 characters and fits at every scale. MEDIUM does not. So the
 * threshold sits between them, and that is not a compromise — it is the
 * module's own scope arriving at its number. RFC-20 §11.2 measured the plate
 * this object exists for at `occupiedShare` **0.0383-0.1252**: a statement
 * with little on it. A plate carrying 215 characters is not that plate. It has
 * something to read already, and the object would be a third block competing
 * with it rather than the subject a thin plate is missing.
 */

/** A fact card as this module reads it — `ResearchFact` and `FactCardForPrompt` both satisfy it, and so does `RelayoutFactCard`. */
export interface BoundedObjectFactCard {
  claim: string;
  source: string;
}

/** What happened to one slide, for the trace. A composition nobody can audit is a composition nobody can correct. */
export interface BoundedObjectDecision {
  slide: number;
  layout: InstagramSlideLayout;
  outcome: "kept" | "composed" | "refused";
  /** One line a reviewer reads without decoding. */
  reason: string;
  /** The figure that was set, when one was. */
  value?: string;
}

/**
 * The object one statement slide carries, or `undefined` when it honestly
 * carries none.
 *
 * Reads the slide's own headline and body for a figure and the slide's own
 * `sourceRef` for the source that figure was cited to. Both halves must be
 * present: a figure with no source is the shape of a claim a reader should
 * distrust, and item M's rule — *every figure names its source on the slide*
 * — is older than this phase.
 *
 * **There is no fallback limb.** See the module header: §11.4 proposed a
 * plinth and §11.1 is why it is refused.
 *
 * ## IT DOES NOT COMPOSE ONTO A PLATE THAT IS ALREADY FULL
 *
 * Measured on CI 34972021273, the first render where these archetypes carried
 * a device at every copy length: `headline_focus` at LONG and `slide.html` at
 * `long/l` both reported `clipped`, and the pixel limb was nowhere near firing
 * — `probe.overflow` caught it, the block-start limb that exists because this
 * same file once printed its headline 155px above its own parent.
 *
 * The cause is arithmetic rather than a tuning miss. A figure device is a
 * numeral, a rule, a label and a source: about 300px of fixed block that does
 * not shrink with the copy. `.hf-field` and `.sl-field` are elastic but the
 * plate is not, and at `l` every sibling in the field is 18% taller. A long
 * headline plus a long body plus a fixed 300px block does not fit, and no
 * figure size makes it fit without making the numeral pointless.
 *
 * **So the object is composed only where it is FOR.** RFC-20 §11.2 measured
 * the problem it exists to solve: a statement plate with little on it, at
 * `occupiedShare` 0.0383-0.1252. A plate carrying a long headline and a long
 * body is not that plate — it already has something to read, and adding a
 * third block to it is the "nine element groups" cover the restraint reference
 * was harvested to refuse.
 *
 * `MAX_COPY_FOR_OBJECT` is read off the fixtures' own bands rather than
 * guessed: the calibration renders SHORT, MEDIUM and LONG, the first two fit
 * an object at every type scale and the third does not, and LONG is 90 + 307 =
 * 397 characters against MEDIUM's ~200.
 *
 * ## THE BODY IS READ FIRST, AND THE HEADLINE IS NEVER A LABEL
 *
 * The remedy path reads `` `${headline} ${body}` `` as one string, and at
 * compose time that produces a label nobody would write. Measured on the
 * suite's own fixture: a headline carries no full stop, so the sentence
 * splitter sees the pair as ONE sentence and the label came back as
 * *"Triage on arrival, not once the queue is deep Sorting tickets the moment
 * they"* — two thoughts run together and then cut mid-phrase at the 80
 * character cap. On a remedy that is a plate rescued from a hold; on every
 * statement plate we ship it would be the caption under the number.
 *
 * So the two strings are read SEPARATELY and in a deliberate order:
 *
 * 1. **A figure in the BODY**, labelled with its own sentence minus the
 *    figure. The body is prose, it is punctuated, and its sentence is the
 *    one that explains the number.
 * 2. **Else a figure in the HEADLINE — labelled from the BODY.** Never from
 *    the headline itself. The headline is already on this plate, set in the
 *    display face directly beside the device, and a label that restates it
 *    is the defect the restraint reference names on the prep render the
 *    owner read: *"nine element groups on its cover, three of which said the
 *    same sentence."* One subject, said once.
 *
 * A sentence never spans the two fields in either limb, which is the
 * property the run-on above violated.
 */
export function boundedObjectFor(slide: InstagramSlideCopy, factCards: readonly BoundedObjectFactCard[]): RelayoutFigureDevice | undefined {
  if (slide.headline.length + slide.body.length > MAX_COPY_FOR_OBJECT) return undefined;
  const source = factCards.find((card) => card.claim === slide.sourceRef)?.source;
  if (source === undefined || source.trim().length === 0) return undefined;

  const fromBody = deviceFromText(slide.body, source);
  if (fromBody !== undefined) return fromBody;

  // Limb 2. The figure comes from the headline; the label does not.
  const headlineDevice = deviceFromText(slide.headline, source);
  if (headlineDevice === undefined) return undefined;
  // The body's FIRST sentence, which is what a reader takes the number to
  // mean. `undefined` rather than a partial when the body cannot supply one:
  // a figure with no label is a big unattributed number, which is the shape
  // of a claim a reader should distrust, and item M's rule refuses it.
  const label = clampWords(sentencesOf(slide.body)[0] ?? "", MAX_DEVICE_LABEL_LENGTH);
  if (label.length === 0) return undefined;
  return { ...headlineDevice, label };
}

/**
 * Every statement slide in `copy` composed with the object it can carry.
 *
 * Returns a NEW copy — `assembleForAttempt` may run three times for one
 * attempt (07c, the typographic fallback at 08a, the free re-layout's
 * re-render at 08a1c) and each has to see the same input, so mutating the
 * draft in place would make the second assembly a function of the first.
 *
 * ## Three outcomes, and each one is recorded
 *
 * * **kept** — the writer already composed a device for this slide. An
 *   explicit authorial decision beats a derived one, which is the precedence
 *   every other token in this system uses, and the writer can compose a
 *   `bars`, a `timeline` or a `versus` where this function only knows how to
 *   build a `figure`.
 * * **composed** — the slide carried a figure and a source, and now carries
 *   the object built from them.
 * * **refused** — the slide's own copy has no standalone figure, or cites no
 *   source. **Nothing is invented to cover the gap.** The plate goes to the
 *   floor as it is, and if its typography does not carry it either then
 *   clause C and clause G refuse it, which is the instrument working.
 */
export function composeBoundedObjects(
  copy: InstagramCopyOutput,
  factCards: readonly BoundedObjectFactCard[],
): { copy: InstagramCopyOutput; decisions: BoundedObjectDecision[] } {
  const decisions: BoundedObjectDecision[] = [];
  const slides = copy.slides.map((slide) => {
    const layout = slide.layout ?? "photo";
    if (!BOUNDED_OBJECT_LAYOUTS.has(layout)) return slide;
    if (slide.device !== undefined) {
      decisions.push({ slide: slide.n, layout, outcome: "kept", reason: `the draft composed its own ${slide.device.kind} device` });
      return slide;
    }
    const device = boundedObjectFor(slide, factCards);
    if (device === undefined) {
      decisions.push({
        slide: slide.n,
        layout,
        outcome: "refused",
        reason:
          slide.sourceRef === undefined || slide.sourceRef.trim().length === 0
            ? "the slide cites no source, and an unsourced figure is not a device"
            : "the slide's own copy carries no standalone figure — nothing was invented to fill the plate",
      });
      return slide;
    }
    decisions.push({ slide: slide.n, layout, outcome: "composed", reason: `built from a figure already in the slide's own copy`, value: device.value });
    return { ...slide, device };
  });
  return { copy: { ...copy, slides }, decisions };
}
