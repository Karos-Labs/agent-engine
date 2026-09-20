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
 * ## What it refuses to draw, and where the line actually is
 *
 * The first version of this banned people, logos, brands and products
 * outright. That is why every generated frame came back as "geometric forms,
 * layered planes and connective lines": with every real subject excluded, the
 * only thing left to draw is abstraction, and eight slides of it look like one
 * slide eight times. The owner read the result and named it exactly:
 * *"תמונות גנריות עם AI זה משעמם לרוב שזה חזרתי"*.
 *
 * The line is not the subject. It is **whether the image could be read as a
 * record of something that happened.**
 *
 * An illustrated figure, in a declared register, standing in a conceptual
 * scene, is commentary. Every serious publication runs one every week. A
 * photorealistic frame of the same person is a fabricated photograph of a real
 * human being, and that is the thing that gets a brand into trouble and the
 * thing Meta's AI disclosure exists for.
 *
 * So: `ALWAYS_EXCLUDED` holds what no treatment makes acceptable, and
 * `PHOTOREAL_ONLY_EXCLUDED` holds what stops being a problem the moment the
 * frame is openly an illustration. `registerFor` picks which illustration, and
 * varies it per run, because one house style repeated IS the repetition.
 *
 * It all lives in the prompt rather than a gate because a gate downstream can
 * only throw an image away after it has been paid for, which is the exact
 * shape of waste the picture floor was just fixed to stop.
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

/**
 * Scenes that are a SENTINEL for "there is no scene", not a description of one.
 *
 * `visualNeed.source` already says `"none"`, and a writer filling the sibling
 * `scene` field on the same object reaches for the same word. It is not a brief;
 * it is the absence of one, spelled.
 *
 * ## The $0.067 frame this exists to stop (karoslabs, 2026-09-20)
 *
 * `sceneDescribesAPicture("none")` was `true` — the string is non-empty and
 * `SCENE_IS_AN_ARGUMENT` does not list it — so `planImageBackfill` chose the
 * "the writer's own words are the brief" branch and emitted
 * `{ n: 2, prompt: "none", backfilled: true }`. The floor paid for a frame drawn
 * to the brief *"none"*, and `06h2` then graded it against a subject of
 * *"none"*: *"The slide asked for a subject of 'none' and the candidate was
 * generated to exactly that brief."* Every layer behaved correctly on an input
 * that never meant anything.
 *
 * The list is deliberately tiny and exact. It is not a general "is this string
 * meaningful" heuristic — those are the checks that fail on the one input that
 * matters. These are the literal sentinels a writer types INSTEAD of a scene,
 * matched whole; anything with real words in it goes to the writer's branch as
 * before.
 */
const SCENE_IS_A_SENTINEL = /^\s*(none|n\/?a|null|nil|undefined|no|-+|—+|\.*)\s*$/i;

export function sceneDescribesAPicture(scene: string): boolean {
  return scene.trim().length > 0 && !SCENE_IS_A_SENTINEL.test(scene) && !SCENE_IS_AN_ARGUMENT.test(scene);
}

/**
 * What no treatment makes acceptable.
 *
 * Text is here because image models cannot spell and a slide with invented
 * letters on it is unusable. The other two are the real rules: an image that
 * stages an event is a fabricated record whatever style it is drawn in, and
 * nothing this agent makes mocks a real person.
 */
export const ALWAYS_EXCLUDED =
  "No text, letters, numbers, words or signage anywhere in the image. " +
  "Do not stage an event as though it happened: no signing, no handshake, no announcement, no podium, no stage moment, no dated scene. " +
  "Nothing mocking, degrading or unflattering to anyone depicted.";

/**
 * What stops being a problem the moment the frame is openly an illustration.
 *
 * A photorealistic frame of a real person is a fabricated photograph of them.
 * The same person in cut paper is a drawing, which is what commentary looks
 * like. The same reasoning covers a brand mark, with a second practical edge:
 * an image model renders a trademark as a smeared near-miss, so a photoreal
 * brief that asks for one produces a wrong logo AND a fake photograph.
 */
