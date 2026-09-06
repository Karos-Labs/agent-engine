import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ELEVENLABS_TTS_SKU,
  GOOGLE_TTS_SKU,
  createSynthesizeVoice,
  defaultChirpVoice,
  type CreateSynthesizeVoiceOptions,
  type SynthesizeVoiceResult,
} from "../src/tools/synthesize-voice.js";
import type { ProcessRunner } from "../src/process/runner.js";
import { ctx } from "./test-helpers.js";

/**
 * Every case here runs against a fake fetch and a fake ffprobe: the point is
 * the exact request each vendor receives, which SKU is billed, and which
 * outcome an unconfigured / broken deployment gets — never the audio.
 */

const MP3_BYTES = Buffer.from("ID3-fake-mp3-bytes");

/** ffprobe says 4.2s for anything; nothing else is ever spawned by this tool. */
const probeRunner: ProcessRunner = async (bin) => {
  if (bin === "ffprobe") return { exitCode: 0, stdout: JSON.stringify({ format: { duration: "4.2" } }), stderr: "" };
  throw new Error(`unexpected spawn: ${bin}`);
};

function googleOk() {
  return new Response(JSON.stringify({ audioContent: MP3_BYTES.toString("base64") }), { status: 200 });
}
function elevenOk() {
  return new Response(new Uint8Array(MP3_BYTES), { status: 200, headers: { "content-type": "audio/mpeg" } });
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "synth-voice-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function make(opts: Partial<CreateSynthesizeVoiceOptions> & { fetchImpl: ReturnType<typeof vi.fn> }) {
  const { fetchImpl, ...rest } = opts;
  return createSynthesizeVoice({ runner: probeRunner, env: {}, ...rest, fetchImpl: fetchImpl as unknown as typeof fetch });
}

function resultOf(outcome: unknown): SynthesizeVoiceResult {
  const o = outcome as { status: string; result: SynthesizeVoiceResult; reason?: string };
  if (o.status !== "success") throw new Error(`expected success, got ${o.status}: ${o.reason}`);
  return o.result;
}

describe("defaultChirpVoice", () => {
  it("picks Charon for English locales and Aoede elsewhere", () => {
    expect(defaultChirpVoice("en-US")).toBe("en-US-Chirp3-HD-Charon");
    expect(defaultChirpVoice("en-GB")).toBe("en-GB-Chirp3-HD-Charon");
    expect(defaultChirpVoice("de-DE")).toBe("de-DE-Chirp3-HD-Aoede");
    // "english"-looking prefixes that are not English must not match.
    expect(defaultChirpVoice("es-ES")).toBe("es-ES-Chirp3-HD-Aoede");
  });
});

describe("video.synthesizeVoice — provider resolution", () => {
  it("is not_available naming both switches when neither provider is configured, and never calls fetch", async () => {
    const fetchImpl = vi.fn();
    const outcome = await make({ fetchImpl }).execute({ text: "hi", outputPath: path.join(tmp, "vo.mp3") } as never, { ctx });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.status).toBe("not_available");
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain("authorize");
    expect(reason).toContain("ELEVENLABS_API_KEY");
  });

  it("is not_available (not tooling_error) when the explicitly requested provider is unconfigured", async () => {
    const fetchImpl = vi.fn();
    const tool = make({ fetchImpl, env: { ELEVENLABS_API_KEY: "sk" } });
    const outcome = await tool.execute({ text: "hi", outputPath: path.join(tmp, "vo.mp3"), provider: "google" } as never, { ctx });
    expect(outcome.status).toBe("not_available");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a misspelt VOICEOVER_PROVIDER as an operator problem", async () => {
    const fetchImpl = vi.fn();
    const tool = make({ fetchImpl, env: { VOICEOVER_PROVIDER: "gogle", ELEVENLABS_API_KEY: "sk" } });
    const outcome = await tool.execute({ text: "hi", outputPath: path.join(tmp, "vo.mp3") } as never, { ctx });
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain("gogle");
  });

  it("defaults to Google when only authorize is configured, ElevenLabs when only the key is", async () => {
    const g = vi.fn().mockResolvedValue(googleOk());
    const google = await make({ fetchImpl: g, authorize: async () => "Bearer t" }).execute({ text: "hi", outputPath: path.join(tmp, "a.mp3") } as never, { ctx });
    expect(resultOf(google).provider).toBe("google");

    const e = vi.fn().mockResolvedValue(elevenOk());
    const eleven = await make({ fetchImpl: e, env: { ELEVENLABS_API_KEY: "sk" } }).execute({ text: "hi", outputPath: path.join(tmp, "b.mp3") } as never, { ctx });
    expect(resultOf(eleven).provider).toBe("elevenlabs");
  });

  it("VOICEOVER_PROVIDER picks the primary when both are configured; defaultProvider beats it; input.provider beats both", async () => {
    const both = { authorize: async () => "Bearer t", env: { ELEVENLABS_API_KEY: "sk", VOICEOVER_PROVIDER: "elevenlabs" } };

    const f1 = vi.fn().mockResolvedValue(elevenOk());
    expect(resultOf(await make({ fetchImpl: f1, ...both }).execute({ text: "hi", outputPath: path.join(tmp, "1.mp3") } as never, { ctx })).provider).toBe("elevenlabs");

    const f2 = vi.fn().mockResolvedValue(googleOk());
    expect(resultOf(await make({ fetchImpl: f2, ...both, defaultProvider: "google" }).execute({ text: "hi", outputPath: path.join(tmp, "2.mp3") } as never, { ctx })).provider).toBe("google");

    const f3 = vi.fn().mockResolvedValue(googleOk());
    expect(
      resultOf(await make({ fetchImpl: f3, ...both }).execute({ text: "hi", outputPath: path.join(tmp, "3.mp3"), provider: "google" } as never, { ctx })).provider,
    ).toBe("google");
  });
});

