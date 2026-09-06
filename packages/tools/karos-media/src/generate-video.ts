import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, notAvailable, toolingError } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";

// 1.1.0: Veo 3.1 by default, priced per second at last; resolution/audio/
// people/negative-prompt controls; `outputName` so several plates can share
// one run dir.
const TOOL_VERSION = "1.1.0";

/**
 * `video.generateClip` — Tier 3 of the clip pipeline's sourcing cascade:
 * a short generated B-roll plate for when the run has no user-attached
 * episode (Tier 1) and no harvestable footage (Tier 2). Follows
 * `image.generate`'s exact conventions: injectable client, `not_available`
 * when unconfigured (never a construction throw), retry only on the
 * transient quota/availability shape, repoRoot-bounded cache writes.
 *
 * The brief is constrained the same way `image.generate`'s is, for the same
 * reason: the branded frame (`video.brandFrame`) composites bars, captions,
 * a header and a logo ON TOP of this plate, so generated text or logos
 * underneath would collide with the real ones. A caller's `negativePrompt`
 * is merged with that built-in list, never substituted for it.
 */

export const GenerateVideoInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. The written clip path is relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as media.findImages does."),
  brief: z.string().min(1).max(1200).describe("What the plate should show — a scene, not a message."),
  durationSeconds: z.number().int().min(4).max(8).default(8).describe("Veo generates short clips; the pipeline loops/cuts as needed."),
  aspectRatio: z.enum(["9:16", "16:9"]).default("9:16").describe("The generated clip's aspect ratio."),
  resolution: z.enum(["720p", "1080p"]).default("1080p").describe("Output resolution. Priced per second by resolution on the Fast tier."),
  generateAudio: z.boolean().default(true).describe("Veo's native ambient sound; the composer ducks it under a voiceover."),
  allowPeople: z
    .boolean()
    .default(false)
    .describe("Permit adult people in the plate (Veo `personGeneration: allow_adult`). Off by default: a B-roll plate rarely needs a face, and a generated one is the fastest way to look AI-made."),
  negativePrompt: z.string().max(400).optional().describe("Things the plate must NOT contain, merged with the built-in no-text/no-logo list."),
  outputName: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("generated-clip")
    .describe("File stem inside the run cache (`<outputName>.mp4`), so a caller can generate several plates into one run dir."),
});
export type GenerateVideoInput = z.infer<typeof GenerateVideoInputSchema>;

export interface GenerateVideoResult {
  /** Repo-relative, forward-slashed — the same contract every media tier's candidates use. */
  path: string;
  model: string;
  resolution: "720p" | "1080p";
  durationSeconds: number;
}

/**
 * The narrow slice of `@google/genai` this tool uses — injectable so tests
 * never talk to Vertex, mirroring `ImageGenerationClient`.
 */
export interface VideoGenerationClient {
  models: {
    generateVideos(params: {
      model: string;
      prompt: string;
      config?: Record<string, unknown>;
    }): Promise<VideoGenerationOperation>;
  };
  operations: {
    getVideosOperation(params: { operation: VideoGenerationOperation }): Promise<VideoGenerationOperation>;
  };
}

export interface VideoGenerationOperation {
  done?: boolean;
  error?: { message?: string };
  response?: {
    generatedVideos?: Array<{
      video?: { videoBytes?: string; uri?: string };
    }>;
  };
}

/** Same transient shape `image.generate` retries — Vertex burst limits clear themselves in seconds. */
function isRetryableGenerationError(message: string): boolean {
  return /"code"\s*:\s*429|RESOURCE_EXHAUSTED|"code"\s*:\s*503|\bUNAVAILABLE\b/.test(message);
}

