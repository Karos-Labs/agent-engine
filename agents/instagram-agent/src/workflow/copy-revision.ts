/**
 * A retry that EDITS the draft instead of writing a new one.
 *
 * ## The two things wrong with a rewrite, and the second is the worse one
 *
 * The three prep runs of 2026-09-18 each spent their whole attempt budget.
 * $1.14 of a $2.39 run went on three copy attempts. What bounced them,
 * verbatim, was a banned em dash, then *"slides 4, 5, 8 all open with the word
 * 'the'"*, then *"the caption reproduces 6 consecutive words of a fact card"*.
 *
 * Every one of those is a targeted edit, and every one bought an eight-slide
 * carousel plus its caption written again from nothing.
 *
 * The price is the smaller half. A rewrite is a NEW RANDOM DRAW: in two of the
 * three runs attempt 2 fixed the finding and broke something else, and attempt
 * 3 fixed that and broke a third thing. The loop was not converging, it was
 * resampling, and that is why every run reached three attempts. The owner's
 * words: *"חבל על הכסף סתם וזה לא חכם"*.
 *
 * An edit cannot do that. What the gates passed is untouched **by
 * construction** rather than by the model's good intentions, so the second
 * attempt can only be the first attempt plus the fixes.
 *
 * ## Why a path string and not a nested patch object
 *
 * `slide.3.headline` is one required field a model fills in correctly or
 * obviously does not, and every rejection this file can produce names the path
 * it could not resolve. A nested patch would let a model half-specify a target
 * and leave the code guessing which slide it meant, and guessing is what puts
 * an edit on the wrong plate.
 *
 * ## Nothing here trusts the model about WHERE
 *
 * Every path is resolved against the draft that actually exists. A slide
 * number nothing carries, a field an archetype does not have, an item index
 * past the end of the list: each is REJECTED with its reason, never created.
 * A revision that invents `slide.9.headline` on an eight-slide post is a
 * revision that would otherwise have grown the post by a slide nobody wrote.
 */

import { z } from "zod";
import type { InstagramCopyOutput, InstagramSlideCopy } from "./types.js";

export const CopyEditSchema = z.object({
  /**
   * What to change, as a dotted path into the draft.
   *
   * `caption` | `slide.<n>.headline` | `slide.<n>.body` |
   * `slide.<n>.items.<i>.title` | `slide.<n>.items.<i>.note` |
   * `slide.<n>.stat.subLabel` | `slide.<n>.quote.text`
   *
   * `<n>` is the slide's own `n`, which is what the findings name, not its
   * index in the array.
   */
  path: z.string().min(1).max(60),
  /** The replacement text for that one field. */
  text: z.string().min(1).max(600),
  /** Which finding this edit answers, in the finding's own words. One line. */
  fixes: z.string().min(1).max(300),
});
export type CopyEdit = z.infer<typeof CopyEditSchema>;

export const CopyRevisionSchema = z.object({
  /**
   * Capped at twelve, and the cap is the point rather than a guard against
   * runaway output: a revision that needs to touch more than twelve fields is
   * a rewrite wearing an edit's clothes, and the caller should know that
   * rather than absorb it.
   */
  edits: z.array(CopyEditSchema).min(1).max(12),
  /** What was deliberately LEFT ALONE, and why. The anti-thrash half. */
  kept: z.string().min(1).max(600),
});
export type CopyRevision = z.infer<typeof CopyRevisionSchema>;

export interface RejectedEdit {
  readonly path: string;
  readonly reason: string;
}

export interface AppliedRevision {
  readonly copy: InstagramCopyOutput;
  readonly applied: CopyEdit[];
  readonly rejected: RejectedEdit[];
}

const PATH = {
  caption: /^caption$/u,
  slideField: /^slide\.(\d+)\.(headline|body)$/u,
  item: /^slide\.(\d+)\.items\.(\d+)\.(title|note)$/u,
  stat: /^slide\.(\d+)\.stat\.subLabel$/u,
  quote: /^slide\.(\d+)\.quote\.text$/u,
} as const;

