import { exemplarVoteWeight } from "./exemplar-look.js";
import type { ExemplarLibrary } from "./exemplar-library.js";

/**
 * HOW THE FIRST SLIDE IS COMPOSED, RUN TO RUN (2026-09-26).
 *
 * Owner decision 5 made the poster (a full-bleed photograph under a big
 * title) the default cover, and #317 made it the only one. The owner, on the
 * results: a poster every time turns generic; sometimes the first slide
 * should be a picture in the middle with the words around it, or another
 * cover shape that fits, "according to what you see in the harvests". So the
 * cover's composition is drawn per run from a weighted set:
 *
 * - `poster`: the photograph is the plate and the title stands on it;
 * - `sandwich`: title on top, the picture filling the middle, the deck below;
 * - `framed`: the picture as a block at the top, the words under it.
 *
 * The weights start from the owner's default (mostly posters) and move toward
 * how the client's category actually opens its best posts: the cover type the
 * harvest's vision judge recorded on each reference exemplar, weighted by its
 * craft and its lift over its own account. Seeded on the run, so a resume
 * re-renders the same cover, and a different run can open differently.
 */
export const COVER_COMPOSITIONS = ["poster", "sandwich", "framed"] as const;
export type CoverComposition = (typeof COVER_COMPOSITIONS)[number];

export type CoverWeights = Record<CoverComposition, number>;

/** The owner's default: a poster most of the time, the other two for rhythm. */
export const DEFAULT_COVER_WEIGHTS: CoverWeights = { poster: 0.6, sandwich: 0.25, framed: 0.15 };

/** How much of the mix the harvest may move: half, so the default never disappears. */
const LIBRARY_SHARE = 0.5;
const MIN_ENTRIES = 3;

/** The judge's `coverType` vocabulary, mapped to what a cover can render. */
const FROM_COVER_TYPE: Record<string, Partial<CoverWeights>> = {
  "photo-full-bleed": { poster: 1 },
  person: { poster: 1 },
  product: { poster: 0.5, sandwich: 0.5 },
  illustration: { poster: 1 },
  "photo-framed": { framed: 0.5, sandwich: 0.5 },
  screenshot: { sandwich: 1 },
  collage: { sandwich: 1 },
  moodboard: { sandwich: 1 },
  logo: { framed: 1 },
  typographic: { framed: 0.5, sandwich: 0.5 },
  // Judge 1.2.0 (2026-09-26). Until the renderer grows these looks, each
  // votes for the nearest composition it has: a picture at bleed for a
  // marked-up photo or a drawing, the picture-over-type sandwich for an
  // isolated object, a rendered form or a screen collage.
  "annotated-photo": { poster: 1 },
  doodle: { poster: 1 },
  "ui-collage": { sandwich: 1 },
  "object-on-ground": { sandwich: 1 },
  "abstract-3d": { sandwich: 1 },
};

export function coverWeightsFor(library: ExemplarLibrary | undefined): { weights: CoverWeights; basis: string } {
  if (library === undefined || library.status !== "built") return { weights: DEFAULT_COVER_WEIGHTS, basis: "the owner's default (no exemplar library)" };
  // S1 (2026-09-26): the client's own strong posts vote too, twice (`exemplarVoteWeight`).
  const entries = library.entries.filter((e) => exemplarVoteWeight(e) > 0 && typeof e.dna["coverType"] === "string");
  if (entries.length < MIN_ENTRIES) return { weights: DEFAULT_COVER_WEIGHTS, basis: `the owner's default (${entries.length} exemplar cover(s), fewer than ${MIN_ENTRIES})` };
  const seen: CoverWeights = { poster: 0, sandwich: 0, framed: 0 };
  const types = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    const type = e.dna["coverType"] as string;
    const map = FROM_COVER_TYPE[type];
    if (map === undefined) continue;
    const w = Math.max(1, e.craft) * Math.max(1, Math.min(10, e.lift ?? 1)) * exemplarVoteWeight(e);
    for (const c of COVER_COMPOSITIONS) seen[c] += (map[c] ?? 0) * w;
    types.set(type, (types.get(type) ?? 0) + 1);
    total += w;
  }
  if (total === 0) return { weights: DEFAULT_COVER_WEIGHTS, basis: "the owner's default (no mappable exemplar cover types)" };
  const weights: CoverWeights = { poster: 0, sandwich: 0, framed: 0 };
  for (const c of COVER_COMPOSITIONS) weights[c] = (1 - LIBRARY_SHARE) * DEFAULT_COVER_WEIGHTS[c] + LIBRARY_SHARE * (seen[c] / total);
  const basis = `the owner's default blended with ${entries.length} exemplar covers (${[...types.entries()].map(([t, n]) => `${t} ${n}`).join(", ")})`;
  return { weights, basis };
}

function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Mix the high bits down: raw FNV-1a barely moves them across similar seeds.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** A seeded weighted draw. */
export function pickCoverComposition(weights: CoverWeights, seed: string): CoverComposition {
  const total = COVER_COMPOSITIONS.reduce((sum, c) => sum + Math.max(0, weights[c]), 0);
  if (total <= 0) return "poster";
  let roll = (fnv1a32(`${seed}:cover-composition`) / 0x100000000) * total;
  for (const c of COVER_COMPOSITIONS) {
    roll -= Math.max(0, weights[c]);
    if (roll < 0) return c;
  }
  return "poster";
}
