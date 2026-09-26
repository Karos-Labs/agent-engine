import type { ExemplarLibrary, LibraryEntry } from "./exemplar-library.js";
import { ACCENT, exemplarVoteWeight, GROUND, TYPE_SCALE, type ExemplarLook } from "./exemplar-look.js";
import { COVER_COMPOSITIONS, FROM_COVER_TYPE, type CoverComposition } from "./cover-composition.js";

/**
 * TEMPLATES FROM THE HARVEST (2026-09-26).
 *
 * The owner, twice: setup harvests hundreds of posts from the client's
 * competitors and the category's famous accounts, finds the ones that earned
 * traffic and likes, and takes the best of them as the templates. The Template
 * Studio was meant to do that and does not: its format evidence is read from
 * Reddit and X, not from the Instagram harvest, and it writes free HTML the
 * render gates refuse (0 of 6 stored, prep batch 7).
 *
 * A recipe is one harvested post turned into the axes this agent renders
 * with: the ground, the accent form, the type scale (the exemplar look's own
 * mapping), and the cover composition its cover type votes for. The posts
 * are ranked by what they EARNED (lift: times their own account's median) and
 * how well they are made (the judge's calibrated craft), the client's own
 * strong posts counting double (`exemplarVoteWeight`). Each run is styled
 * after ONE of the top recipes, seeded, so the templates change from post to
 * post and every look traces back to a named, measured post. The plurality
 * look (`exemplarLook`) fills any axis a recipe leaves open.
 */

export interface ExemplarRecipe {
  handle: string;
  role: string;
  /** Times its own account's median, capped at `LIFT_CAP` for the ranking. */
  lift: number;
  craft: number;
  score: number;
  /** The judge's one transferable technique for this post. */
  standout: string;
  ground?: ExemplarLook["ground"];
  accentForm?: ExemplarLook["accentForm"];
  typeScale?: ExemplarLook["typeScale"];
  cover?: CoverComposition;
  /** The first stored frame, for the trace (reference only, never republished). */
  frame?: string;
}

/** How many of the strongest posts become recipes. */
export const MAX_RECIPES = 6;
/** Only a post the judge graded this well is a template. */
export const RECIPE_MIN_CRAFT = 4;
/** At most this many templates from one account, so the rotation spans the category rather than one feed. */
export const MAX_RECIPES_PER_ACCOUNT = 2;
/** A breakout counts, but ten times the median already says so; past that it is noise. */
export const LIFT_CAP = 10;

function coverFor(coverType: unknown): CoverComposition | undefined {
  if (typeof coverType !== "string") return undefined;
  const weights = FROM_COVER_TYPE[coverType];
  if (weights === undefined) return undefined;
  let best: CoverComposition | undefined;
  for (const c of COVER_COMPOSITIONS) if ((weights[c] ?? 0) > 0 && (best === undefined || (weights[c] ?? 0) > (weights[best] ?? 0))) best = c;
  return best;
}

function recipeOf(entry: LibraryEntry): ExemplarRecipe {
  const dna = entry.dna;
  const str = (k: string): string | undefined => (typeof dna[k] === "string" ? (dna[k] as string) : undefined);
  const lift = Math.max(1, Math.min(LIFT_CAP, entry.lift ?? 1));
  const ground = GROUND[str("groundStyle") ?? ""];
  const accentForm = ACCENT[str("emphasis") ?? ""];
  const typeScale = TYPE_SCALE[str("textDensity") ?? ""];
  const cover = coverFor(dna["coverType"]);
  return {
    handle: entry.handle,
    role: entry.role,
    lift,
    craft: entry.craft,
    score: entry.craft * lift * exemplarVoteWeight(entry),
    standout: entry.standout,
    ...(ground !== undefined ? { ground } : {}),
    ...(accentForm !== undefined ? { accentForm } : {}),
    ...(typeScale !== undefined ? { typeScale } : {}),
    ...(cover !== undefined ? { cover } : {}),
    ...(entry.storedFrames[0] !== undefined ? { frame: entry.storedFrames[0] } : {}),
  };
}

/** The top recipes, one per distinct look (two posts that would render the same way are one template). */
export function exemplarRecipes(library: ExemplarLibrary | undefined): ExemplarRecipe[] {
  if (library === undefined || library.status !== "built") return [];
  const ranked = library.entries
    .filter((e) => e.craft >= RECIPE_MIN_CRAFT && exemplarVoteWeight(e) > 0)
    .map(recipeOf)
    .filter((r) => r.ground !== undefined || r.accentForm !== undefined || r.typeScale !== undefined || r.cover !== undefined)
    .sort((a, b) => b.score - a.score || b.craft - a.craft);
  const seen = new Set<string>();
  const perAccount = new Map<string, number>();
  const out: ExemplarRecipe[] = [];
  for (const r of ranked) {
    const key = [r.ground, r.accentForm, r.typeScale, r.cover].join("|");
    if (seen.has(key) || (perAccount.get(r.handle) ?? 0) >= MAX_RECIPES_PER_ACCOUNT) continue;
    seen.add(key);
    perAccount.set(r.handle, (perAccount.get(r.handle) ?? 0) + 1);
    out.push(r);
    if (out.length >= MAX_RECIPES) break;
  }
  return out;
}

/**
 * This run's template: one recipe, drawn in proportion to its score so the
 * strongest posts lead without one post styling every run. Seeded, so a
 * resumed run keeps its template.
 */
export function pickRecipe(recipes: readonly ExemplarRecipe[], seed: string): ExemplarRecipe | undefined {
  if (recipes.length === 0) return undefined;
  const total = recipes.reduce((sum, r) => sum + r.score, 0);
  let h = 2166136261;
  for (const ch of `${seed}:recipe`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  let at = ((h % 1_000_000) / 1_000_000) * total;
  for (const r of recipes) {
    at -= r.score;
    if (at < 0) return r;
  }
  return recipes[recipes.length - 1];
}

/** One line for the trace and the gate: which post this run is styled after, and why it earned the slot. */
export function recipeBasis(recipe: ExemplarRecipe): string {
  const axes = [recipe.ground && `ground ${recipe.ground}`, recipe.accentForm && `accent ${recipe.accentForm}`, recipe.typeScale && `type ${recipe.typeScale}`, recipe.cover && `cover ${recipe.cover}`].filter(Boolean).join(", ");
  return `styled after @${recipe.handle} (${recipe.role}, ${recipe.lift.toFixed(1)}x its account's median, craft ${recipe.craft}): ${axes}. Its technique: ${recipe.standout}`;
}
