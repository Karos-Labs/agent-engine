import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logWarning } from "@agent-engine/telemetry";
import { defineTool, success, contentFail, toolingError, notAvailable } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX, type FindImagesCandidate } from "./find-images.js";
import { assessImageFloor } from "./image-floor.js";
import { IMAGE_MODEL_LADDER, ImageModelLadder, isModelUnavailableError } from "./image-model-ladder.js";
import { buildImageProvenance } from "./image-provenance.js";

// 1.0.1 (SCRUM-296/AU11): removed the redundant re-parse of already-validated input.
// 1.1.0 (RFC-13 Phase 3, item Q): `art` gains `forbid` and `styleLock`, and
// `buildBrief` gains the two blocks that carry them. A MINOR bump rather than
// a patch because the prompt this tool composes changed shape: two callers
// passing the same `needs` and the same `art` before and after this version
// do not send the same brief to the model, and the tool-version gate on main
// exists precisely so that a prompt change is legible in the version (PR #95
// is the precedent). Both fields are optional and additive, so every existing
// caller's brief is byte-identical.
// 1.2.0 (RFC-16 §5.3, Instagram Phase 4): `art` gains `permittedMarks` and
// `permittedFigures` — the names an owner's `generatedLikeness` consent record
// actually listed. MINOR for the same reason 1.1.0 was, and the reasoning is
// worth restating because this is the field where getting it wrong is
// expensive: both are optional and additive, and with neither present (every
// client in the fleet on day one) the composed brief and the generated image's
// description are BYTE-IDENTICAL to 1.1.0's — that is the property
// `generate-image-concept.test.ts` asserts as an exact string rather than a
// set of `toContain`s. But when a list IS non-empty the standing constraint
// line changes shape, and the tool-version gate on main exists precisely so a
// prompt change is legible in the version.
// 1.3.0: the default model moved from gemini-2.5-flash-image to
// gemini-3.1-flash-image (a different generation, a different per-image rate),
// and the client's Vertex location moved to `global` because that is the only
// endpoint serving it. Both change what a call does, so a telemetry record
// from before must not read as one from after.
// 2.0.0 (Phase 5.6, items D2/A8/A11): three changes, one of which is
// breaking. The MODEL is no longer a constant — an unpinned caller gets the
// best rung of `IMAGE_MODEL_LADDER` this project can actually reach, so two
// callers passing identical input can receive frames from different models
// and `result.model` can name more than one. A generated frame must now clear
// the same 1080px floor a sourced one does, so a call that previously
// returned a small image now reports it unmet. And every candidate carries
// `provenance`. The MAJOR digit is for the first: the tool's output is no
// longer a function of its input alone. A caller passing `model` explicitly
// is unaffected — the ladder collapses to that single rung.
//
// 1.3.0 landed on main while this was in flight and is KEPT: it moved the
// default to `gemini-3.1-flash-image`, which is the right model and is now
// the ladder's top rung rather than its only one. The two changes want the
// same thing from opposite directions — 1.3.0 picked a better default, this
// stops a default from being the whole answer — and 1.3.0's own note that
// 3.1 serves ONLY on the `global` endpoint is exactly the fragility a ladder
// exists for.
// 2.1.0 (the merge with main): resolving the two above left the ladder's TOP
// rung as `gemini-3.1-flash-image` where 2.0.0's was `gemini-2.5-flash-image`,
// so an unpinned caller gets a frame from a different model and a different
// per-image rate than 2.0.0 gave. MINOR rather than MAJOR: no field changed
// shape and no caller has to do anything — only which model answers first.
// The push gate caught this, which is the gate doing precisely its job: the
// version was carried through a conflict resolution unchanged while the
// constant under it changed value.
// 2.3.0 (2026-09-23, stage 2 of the reference-looks plan): a need may carry
// `references`, real images the model receives alongside the brief (the
// client's own product, a logo, an event photograph), so a generated scene
// can hold the client's actual bottle rather than an invented one. MINOR:
// optional and additive, and a need without references sends the same string
// `contents` and the same brief byte for byte.
const TOOL_VERSION = "2.3.0";
/**
 * The image-generation call, narrowed to what this tool uses so the package
 * does not take a type dependency on the whole `@google/genai` surface.
 *
 * This is `generateContent`, not `generateImages`. The SDK deprecates
 * `generateImages` ("will be removed in the next major release… use the
 * generateContent method with image models instead"), and the Imagen publisher
 * models it targets are not available in this deployment at all — every
 * `imagen-*` id returns 404 for `karoscmo-prep` — re-probed 2026-09-17, still
 * true for imagen-4.0, imagen-4.0-fast and imagen-3.0. The model that answers
 * is a Gemini image id, today `gemini-3.1-flash-image`, and ONLY on the
 * `global` endpoint: unlike the outgoing `gemini-2.5-flash-image`, which
 * served both, every 3.x id 404s at `us-central1`. Probed directly, as the
 * worker's own service account, before this was written rather than assumed.
 */
