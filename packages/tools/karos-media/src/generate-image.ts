import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError, notAvailable } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX, type FindImagesCandidate } from "./find-images.js";

const TOOL_VERSION = "1.0.0";

/**
 * Vertex Imagen, reached through the same `@google/genai` client the Gemini
 * adapter uses. Narrowed to the one call this tool makes so the package does
 * not take a type dependency on the whole SDK surface.
 */
export interface ImageGenerationClient {
  models: {
    generateImages(request: {
      model: string;
      prompt: string;
      config?: Record<string, unknown>;
    }): Promise<{
      generatedImages?: Array<{
        image?: { imageBytes?: string; mimeType?: string } | undefined;
        raiFilteredReason?: string | undefined;
      }>;
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
        /** The slide's own `visualNeed`, used verbatim as the generation subject. */
        prompt: z.string().min(1),
      }),
    )
    .min(1),
  /** Images per need. One is usually right — a second costs the same again for a marginal choice. */
  perNeed: z.number().int().min(1).max(4).default(1),
  /** Imagen aspect ratio. Carousel slides are rendered into a template, so a landscape crop suits most. */
  aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).default("4:3"),
});
export type GenerateImageInput = z.input<typeof GenerateImageInputSchema>;

export interface GenerateImageResult {
  candidates: FindImagesCandidate[];
  /** Needs that produced nothing, with the reason. Never silently dropped. */
  unmet: { n: number; reason: string }[];
  model: string;
}

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
 * A short, explicit provenance note prepended to the description.
 *
 * The vetting agent has to decide `rightsUsable`/`watermarkFree` on this
 * image, and it cannot inspect pixels — it reads the description. Saying
 * plainly that this was generated to the slide's own brief is what lets it
 * answer yes on rights honestly, rather than defaulting to sceptical the way
 * it should for a web-sourced hit.
 */
function describeGenerated(prompt: string): string {
  return `AI-generated illustration created specifically for this slide, to the brief: "${prompt}". Not a stock photo — no third-party copyright, no watermark, no identifiable real person unless described above.`;
}

/**
 * `media.generateImage` — the fallback for a visual need no library holds.
 *
 * ## Why this exists
 *
 * Retrieval has a hard ceiling that more providers cannot raise. prep run
 * pubsub-21535110633863323 hit it precisely: with four providers and 36
 * candidates, slide 5 still failed because it needed "a timeline or roadmap
 * with a clearly labeled 'research' first phase, shot from above, clean and
 * minimal". No stock or CC library contains that picture, and no number of
 * additional search backends will conjure it. Generation is the only source
 * that can answer a specific brief on demand.
 *
 * ## Why it is a tool and not another `ImageSearchProvider`
 *
 * Every provider in a chain is queried for every need — that is what makes
 * the merged pool diverse. Generation must not work that way: each image is
 * billed, so it belongs to the slides that actually came up empty, invoked
 * deliberately by the workflow after the gate has spoken. Putting it in the
 * chain would generate six images on every run, most of them thrown away.
 *
 * Unconfigured (no `client`) it reports `not_available`, exactly like every
 * other capability in this codebase — never a construction-time throw.
 */
export function createGenerateImage(options: {
  client?: ImageGenerationClient | undefined;
  /** Vertex Imagen model id. Overridable because availability varies per project and region. */
  model?: string;
}) {
  const model = options.model ?? "imagen-4.0-generate-001";

  return defineTool<GenerateImageInput, GenerateImageResult>({
    name: "media.generateImage",
    version: TOOL_VERSION,
    inputSchema: GenerateImageInputSchema,
    async execute(rawInput) {
      const input = GenerateImageInputSchema.parse(rawInput);

      if (options.client === undefined) {
        return notAvailable(
          "media.generateImage: no image-generation backend configured — set GEMINI_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) " +
            "so Vertex Imagen can be reached (see packages/tools/karos-media/README.md)",
        );
      }

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
        let response: Awaited<ReturnType<ImageGenerationClient["models"]["generateImages"]>>;
        try {
          response = await options.client.models.generateImages({
            model,
            prompt: need.prompt,
            config: {
              numberOfImages: input.perNeed,
              aspectRatio: input.aspectRatio,
              // Slides routinely call for a person ("someone at a laptop with a
              // thoughtful expression"). Without this, Imagen refuses those
              // outright and the rescue pass would fail on exactly the needs it
              // was added to cover.
              personGeneration: "allow_adult",
            },
          });
        } catch (error) {
          // One need's failure must not abandon the others: a rescue pass that
          // fills 1 of 2 gaps is strictly better than one that fills neither,
          // and the caller still sees why the other was missed.
          unmet.push({ n: need.n, reason: `generation failed: ${(error as Error).message}` });
          continue;
        }

        const images = response.generatedImages ?? [];
        if (images.length === 0) {
          unmet.push({ n: need.n, reason: "the model returned no images" });
          continue;
        }

        let savedForNeed = 0;
        for (const [index, generated] of images.entries()) {
          // A safety-filtered result is a real, reportable outcome rather than
          // an error — the brief asked for something the model will not draw.
          if (generated.raiFilteredReason) {
            unmet.push({ n: need.n, reason: `filtered by the model's safety policy: ${generated.raiFilteredReason}` });
            continue;
          }
          const base64 = generated.image?.imageBytes;
          if (base64 === undefined || base64.length === 0) continue;

          const mime = generated.image?.mimeType ?? "image/png";
          const extension = MIME_EXTENSION[mime] ?? ".png";
          const stem = `n${need.n}-gen${index}`;
          const relative = `${relDir}/${stem}${extension}`;

          try {
            await fs.writeFile(path.join(absDir, `${stem}${extension}`), Buffer.from(base64, "base64"));
          } catch (error) {
            unmet.push({ n: need.n, reason: `could not write the generated image: ${(error as Error).message}` });
            continue;
          }

          candidates.push({
            path: relative,
            description: `slide ${need.n} candidate — ${describeGenerated(need.prompt)} [licence: ${GENERATED_LICENSE}]`,
            provider: "imagen",
            licenseConfidence: "generated",
          });
          savedForNeed += 1;
        }

        if (savedForNeed === 0 && !unmet.some((u) => u.n === need.n)) {
          unmet.push({ n: need.n, reason: "the model returned no usable image bytes" });
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
