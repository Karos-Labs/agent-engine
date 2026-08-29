import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, notAvailable, toolingError } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";

const TOOL_VERSION = "1.0.0";

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
 * underneath would collide with the real ones.
 */

export const GenerateVideoInputSchema = z.object({
  // No existing TSDoc on these two fields to transcribe (SCRUM-293 flag) — synthesized from find-images.ts's identical fields and this file's own doc comment.
  repoRoot: z.string().min(1).describe("Bounds root. The written clip path is relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as media.findImages does."),
  brief: z.string().min(1).max(1200).describe("What the plate should show — a scene, not a message."),
  durationSeconds: z.number().int().min(4).max(8).default(8).describe("Veo generates short clips; the pipeline loops/cuts as needed."),
  aspectRatio: z.enum(["9:16", "16:9"]).default("9:16").describe("The generated clip's aspect ratio."),
});
export type GenerateVideoInput = z.infer<typeof GenerateVideoInputSchema>;

export interface GenerateVideoResult {
  /** Repo-relative, forward-slashed — the same contract every media tier's candidates use. */
  path: string;
  model: string;
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
  /** Model override. Default favors a 9:16-capable Veo generation. */
  model?: string | undefined;
  /** Injectable for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /** Video generation is a long-running operation; this caps the wait. */
  maxWaitMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_VIDEO_MODEL = "veo-2.0-generate-001";

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
      "Tier 3 of the clip pipeline's sourcing cascade: generates a short B-roll plate via Veo for when a run has no user-attached episode (Tier 1) and no harvestable footage (Tier 2). Reports not_available when unconfigured; retries the same transient quota/availability shape image.generate does.",
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
              personGeneration: "dont_allow",
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

      const outFile = path.join(absDir, "generated-clip.mp4");
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

      // the per-unit cost work — shipped without a Jira ticket: video is billed PER SECOND, and this is the case the
      // per-unit dimension was designed around rather than retrofitted to.
      //
      // `model` has no UNIT_PRICING row today and that is deliberate, not an
      // oversight: no per-second rate for this exact id could be verified
      // against a page actually read. So this records the seconds and costs
      // them at $0, loudly — the units are persisted, so the run becomes
      // reconcilable the moment a rate exists. Reporting nothing at all would
      // be the old behaviour, and the old behaviour is what made a $0.00 step
      // indistinguishable from a free one.
      return success<GenerateVideoResult>({ path: `${relDir}/generated-clip.mp4`, model }, [
        { model, unit: "second", quantity: input.durationSeconds },
      ]);
    },
  });
}