export interface ImageGenerationClient {
  models: {
    generateContent(request: {
      model: string;
      /** A plain brief, or (with references) one user turn carrying the reference images and then the brief. */
      contents: string | ReferenceContent[];
      config?: Record<string, unknown>;
    }): Promise<{
      candidates?: Array<{
        finishReason?: string | undefined;
        content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> } | undefined;
      }>;
      promptFeedback?: { blockReason?: string } | undefined;
    }>;
  };
}

/** One user turn: the reference images first, then the brief. The shape `@google/genai` accepts as `Content[]`. */
export interface ReferenceContent {
  role: "user";
  parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }>;
}

/**
 * What a reference image IS, which decides what the brief tells the model to
 * do with it. `product` and `logo` must come back unchanged (their printed
 * text included); a `subject` is a person or a place the scene is built
 * around, kept recognisable rather than pixel-identical.
 */
export const REFERENCE_ROLES = ["product", "logo", "subject"] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

/** Three at most: past that the model starts averaging the references instead of placing them. */
export const MAX_REFERENCES = 3;
/** Per reference. Inline data counts against the request, and a product shot is never this big. */
export const MAX_REFERENCE_BYTES = 7_000_000;

const REFERENCE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export const GenerateImageInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. Written paths are relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as media.findImages does."),
  needs: z
    .array(
      z.object({
        n: z.number().int().positive().describe("This slide's number."),
        prompt: z.string().min(1).describe("The slide's own visualNeed, used as the generation brief."),
        references: z
          .array(
            z.object({
              path: z.string().min(1).describe("Repo-relative path to a PNG, JPEG or WebP inside repoRoot."),
              role: z.enum(REFERENCE_ROLES).describe("product/logo: reproduced unchanged, printed text included. subject: kept recognisable."),
            }),
          )
          .max(MAX_REFERENCES)
          .optional()
          .describe(
            "Real images the model receives with the brief: the client's own product, a logo, a photograph of the subject. The scene is generated around them. Omit for a plain text-to-image generation.",
          ),
      }),
    )
    .min(1)
    .describe(
      "One entry per slide that retrieval could not satisfy. Deliberately not \"every slide\": each image is a real, billed generation, so this tool is called for the gaps rather than the whole carousel.",
    ),
  perNeed: z
    .number()
    .int()
    .min(1)
    .max(3)
    .default(1)
    .describe("Images per need, as separate billed calls. One is usually right: a rescue needs a picture that works, not a shortlist."),
  aspectRatio: z
    .enum(["1:1", "3:4", "4:3", "4:5", "9:16", "16:9"])
    .default("4:3")
    .describe(
      "Passed through as imageConfig.aspectRatio; verified accepted by the model. `4:5` is the platform's own portrait ratio and the one a full-bleed slide wants — it was absent from this enum until Phase 5.6, so a caller that wanted it had to ask for 3:4 and have the frame cropped.",
    ),
  art: z
    .object({
      aesthetic: z.string().min(1).optional().describe("e.g. \"editorial\", \"documentary\", \"minimal product photography\"."),
      lighting: z.string().min(1).optional().describe("e.g. \"soft diffused daylight\", \"hard directional studio light\"."),
      palette: z.array(z.string().min(1)).max(6).optional().describe("Named or hex colours the frame should sit in."),
      accentColor: z.string().min(1).optional().describe("The client's single accent colour, when they have one."),
      mood: z.string().min(1).optional().describe("e.g. \"calm and considered\", \"urgent\"."),
      notes: z.string().min(1).optional().describe("Extra client-specific direction, appended verbatim."),
      /**
       * What must never appear in the frame — the client's own negative
       * list, distinct from the standing `Constraints:` line below.
       *
       * The constraints are this pipeline's (no lettering, no logos: the
       * template draws the real headline over this image). This is the
       * client's: "no stock handshakes", "no cityscape skylines", "never a
       * person's face". Advisory to an image model rather than enforced —
       * which is honest about what the only available lever can do — but a
       * named negative is measurably better than none, and everything on
       * this list arrived with a basis attached (see the instagram agent's
       * `visual-direction.ts`).
       */
      forbid: z
        .array(z.string().min(1))
        .max(10)
        .optional()
        .describe("Client-specific things that must never appear in the frame, emitted as an explicit negative block. Distinct from the standing pipeline constraints, which always apply."),
      /**
       * The ONE per-client generation style every generated image in a run
       * inherits, so a set of rescue images reads as one set rather than as
       * three unrelated pictures that happen to sit in one carousel.
       *
       * A single string rather than a structure: it is appended verbatim, and
       * the caller owns keeping it stable across the run.
       */
      styleLock: z
        .string()
        .min(1)
        .optional()
        .describe("One sentence, identical for every image in a run, so the generated images read as one set. Placed after the art direction and before the constraints."),
      /**
       * RFC-16 §5.3 — the third-party marks this client's OWNER has recorded a
       * permission for, in `clients/<slug>/client/consent.json`.
       *
       * Absent for every client in the fleet until such a record exists, and
       * absent is the point: with nothing here the standing constraint below
       * stays `no logos`, byte-for-byte as it has always read. A caller must
       * never populate this from anything but a `granted` consent record that
       * NAMES these marks — this tool takes the list on trust, exactly as it
       * takes `forbid` on trust, because a tool cannot verify a permission it
       * did not witness being granted.
       *
       * Six, not unbounded: a badge treatment stops reading at three or four
       * marks in one frame, and a longer list is a sign the caller is passing
       * the whole permit rather than the names this one concept uses.
       */
      permittedMarks: z
        .array(z.string().min(1))
        .max(6)
        .optional()
        .describe("Third-party brand marks this client has a RECORDED, NAMED permission for. Omitted (the fleet-wide default) leaves the standing 'no logos' constraint unchanged. Named marks are permitted only as clean flat circular badges or wordless silhouettes, never as a photographed product or a likeness."),
      /**
       * The real public figures the same record names. A separate list from
       * `permittedMarks` because it is a separate body of law — a trademark
       * question and a right-of-publicity question are not the same question
       * and are not granted by the same sentence.
       *
       * Three, not six: a frame containing four recognisable people is a
       * composite, and the standing constraints forbid composites anyway.
       */
      permittedFigures: z
        .array(z.string().min(1))
        .max(3)
        .optional()
        .describe("Real, identifiable public figures this client has a RECORDED, NAMED permission to depict. Omitted (the fleet-wide default) keeps the generated image's description asserting no identifiable real person, which is what the rights vet reads."),
    })
    .optional()
    .describe(
      "Photographic direction for the brief, derived by the caller from the client's own brand tokens and canvas. Every field is only ever passed through, never invented here — a caller with nothing to say supplies nothing and the brief falls back to neutral direction.",
    ),
});
export type GenerateImageInput = z.input<typeof GenerateImageInputSchema>;
/** The post-parse shape, so `buildBrief` can name the art block without restating it. */
type GenerateImageInputParsed = z.output<typeof GenerateImageInputSchema>;