export const PHOTOREAL_ONLY_EXCLUDED =
  "No identifiable real person, and no real company logo, brand mark or product packaging.";

/** The exclusions in force for a frame of this kind. */
export function exclusionsFor(photoreal: boolean): string {
  return photoreal ? `${ALWAYS_EXCLUDED} ${PHOTOREAL_ONLY_EXCLUDED}` : ALWAYS_EXCLUDED;
}

/**
 * The illustration registers, and why there is a list rather than a style.
 *
 * One house style applied to every generated frame is the repetition the owner
 * named. A register is chosen per RUN, so a carousel is coherent with itself
 * and the next week's post does not look like this week's.
 *
 * Every one of them is unmistakably a drawing at a glance, which is the whole
 * requirement: the register is what signals "this is commentary" and therefore
 * what licenses a real subject to appear in it.
 */
export const ILLUSTRATION_REGISTERS = [
  { id: "cut-paper", phrase: "layered cut-paper collage, visible paper edges, soft drop shadows, flat colour" },
  { id: "isometric", phrase: "clean isometric diagram, flat planes, precise geometry, no perspective distortion" },
  { id: "risograph", phrase: "risograph print, two spot inks, visible grain and slight misregistration" },
  { id: "clay", phrase: "soft 3D clay render, matte rounded surfaces, single studio key light" },
  { id: "blueprint", phrase: "technical blueprint, fine luminous linework on a deep ground, drafting marks" },
  { id: "collage", phrase: "editorial collage, halftone textures, hard-cut shapes, one bold field of colour" },
  { id: "wireframe", phrase: "glowing wireframe forms in dark space, thin neon lines, long falloff" },
] as const;
export type IllustrationRegisterId = (typeof ILLUSTRATION_REGISTERS)[number]["id"];

/**
 * Which register this run draws in.
 *
 * Seeded on the run, so it is stable inside one carousel and different in the
 * next. Deterministic, so a resumed run does not change style halfway.
 */
export function registerFor(seed: string): (typeof ILLUSTRATION_REGISTERS)[number] {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.codePointAt(0)!) % 1_000_003;
  return ILLUSTRATION_REGISTERS[hash % ILLUSTRATION_REGISTERS.length]!;
}

/** A real thing the post names, as the generator needs to know about it. */
export interface NamedSubject {
  readonly name: string;
  readonly kind: string;
  readonly isPublicFigure?: boolean;
}

/**
 * Whether a frame carrying these subjects may be photorealistic.
 *
 * A person or an organisation makes it an illustration, full stop. Everything
 * else (a place, a work, an event's SETTING rather than the event) is free.
 */
export function photorealAllowed(subjects: readonly NamedSubject[] = []): boolean {
  return !subjects.some((s) => s.kind === "person" || s.kind === "company" || s.kind === "organisation" || s.kind === "product");
}

export interface ConceptualPromptOptions {
  /** The run's frozen treatment, so a backfilled frame sits in the same world as the sourced ones. */
  readonly treatment?: string;
  /** The client's stated visual style, when the brand kit names one. */
  readonly aesthetic?: string;
  /** This run's illustration register. Absent means the caller wants the default abstract shape. */
  readonly register?: (typeof ILLUSTRATION_REGISTERS)[number];
  /** The real things the post names, which the frame may show ILLUSTRATED. */
  readonly subjects?: readonly NamedSubject[];
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

  const subjects = (options.subjects ?? []).filter((s) => s.name.trim().length > 0);
  // A named subject forces the illustration, and it is the register that makes
  // that safe rather than a promise in the prompt. With no register to draw in
  // there is nothing to license the subject, so the frame goes back to being
  // about the idea alone.
  const register = options.register;
  const showsSubjects = subjects.length > 0 && register !== undefined;
  // With no declared register there is nothing signalling commentary, so the
  // stricter list applies whatever the subjects are. The claim itself can name
  // a person, and a frame drawn from it would otherwise be free to render one.
  const unillustrated = register === undefined;