export interface GenerateVideoOptions {
  client?: VideoGenerationClient | undefined;
  /** Model override (`VIDEO_GEN_MODEL`). Default is the priced Veo 3.1 Standard id. */
  model?: string | undefined;
  /** Injectable for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /** Video generation is a long-running operation; this caps the wait. */
  maxWaitMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_VIDEO_MODEL = "veo-3.1-generate-001";

/**
 * The `UNIT_PRICING` SKU a generation bills against. Veo 3.1 Standard is one
 * rate at both resolutions, so its row is the bare model id; the Fast tier
 * is priced per resolution, so its rows carry a `:<resolution>` suffix and
 * the SKU must too. Any other id is reported as-is — an unpriced id then
 * fails `check:pricing`, which is the intended way to notice a model swap
 * that nobody priced.
 */
export function videoGenerationSku(model: string, resolution: "720p" | "1080p"): string {
  if (model === DEFAULT_VIDEO_MODEL) return model;
  if (model.includes("fast")) return `${model}:${resolution}`;
  return model;
}

/** What the frame composites over the plate, so the plate must not already contain it. */
const BUILT_IN_NEGATIVE_PROMPT = "text, words, lettering, captions, subtitles, logos, watermarks, borders, letterboxing";

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createGenerateVideo(options: GenerateVideoOptions = {}) {
  const model = options.model ?? DEFAULT_VIDEO_MODEL;
  const sleep = options.sleepImpl ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const maxWaitMs = options.maxWaitMs ?? 5 * 60_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<GenerateVideoInput, GenerateVideoResult>({
    name: "video.generateClip",
    description:
      "Tier 3 of the clip pipeline's sourcing cascade: generates a short B-roll plate via Veo 3.1 for when a run has no user-attached episode (Tier 1) and no harvestable footage (Tier 2). Reports not_available when unconfigured; retries the same transient quota/availability shape image.generate does; bills per generated second.",
    version: TOOL_VERSION,
    inputSchema: GenerateVideoInputSchema,
    async execute(input) {
      const client = options.client;
      if (client === undefined) {
        return notAvailable(
          "video generation is not configured for this deployment (no Vertex project) — the clip pipeline's other tiers still work",
        );
      }

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`video.generateClip: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }
      await fs.mkdir(absDir, { recursive: true });

      const prompt =
        `${input.brief}. Cinematic b-roll, natural motion, realistic lighting. ` +
        `No text, no words, no lettering, no captions, no logos, no watermarks, no borders — ` +
        `branded framing and captions are composited on top of this footage separately.`;
      const negativePrompt = input.negativePrompt?.trim()
        ? `${BUILT_IN_NEGATIVE_PROMPT}, ${input.negativePrompt.trim()}`
        : BUILT_IN_NEGATIVE_PROMPT;

      let operation: VideoGenerationOperation | undefined;
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          operation = await client.models.generateVideos({
            model,
            prompt,
            config: {
              numberOfVideos: 1,
              durationSeconds: input.durationSeconds,
              aspectRatio: input.aspectRatio,
              resolution: input.resolution,
              generateAudio: input.generateAudio,
              personGeneration: input.allowPeople ? "allow_adult" : "dont_allow",
              negativePrompt,
            },
          });
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt >= maxAttempts || !isRetryableGenerationError(lastError.message)) {
            return toolingError(`video.generateClip: generation request failed: ${lastError.message.slice(0, 600)}`);
          }
          await sleep(2000 * 2 ** (attempt - 1));
        }
      }
      if (operation === undefined) {
        return toolingError(`video.generateClip: generation never started${lastError ? `: ${lastError.message.slice(0, 300)}` : ""}`);
      }

      const deadline = Date.now() + maxWaitMs;
      while (!operation.done) {
        if (Date.now() > deadline) {
          return toolingError(`video.generateClip: generation did not complete within ${Math.round(maxWaitMs / 1000)}s`);
        }
        await sleep(pollIntervalMs);
        try {
          operation = await client.operations.getVideosOperation({ operation });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isRetryableGenerationError(message)) {
            return toolingError(`video.generateClip: polling failed: ${message.slice(0, 600)}`);
          }
        }
      }
      if (operation.error?.message) {
        return contentFail(`video.generateClip: the model declined this brief: ${operation.error.message.slice(0, 600)}`);
      }

      const video = operation.response?.generatedVideos?.[0]?.video;
      if (!video || (!video.videoBytes && !video.uri)) {
        return contentFail("video.generateClip: generation completed with no video in the response");
      }

      const fileName = `${input.outputName}.mp4`;
      const outFile = path.join(absDir, fileName);
      if (video.videoBytes) {
        await fs.writeFile(outFile, Buffer.from(video.videoBytes, "base64"));
      } else {
        // A URI response (Vertex sometimes returns a downloadable location
        // instead of inline bytes) — fetched with the same refuse-don't-guess
        // posture the ingest downloader takes.
        const response = await fetchImpl(video.uri!);
        if (!response.ok) {
          return toolingError(`video.generateClip: could not download the generated video (${response.status})`);
        }
        await fs.writeFile(outFile, Buffer.from(await response.arrayBuffer()));
      }

      // Video is billed PER SECOND — the case the per-unit usage dimension was
      // designed around. The Veo 3.1 rows exist in `UNIT_PRICING` (read off
      // the pricing page, not guessed), so this is a real cost now, not the
      // $0-with-units placeholder it was under the Veo 2 id. Quantity is the
      // requested duration: Veo returns exactly the seconds asked for.
      return success<GenerateVideoResult>(
        { path: `${relDir}/${fileName}`, model, resolution: input.resolution, durationSeconds: input.durationSeconds },
        [{ model: videoGenerationSku(model, input.resolution), unit: "second", quantity: input.durationSeconds }],
      );
    },
  });
}