export interface GenerateImageResult {
  candidates: FindImagesCandidate[];
  /** Needs that produced nothing, with the reason. Never silently dropped. */
  unmet: { n: number; reason: string }[];
  model: string;
}

/**
 * The model this tool falls back to, and no longer the model it starts from.
 *
 * For three releases this was `gemini-2.5-flash-image`, on the strength of a
 * note reading *"Verified reachable in prep; every `imagen-*` id 404s there"*
 * — a true observation about one project on one afternoon, which then decided
 * every picture the fleet made. Main has since moved it to
 * `gemini-3.1-flash-image`, which is the current model and the right answer;
 * `IMAGE_MODEL_LADDER` is the other half, so that the next time the right
 * answer changes, or the `global`-only endpoint 3.1 needs is unavailable, a
 * run loses no pictures waiting for someone to edit a constant.
 */
export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
/**
 * Whether a `generateContent` failure is quota/availability noise rather than
 * a real answer about the request.
 *
 * prep runs pubsub-21533408759483219 and pubsub-21543794087429035 both held
 * on this exact shape: three or so generations succeed back-to-back, then
 * Vertex's per-minute burst limit trips and every following call in the same
 * step 429s with `RESOURCE_EXHAUSTED`. Before this, that error was
 * indistinguishable from "the model refuses this prompt" — one `unmet` entry,
 * zero retries, and the *only* fallback tier this package has left gave up on
 * a condition that clears itself in seconds. `503`/`UNAVAILABLE` is the same
 * shape for a different transient cause and gets the same treatment.
 *
 * Matched on the error's own message text: the SDK surfaces Vertex's raw
 * `{"error":{"code":429,...,"status":"RESOURCE_EXHAUSTED"}}` body as
 * `Error#message` rather than a typed field, so the code/status strings are
 * the only reliable signal available here.
 */
function isRetryableGenerationError(message: string): boolean {
  return /"code"\s*:\s*429|RESOURCE_EXHAUSTED|"code"\s*:\s*503|\bUNAVAILABLE\b/.test(message);
}

