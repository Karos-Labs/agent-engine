/**
 * Getting a carousel back up to the picture floor when the DRAFT is what put
 * it under.
 *
 * ## The defect this exists for
 *
 * `MIN_PICTURE_SLIDES` is 3 and `06h-imagery-floor-check` enforces it. On
 * 2026-09-18 the Karos prep carousel shipped with 2 and the Geektime one with
 * 0, and the floor recorded, both times, *"no slide is still without a
 * picture, so there is nothing to fill"*.
 *
 * It was telling the truth about the only slides it could see. The floor
 * refills `selections.filter(isUnfillable)` — slides that ASKED for a picture
 * and did not get one. A slide whose brief said `source: "none"` never
 * produces a selection at all, so it is invisible to the floor: the floor can
 * measure the shortfall and cannot reach the slides causing it.
 *
 * Both drafts opted out on six slides of eight. The copy prompt already tells
 * the writer *"a carousel of `none` is a wall of type, which reads as cheap"*,
 * and then exempts every archetype in the set from the cost it attaches — so
 * `"none"` is free, and the writer took it. Prose was never going to fix that.
 *
 * ## Why the opted-out slide's own scene cannot be the prompt
 *
 * `generationPromptFor` is `need.scene`, and on a slide that opted out the
 * scene is not a picture. It is the WRITER'S REASON for not wanting one:
 *
 *   "typographic editorial slide, no photograph needed"
 *   "a minimal security checklist on a dark background, technical context"
 *   "this is a list of rules — no photograph adds to a typed checklist"
 *
 * Handing the first of those to an image model buys a picture of a slide.
 * `conceptualPromptFor` builds the prompt from the slide's own CLAIM instead,
 * and asks for the thing the owner asked for on 2026-09-18: a made image that
 * carries an idea, not a stock photograph of an office.
 *
 * ## What it refuses to draw, and why that is in the prompt rather than a gate
 *
 * No people, no logos, no brands, no products, no screens with text. That is
 * the standing rule that a generated frame never depicts an identifiable real
 * person, customer, result or product, and it belongs in the prompt because a
 * gate downstream can only throw the image away after it has been paid for —
 * which is the exact shape of waste the picture floor was just fixed to stop.
 */

import type { InstagramCopyOutput, InstagramSlideCopy } from "./types.js";
import { normaliseVisualNeed } from "./scene-brief.js";
import { FULL_BLEED_IMAGE_LAYOUTS, HERO_IMAGE_LAYOUTS } from "./slides-data.js";

/**
 * Phrases that mark a `scene` as an ARGUMENT rather than a picture.
 *
 * Every one of these is lifted from a scene string in the two prep runs of
 * 2026-09-18. They are matched only to decide ORDERING — a slide whose scene
 * really does describe a picture is backfilled before one whose scene is a
 * justification — and never to refuse a slide, because a writer who explains
 * themselves clearly should not be punished for it.
 */
const SCENE_IS_AN_ARGUMENT =
  /\b(typographic|typography|no photograph|no photo\b|no image|text[- ]only|not photographable|editorial slide|checklist|no picture)\b/i;

export function sceneDescribesAPicture(scene: string): boolean {
  return scene.trim().length > 0 && !SCENE_IS_AN_ARGUMENT.test(scene);
}

/** Words a generated frame may never be asked for. The standing likeness and brand rule, stated where it costs nothing. */
export const GENERATION_EXCLUSIONS =
  "No text, letters, numbers or words anywhere in the image. " +
  "No people, no faces, no hands. No logos, brand marks, product packaging or recognisable real products. " +
  "No screenshots and no user interfaces.";

export interface ConceptualPromptOptions {
  /** The run's frozen treatment, so a backfilled frame sits in the same world as the sourced ones. */
  readonly treatment?: string;
  /** The client's stated visual style, when the brand kit names one. */
  readonly aesthetic?: string;
}

/**
 * An image brief built from what the slide SAYS, for a slide that asked for
 * no picture.
 *
 * The shape is deliberately an abstract editorial illustration rather than a
 * photograph: a photograph of a checklist is a picture of nothing, and a
 * carousel that fills its quiet plates with generic desk photography is the
 * filler the copy prompt spends a section warning against. An abstract form
 * that carries the slide's idea is the thing the owner named — *"an AI
 * generation of a flow of what we do"*.
 *
 * The claim is passed through verbatim and NOT paraphrased, because a
 * paraphrase of a claim is a new claim and nothing downstream would re-check
 * it.
 */
