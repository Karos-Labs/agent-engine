/**
 * Which image model to generate with, decided by asking rather than by
 * assuming.
 *
 * ## Why this exists
 *
 * `DEFAULT_IMAGE_MODEL` was `gemini-2.5-flash-image`, and the comment above it
 * said why: *"Verified reachable in prep; every `imagen-*` id 404s there."*
 * That is an honest note about an outage, and it hardened into a product
 * decision. The model this pipeline uses for every picture was chosen because
 * the better one was unreachable on one afternoon in one project — and
 * nothing ever re-asked.
 *
 * Vertex's availability has since changed at least twice in this project
 * (a billing hold that 403'd everything, and its clearing). A constant cannot
 * track that. A probe can.
 *
 * ## How it decides
 *
 * The ladder is tried in order on the FIRST generation of a tool instance.
 * A model that answers is remembered for the rest of that instance's life; a
 * model that reports it does not exist is struck off and the next is tried.
 * Nothing else is inferred from a failure: a rate limit, a safety refusal or
 * a timeout says nothing about whether the model exists, so those do not
 * demote it. Only `NOT_FOUND`/404/`is not supported` does — which is exactly
 * the failure the original comment described.
 *
 * ## Why the probe is the generation itself
 *
 * There is no cheaper existence check that is also a true one. Vertex's model
 * listing does not agree with what a project may actually call, which is how
 * the 404s were discovered in the first place. So the first real generation
 * IS the probe: if the preferred model answers, that answer is used and
 * nothing was wasted; if it 404s, the attempt cost nothing because nothing
 * was billed.
 */

/**
 * Best first.
 *
 * Imagen leads because it is Google's dedicated image model and the Gemini
 * flash image path is a general multimodal model doing image output as a
 * side job — which is visible in exactly the way the owner described: frames
 * that look competent and generic. The two Imagen ids are the current
 * generate-capable ones; both are listed because a project may be entitled to
 * one and not the other.
 *
 * `gemini-2.5-flash-image` stays last and stays REACHABLE — it is the one
 * verified to work in prep, so the ladder always has a floor and a run never
 * loses its pictures to a model-availability question.
 */
export const IMAGE_MODEL_LADDER: readonly string[] = [
  "imagen-4.0-generate-001",
  "imagen-3.0-generate-002",
  "gemini-2.5-flash-image",
];

/**
 * Whether a generation failure means THIS MODEL DOES NOT EXIST HERE, as
 * opposed to any of the many failures that say nothing about the model.
 *
 * Matched on the error's message text for the same reason
 * `isRetryableGenerationError` is: the SDK surfaces Vertex's raw error body
 * as `Error#message` rather than as typed fields.
 *
 * Deliberately narrow. A permission error (403) is NOT a demotion: a project
 * that is not yet entitled to Imagen today may be tomorrow, and striking the
 * model off a long-lived process's ladder over an IAM state would make the
 * fallback permanent. It falls through for this call and is asked again next
 * time.
 */
export function isModelUnavailableError(message: string): boolean {
  return /"code"\s*:\s*404|\bNOT_FOUND\b|was not found|is not found|is not supported|not supported for/i.test(message);
}

/**
 * A tool instance's memory of which rungs are still worth trying.
 *
 * Deliberately per-instance and in-memory: a tool is constructed per process,
 * the state is a few strings, and persisting it would recreate exactly the
 * problem this module exists to fix — a stale availability fact outliving the
 * outage that produced it.
 */
export class ImageModelLadder {
  private readonly rungs: string[];
  private readonly struck = new Set<string>();

  constructor(ladder: readonly string[] = IMAGE_MODEL_LADDER, pinned?: string | undefined) {
    // An explicitly configured model is an instruction, not a preference: a
    // caller that names one gets exactly it, and the ladder becomes a
    // single rung. That keeps every existing test and every deployment that
    // pins a model working precisely as before.
    this.rungs = pinned === undefined ? [...ladder] : [pinned];
  }

  /** The models still worth trying, best first. Empty only if every rung has been struck off. */
  available(): string[] {
    return this.rungs.filter((m) => !this.struck.has(m));
  }

  /** The model to try now, or `undefined` when the ladder is exhausted. */
  preferred(): string | undefined {
    return this.available()[0];
  }

  /**
   * Record that a model reported it does not exist here.
   *
   * Never strikes the LAST remaining rung: a ladder with nothing on it can
   * only produce "no image", and reporting "the model 404s" on every
   * subsequent need is less useful than letting the final rung keep failing
   * visibly with its own error. This is the always-deliver rule applied to a
   * model list.
   */
  strike(model: string): void {
    if (this.available().length <= 1) return;
    this.struck.add(model);
  }

  /** True when this model has been struck off — for a log line, and for tests. */
  isStruck(model: string): boolean {
    return this.struck.has(model);
  }
}
