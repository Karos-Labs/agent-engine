/**
 * What a gate should FIX rather than bounce a post over.
 *
 * ## The waste this exists for
 *
 * The three prep runs of 2026-09-18 each bought THREE full copy attempts, at
 * roughly $0.40 apiece: $1.14 of a $2.39 run, 48% of the bill. What the
 * rejections said, verbatim:
 *
 *   "caption failed the mechanical craft-hygiene gate: text contains a banned
 *    em dash, en dash, or double hyphen"
 *   "slides 4, 5, 8 all open with the word 'the'"
 *   "the caption reproduces 6 consecutive words of a fact card"
 *
 * Every one is a targeted edit. The first is a one-character edit. And each
 * bounced an eight-slide carousel plus its caption back to the model to be
 * written again from nothing.
 *
 * Worse than the price: a rewrite is a NEW RANDOM DRAW. In two of the three
 * runs the second attempt fixed the finding and broke something else, and the
 * third attempt fixed that and broke a third thing. That is why every run
 * spends its whole attempt budget — the loop is not converging, it is
 * resampling.
 *
 * ## Why the dash is repaired in code and not by a model
 *
 * A dash is not a judgement. The copy guide bans em dashes, en dashes and
 * double hyphens because they are the most-cited tell of machine writing, and
 * a model that emitted one did not mean anything by it. Asking a model to fix
 * it costs a redraft; asking code costs nothing and cannot introduce a new
 * violation somewhere else in the post.
 *
 * A comma is the replacement because it is grammatical in the overwhelmingly
 * common use, the parenthetical, and because the alternative is not "better
 * punctuation" but "an eight-slide post rewritten from scratch". The repair
 * is RECORDED on the run, so a reviewer reads that it happened rather than
 * discovering a comma they did not write.
 *
 * This is the owner's own standing pattern, stated in
 * `never-hold-on-an-internal-gate`: repair deterministically where the answer
 * is mechanical, and spend a model call only where judgement is required.
 */

import type { InstagramCopyOutput, InstagramSlideCopy } from "./types.js";

/**
 * The dashes the copy guide bans, and the reason the set is exactly these
 * three: they are what `gate.lintPost` scans for, so anything this leaves
 * behind still bounces the post and anything it adds is invisible to the
 * gate.
 */
const BANNED_DASH = /\s*(?:—|–|--)\s*/gu;

/** A dash at the very start or end of a field is not punctuation, it is a stray. */
const EDGE_DASH = /^\s*(?:—|–|--)\s*|\s*(?:—|–|--)\s*$/gu;

/**
 * A line that OPENS with an arrow: the glyph, the double glyph, a guillemet,
 * or either ASCII spelling, followed by space and something.
 *
 * Anchored to the line start because that is what makes it a bullet. An arrow
 * inside a sentence ("revenue fell 4% -> the round was pulled") is prose and
 * none of this rule's business -- the same boundary `usesArrowBullets` draws
 * in `post-performance.ts`, and drawn the same way on purpose.
 */
const ARROW_BULLET_LINE = /^([ \t]*)(?:→|⇒|»|->|=>)[ \t]+(?=\S)/u;

/**
 * How many arrow-bulleted lines one caption may keep.
 *
 * ONE. A device used once is a device; used four times down a caption it is a
 * template, which is what the owner has now said three times -- most recently
 * on 2026-09-20: *"there are still arrows in the post's text all the time and
 * it is already templated and happens too much."*
 */
export const MAX_ARROW_BULLETS_PER_CAPTION = 1;