  return [
    register === undefined
      ? "An abstract editorial illustration."
      : `An editorial illustration, drawn in this register: ${register.phrase}.`,
    showsSubjects
      ? `It shows ${subjects.map((s) => s.name).join(" and ")}, drawn in that register and never photographically, carrying this idea: ${claim}`
      : `It carries this idea: ${claim}`,
    "Composition reads at a glance: one clear focal mass, generous negative space, no clutter.",
    world.length > 0 ? `Treatment: ${world}.` : "",
    exclusionsFor(unillustrated),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * Whether a briefed subject noun is an illustration of a WORD in the headline
 * rather than a picture of what the slide is about.
 *
 * The three prep carousels of 2026-09-18 all did this. *"Two clocks run your
 * marketing"* was given a photograph of a pocket watch. *"Buyers open their
 * window when they are ready"* was given a photograph of a lit doorway.
 * *"…on a publishing schedule"* was given a photograph of a watch on a desk.
 *
 * It is the oldest failure in stock photography, and this pipeline causes it:
 * the brief demands "a concrete noun phrase a photo library would index", so
 * the model hands back the most concrete noun in the sentence. The rule was
 * written to stop abstract nouns and over-corrected into literalism.
 *
 * Reported as a NOTE and never a refusal: a slide about a real conference
 * genuinely is about a stage, and no matcher can tell that from a slide about
 * a metaphor. Code proves a word is present, not that a picture is wrong.
 */
const HEADLINE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "from", "with", "at", "by", "as", "is", "are", "was", "were",
  "your", "our", "their", "you", "we", "they", "it", "its", "this", "that", "these", "those", "not", "no", "only", "most", "more",
  "one", "two", "three", "when", "what", "who", "how", "why", "run", "runs", "make", "makes",
]);

export function literalIllustrationOf(subjectNoun: string, headline: string): string | undefined {
  const words = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3 && !HEADLINE_STOPWORDS.has(w));
  const inHeadline = new Set(words(headline));
  const echoed = words(subjectNoun).filter((w) => inHeadline.has(w) || inHeadline.has(`${w}s`) || (w.endsWith("s") && inHeadline.has(w.slice(0, -1))));
  if (echoed.length === 0) return undefined;
  return (
    `the picture's subject repeats "${echoed.join('", "')}" from the headline, which is usually a picture of a WORD ` +
    `rather than of what the slide is about. A photograph of a clock under "two clocks run your marketing" is the shape to avoid`
  );
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


/**
 * Which verdict a slide keeps after the floor step has vetted a rescued frame.
 *
 * ## Why this is a function and not two lines at the call site
 *
 * The call site's rule was `isUnfillable(replacement) ? keep : replace`, and
 * `isUnfillable` opens with `if (!photoSlideNs.has(s.n)) return false` — a
 * slide the writer marked `source: "none"` is not in that set, because it
 * carries a typographic placeholder rather than an image request. So for
 * exactly the slides a backfill fills, the helper answers "not unfillable"
 * about a verdict it has not looked at.
 *
 * Both directions of that are wrong and both cost something real. A refused
 * frame would replace a good placeholder with a null-image entry whose reason
 * is about a picture the slide never asked for; and any change that made the
 * helper stricter would drop a frame this run has ALREADY PAID FOR, which is
 * the waste the whole picture-floor fix exists to stop.
 *
 * For a backfilled slide the honest test is the image itself.
 */
export function resolveRescuedSelection<T extends { imagePath: string | null }>(args: {
  readonly placeholder: T;
  readonly vetted: T | undefined;
  readonly wasBackfilled: boolean;
  readonly isUnfillable: (selection: T) => boolean;
}): T {
  const { placeholder, vetted, wasBackfilled, isUnfillable } = args;
  if (vetted === undefined) return placeholder;
  if (wasBackfilled) return vetted.imagePath === null ? placeholder : vetted;
  return isUnfillable(vetted) ? placeholder : vetted;
}