describe("video.synthesizeVoice — Google Cloud TTS", () => {
  it("posts the documented request with the minted bearer, writes the decoded bytes, and bills the Google SKU per character", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(googleOk());
    const authorize = vi.fn().mockResolvedValue("Bearer ya29.test");
    const out = path.join(tmp, "vo.mp3");
    const text = "Hello there, world.";
    const outcome = await make({ fetchImpl, authorize }).execute({ text, outputPath: out, speakingRate: 1.1 } as never, { ctx });

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ya29.test");
    expect(JSON.parse(init.body as string)).toEqual({
      input: { text },
      voice: { languageCode: "en-US", name: "en-US-Chirp3-HD-Charon" },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.1 },
    });

    const result = resultOf(outcome);
    expect(result).toEqual({ outputPath: out, provider: "google", voice: "en-US-Chirp3-HD-Charon", charCount: text.length, durationSeconds: 4.2 });
    expect(await fs.readFile(out)).toEqual(MP3_BYTES);
    expect((outcome as { usage: unknown }).usage).toEqual([{ model: GOOGLE_TTS_SKU, unit: "character", quantity: text.length }]);
  });

  it("voice resolution: input.voice > GOOGLE_TTS_VOICE > the Chirp default for the language", async () => {
    const authorize = async () => "Bearer t";
    const f1 = vi.fn().mockResolvedValue(googleOk());
    await make({ fetchImpl: f1, authorize, env: { GOOGLE_TTS_VOICE: "de-DE-Chirp3-HD-Kore" } }).execute({ text: "hi", outputPath: path.join(tmp, "1.mp3"), language: "de-DE" } as never, { ctx });
    expect(JSON.parse((f1.mock.calls[0] as [string, RequestInit])[1].body as string).voice).toEqual({ languageCode: "de-DE", name: "de-DE-Chirp3-HD-Kore" });

    const f2 = vi.fn().mockResolvedValue(googleOk());
    const r2 = await make({ fetchImpl: f2, authorize, env: { GOOGLE_TTS_VOICE: "de-DE-Chirp3-HD-Kore" } }).execute(
      { text: "hi", outputPath: path.join(tmp, "2.mp3"), language: "de-DE", voice: "de-DE-Chirp3-HD-Puck" } as never,
      { ctx },
    );
    expect(resultOf(r2).voice).toBe("de-DE-Chirp3-HD-Puck");

    const f3 = vi.fn().mockResolvedValue(googleOk());
    const r3 = await make({ fetchImpl: f3, authorize }).execute({ text: "hi", outputPath: path.join(tmp, "3.mp3"), language: "fr-FR" } as never, { ctx });
    expect(resultOf(r3).voice).toBe("fr-FR-Chirp3-HD-Aoede");
  });

  it("is a tooling_error on a vendor 5xx when no fallback is configured, with the body surfaced", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("backend unavailable", { status: 503, statusText: "Service Unavailable" }));
    const outcome = await make({ fetchImpl, authorize: async () => "Bearer t" }).execute({ text: "hi", outputPath: path.join(tmp, "vo.mp3") } as never, { ctx });
    expect(outcome.status).toBe("tooling_error");
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain("503");
    expect(reason).toContain("backend unavailable");
    expect(reason).toContain("no other provider");
  });

  it("reports a null duration (not a failure) when ffprobe cannot read the file", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(googleOk());
    const brokenProbe: ProcessRunner = async () => {
      throw new Error("spawn ffprobe ENOENT");
    };
    const tool = createSynthesizeVoice({ fetchImpl: fetchImpl as unknown as typeof fetch, authorize: async () => "Bearer t", env: {}, runner: brokenProbe });
    const outcome = await tool.execute({ text: "hi", outputPath: path.join(tmp, "vo.mp3") } as never, { ctx });
    expect(resultOf(outcome).durationSeconds).toBeNull();
  });
});

