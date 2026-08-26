import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGenerateVideo, type VideoGenerationClient, type VideoGenerationOperation } from "../src/generate-video.js";

const TINY_MP4 = Buffer.from("AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==", "base64");

function clientReturning(operation: VideoGenerationOperation, polls: VideoGenerationOperation[] = []): VideoGenerationClient {
  const queue = [...polls];
  return {
    models: { generateVideos: async () => operation },
    operations: { getVideosOperation: async () => queue.shift() ?? operation },
  };
}

describe("video.generateClip", () => {
  it("reports not_available when no client is configured — the cascade's other tiers still work", async () => {
    const tool = createGenerateVideo({});
    const outcome = await tool.execute({ repoRoot: "/tmp", runId: "r", brief: "a calm office" }, { ctx: {} as never });
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
    const outcome = await tool.execute({ repoRoot, runId: "run1", brief: "aerial city at dusk" }, { ctx: {} as never });
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { path: string } }).result;
    expect(result.path).toBe(".media-cache/run1/generated-clip.mp4");
    const bytes = await fs.readFile(path.join(repoRoot, result.path));
    expect(bytes.equals(TINY_MP4)).toBe(true);
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("a declined brief is a content_fail, never a hold-worthy tooling error", async () => {
    const tool = createGenerateVideo({
      client: clientReturning({ done: true, error: { message: "safety: persons requested" } }),
      sleepImpl: async () => {},
    });
    const outcome = await tool.execute({ repoRoot: os.tmpdir(), runId: "r2", brief: "x" }, { ctx: {} as never });
    expect(outcome.status).toBe("content_fail");
  });

  it("constrains the prompt so bars/captions composited on top never collide with generated text", async () => {
    let seenPrompt = "";
    const client: VideoGenerationClient = {
      models: {
        generateVideos: async ({ prompt }) => {
          seenPrompt = prompt;
          return { done: true, response: { generatedVideos: [{ video: { videoBytes: TINY_MP4.toString("base64") } }] } };
        },
      },
      operations: { getVideosOperation: async (p) => p.operation },
    };
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genvid-"));
    await createGenerateVideo({ client, sleepImpl: async () => {} }).execute({ repoRoot, runId: "r3", brief: "a whiteboard session" }, { ctx: {} as never });
    expect(seenPrompt).toContain("No text, no words");
    expect(seenPrompt).toContain("no logos, no watermarks");
    await fs.rm(repoRoot, { recursive: true, force: true });
  });
});
