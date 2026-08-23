import { describe, expect, it, vi } from "vitest";
import { createTranscribe } from "../src/tools/transcribe.js";
import { ctx } from "./test-helpers.js";

const readFileImpl = async () => Buffer.from("fake video bytes");

describe("video.transcribe", () => {
  it("is not_available with no ElevenLabs API key configured, and never calls fetch", async () => {
    // Was `tooling_error`, deliberately changed. "This deployment has never
    // been given a key" and "ElevenLabs is broken" have different answers —
    // one is an operator setting a value, the other is a retry — and reporting
    // the first as the second made an unconfigured prep environment read as an
    // outage. karos-media already drew this line; see transcribe-degradation
    // for the full set.
    const fetchImpl = vi.fn();
    const tool = createTranscribe({ fetchImpl: fetchImpl as unknown as typeof fetch, env: {}, readFileImpl });
    const outcome = await tool.execute({ videoPath: "/clip.mov" }, { ctx });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain("ELEVENLABS_API_KEY");
  });

  it("posts the file as multipart form data with the xi-api-key header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ words: [] }), { status: 200 }));
    const tool = createTranscribe({ fetchImpl: fetchImpl as unknown as typeof fetch, env: { ELEVENLABS_API_KEY: "sk-test" }, readFileImpl });
    await tool.execute({ videoPath: "/clip.mov" }, { ctx });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk-test");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("maps ElevenLabs word-level output onto the transcript shape cut_check.py expects", async () => {
    const words = [
      { text: "um", start: 0.0, end: 0.2, type: "audio_event" },
      { text: "Hello", start: 0.3, end: 0.6, type: "word" },
      { text: " ", start: 0.6, end: 0.65, type: "spacing" },
      { text: "world", start: 0.65, end: 1.0, type: "word" },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ words }), { status: 200 }));
    const tool = createTranscribe({ fetchImpl: fetchImpl as unknown as typeof fetch, env: { ELEVENLABS_API_KEY: "sk-test" }, readFileImpl });
    const outcome = await tool.execute({ videoPath: "/clip.mov" }, { ctx });

    expect(outcome).toEqual({ status: "success", result: { words } });
  });

  it("is a tooling_error on a non-2xx ElevenLabs response, with the body surfaced for debugging", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("invalid_api_key", { status: 401, statusText: "Unauthorized" }));
    const tool = createTranscribe({ fetchImpl: fetchImpl as unknown as typeof fetch, env: { ELEVENLABS_API_KEY: "bad-key" }, readFileImpl });
    const outcome = await tool.execute({ videoPath: "/clip.mov" }, { ctx });

    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("401");
    expect((outcome as { reason: string }).reason).toContain("invalid_api_key");
  });

  it("lets an explicit apiKey argument override the environment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ words: [] }), { status: 200 }));
    const tool = createTranscribe({ fetchImpl: fetchImpl as unknown as typeof fetch, env: { ELEVENLABS_API_KEY: "env-key" }, readFileImpl });
    await tool.execute({ videoPath: "/clip.mov", apiKey: "explicit-key" }, { ctx });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("explicit-key");
  });
});