describe("video.synthesizeVoice — ElevenLabs", () => {
  it("posts to the voice's endpoint with xi-api-key, writes the binary body, and bills the ElevenLabs SKU per character", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(elevenOk());
    const out = path.join(tmp, "vo.mp3");
    const text = "Grüezi mitenand";
    const outcome = await make({ fetchImpl, env: { ELEVENLABS_API_KEY: "sk-test" } }).execute({ text, outputPath: out } as never, { ctx });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk-test");
    expect(JSON.parse(init.body as string)).toEqual({ text, model_id: "eleven_multilingual_v2" });

    const result = resultOf(outcome);
    expect(result).toEqual({ outputPath: out, provider: "elevenlabs", voice: "21m00Tcm4TlvDq8ikWAM", charCount: text.length, durationSeconds: 4.2 });
    expect(await fs.readFile(out)).toEqual(MP3_BYTES);
    // text.length, not byte length — "ü" is one billed character, two UTF-8 bytes.
    expect((outcome as { usage: unknown }).usage).toEqual([{ model: ELEVENLABS_TTS_SKU, unit: "character", quantity: 15 }]);
  });

  it("voice resolution: input.voice > ELEVENLABS_VOICE_ID > the stock default", async () => {
    const f1 = vi.fn().mockResolvedValue(elevenOk());
    await make({ fetchImpl: f1, env: { ELEVENLABS_API_KEY: "sk", ELEVENLABS_VOICE_ID: "envVoice" } }).execute({ text: "hi", outputPath: path.join(tmp, "1.mp3") } as never, { ctx });
    expect((f1.mock.calls[0] as [string])[0]).toContain("/text-to-speech/envVoice?");

    const f2 = vi.fn().mockResolvedValue(elevenOk());
    await make({ fetchImpl: f2, env: { ELEVENLABS_API_KEY: "sk", ELEVENLABS_VOICE_ID: "envVoice" } }).execute(
      { text: "hi", outputPath: path.join(tmp, "2.mp3"), voice: "inputVoice" } as never,
      { ctx },
    );
    expect((f2.mock.calls[0] as [string])[0]).toContain("/text-to-speech/inputVoice?");
  });
});

describe("video.synthesizeVoice — fallback", () => {
  it("falls back from a Google 500 to ElevenLabs when both are configured, recording who answered and who was asked", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500, statusText: "Internal Server Error" }))
      .mockResolvedValueOnce(elevenOk());
    const out = path.join(tmp, "vo.mp3");
    const outcome = await make({ fetchImpl, authorize: async () => "Bearer t", env: { ELEVENLABS_API_KEY: "sk" } }).execute(
      { text: "hello", outputPath: out } as never,
      { ctx },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[0] as [string])[0]).toContain("texttospeech.googleapis.com");
    expect((fetchImpl.mock.calls[1] as [string])[0]).toContain("api.elevenlabs.io");
    const result = resultOf(outcome);
    expect(result.provider).toBe("elevenlabs");
    expect(result.fallbackFrom).toBe("google");
    // Billed against the vendor that actually produced the file.
    expect((outcome as { usage: unknown }).usage).toEqual([{ model: ELEVENLABS_TTS_SKU, unit: "character", quantity: 5 }]);
    expect(await fs.readFile(out)).toEqual(MP3_BYTES);
  });

  it("falls back on a network failure too, and reports BOTH reasons when the fallback also fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("quota", { status: 429, statusText: "Too Many Requests" }));
    const outcome = await make({ fetchImpl, authorize: async () => "Bearer t", env: { ELEVENLABS_API_KEY: "sk" } }).execute(
      { text: "hello", outputPath: path.join(tmp, "vo.mp3") } as never,
      { ctx },
    );
    expect(outcome.status).toBe("tooling_error");
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain("could not be reached");
    expect(reason).toContain("429");
  });

  it("a failing authorize() is a Google vendor failure, so ElevenLabs answers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(elevenOk());
    const outcome = await make({
      fetchImpl,
      authorize: async () => {
        throw new Error("metadata server unreachable");
      },
      env: { ELEVENLABS_API_KEY: "sk" },
    }).execute({ text: "hello", outputPath: path.join(tmp, "vo.mp3") } as never, { ctx });
    expect(resultOf(outcome).fallbackFrom).toBe("google");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("video.synthesizeVoice — sandbox", () => {
  it("refuses a traversal outputPath before any vendor is called (no money spent on a rejected path)", async () => {
    const fetchImpl = vi.fn();
    const outcome = await make({ fetchImpl, authorize: async () => "Bearer t" }).execute({ text: "hi", outputPath: "../../escape.mp3" } as never, { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("confines outputPath to <workRoot>/<clientSlug>/ when a work root is configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(googleOk());
    const tool = createSynthesizeVoice({ fetchImpl: fetchImpl as unknown as typeof fetch, authorize: async () => "Bearer t", env: {}, runner: probeRunner, workRoot: tmp });
    const outside = await tool.execute({ text: "hi", outputPath: path.join(tmp, "other-tenant", "vo.mp3") } as never, { ctx });
    expect(outside.status).toBe("tooling_error");
    expect(fetchImpl).not.toHaveBeenCalled();

    // Inside the tenant's own root — an absolute path under the temp dir, so
    // the test never writes into the package checkout.
    const inside = await tool.execute({ text: "hi", outputPath: path.join(tmp, ctx.clientSlug, "vo.mp3") } as never, { ctx });
    expect(inside.status).toBe("success");
  });
});