function editSlide(
  slides: InstagramSlideCopy[],
  n: number,
  edit: (slide: InstagramSlideCopy) => InstagramSlideCopy | string,
): string | undefined {
  const index = slides.findIndex((s) => s.n === n);
  if (index < 0) return `slide ${n} is not in this draft (it has ${slides.map((s) => s.n).join(", ")})`;
  const next = edit(slides[index]!);
  if (typeof next === "string") return next;
  slides[index] = next;
  return undefined;
}

/**
 * Apply a revision to a draft.
 *
 * Returns a NEW copy. Order is the model's own, and a later edit to the same
 * path wins, which is the ordinary meaning of a list of edits.
 */
export function applyCopyEdits(copy: InstagramCopyOutput, revision: CopyRevision): AppliedRevision {
  const slides = [...copy.slides];
  let caption = copy.caption;
  const applied: CopyEdit[] = [];
  const rejected: RejectedEdit[] = [];

  for (const edit of revision.edits) {
    const path = edit.path.trim();
    const text = edit.text.trim();
    if (text.length === 0) {
      rejected.push({ path, reason: "the replacement text is empty, and a field this draft renders cannot be blanked by an edit" });
      continue;
    }

    let failure: string | undefined;
    let matched = true;

    const slideField = PATH.slideField.exec(path);
    const item = PATH.item.exec(path);
    const stat = PATH.stat.exec(path);
    const quote = PATH.quote.exec(path);

    if (PATH.caption.test(path)) {
      caption = text;
    } else if (slideField !== null) {
      failure = editSlide(slides, Number(slideField[1]), (s) => ({ ...s, [slideField[2]!]: text }) as InstagramSlideCopy);
    } else if (item !== null) {
      const i = Number(item[2]) - 1;
      failure = editSlide(slides, Number(item[1]), (s) => {
        if (s.items === undefined || s.items[i] === undefined) {
          return `slide ${s.n} has ${s.items?.length ?? 0} item(s), so item ${i + 1} is not there to edit`;
        }
        const items = [...s.items];
        items[i] = { ...items[i]!, [item[3]!]: text };
        return { ...s, items };
      });
    } else if (stat !== null) {
      failure = editSlide(slides, Number(stat[1]), (s) =>
        s.stat === undefined ? `slide ${s.n} carries no stat, so there is no label to edit` : { ...s, stat: { ...s.stat, subLabel: text } },
      );
    } else if (quote !== null) {
      failure = editSlide(slides, Number(quote[1]), (s) =>
        s.quote === undefined ? `slide ${s.n} carries no quote, so there is no quote text to edit` : { ...s, quote: { ...s.quote, text } },
      );
    } else {
      matched = false;
    }

    if (!matched) {
      rejected.push({ path, reason: "not a field a revision may address; nothing was changed" });
    } else if (failure !== undefined) {
      rejected.push({ path, reason: failure });
    } else {
      applied.push({ ...edit, path, text });
    }
  }

  return { copy: { ...copy, caption, slides }, applied, rejected };
}

/** The draft as the reviser reads it: every addressable field, with its path. */
export function addressableFields(copy: InstagramCopyOutput): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [{ path: "caption", text: copy.caption }];
  for (const s of copy.slides) {
    out.push({ path: `slide.${s.n}.headline`, text: s.headline });
    out.push({ path: `slide.${s.n}.body`, text: s.body });
    (s.items ?? []).forEach((item, i) => {
      out.push({ path: `slide.${s.n}.items.${i + 1}.title`, text: item.title });
      if (item.note !== undefined) out.push({ path: `slide.${s.n}.items.${i + 1}.note`, text: item.note });
    });
    if (s.stat !== undefined) out.push({ path: `slide.${s.n}.stat.subLabel`, text: s.stat.subLabel });
    if (s.quote !== undefined) out.push({ path: `slide.${s.n}.quote.text`, text: s.quote.text });
  }
  return out;
}

/** One line for the trace: what changed, what was refused, and what the reviser said it kept. */
export function describeRevision(result: AppliedRevision, revision: CopyRevision): string {
  const changed = result.applied.map((e) => e.path).join(", ") || "nothing";
  const refused = result.rejected.length === 0 ? "" : `; ${result.rejected.length} edit(s) refused: ${result.rejected.map((r) => `${r.path} (${r.reason})`).join("; ")}`;
  return `revised ${result.applied.length} field(s) rather than rewriting the post: ${changed}${refused}. Kept: ${revision.kept}`;
}
