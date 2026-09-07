import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeToolCostUsd } from "@agent-engine/core";
import {
  DEFAULT_VIDEO_MODEL,
  GenerateVideoInputSchema,
  createGenerateVideo,
  videoGenerationSku,
  type VideoGenerationClient,
  type VideoGenerationOperation,
} from "../src/generate-video.js";

/** The input as a caller sends it — parsed so Zod applies the schema's own defaults, exactly what `defineTool` does at runtime. */
function input(repoRoot: string, runId: string, brief: string, extra: Record<string, unknown> = {}) {
  return GenerateVideoInputSchema.parse({ repoRoot, runId, brief, ...extra });
}

const TINY_MP4 = Buffer.from("AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==", "base64");

function clientReturning(operation: VideoGenerationOperation, polls: VideoGenerationOperation[] = []): VideoGenerationClient {
  const queue = [...polls];
  return {
    models: { generateVideos: async () => operation },
    operations: { getVideosOperation: async () => queue.shift() ?? operation },
  };
}

/** A client that answers immediately and records what it was asked. */
function capturingClient() {
  const calls: Array<{ model: string; prompt: string; config?: Record<string, unknown> }> = [];
  const client: VideoGenerationClient = {
    models: {
      generateVideos: async (params) => {
        calls.push(params);
        return { done: true, response: { generatedVideos: [{ video: { videoBytes: TINY_MP4.toString("base64") } }] } };
      },
    },
    operations: { getVideosOperation: async (p) => p.operation },
  };
  return { client, calls };
}

type Usage = Array<{ model: string; unit: string; quantity: number }>;

