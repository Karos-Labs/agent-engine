/**
 * Which image model to generate with, decided by asking rather than by
 * assuming.
 *
 * ## Why this exists
 *
 * `DEFAULT_IMAGE_MODEL` was `gemini-2.5-flash-image` for three releases, and
 * the comment above it said why: *"Verified reachable in prep; every
 * `imagen-*` id 404s there."* That is an honest note about an outage, and it
 * hardened into a product decision — the model this pipeline used for every
 * picture was chosen because something else was unreachable on one afternoon
 * in one project, and nothing ever re-asked.
 *
 * Somebody did re-ask, eventually, by hand: main moved the default to
 * `gemini-3.1-flash-image` while this module was being written. That is the
 * right answer and it is this ladder's top rung. It is also the argument for
 * the ladder rather than against it — the fix took a person noticing, and the
 * new default serves on one endpoint only.
 *
 * Vertex's availability has changed at least three times in this project: a
 * billing hold that 403'd everything, its clearing, and a whole model
 * generation moving to a `global`-only endpoint. A constant cannot track
 * that. A probe can.
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
 * Best first, and the order is evidence rather than taste.
 *
 * **`gemini-3.1-flash-image`** leads because it is Google's current image
 * model and main moved the default to it while this was being written. Its
 * one fragility is stated in `generate-image.ts`'s own version note: it
 * serves ONLY on the `global` endpoint, where the model below it serves
 * everywhere. That is precisely the kind of fact a ladder exists to survive.
 *
 * **`gemini-2.5-flash-image`** is the floor and stays reachable. It is the id
 * verified working in prep, so a generation-level outage above it costs a run
 * nothing.
 *
 * **`imagen-4.0-generate-001`** is last and is a different family, not a
 * better one. It is here for the case both Gemini image ids are unavailable
 * at once — a generation-wide problem, which a same-family fallback does not
 * help with. It is NOT placed above them: an earlier draft of this ladder put
 * Imagen on top on the reasoning that a dedicated image model beats a
 * multimodal one doing images as a side job, and that reasoning was written
 * before `gemini-3.1-flash-image` existed. Promoting an older dedicated model
 * over a newer flagship on a general argument would be exactly the
 * assumption this module was built to stop.
 *
 * Every rung is priced in `UNIT_PRICING`, and it has to be: `pricingForUnit`
 * throws on an unpriced unit, so an unpriced rung would kill a run at the
 * cost step with the money already spent.
 */
export const IMAGE_MODEL_LADDER: readonly string[] = [
  "gemini-3.1-flash-image",
  "gemini-2.5-flash-image",
  "imagen-4.0-generate-001",
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
