import type { ExemplarLibrary } from "./exemplar-library.js";

/**
 * THE LOOK THE CATEGORY'S BEST POSTS SHARE (2026-09-26).
 *
 * The owner: setup harvests hundreds of posts and takes the best ones as the
 * templates. The harvest runs (`00h1`) and a vision model records each
 * judged exemplar's design DNA, but the Template Studio stores no templates
 * for any client, so none of it reached a slide: `04p` drew the run's visual
 * system uniformly at random from the catalog. This module reads the
 * library's DNA and states the catalog axes it agrees on, and `04p` ranks
 * the catalog by them before its seeded draw. The variety holds still come
 * first, so the category's taste narrows the pool, never the rotation.
 */
export interface ExemplarLook {
  ground?: "flat" | "grid" | "glyph";
  accentForm?: "rule" | "band" | "field" | "tint" | "none";
  typeScale?: "display" | "editorial" | "condensed";
  /** The votes behind each axis, for the trace. */
  basis: string[];
}

/** An axis needs at least this many exemplars behind its most common value, and a plurality. */
const MIN_VOTES = 2;

/**
 * The client's OWN posts lead when they are good (2026-09-26, S1).
 *
 * Owner: "Deel's own recent posts are prettier". The look and the cover mix
 * were voted by competitors and references only, so a client whose feed the
 * judge graded 5/5 on every post (Hanky Panky, prep batch 8: six of six) was
 * styled after other accounts. A client post graded at least this well votes,
 * and votes twice: it is the brand's own proven look.
 */
export const CLIENT_LEAD_MIN_CRAFT = 4;
export const CLIENT_LEAD_WEIGHT = 2;

/** Whether an entry votes, and how many times: references once, the client's own strong posts twice, its weaker ones not at all. */
export function exemplarVoteWeight(entry: { role: string; craft: number }): number {
  if (entry.role !== "client") return 1;
  return entry.craft >= CLIENT_LEAD_MIN_CRAFT ? CLIENT_LEAD_WEIGHT : 0;
}
/** The strongest exemplars only: craft first, then lift. */
const MAX_ENTRIES = 12;

export const GROUND: Record<string, ExemplarLook["ground"]> = {
  "flat-light": "flat",
  "flat-dark": "flat",
  "brand-colour": "flat",
  gradient: "flat",
  texture: "glyph",
};
export const ACCENT: Record<string, ExemplarLook["accentForm"]> = {
  "highlight-block": "band",
  "colour-word": "tint",
  underline: "rule",
  weight: "none",
  none: "none",
};
export const TYPE_SCALE: Record<string, ExemplarLook["typeScale"]> = {
  low: "display",
  none: "display",
  medium: "editorial",
  high: "condensed",
};

function vote<T extends string>(values: ReadonlyArray<T | undefined>): { value: T; votes: number; of: number } | undefined {
  const counts = new Map<T, number>();
  let of = 0;
  for (const v of values) {
    if (v === undefined) continue;
    of++;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (top === undefined || top[1] < MIN_VOTES) return undefined;
  if (ranked[1] !== undefined && ranked[1][1] === top[1]) return undefined;
  return { value: top[0], votes: top[1], of };
}

export function exemplarLook(library: ExemplarLibrary | undefined): ExemplarLook | undefined {
  if (library === undefined || library.status !== "built") return undefined;
  const ranked = [...library.entries]
    .filter((e) => exemplarVoteWeight(e) > 0)
    .sort((a, b) => b.craft - a.craft || (b.lift ?? 0) - (a.lift ?? 0))
    .slice(0, MAX_ENTRIES);
  if (ranked.length < MIN_VOTES) return undefined;
  // A strong client post is listed twice, so it counts twice in every vote.
  const entries = ranked.flatMap((e) => Array.from({ length: exemplarVoteWeight(e) }, () => e));
  const dna = (key: string): Array<string | undefined> => entries.map((e) => (typeof e.dna[key] === "string" ? (e.dna[key] as string) : undefined));
  const ground = vote(dna("groundStyle").map((v) => (v === undefined ? undefined : GROUND[v])));
  const accent = vote(dna("emphasis").map((v) => (v === undefined ? undefined : ACCENT[v])));
  const scale = vote(dna("textDensity").map((v) => (v === undefined ? undefined : TYPE_SCALE[v])));
  const basis = [
    ...(ground ? [`ground ${ground.value} (${ground.votes} of ${ground.of} exemplars)`] : []),
    ...(accent ? [`accent ${accent.value} (${accent.votes} of ${accent.of})`] : []),
    ...(scale ? [`type ${scale.value} (${scale.votes} of ${scale.of})`] : []),
  ];
  if (basis.length === 0) return undefined;
  return {
    ...(ground ? { ground: ground.value } : {}),
    ...(accent ? { accentForm: accent.value } : {}),
    ...(scale ? { typeScale: scale.value } : {}),
    basis,
  };
}
