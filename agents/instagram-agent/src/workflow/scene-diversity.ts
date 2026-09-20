/**
 * Scene diversity for GENERATED imagery (2026-09-20).
 *
 * ## The post this exists because of
 *
 * prep run `pubsub-21909275109642063` (thepitchbydeel) shipped two pictures
 * and the owner's first reaction was that both looked the same. They did. The
 * vet's own notes on the frames it accepted read:
 *
 *   - "a founder at a desk reviewing a pitch deck on a laptop"
 *   - "the act of reviewing a pitch deck"
 *   - "a founder mid-review looking at a pitch deck on a laptop screen"
 *
 * Three slides, one picture. Nothing was broken: every frame honestly matched
 * the brief it was given, and the briefs had converged. `06f2-one-picture-one-slide`
 * passed them clean because it compares FILE PATHS, and two separately
 * generated frames of the same scene have different paths.
 *
 * ## Two rules this module is built around
 *
 * 1. **It only ever looks at GENERATED frames.** A client's upload, a library
 *    asset, a retrieved photograph of a named entity — those are specific
 *    things somebody chose, and two of them resembling each other is not a
 *    defect this code gets to have an opinion about. The test is
 *    `provenance.origin === "generated"`, which is absent on everything else.
 *
 * 2. **It never removes a picture.** The whole reason the owner is looking at
 *    text-heavy slides is that images keep being dropped and `07a` downgrades
 *    the plate. A similarity check that rejects a frame would be one more way
 *    to lose one. So this steers generation toward variety BEFORE the spend,
 *    and after the spend it can ask for a re-draw — but a slide that ends up
 *    holding a near-duplicate keeps it. A similar picture beats a wall of
 *    text.
 */

/** Words that say nothing about WHICH scene a brief describes — grammar, and the art-direction vocabulary every brief carries. */
const SCENE_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "with", "without", "for", "from", "into", "over",
  "is", "are", "be", "as", "by", "its", "their", "this", "that", "it", "no", "not",
  // Art direction that appears in every brief by construction, so it can only
  // ever make two different scenes look alike.
  "image", "photo", "photograph", "photographic", "shot", "frame", "scene", "slide", "candidate", "picture",
  "style", "lighting", "natural", "clean", "composition", "realistic", "background", "foreground", "colour", "color",
  "generated", "illustration", "illustrated", "vector", "flat", "design", "brand", "brands", "visual",
]);

/** The content words of a scene brief, deduplicated. */
export function sceneWords(brief: string): string[] {
  return [
    ...new Set(
      brief
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !SCENE_STOPWORDS.has(w)),
    ),
  ];
}

/**
 * How much two scene briefs describe the same picture: 1 when one brief's
 * subject words are all in the other, 0 when they share nothing.
 *
 * The overlap coefficient rather than Jaccard, for the reason the topic
 * rotation uses it too: Jaccard divides by the union and so reads two briefs
 * as unrelated purely because one of them is longer, which is the common case
 * when one slide's brief carries extra art direction.
 */