describe("video.generateClip", () => {
  it("reports not_available when no client is configured — the cascade's other tiers still work", async () => {
    const tool = createGenerateVideo({});
    const outcome = await tool.execute(input("/tmp", "r", "a calm office"), { ctx: {} as never });
    expect(outcome.status).toBe("not_available");
  });

  it("polls the long-running operation to completion and writes the clip into the run cache", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genvid-"));
    const done: VideoGenerationOperation = {
      done: true,
      response: { generatedVideos: [{ video: { videoBytes: TINY_MP4.toString("base64") } }] },
    };
    const tool = createGenerateVideo({
      client: clientReturning({ done: false }, [{ done: false }, done]),
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const outcome = await tool.execute(input(repoRoot, "run1", "aerial city at dusk"), { ctx: {} as never });
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { path: string; model: string; resolution: string; durationSeconds: number } }).result;
    expect(result.path).toBe(".media-cache/run1/generated-clip.mp4");
    expect(result.model).toBe("veo-3.1-generate-001");
    expect(result.resolution).toBe("1080p");
    expect(result.durationSeconds).toBe(8);
    const bytes = await fs.readFile(path.join(repoRoot, result.path));
    expect(bytes.equals(TINY_MP4)).toBe(true);
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("a declined brief is a content_fail, never a hold-worthy tooling error", async () => {
    const tool = createGenerateVideo({
      client: clientReturning({ done: true, error: { message: "safety: persons requested" } }),
      sleepImpl: async () => {},
    });
    const outcome = await tool.execute(input(os.tmpdir(), "r2", "x"), { ctx: {} as never });
    expect(outcome.status).toBe("content_fail");
  });

  it("constrains the prompt so bars/captions composited on top never collide with generated text, and merges a caller's negativePrompt with the built-in list", async () => {
    const { client, calls } = capturingClient();
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genvid-"));
    await createGenerateVideo({ client, sleepImpl: async () => {} }).execute(input(repoRoot, "r3", "a whiteboard session", { negativePrompt: "crowds" }), { ctx: {} as never });
    expect(calls[0]!.prompt).toContain("No text, no words");
    expect(calls[0]!.prompt).toContain("no logos, no watermarks");
    // 1.2.0: the register is documentary, never "cinematic" — the generator's own default look.
    expect(calls[0]!.prompt).toContain("Documentary realism");
    expect(calls[0]!.prompt).not.toMatch(/cinematic/i);
    const negative = calls[0]!.config!["negativePrompt"] as string;
    expect(negative).toContain("logos");
    expect(negative).toContain("watermarks");
    expect(negative).toContain("CGI");
    expect(negative).toContain("slow motion");
    expect(negative.endsWith(", crowds")).toBe(true);
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("defaults to Veo 3.1 at 1080p with native audio and no people, and passes each control into config", async () => {
    const { client, calls } = capturingClient();
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genvid-"));
    const tool = createGenerateVideo({ client, sleepImpl: async () => {} });
    await tool.execute(input(repoRoot, "r4", "rain on a window"), { ctx: {} as never });
    expect(calls[0]!.model).toBe(DEFAULT_VIDEO_MODEL);
    expect(calls[0]!.config).toMatchObject({
      numberOfVideos: 1,
      durationSeconds: 8,
      aspectRatio: "9:16",
      resolution: "1080p",
      generateAudio: true,
      personGeneration: "dont_allow",
    });

    await tool.execute(input(repoRoot, "r4", "a barista at work", { allowPeople: true, resolution: "720p", generateAudio: false, durationSeconds: 5 }), { ctx: {} as never });
    expect(calls[1]!.config).toMatchObject({ resolution: "720p", generateAudio: false, personGeneration: "allow_adult", durationSeconds: 5 });
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("bills per generated second against the priced Veo 3.1 SKU — the bare id for Standard, resolution-suffixed for Fast", async () => {
    const { client } = capturingClient();
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genvid-"));

    const standard = await createGenerateVideo({ client, sleepImpl: async () => {} }).execute(input(repoRoot, "r5", "x", { durationSeconds: 6 }), { ctx: {} as never });
    const standardUsage = (standard as unknown as { usage: Usage }).usage;
    expect(standardUsage).toEqual([{ model: "veo-3.1-generate-001", unit: "second", quantity: 6 }]);
    expect(computeToolCostUsd(standardUsage)).toBeCloseTo(6 * 0.4, 6);

    const fast = await createGenerateVideo({ client, model: "veo-3.1-fast-generate-001", sleepImpl: async () => {} }).execute(
      input(repoRoot, "r5", "x", { resolution: "720p", durationSeconds: 4 }),
      { ctx: {} as never },
    );
    const fastUsage = (fast as unknown as { usage: Usage }).usage;
    expect(fastUsage).toEqual([{ model: "veo-3.1-fast-generate-001:720p", unit: "second", quantity: 4 }]);
    expect(computeToolCostUsd(fastUsage)).toBeCloseTo(4 * 0.1, 6);

    // Anything else is reported verbatim — an unpriced id then fails check:pricing on purpose.
    expect(videoGenerationSku("veo-9-experimental", "1080p")).toBe("veo-9-experimental");
    expect(videoGenerationSku("veo-3.1-fast-generate-001", "1080p")).toBe("veo-3.1-fast-generate-001:1080p");
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("two calls with different outputName write two files into the same run dir", async () => {
    const { client } = capturingClient();
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genvid-"));
    const tool = createGenerateVideo({ client, sleepImpl: async () => {} });
    const a = await tool.execute(input(repoRoot, "r6", "plate one", { outputName: "plate-1" }), { ctx: {} as never });
    const b = await tool.execute(input(repoRoot, "r6", "plate two", { outputName: "plate-2" }), { ctx: {} as never });
    expect((a as { result: { path: string } }).result.path).toBe(".media-cache/r6/plate-1.mp4");
    expect((b as { result: { path: string } }).result.path).toBe(".media-cache/r6/plate-2.mp4");
    const files = (await fs.readdir(path.join(repoRoot, ".media-cache", "r6"))).sort();
    expect(files).toEqual(["plate-1.mp4", "plate-2.mp4"]);
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("refuses an outputName that could leave the run dir or collide with the harvest tier's file", () => {
    expect(GenerateVideoInputSchema.safeParse({ repoRoot: "/r", runId: "x", brief: "b", outputName: "../escape" }).success).toBe(false);
    expect(GenerateVideoInputSchema.safeParse({ repoRoot: "/r", runId: "x", brief: "b", outputName: "Plate One" }).success).toBe(false);
    expect(GenerateVideoInputSchema.safeParse({ repoRoot: "/r", runId: "x", brief: "b", outputName: "plate-1" }).success).toBe(true);
  });
});