export function conceptualPromptFor(slide: InstagramSlideCopy, options: ConceptualPromptOptions = {}): string {
  const claim = [slide.headline, slide.body]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(". ")
    .replace(/\s+/gu, " ")
    .slice(0, 320);

  const world = [options.treatment, options.aesthetic]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(", ");

  return [
    `An abstract editorial illustration carrying this idea: ${claim}`,
    "Geometric forms, layered planes and connective lines. Generous negative space. One accent colour against a dark ground.",
    world.length > 0 ? `Treatment: ${world}.` : "",
    GENERATION_EXCLUSIONS,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

export interface BackfillCandidate {
  readonly n: number;
  readonly prompt: string;
  /** Why this slide was chosen, for the step's own trace. */
  readonly reason: string;
}

/**
 * Which slides to put a made picture on, and in what order.
 *
 * Ordering, strongest first:
 *
 * 1. **A BOUNDED plate before a full-bleed one.** The owner's ruling of
 *    2026-09-18: a picture that sits inside the plate beside the type is the
 *    one that adds, and both carousels that day carried their pictures only
 *    as backgrounds. The four panel archetypes render `.sc-figure-band`; the
 *    two in `FULL_BLEED_IMAGE_LAYOUTS` render a ground.
 * 2. **A briefed scene before a derived one**, inside each group: a slide
 *    that described a picture and still said `"none"` is the cheapest good
 *    frame available, and the words are the writer's.
 * 3. **A layout with no image slot at all is skipped**, because paying for a
 *    frame the template cannot place is the waste this whole area was just
 *    fixed to stop.
 *
 * The CLOSER is excluded outright. It carries the ask, it is the one plate a
 * reader is meant to act on rather than look at, and a picture behind a call
 * to action competes with the only thing on the slide that has a job.
 *
 * `alreadyWithPicture` is passed in rather than read off the copy because the
 * slides that count are the ones whose picture SURVIVED vetting, which only
 * the caller knows.
 */
export function planImageBackfill(
  copy: InstagramCopyOutput,
  alreadyWithPicture: ReadonlySet<number>,
  want: number,
  options: ConceptualPromptOptions = {},
): BackfillCandidate[] {
  if (want <= 0) return [];
  const lastN = copy.slides.reduce((max, slide) => Math.max(max, slide.n), 0);

  const eligible = copy.slides.filter((slide) => {
    if (alreadyWithPicture.has(slide.n)) return false;
    if (slide.n === lastN) return false;
    // A layout with no image slot would take the money and drop the frame,
    // which is the exact waste the picture floor was just fixed to stop.
    if (!HERO_IMAGE_LAYOUTS.has(slide.layout ?? "photo")) return false;
    return normaliseVisualNeed(slide).source === "none";
  });

  const bounded: BackfillCandidate[] = [];
  const fullBleed: BackfillCandidate[] = [];
  for (const slide of eligible) {
    const need = normaliseVisualNeed(slide);
    const briefed = sceneDescribesAPicture(need.scene);
    const candidate: BackfillCandidate = {
      n: slide.n,
      prompt: briefed ? need.scene : conceptualPromptFor(slide, options),
      reason: briefed
        ? "the slide opted out of a picture but its scene describes one, so the writer's own words are the brief"
        : "the slide opted out of a picture and its scene explains why rather than describing one, so the brief is built from the claim",
    };
    (FULL_BLEED_IMAGE_LAYOUTS.has(slide.layout ?? "photo") ? fullBleed : bounded).push(candidate);
  }

  // Bounded first, and that is the owner's 2026-09-18 ruling rather than a
  // tidiness preference: *"not every image has to be a background. Images can
  // appear inside the post as part of it, even if it is a small part. What
  // matters is that it adds, because it really adds when there is an image
  // inside."* Both prep carousels that day carried their pictures ONLY as
  // full-bleed grounds — two on Karos, none on Geektime — so the register the
  // owner is asking for was absent from the set, not merely rare in it.
  //
  // A briefed scene still beats a derived one inside each group, so the
  // writer's own words win where they exist.
  const byBrief = (a: BackfillCandidate, b: BackfillCandidate): number =>
    Number(a.reason.includes("built from the claim")) - Number(b.reason.includes("built from the claim")) || a.n - b.n;

  return [...bounded.sort(byBrief), ...fullBleed.sort(byBrief)].slice(0, want);
}
