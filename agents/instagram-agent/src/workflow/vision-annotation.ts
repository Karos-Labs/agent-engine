/**
 * What a vision inspection adds to an image candidate's description before
 * the vetting gate reads it (Phase 0, item F).
 *
 * ## The defect this closes
 *
 * The vet (`instagram-image-vet@3`) judges pictures as TEXT: it never sees an
 * image, only the candidate's `description`. Its whole `claimMatch` rubric
 * turns on identity — "a different subject, team, place or era than the slide
 * names ... a photograph of Maccabi fans under a Juventus headline is a 1" —
 * and the field most likely to carry "Maccabi Tel Aviv supporters" is
 * `subjects`, which `media.inspectImages` returns and which the two
 * enrichment sites in the workflow used to drop on the floor. The vet was
 * handed "football supporters with scarves in a floodlit stadium" and the
 * honest score for that against a Juventus headline is a 3 ("compatible and
 * generic"), which is the selection floor: the audited defect survived
 * whenever the photo carried no legible club text.
 *
 * So `subjects` travels, and so does anything else that names what is in
 * frame. One function for both call sites (tier-0 client uploads at `05z`
 * and harvested candidates at `05c`) so the two cannot drift: a rubric that
 * depends on a field only one of them passes is a rubric that scores the same
 * photograph differently depending on where it came from.
 */

/** The `media.inspectImages` fields this annotation reads. Every one is optional: a partial inspection still annotates what it did return. */
export interface VisionInspectionFields {
  description?: unknown;
  subjects?: unknown;
  textInImage?: unknown;
  looksLikeScreenshot?: unknown;
  looksAiGenerated?: unknown;
}

/** Trimmed, de-duplicated (case-insensitively), order kept, clamped — a description is prompt input, not a data dump. */
function cleanList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const text = entry.replace(/\s+/gu, " ").trim();
    if (text.length === 0) continue;
    if (out.some((existing) => existing.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
    if (out.length === max) break;
  }
  return out;
}

export interface VisionAnnotationOptions {
  /** Include the screenshot / AI-generated flags (the harvested-candidate path passes them; a client upload is not judged on them). */
  includeFlags?: boolean;
}

/**
 * The `[vision: ...]` suffix for one candidate, or `""` when the inspection
 * returned nothing worth appending.
 *
 * Order is deliberate: the sentence of what is in frame, then the NAMED
 * subjects, then legible text, then the flags. The vet reads the description
 * top to bottom and the identity question ("is this the team/company/place
 * the slide names?") is answered by the middle two.
 */
export function buildVisionAnnotation(found: VisionInspectionFields, options: VisionAnnotationOptions = {}): string {
  const description = typeof found.description === "string" ? found.description.replace(/\s+/gu, " ").trim() : "";
  const subjects = cleanList(found.subjects, 6);
  const textInImage = cleanList(found.textInImage, 8);
  const flags = options.includeFlags
    ? [found.looksLikeScreenshot === true ? "screenshot/document" : "", found.looksAiGenerated === true ? "looks AI-generated" : ""].filter(Boolean).join(", ")
    : "";

  const parts: string[] = [];
  if (description.length > 0) parts.push(description);
  if (subjects.length > 0) parts.push(`subjects: ${subjects.join(", ")}`);
  if (textInImage.length > 0) parts.push(`text in image: ${textInImage.join(" / ")}`);
  if (flags.length > 0) parts.push(flags);
  if (parts.length === 0) return "";
  return ` [vision: ${parts.join("; ")}]`;
}

/** `candidate.description` with the annotation appended. Unchanged when there was nothing to append. */
export function describeWithVision(description: string, found: VisionInspectionFields, options: VisionAnnotationOptions = {}): string {
  return `${description}${buildVisionAnnotation(found, options)}`;
}