export interface GenerateImageRetryOptions {
  /** Attempts per generation call, including the first. */
  maxAttempts?: number;
  /** Base delay for exponential backoff; attempt N waits `baseDelayMs * 2^(N-1)`. */
  baseDelayMs?: number;
  /** Overridable so tests don't pay real wall-clock delay. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MIME_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

/**
 * The licence line recorded on a generated image.
 *
 * Generation is the only source in this package with no third-party rights
 * question at all: nobody else owns the output, there is no photographer to
 * credit and no watermark to detect. That is why `licenseConfidence` is
 * `"generated"` — a distinct value above `blanket`, not a synonym for it.
 */
const GENERATED_LICENSE =
  "Generated image — no third-party rights: created for this post, owned outright, unwatermarked, no attribution required";

/**
 * Provenance stated plainly, because the vetting agent decides
 * `rightsUsable`/`watermarkFree` from the description and cannot inspect
 * pixels. Without this it would default to sceptical — correctly, for a
 * web-sourced hit — and refuse an image we own outright.
 *
 * ## The likeness clause (1.2.0)
 *
 * With `permittedFigures` empty — every client, every run, until an owner
 * writes a consent record — this returns the byte-identical 1.1.0 sentence,
 * ending "no identifiable real person unless described above".
 *
 * With names in it, that trailing assertion would be a LIE told to the one
 * reader who cannot check it: the vet has no pixels on the generate tier, so
 * it believes this sentence. An image that deliberately contains Tim Cook must
 * not be described to the rights vet as containing no identifiable real
 * person — the vet would clear it on a false premise, which is worse than it
 * refusing. So the clause is replaced, not appended to, and it says the
 * likeness is intentional and recorded.
 */
function describeGenerated(prompt: string, permittedFigures: readonly string[] = []): string {
  const likeness =
    permittedFigures.length > 0
      ? `a deliberate, recorded-permission likeness of ${permittedFigures.join(", ")} and no other identifiable real person`
      : "no identifiable real person unless described above";
  return `AI-generated illustration created specifically for this slide, to the brief: "${prompt}". Not a stock photo — no third-party copyright, no watermark, ${likeness}.`;
}

/**
 * `image.generate` — the fallback for a visual need no library holds.
 *
 * ## Why this exists
 *
 * Retrieval has a ceiling that more providers cannot raise. prep run
 * pubsub-21535110633863323 hit it precisely: four providers, 36 candidates,
 * and slides 2 and 5 still failed because one needed "a timeline or roadmap
 * with a clearly labeled 'research' first phase, shot from above". No stock or
 * CC library contains that picture, and no additional search backend will
 * conjure it. Generation is the only source that answers a brief on demand.
 *
 * ## Why it is a tool and not another `ImageSearchProvider`
 *
 * Every provider in a chain is queried for every need — that is what makes the
 * merged pool diverse. Generation must not work that way: each image is
 * billed, so it belongs to the slides that actually came up empty, invoked
 * deliberately by the workflow after the gate has spoken. In the chain it
 * would generate six images per run and discard most of them.
 *
 * Unconfigured (no `client`) it reports `not_available`, exactly like every
 * other capability here — never a construction-time throw.
 */
export function createGenerateImage(options: {
  client?: ImageGenerationClient | undefined;
  /** Overridable because model availability varies by project and region. */
  model?: string;
  /** Backoff applied to a `RESOURCE_EXHAUSTED`/`UNAVAILABLE` generateContent failure. */
  retry?: GenerateImageRetryOptions;
}) {
  // A caller that names a model still gets exactly it — `ImageModelLadder`
  // collapses to a single rung when pinned. A caller that does not now gets
  // the best model this project can actually reach, asked rather than assumed.
  const ladder = new ImageModelLadder(IMAGE_MODEL_LADDER, options.model);
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 3);
  const baseDelayMs = options.retry?.baseDelayMs ?? 2_000;
  const sleep = options.retry?.sleepImpl ?? defaultSleep;

