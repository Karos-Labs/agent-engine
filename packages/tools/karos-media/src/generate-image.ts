import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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
  /** Bounds root. Written paths are relative to this and provably inside it. */
  repoRoot: z.string().min(1),
  /** Namespaces the cache directory, exactly as `media.findImages` does. */
  runId: z.string().min(1),
  /**
   * One entry per slide that retrieval could not satisfy. Deliberately not
   * "every slide": each image is a real, billed generation, so this tool is
   * called for the gaps rather than the whole carousel.
   */
  needs: z
    .array(
      z.object({
        n: z.number().int().positive(),
        /** The slide's own `visualNeed`, used as the generation brief. */
        prompt: z.string().min(1),
      }),
    )
    .min(1),
  /**
   * Images per need, as separate billed calls. One is usually right: a rescue
   * needs a picture that works, not a shortlist, and the gate is about to
   * judge whatever arrives.
   */
  perNeed: z.number().int().min(1).max(3).default(1),
  /** Passed through as `imageConfig.aspectRatio`; verified accepted by the model. */
  aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).default("4:3"),
});
export type GenerateImageInput = z.input<typeof GenerateImageInputSchema>;

export interface GenerateImageResult {
  candidates: FindImagesCandidate[];
  /** Needs that produced nothing, with the reason. Never silently dropped. */
  unmet: { n: number; reason: string }[];
  model: string;
}

/** The default. Verified reachable in prep; every `imagen-*` id 404s there. */
export const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

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
 * `media.generateImage` — the fallback for a visual need no library holds.
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
}) {
  const model = options.model ?? DEFAULT_IMAGE_MODEL;

  return defineTool<GenerateImageInput, GenerateImageResult>({
    name: "media.generateImage",
    version: TOOL_VERSION,
    inputSchema: GenerateImageInputSchema,
    async execute(rawInput) {
      const input = GenerateImageInputSchema.parse(rawInput);

      if (options.client === undefined) {
        return notAvailable(
          "media.generateImage: no image-generation backend configured — set GEMINI_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) " +
            "so Vertex can be reached (see packages/tools/karos-media/README.md)",
        );
      }
      const client = options.client;

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      // Same bounds check as `media.findImages`: a runId carrying "../" is the
      // case that matters, and it is caught before anything is written.
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`media.generateImage: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }

      try {
        await fs.mkdir(absDir, { recursive: true });
      } catch (error) {
        return toolingError(`media.generateImage: could not create ${relDir}: ${(error as Error).message}`);
      }

      const candidates: FindImagesCandidate[] = [];
      const unmet: GenerateImageResult["unmet"] = [];

      for (const need of input.needs) {
        let savedForNeed = 0;
        const failures: string[] = [];

        for (let attempt = 0; attempt < input.perNeed; attempt++) {
          let response: Awaited<ReturnType<ImageGenerationClient["models"]["generateContent"]>>;
          try {
            response = await client.models.generateContent({
              model,
              contents: buildBrief(need.prompt),
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
          `media.generateImage: produced nothing for ${input.needs.length} need(s) — ${unmet
            .map((u) => `slide ${u.n} (${u.reason})`)
            .join("; ")}`,
        );
      }

      return success<GenerateImageResult>({ candidates, unmet, model });
    },
  });
}

/**
 * Wraps the slide's `visualNeed` in the framing the rest of this package
 * assumes: a photographic still, no text baked into the pixels.
 *
 * The no-text instruction matters twice over. Generated lettering comes out
 * malformed, and the carousel template renders the real headline and body as
 * live text over the image — so any words in the picture itself would collide
 * with copy that is already there.
 */
function buildBrief(visualNeed: string): string {
  return (
    `Create a photographic image for a social media carousel slide: ${visualNeed}\n\n` +
    "Style: realistic photography, natural lighting, clean composition, no text, no words, " +
    "no lettering, no logos, no watermarks, no borders or frames."
  );
}