export function sceneSimilarity(a: string, b: string): number {
  const wa = sceneWords(a);
  const wb = sceneWords(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const set = new Set(wb);
  const shared = wa.filter((w) => set.has(w)).length;
  return shared / Math.min(wa.length, wb.length);
}

/**
 * Above this, two briefs are asking for the same picture.
 *
 * Measured on the run that caused this: the three pitch-deck briefs score
 * 0.55-0.71 against each other, and the briefs of genuinely different slides
 * on the same run score below 0.3. 0.5 sits in that gap with room on both
 * sides — it is not a number that has to be exactly right, because being
 * wrong in the permissive direction costs one similar picture and being wrong
 * in the strict direction costs one redundant variation clause.
 */
export const SCENE_SIMILARITY_CEILING = 0.5;

/**
 * The ways one frame can be made to differ from another, as instructions a
 * generator can act on.
 *
 * Framing and subject distance rather than content: the brief already says
 * what the slide is ABOUT and that part must survive — a variation clause
 * that changed the subject would buy variety by making the picture wrong for
 * its slide. These change how the same subject is seen.
 */
export const VARIATION_CLAUSES: readonly string[] = [
  "Frame this one differently from the other images in this post: a tight detail shot, close in on the hands or the object, no full figure.",
  "Frame this one differently from the other images in this post: a wide establishing view, the subject small in its setting.",
  "Frame this one differently from the other images in this post: no people at all — the objects, surfaces or workspace alone.",
  "Frame this one differently from the other images in this post: an overhead, flat-lay vantage looking straight down.",
  "Frame this one differently from the other images in this post: an over-the-shoulder view, the subject seen from behind.",
  "Frame this one differently from the other images in this post: a different setting entirely — not a desk, not an office interior.",
];

/** One brief that was steered, and what it was steered away from. */
export interface SceneVariation {
  n: number;
  /** The slide whose brief it was too close to, or `"an image already chosen for this post"`. */
  tooCloseTo: string;
  similarity: number;
  clause: string;
}

export interface DiversifiedScenes<T> {
  scenes: T[];
  variations: SceneVariation[];
}

/**
 * Steers a set of generation briefs apart BEFORE any of them is paid for.
 *
 * Each brief is compared against the ones already settled — the earlier gaps
 * in this batch, and the briefs of frames this run has already accepted. The
 * first occurrence of a scene keeps its brief untouched; a later one that is
 * asking for the same picture gets a variation clause appended.
 *
 * Deterministic: the clause is chosen by the slide number and the run seed, so
 * a resumed run rebuilds the identical briefs (these are `step.code` inputs
 * and a resume must not produce a different prompt), and two runs of the same
 * client do not reach for the same clause every week.
 *
 * Doing this before generation rather than after is the difference between
 * spending the image quota once and spending it twice — which matters, because
 * the quota running out is the OTHER reason this client's posts have been
 * short of pictures.
 */
export function diversifySceneBriefs<T extends { n: number; prompt: string }>(
  gaps: readonly T[],
  options: { alreadyChosenBriefs?: readonly string[]; seed?: string } = {},
): DiversifiedScenes<T> {
  const settled: Array<{ label: string; brief: string }> = (options.alreadyChosenBriefs ?? []).map((brief) => ({
    label: "an image already chosen for this post",
    brief,
  }));
  const variations: SceneVariation[] = [];
  const scenes = gaps.map((gap) => {
    let worst: { label: string; similarity: number } | undefined;
    for (const prior of settled) {
      const similarity = sceneSimilarity(gap.prompt, prior.brief);
      if (similarity > (worst?.similarity ?? 0)) worst = { label: prior.label, similarity };
    }
    if (worst === undefined || worst.similarity <= SCENE_SIMILARITY_CEILING) {
      settled.push({ label: `slide ${gap.n}`, brief: gap.prompt });
      return gap;
    }
    const clause = VARIATION_CLAUSES[variationIndex(gap.n, options.seed, variations.length)]!;
    variations.push({ n: gap.n, tooCloseTo: worst.label, similarity: Math.round(worst.similarity * 100) / 100, clause });
    const prompt = `${gap.prompt}\n\n${clause}`;
    settled.push({ label: `slide ${gap.n}`, brief: prompt });
    return { ...gap, prompt };
  });
  return { scenes, variations };
}

/**
 * Which clause a slide takes. Offset by how many variations this batch has
 * already issued, so two slides steered in the same batch never receive the
 * same instruction — the failure mode that would make the fix produce a
 * matching pair of its own.
 */
function variationIndex(n: number, seed: string | undefined, already: number): number {
  let hash = 0x811c9dc5;
  for (const ch of `${seed ?? ""}:${n}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  return (((hash >>> 0) % VARIATION_CLAUSES.length) + already) % VARIATION_CLAUSES.length;
}

/** A frame this run accepted, as much of it as the duplicate check needs. */
export interface AcceptedFrame {
  n: number;
  /** Absent on anything not generated — a client upload, a library asset, a retrieved photograph. */
  generatedBrief?: string | undefined;
}

export interface NearDuplicateFrames {
  /** The LATER slide of the pair — the one a re-draw would target. Never the first occurrence. */
  n: number;
  matches: number;
  similarity: number;
}

/**
 * Which accepted frames are near-duplicates of an earlier one.
 *
 * Reports, and nothing else. The caller decides whether it can afford a
 * re-draw; what it must NOT do is drop the frame, for the reason in this
 * module's header — a slide with a similar picture is a better post than a
 * slide with a wall of text, and the owner has been looking at the wall.
 *
 * Only frames carrying `generatedBrief` are considered. A client's upload and
 * a photograph of a named entity are specific things somebody chose, and this
 * check has no business comparing them.
 */
export function findNearDuplicateFrames(frames: readonly AcceptedFrame[]): NearDuplicateFrames[] {
  const generated = frames.filter((f): f is AcceptedFrame & { generatedBrief: string } => typeof f.generatedBrief === "string" && f.generatedBrief.length > 0);
  const out: NearDuplicateFrames[] = [];
  for (let i = 1; i < generated.length; i++) {
    let worst: { n: number; similarity: number } | undefined;
    for (let j = 0; j < i; j++) {
      const similarity = sceneSimilarity(generated[i]!.generatedBrief, generated[j]!.generatedBrief);
      if (similarity > (worst?.similarity ?? 0)) worst = { n: generated[j]!.n, similarity };
    }
    if (worst !== undefined && worst.similarity > SCENE_SIMILARITY_CEILING) {
      out.push({ n: generated[i]!.n, matches: worst.n, similarity: Math.round(worst.similarity * 100) / 100 });
    }
  }
  return out;
}