  /**
   * Retries only the transient shape (`isRetryableGenerationError`) — a real
   * refusal or a malformed request fails on the first try exactly as before,
   * with no added latency.
   */
  async function generateWithBackoff(
    request: Omit<Parameters<ImageGenerationClient["models"]["generateContent"]>[0], "model">,
  ): Promise<{ response: Awaited<ReturnType<ImageGenerationClient["models"]["generateContent"]>>; model: string }> {
    const client = options.client!;
    let lastError: Error;

    // Models this CALL has already found absent.
    //
    // The loop's termination must not depend on `ladder.strike` having taken
    // effect. It nearly did: a first draft skipped the retry budget for a
    // model-absent answer (correctly — nothing was served, so nothing should
    // be charged against the retries) by rewinding `attempt`, and a
    // deliberately broken `strike` in the falsification run turned that into
    // an infinite loop. A local set makes the rewind safe whatever the ladder
    // decides, which is the right coupling: the ladder's policy is about
    // FUTURE calls, this set is about this one.
    const absentHere = new Set<string>();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const model = ladder.available().find((m) => !absentHere.has(m)) ?? ladder.preferred()!;
      try {
        return { response: await client.models.generateContent({ ...request, model }), model };
      } catch (error) {
        lastError = error as Error;

        // "This model does not exist here" is not a transient failure and not
        // a refusal — it is a fact about the ladder. Struck off, and the next
        // rung is tried on the NEXT pass of this same loop rather than
        // counting against the retry budget, because no request was served.
        const untried = ladder.available().filter((m) => m !== model && !absentHere.has(m));
        if (isModelUnavailableError(lastError.message) && untried.length > 0) {
          absentHere.add(model);
          ladder.strike(model);
          logWarning(`image.generate: ${model} is not reachable here — falling back to ${untried[0]}`, {
            event: "image.generate.model_unavailable",
            model,
            fallback: untried[0],
          });
          attempt -= 1;
          continue;
        }

        const retryable = isRetryableGenerationError(lastError.message);

        // AU61: this loop used to retry and rethrow in silence. Every one of
        // the 10 Vertex 429s observed in prep over 29 days came from HERE, and
        // none of them produced an application-side signal — they were visible
        // only because Vertex happens to meter Gemini, which it does NOT do for
        // Claude. Exhausting the backoff is the interesting event: it means the
        // capacity problem outlived the retry and a slide is about to go
        // unfilled.
        if (attempt >= maxAttempts || !retryable) {
          if (retryable) {
            logWarning(`image.generate exhausted ${maxAttempts} attempts and gave up`, {
              event: "image.generate.retry_exhausted",
              attempts: maxAttempts,
              errorClass: "rate_limited_or_unavailable",
            });
          }
          throw lastError;
        }

        logWarning(`image.generate retrying after a transient failure (attempt ${attempt}/${maxAttempts})`, {
          event: "image.generate.retry",
          attempt,
          maxAttempts,
          errorClass: "rate_limited_or_unavailable",
        });
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError!;
  }

  return defineTool<GenerateImageInput, GenerateImageResult>({
    name: "image.generate",
    description:
      "Generates a real, billed image per unmet slide need via Vertex Gemini image generation, retrying transient rate-limit/availability errors with backoff. Reports not_available when no generation backend is configured, rather than a per-call failure.",
    version: TOOL_VERSION,
    inputSchema: GenerateImageInputSchema,
    async execute(rawInput) {
      // See find-images.ts's identical comment: `defineTool` already parsed `rawInput`
      // against `GenerateImageInputSchema` (defaults applied) before calling this —
      // this cast reflects that instead of a second, actually-redundant `.parse()` call.
      const input = rawInput as z.output<typeof GenerateImageInputSchema>;
      if (options.client === undefined) {
        return notAvailable(
          "image.generate: no image-generation backend configured — set GEMINI_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) " +
            "so Vertex can be reached (see packages/tools/karos-media/README.md)",
        );
      }

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      // Same bounds check as `media.findImages`: a runId carrying "../" is the
      // case that matters, and it is caught before anything is written.
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`image.generate: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }

      try {
        await fs.mkdir(absDir, { recursive: true });
      } catch (error) {
        return toolingError(`image.generate: could not create ${relDir}: ${(error as Error).message}`);
      }

      const candidates: FindImagesCandidate[] = [];
      const unmet: GenerateImageResult["unmet"] = [];
      // Which rungs actually served this run, for the result's `model` field
      // and for the cost units, which are billed per model.
      const producedBy = new Map<string, number>();

      for (const need of input.needs) {
        let savedForNeed = 0;
        const failures: string[] = [];

        // The references are read ONCE per need and before any billed call:
        // a reference that cannot be read is this need's failure, named, and
        // the model is never asked to invent the product it was meant to hold.
        const references = need.references ?? [];
        let referenceParts: ReferenceContent["parts"] = [];
        if (references.length > 0) {
          const loaded = await loadReferences(references, input.repoRoot);
          if (!loaded.ok) {
            unmet.push({ n: need.n, reason: loaded.reason });
            continue;
          }
          referenceParts = loaded.parts;
        }

        for (let attempt = 0; attempt < input.perNeed; attempt++) {
          const brief = buildBrief(need.prompt, input.art, references.map((r) => r.role));
          let response: Awaited<ReturnType<ImageGenerationClient["models"]["generateContent"]>>;
          let servedBy: string;
          try {
            const served = await generateWithBackoff({
              contents: referenceParts.length > 0 ? [{ role: "user", parts: [...referenceParts, { text: brief }] }] : brief,
              config: {
                // Both modalities: the model narrates its refusal as text when
                // it declines, and that text is the only explanation on offer.
                responseModalities: ["TEXT", "IMAGE"],
                imageConfig: { aspectRatio: input.aspectRatio },
              },
            });
            response = served.response;
            servedBy = served.model;
          } catch (error) {
            // One need's failure must not abandon the others: a rescue filling
            // 1 of 2 gaps beats one filling neither, and the caller still sees
            // why the other missed.
            failures.push(`generation failed: ${(error as Error).message}`);
            continue;
          }

          const candidate = response.candidates?.[0];
          const parts = candidate?.content?.parts ?? [];
          const image = parts.find((p) => p.inlineData?.data);

          if (image?.inlineData?.data === undefined) {
            // A refusal arrives as finishReason STOP with no image part and a
            // text part saying why — no `blockReason`, no filter field. That
            // text is genuinely the best available reason, so it is surfaced
            // rather than replaced with a generic "no image".
            const spoken = parts.find((p) => p.text)?.text?.replace(/\s+/g, " ").trim();
            const blocked = response.promptFeedback?.blockReason;
            failures.push(
              blocked
                ? `blocked before generation: ${blocked}`
                : spoken
                  ? `the model declined: ${spoken.slice(0, 200)}`
                  : `no image returned (finishReason: ${candidate?.finishReason ?? "unknown"})`,
            );
            continue;
          }

          const mime = image.inlineData.mimeType ?? "image/png";
          const extension = MIME_EXTENSION[mime] ?? ".png";
          const stem = `n${need.n}-gen${attempt}`;
          const relative = `${relDir}/${stem}${extension}`;

          const bytes = Buffer.from(image.inlineData.data, "base64");

          // Measured, and measured for the same reasons a SOURCED image is:
          // to book what was produced and to say where it can go. Size no
          // longer refuses anything (see `image-floor.ts` — the owner's
          // 2026-09-18 ruling), which matters most precisely here. This path
          // has ALREADY PAID the image charge by the time the bytes arrive,
          // so a refusal on size was spending money and then discarding the
          // result; both prep runs on 2026-09-18 did exactly that, six times,
          // over a 896x1200 frame that would have been enlarged 1.21x.
          //
          // What survives is the refusal a broken frame deserves: unreadable
          // bytes, or a CMYK separation that renders with shifted colour.
          const verdict = assessImageFloor(bytes);
          if (!verdict.ok) {
            failures.push(`the generated frame is not placeable — ${verdict.reasons.join("; ")}`);
            continue;
          }

          try {
            await fs.writeFile(path.join(absDir, `${stem}${extension}`), bytes);
          } catch (error) {
            failures.push(`could not write the generated image: ${(error as Error).message}`);
            continue;
          }

          producedBy.set(servedBy, (producedBy.get(servedBy) ?? 0) + 1);
          candidates.push({
            path: relative,
            description: `slide ${need.n} candidate — ${describeGenerated(need.prompt, input.art?.permittedFigures ?? [])} [licence: ${GENERATED_LICENSE}]`,
            // Still `gemini-image`: `provider` names the SOURCE TIER, which
            // is what the rest of the pipeline books and reports against, and
            // generation is one tier however many models sit behind it. The
            // model that actually served is on `provenance.model`.
            provider: "gemini-image",
            licenseConfidence: "generated",
            pixels: verdict.facts,
            ...(verdict.warnings.length > 0 ? { qualityNotes: verdict.warnings } : {}),
            provenance: buildImageProvenance({
              model: servedBy,
              brief,
              styleLock: input.art?.styleLock,
              aesthetic: input.art?.aesthetic,
            }),
          });
          savedForNeed += 1;
        }

        if (savedForNeed === 0) {
          unmet.push({ n: need.n, reason: failures.join("; ") || "no image was produced" });
        }
      }

      if (candidates.length === 0) {
        return contentFail(
          `image.generate: produced nothing for ${input.needs.length} need(s) — ${unmet
            .map((u) => `slide ${u.n} (${u.reason})`)
            .join("; ")}`,
        );
      }

      // the per-unit cost work — shipped without a Jira ticket: `candidates.length` is what was actually PRODUCED, not what
      // was asked for — attempts the model declined return no image part and
      // are not billed the image charge. Their text prompt still costs input
      // tokens, which this does not capture: the residual is a known
      // under-report, bounded by the declined-attempt count, and named here
      // rather than left for someone to rediscover from a bill.
      // Billed per model that actually served, not per configured preference:
      // a run that fell from Imagen to the Gemini path mid-way is two
      // different unit prices and reporting it as one would restate the
      // cost-reporting defect Phase 5.5 just finished fixing.
      const served = [...producedBy.entries()];
      return success<GenerateImageResult>(
        { candidates, unmet, model: served.map(([m]) => m).join(", ") || (ladder.preferred() ?? "none") },
        served.map(([m, quantity]) => ({ model: m, unit: "image" as const, quantity })),
      );
    },
  });
}

/**
 * Composes the generation brief: the slide's own `visualNeed`, then the
 * client's art direction, then the constraints this pipeline always imposes.
 *
 * ## Why the direction is worth the tokens
 *
 * A flat "photographic image of X" gets a generic stock-looking frame, which
 * is the same failure mode that made retrieval insufficient in the first
 * place. Lighting, aesthetic and palette are what make a generated slide look
 * like it belongs to this client rather than to nobody. The values come from
 * the caller's brand tokens and canvas — this function invents none of them,
 * and a caller with nothing to say still gets a working neutral brief.
 *
 * ## The constraints are not negotiable
 *
 * No text in the pixels, twice over: generated lettering comes out malformed,
 * and the carousel template renders the real headline and body as live text
 * over this image, so words in the frame would collide with copy already
 * there. No logos or watermarks for the same reason the rights gate exists.
 *
 * ## The order of the blocks (1.1.0)
 *
 * Need, then art direction, then the style lock, then `Do not include:`, then
 * the standing constraints. The style lock sits with the direction because it
 * IS direction — one sentence repeated across a run so a set of rescue images
 * reads as one set. `Do not include:` sits next to the constraints because
 * both are negatives, and a model reading two negative blocks back to back
 * treats them as one list; splitting them across the positive direction would
 * invite it to weigh the client's "no cityscapes" against "no lettering" as
 * if they were different kinds of rule.
 */
/**
 * Reads each reference inside `repoRoot` as inline data, or names why not.
 * Bounds-checked the way every written path in this package is: a reference
 * outside the root is a refusal, not a read.
 */
async function loadReferences(
  references: ReadonlyArray<{ path: string; role: ReferenceRole }>,
  repoRoot: string,
): Promise<{ ok: true; parts: ReferenceContent["parts"] } | { ok: false; reason: string }> {
  const root = path.resolve(repoRoot);
  const parts: ReferenceContent["parts"] = [];
  for (const [index, reference] of references.entries()) {
    const absolute = path.resolve(root, reference.path);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      return { ok: false, reason: `reference ${index + 1} (${reference.path}) is outside repoRoot` };
    }
    const mimeType = REFERENCE_MIME[path.extname(absolute).toLowerCase()];
    if (mimeType === undefined) return { ok: false, reason: `reference ${index + 1} (${reference.path}) is not a PNG, JPEG or WebP` };
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absolute);
    } catch (error) {
      return { ok: false, reason: `reference ${index + 1} (${reference.path}) could not be read: ${(error as Error).message}` };
    }
    if (bytes.length === 0 || bytes.length > MAX_REFERENCE_BYTES) {
      return { ok: false, reason: `reference ${index + 1} (${reference.path}) is ${bytes.length} bytes; a reference is 1 to ${MAX_REFERENCE_BYTES} bytes` };
    }
    parts.push({ inlineData: { data: bytes.toString("base64"), mimeType } });
  }
  return { ok: true, parts };
}

/**
 * What the brief says about the images that arrive before it. One line per
 * reference, in the order they were attached, because the model reads them by
 * position ("image 1") and a role stated without its position is ambiguous.
 */
function referenceBlock(roles: readonly ReferenceRole[]): string[] {
  if (roles.length === 0) return [];
  const line = (role: ReferenceRole, i: number): string => {
    const n = `Image ${i + 1}`;
    switch (role) {
      case "product":
        return `- ${n} is the client's own product. Place THIS product in the scene exactly as it is: the same shape, proportions, colours, label and printed text. Do not redesign it, re-letter it or invent a different one.`;
      case "logo":
        return `- ${n} is the client's own logo. If it appears, reproduce it exactly, flat and undistorted, as a real object in the scene (a sign, a print, a label), never re-drawn.`;
      case "subject":
        return `- ${n} shows the subject of the scene. Keep it recognisable; the scene is built around it.`;
    }
  };
  return ["", "Reference images (attached above, in order):", ...roles.map(line)];
}

function buildBrief(visualNeed: string, art?: GenerateImageInputParsed["art"], referenceRoles: readonly ReferenceRole[] = []): string {
  const lines = [`Create a photographic image for a social media carousel slide: ${visualNeed}`, ...referenceBlock(referenceRoles)];

  const direction: string[] = [];
  if (art?.aesthetic) direction.push(`Aesthetic: ${art.aesthetic}.`);
  if (art?.lighting) direction.push(`Lighting: ${art.lighting}.`);
  if (art?.palette && art.palette.length > 0) direction.push(`Colour palette: ${art.palette.join(", ")}.`);
  if (art?.accentColor) direction.push(`Carry the brand accent colour ${art.accentColor} somewhere in the frame, as an object or surface rather than an overlay.`);
  if (art?.mood) direction.push(`Mood: ${art.mood}.`);
  if (art?.notes) direction.push(art.notes);

  const styleLock = art?.styleLock;
  const forbid = art?.forbid ?? [];

  if (direction.length > 0) {
    lines.push("", "Art direction:", ...direction.map((d) => `- ${d}`));
  } else if (styleLock === undefined) {
    // The prior behaviour, kept verbatim for a caller supplying no direction.
    //
    // Kept rather than deleted for two reasons: a caller with nothing to say
    // would be WORSE off without it, and it is documented prior behaviour
    // that other channels may still rely on. What item Q changes is not this
    // line, it is that the Instagram caller now always has something to say —
    // `fallbackVisualDirection` derives four grounded lines from the brand
    // kit and the brief with no model call at all, so this branch is
    // unreachable for any Instagram client rather than being the default one.
    //
    // A caller supplying ONLY a style lock skips it: emitting "realistic
    // photography, natural lighting, clean composition" immediately above a
    // specific locked treatment states two different styles and lets the
    // model pick.
    lines.push("", "Style: realistic photography, natural lighting, clean composition.");
  }

  if (styleLock !== undefined) {
    lines.push("", `Style lock (identical for every image in this set, do not vary it): ${styleLock}`);
  }

  if (forbid.length > 0) {
    lines.push("", "Do not include:", ...forbid.map((f) => `- ${f}`));
  }

  lines.push("", buildConstraintLine(art?.permittedMarks ?? [], art?.permittedFigures ?? [], referenceRoles.some((r) => r === "product" || r === "logo")));

  return lines.join("\n");
}

/**
 * The standing constraints — this pipeline's own, as distinct from the
 * client's `Do not include:` list.
 *
 * ## The default is the whole point
 *
 * With both permits empty it returns the 1.1.0 string byte for byte. That is
 * not a nicety: it is what every client in the fleet gets, on every run, and
 * it is the single assertion in `generate-image-concept.test.ts` written as an
 * exact literal rather than a `toContain`.
 *
 * ## What a permitted mark changes, and what it must not
 *
 * Only the `no logos` clause. `no text, no words, no lettering, no numbers`
 * stays exactly as it was, and a mark is explicitly NOT a licence to render
 * lettering — a wordmark is lettering, so the permitted form is stated as a
 * badge or a wordless silhouette. That framing is not decoration: it is what
 * the reference account actually does, it keeps the mark out of the
 * photographic content where a rights question is sharpest, and it is the only
 * form that renders legibly at feed size anyway.
 *
 * ## Why figures get their own sentence instead of editing the first
 *
 * The 1.1.0 constraint line says nothing about people, so there is no clause
 * for a figure permit to narrow — appending it to that sentence would mean
 * rewriting a line that has nothing to do with the permission. A second
 * sentence leaves the marks clause at its default when only figures are
 * permitted, which is the composition this has to get right: the two permits
 * are independent, and either one alone must leave the other's default intact.
 */
function buildConstraintLine(permittedMarks: readonly string[], permittedFigures: readonly string[], carriesClientMarks = false): string {
  // A reference product or logo carries its own printed text and mark, which
  // must survive; every OTHER word and mark stays forbidden. Without a
  // reference this is the standing line, byte for byte.
  if (carriesClientMarks) {
    return (
      "Constraints: no text, words, lettering or numbers other than what is printed on the reference product or logo itself; " +
      "no other logos or brand marks; no watermarks, no borders or frames, no collage or split panels."
    );
  }
  const marksClause =
    permittedMarks.length > 0
      ? `no logos or brand marks other than: ${permittedMarks.join(", ")} — those may appear only as clean flat ` +
        "circular badges or plain wordless silhouettes, never as a photographed product, a packaged good or a " +
        "person's likeness;"
      : "no logos,";

  const constraints =
    "Constraints: no text, no words, no lettering, no numbers rendered in the image, " +
    `${marksClause} no watermarks, no borders or frames, no collage or split panels.`;

  if (permittedFigures.length === 0) return constraints;

  return (
    `${constraints} No identifiable real person other than: ${permittedFigures.join(", ")} — ` +
    "no other recognisable face, likeness or public figure may appear in the frame."
  );
}
