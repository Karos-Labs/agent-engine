import { prescribesClicheScene } from "./visual-direction.js";
import { MIN_CLAIM_MATCH, selectionPasses, type ImageSelection, type InstagramCopyOutput } from "./types.js";

/**
 * THE COVER IS THE ONE SLIDE EVERY READER SEES (2026-09-25).
 *
 * Prep batch 5, The Pitch by Deel (b): four interior slides carried a
 * photograph and the cover carried none. Its empty field painted as a flat
 * grey band, the visual QA judge read it as a broken placeholder, and the
 * imagery floor said "ok" because four pictures is above three. Geektime (a)
 * was the same shape with two. The owner's verdict on the karoslabs post of
 * the same day: boring, a step back.
 *
 * So when the cover has no usable picture and an interior slide does, the best
 * of them MOVES to the cover. It moves rather than being copied: one picture
 * appears once in a post (`06f2`), and the slide it leaves is set as the
 * typographic plate it can already render. The picture count does not change,
 * so the floor's verdict still holds.
 *
 * Never moved: a logo or cutout (a cover shows a photograph at bleed, not a
 * mark), the screen cliché, and anything the floor would not have admitted.
 * The closer keeps its picture, which it rarely has, because it is the other
 * slide whose job is fixed.
 */
export interface CoverPictureMove {
  from: number;
  path: string;
}

export function coverPictureMove(
  copy: Pick<InstagramCopyOutput, "slides">,
  selections: readonly ImageSelection[],
  /** Paths never moved: logos and cutouts (not photographs) and pictures already shipped in a prior post. */
  excluded: ReadonlySet<string> = new Set(),
): CoverPictureMove | undefined {
  const cover = copy.slides[0];
  if (cover === undefined || copy.slides.length < 3) return undefined;
  const usable = (sel: ImageSelection): sel is ImageSelection & { imagePath: string } =>
    sel.imagePath !== null && selectionPasses(sel).passes;
  const coverSel = selections.find((s) => s.n === cover.n);
  if (coverSel !== undefined && usable(coverSel)) return undefined;
  const closerN = copy.slides[copy.slides.length - 1]!.n;
  const layoutByN = new Map(copy.slides.map((s) => [s.n, s.layout ?? "photo"]));
  const best = selections
    .filter(usable)
    .filter((sel) => sel.n !== cover.n && sel.n !== closerN)
    .filter((sel) => !excluded.has(sel.imagePath))
    .filter((sel) => !prescribesClicheScene(`${sel.reason ?? ""} ${sel.subjectMatchReason ?? ""}`))
    // Best picture first; between equals, take it from a panel slide (where it
    // was a band beside a device) before a photo plate (where it was the plate).
    .sort(
      (a, b) =>
        b.claimMatch - a.claimMatch ||
        Number(layoutByN.get(a.n) === "photo") - Number(layoutByN.get(b.n) === "photo") ||
        a.n - b.n,
    )[0];
  return best === undefined ? undefined : { from: best.n, path: best.imagePath };
}

/** The selections after `move`: the cover takes the picture and its record; the slide it left gets `standIn`. */
export function applyCoverPictureMove(
  selections: readonly ImageSelection[],
  coverN: number,
  move: CoverPictureMove,
  standIn: (n: number) => ImageSelection,
): ImageSelection[] {
  const source = selections.find((s) => s.n === move.from);
  if (source === undefined) return [...selections];
  // `subjectMatch` goes too: it measured the picture against slide `from`'s
  // subject, and the cover's row must not claim a match nobody scored.
  const { subjectMatch: _subject, subjectMatchReason: _subjectReason, ...record } = source;
  void _subject;
  void _subjectReason;
  const moved: ImageSelection = {
    ...record,
    n: coverN,
    reason: `moved from slide ${move.from} to the cover, the one slide every reader sees, which had no usable picture of its own (${source.reason})`,
    // Scored against slide `from`'s claim; nothing re-scores it against the
    // cover's headline, so the verdict is capped at the floor and re-stated,
    // as the interest re-layout's promote does (`PROMOTED_CLAIM_MATCH_CEILING`).
    claimMatch: Math.min(source.claimMatch, MIN_CLAIM_MATCH),
    claimMatchReason: `vetted for slide ${move.from}'s claim at ${source.claimMatch}/5 (${source.claimMatchReason}), then moved to the cover; not re-vetted against the cover's headline`,
  };
  const out = selections.map((sel) => (sel.n === coverN ? moved : sel.n === move.from ? standIn(move.from) : sel));
  return out.some((s) => s.n === coverN) ? out : [moved, ...out];
}
