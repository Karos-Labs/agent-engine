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
  const caption = repairDashes(copy.caption);
  if (caption !== copy.caption) repairs.push({ field: "caption", before: copy.caption, after: caption });
  const slides = copy.slides.map((slide) => repairSlide(slide, repairs));
  return { copy: { ...copy, caption, slides }, repairs };
}

/** One line for the run's trace and the reviewer's note. */
export function describeRepairs(repairs: readonly MechanicalRepair[]): string {
  if (repairs.length === 0) return "";
  return (
    `repaired ${repairs.length} banned dash(es) in code rather than buying a redraft over punctuation: ` +
    repairs.map((r) => r.field).join(", ")
  );
}
