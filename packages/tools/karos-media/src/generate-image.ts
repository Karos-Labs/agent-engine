import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logWarning } from "@agent-engine/telemetry";
import { defineTool, success, contentFail, toolingError, notAvailable } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX, type FindImagesCandidate } from "./find-images.js";

const TOOL_VERSION = "1.0.0";

/**
 * The image-generation call, narrowed to what this tool uses so the package
 * does not take a type dependency on the whole `@google/genai` surface.
 *
 * This is `generateContent`, not `generateImages`. The SDK deprecates
 * `generateImages` ("will be removed in the next major release… use the
 * generateContent method with image models instead"), and the Imagen publisher
 * models it targets are not available in this deployment at all — every
 * `imagen-*` id returns 404 for `karoscmo-prep`, while `gemini-2.5-flash-image`
 * answers on both `global` and `us-central1`. Probed directly before this was
 * written rather than assumed.
 */
export interface ImageGenerationClient {
  models: {
    generateContent(request: {
      model: string;
      contents: string;
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

export const GenerateImageInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. Written paths are relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as media.findImages does."),
  needs: z
    .array(
      z.object({
        n: z.number().int().positive().describe("This slide's number."),
        prompt: z.string().min(1).describe("The slide's own visualNeed, used as the generation brief."),
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
  aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).default("4:3").describe("Passed through as imageConfig.aspectRatio; verified accepted by the model."),
  art: z
    .object({
      aesthetic: z.string().min(1).optional().describe("e.g. \"editorial\", \"documentary\", \"minimal product photography\"."),
      lighting: z.string().min(1).optional().describe("e.g. \"soft diffused daylight\", \"hard directional studio light\"."),
      palette: z.array(z.string().min(1)).max(6).optional().describe("Named or hex colours the frame should sit in."),
      accentColor: z.string().min(1).optional().describe("The client's single accent colour, when they have one."),
      mood: z.string().min(1).optional().describe("e.g. \"calm and considered\", \"urgent\"."),
      notes: z.string().min(1).optional().describe("Extra client-specific direction, appended verbatim."),
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

/** The default. Verified reachable in prep; every `imagen-*` id 404s there. */
export const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

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
 */
function describeGenerated(prompt: string): string {
  return `AI-generated illustration created specifically for this slide, to the brief: "${prompt}". Not a stock photo — no third-party copyright, no watermark, no identifiable real person unless described above.`;
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
  const model = options.model ?? DEFAULT_IMAGE_MODEL;
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 3);
  const baseDelayMs = options.retry?.baseDelayMs ?? 2_000;
  const sleep = options.retry?.sleepImpl ?? defaultSleep;

  /**
   * Retries only the transient shape (`isRetryableGenerationError`) — a real
   * refusal or a malformed request fails on the first try exactly as before,
   * with no added latency.
   */
  async function generateWithBackoff(
    request: Parameters<ImageGenerationClient["models"]["generateContent"]>[0],
  ): Promise<Awaited<ReturnType<ImageGenerationClient["models"]["generateContent"]>>> {
    const client = options.client!;
    let lastError: Error;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await client.models.generateContent(request);
      } catch (error) {
        lastError = error as Error;
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
      const input = GenerateImageInputSchema.parse(rawInput);

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

      for (const need of input.needs) {
        let savedForNeed = 0;
        const failures: string[] = [];

        for (let attempt = 0; attempt < input.perNeed; attempt++) {
          let response: Awaited<ReturnType<ImageGenerationClient["models"]["generateContent"]>>;
          try {
            response = await generateWithBackoff({
              model,
              contents: buildBrief(need.prompt, input.art),
              config: {
                // Both modalities: the model narrates its refusal as text when
                // it declines, and that text is the only explanation on offer.
                responseModalities: ["TEXT", "IMAGE"],
                imageConfig: { aspectRatio: input.aspectRatio },
              },
            });
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

          try {
            await fs.writeFile(path.join(absDir, `${stem}${extension}`), Buffer.from(image.inlineData.data, "base64"));
          } catch (error) {
            failures.push(`could not write the generated image: ${(error as Error).message}`);
            continue;
          }

          candidates.push({
            path: relative,
            description: `slide ${need.n} candidate — ${describeGenerated(need.prompt)} [licence: ${GENERATED_LICENSE}]`,
            provider: "gemini-image",
            licenseConfidence: "generated",
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
      return success<GenerateImageResult>({ candidates, unmet, model }, [
        { model, unit: "image", quantity: candidates.length },
      ]);
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
 */
function buildBrief(visualNeed: string, art?: GenerateImageInputParsed["art"]): string {
  const lines = [`Create a photographic image for a social media carousel slide: ${visualNeed}`];

  const direction: string[] = [];
  if (art?.aesthetic) direction.push(`Aesthetic: ${art.aesthetic}.`);
  if (art?.lighting) direction.push(`Lighting: ${art.lighting}.`);
  if (art?.palette && art.palette.length > 0) direction.push(`Colour palette: ${art.palette.join(", ")}.`);
  if (art?.accentColor) direction.push(`Carry the brand accent colour ${art.accentColor} somewhere in the frame, as an object or surface rather than an overlay.`);
  if (art?.mood) direction.push(`Mood: ${art.mood}.`);
  if (art?.notes) direction.push(art.notes);

  if (direction.length > 0) {
    lines.push("", "Art direction:", ...direction.map((d) => `- ${d}`));
  } else {
    // The prior behaviour, kept verbatim for a caller supplying no direction.
    lines.push("", "Style: realistic photography, natural lighting, clean composition.");
  }

  lines.push(
    "",
    "Constraints: no text, no words, no lettering, no numbers rendered in the image, " +
      "no logos, no watermarks, no borders or frames, no collage or split panels.",
  );

  return lines.join("\n");
}
