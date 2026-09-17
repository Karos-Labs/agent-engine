/**
 * What a generated image carries with it about how it was made.
 *
 * ## Why this exists
 *
 * Meta's own rule is that photorealistic AI-generated imagery is declared —
 * the publisher sets the AI-info toggle, and images carrying C2PA or IPTC
 * provenance are auto-labelled. Nothing in this pipeline recorded any of it.
 * A generated photograph left this package indistinguishable from a
 * photograph someone took, and the deliverable had no field for the publisher
 * to read even if they wanted to comply.
 *
 * This does not write C2PA manifests. Signing a manifest needs a credential
 * and a signing service, and a fabricated one would be worse than none. What
 * it does is state, in the deliverable, the facts a human or a later signer
 * needs: which model produced the frame, from which brief, and whether the
 * result is the photorealistic kind the rule is about.
 *
 * ## Why the photoreal test errs toward "yes"
 *
 * Declaring an illustration as AI-made costs nothing — it is true, and the
 * toggle is not a penalty. Failing to declare a photorealistic generation is
 * a policy breach. So the test's default is `true`, and only a style lock
 * that NAMES a non-photographic treatment moves it. A generation whose
 * treatment we cannot classify stays declared.
 */

import { createHash } from "node:crypto";

/** Recorded on every generated candidate; absent on a sourced one, which has a licence instead. */
export interface ImageProvenance {
  /** How the frame came to exist. Only `"generated"` today; the field exists so a sourced asset can say so too. */
  origin: "generated";
  /** The exact model id that produced it — the ladder means this is not always the configured preference. */
  model: string;
  /**
   * SHA-256 of the full brief, truncated to 16 hex characters. The brief
   * itself can run to several hundred words and carries the client's art
   * direction, so the hash is what travels; the brief stays in the step's own
   * record where it is already logged.
   */
  briefHash: string;
  /**
   * Whether this is the photorealistic kind Meta's disclosure rule is about.
   * See the module comment for why an unclassifiable treatment is `true`.
   */
  photoreal: boolean;
  /** Why `photoreal` has the value it has, in one clause, so the decision is auditable. */
  photorealBasis: string;
  /** ISO-8601, so a deliverable reviewed weeks later can say when the frame was made. */
  generatedAt: string;
}

/**
 * Treatments that are not photographs. Matched against the style lock and the
 * stated aesthetic, whole-word, case-insensitively.
 *
 * Deliberately short and literal. A longer list of near-synonyms would catch
 * more true illustrations and would also start catching photographic briefs
 * that merely mention one of them ("shot against an illustrated backdrop"),
 * and the cost of that mistake runs in the undeclared direction.
 */
const NON_PHOTOGRAPHIC_TREATMENTS: readonly string[] = [
  "illustration",
  "illustrated",
  "vector",
  "diagram",
  "schematic",
  "line art",
  "flat design",
  "3d render",
  "3d-rendered",
  "isometric",
  "cartoon",
  "collage",
  "typographic",
];

function namesANonPhotographicTreatment(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const haystack = text.toLowerCase();
  return NON_PHOTOGRAPHIC_TREATMENTS.find((term) => new RegExp(`\\b${term.replace(/[-\s]/g, "[-\\s]")}\\b`).test(haystack));
}

export interface ProvenanceInput {
  model: string;
  /** The composed brief exactly as it was sent to the model. */
  brief: string;
  /** The client's locked generation style, when they have one. */
  styleLock?: string | undefined;
  /** The client's stated aesthetic, when they have one. */
  aesthetic?: string | undefined;
  /** Injectable so a test's provenance is deterministic. */
  now?: () => Date;
}

export function buildImageProvenance(input: ProvenanceInput): ImageProvenance {
  const named = namesANonPhotographicTreatment(input.styleLock) ?? namesANonPhotographicTreatment(input.aesthetic);
  return {
    origin: "generated",
    model: input.model,
    briefHash: createHash("sha256").update(input.brief).digest("hex").slice(0, 16),
    photoreal: named === undefined,
    photorealBasis:
      named === undefined
        ? "the brief asks for a photographic image and no treatment overrides it"
        : `the client's own direction names a non-photographic treatment ("${named}")`,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * The one line a publisher reads to decide the AI-info toggle.
 *
 * Phrased as an instruction rather than a fact because that is what the
 * reader has to act on, and because "photoreal: true" sitting in a JSON blob
 * has, historically, been read by nobody.
 */
export function describeProvenanceForPublisher(provenance: ImageProvenance): string {
  return provenance.photoreal
    ? `AI-generated, photorealistic (${provenance.model}) — set Instagram's AI-info toggle on this post.`
    : `AI-generated, non-photorealistic (${provenance.model}) — ${provenance.photorealBasis}; the AI-info toggle is optional here.`;
}