export interface MechanicalRepair {
  /** Where it was, precisely enough for a reviewer to look: `"caption"`, `"slide 3 headline"`. */
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

/**
 * Replace a banned dash with a comma, everywhere in one string.
 *
 * An EDGE dash is deleted rather than commafied: a field that opens or closes
 * on a dash has no clause on one side of it, so a comma there would be a
 * stray of its own.
 *
 * The result is squeezed for the double space and the comma-comma a naive
 * replacement leaves when the model already punctuated around the dash.
 */
export function repairDashes(text: string): string {
  return text
    .replace(EDGE_DASH, "")
    .replace(BANNED_DASH, ", ")
    .replace(/\s*,\s*,\s*/gu, ", ")
    .replace(/\s+,/gu, ",")
    .replace(/,\s*([.!?;:])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .trimEnd();
}

function repairSlide(slide: InstagramSlideCopy, out: MechanicalRepair[]): InstagramSlideCopy {
  const at = (field: string, value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const fixed = repairDashes(value);
    if (fixed !== value) out.push({ field: `slide ${slide.n} ${field}`, before: value, after: fixed });
    return fixed;
  };

  const headline = at("headline", slide.headline)!;
  const body = at("body", slide.body)!;
  const items = slide.items?.map((item, i) => ({
    ...item,
    title: at(`item ${i + 1} title`, item.title)!,
    ...(item.note === undefined ? {} : { note: at(`item ${i + 1} note`, item.note)! }),
  }));
  const stat =
    slide.stat === undefined
      ? undefined
      : { ...slide.stat, subLabel: at("stat label", slide.stat.subLabel)!, source: at("stat source", slide.stat.source)! };
  const quote =
    slide.quote === undefined ? undefined : { ...slide.quote, text: at("quote", slide.quote.text)! };

  return {
    ...slide,
    headline,
    body,
    ...(items === undefined ? {} : { items }),
    ...(stat === undefined ? {} : { stat }),
    ...(quote === undefined ? {} : { quote }),
  };
}

/**
 * Keep the first arrow bullet, strip the marker from the rest.
 *
 * ## Why this is a repair and not a rewrite
 *
 * It changes how many lines carry a marker. It does not change a word, a
 * clause, an order or an argument: `"-> Ship faster"` becomes `"Ship faster"`
 * on the same line, in the same place, saying the same thing. That is the bar
 * this module sets for itself -- *"it repairs ONLY what has a single correct
 * answer that needs no reading of the argument"* -- and a count has one.
 *
 * ## Why it is not another prompt sentence
 *
 * Because two already exist and neither reached the caption the owner is
 * looking at. `instagram-copy@23` section 2 PERMITS arrow bullets, which the
 * writer read as a recommendation; `instagram-copy@26` section 16 carries
 * `deviceSteer`, which is fed by `arrowBulletSteer` and needs
 * `usedArrowBullets` on two of the last three posts -- a field that shipped
 * the same day and that no historical record carries, so it is structurally
 * silent until three more posts ship.
 *
 * The steer stays: it is the right instrument for the ACROSS-POSTS half, and
 * it says something this cannot ("your last three posts all did this"). This
 * is the WITHIN-POST half, it needs no history, and it works on the next run.
 *
 * Leading whitespace is preserved, so an indented list stays indented.
 */
export function repairArrowBullets(caption: string): string {
  let kept = 0;
  return caption
    .split(/\r?\n/u)
    .map((line) => {
      if (!ARROW_BULLET_LINE.test(line)) return line;
      kept += 1;
      if (kept <= MAX_ARROW_BULLETS_PER_CAPTION) return line;
      return line.replace(ARROW_BULLET_LINE, "$1");
    })
    .join("\n");
}

/**
 * Every mechanically-repairable tell in a draft, repaired.
 *
 * Returns a NEW copy and the list of what changed. An empty list means the
 * draft was already clean and the caller has the same object's worth of text
 * it had before, which is the case on most attempts.
 *
 * Deliberately narrow. It repairs ONLY what has a single correct answer that
 * needs no reading of the argument. "Three slides open with the word the" is
 * not in here and must not be: choosing a different opening is writing.
 */
export function repairMechanicalTells(copy: InstagramCopyOutput): { copy: InstagramCopyOutput; repairs: MechanicalRepair[] } {
  const repairs: MechanicalRepair[] = [];
  const dashed = repairDashes(copy.caption);
  if (dashed !== copy.caption) repairs.push({ field: "caption", before: copy.caption, after: dashed });
  // After the dash repair, on the dash-repaired text: the two are independent
  // (a dash is punctuation inside a line, an arrow is a marker at its start)
  // and running them in one pass would make the second read the first's input.
  const caption = repairArrowBullets(dashed);
  if (caption !== dashed) repairs.push({ field: "caption arrow bullets", before: dashed, after: caption });
  const slides = copy.slides.map((slide) => repairSlide(slide, repairs));
  return { copy: { ...copy, caption, slides }, repairs };
}

/** One line for the run's trace and the reviewer's note. */
export function describeRepairs(repairs: readonly MechanicalRepair[]): string {
  if (repairs.length === 0) return "";
  const arrows = repairs.filter((r) => r.field === "caption arrow bullets").length;
  const dashes = repairs.length - arrows;
  const parts: string[] = [];
  if (dashes > 0) parts.push(`${dashes} banned dash(es)`);
  if (arrows > 0) parts.push(`a caption down to ${MAX_ARROW_BULLETS_PER_CAPTION} arrow bullet(s)`);
  return (
    `repaired ${parts.join(" and ")} in code rather than buying a redraft over punctuation: ` +
    repairs.map((r) => r.field).join(", ")
  );
}
