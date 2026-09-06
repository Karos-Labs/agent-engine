import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ToolUnitUsage } from "@agent-engine/core";
import { defineTool, notAvailable, success, toolingError } from "@agent-engine/tool-common";
import { resolveRuntime, type KarosVideoRuntime, type KarosVideoToolOptions } from "../config.js";
import { assertToolPath, probeDuration } from "./clip-compose.js";

const TOOL_VERSION = "1.0.0";

const GOOGLE_TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
const ELEVENLABS_TTS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
/** ElevenLabs' cross-language model — the one `elevenlabs-tts-multilingual-v2` in `UNIT_PRICING` prices. */
const ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
/** ElevenLabs' stock "Rachel" voice: the documented default every account has, so an unconfigured voice still speaks. */
const ELEVENLABS_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/** Billable SKUs — rows in `packages/core/src/telemetry/pricing.ts` `UNIT_PRICING`, unit `character`. */
export const GOOGLE_TTS_SKU = "google-tts-chirp3-hd";
export const ELEVENLABS_TTS_SKU = "elevenlabs-tts-multilingual-v2";

/**
 * A voiceover is at most 2 500 characters (the schema cap), so a vendor that
 * takes a minute over it is not slow, it is gone. Finite beats short here,
 * the same reasoning `transcribe.ts` gives for its 180s.
 */
const SYNTHESIZE_TIMEOUT_MS = 60_000;

/** Same collision note as `TranscribeFetchImpl`: the `@agent-engine/tools` barrel `export *`s every karos package, so a bare `FetchImpl` would TS2308 against karos-reputation's. */
export type SynthesizeVoiceFetchImpl = typeof fetch;

export const VoiceoverProviderSchema = z.enum(["google", "elevenlabs"]);
export type VoiceoverProvider = z.infer<typeof VoiceoverProviderSchema>;

export const SynthesizeVoiceInputSchema = z.object({
  text: z.string().min(1).max(2500).describe("The voiceover script to speak, plain text. Billed per character by both providers."),
  outputPath: z.string().min(1).describe("Where to write the MP3."),
  language: z.string().default("en-US").describe("BCP-47 language tag (e.g. en-US, de-DE). Picks the Google voice family; ElevenLabs' multilingual model infers it from the text."),
  voice: z.string().optional().describe("Provider voice id/name; provider default when absent (Google: a Chirp 3 HD voice for `language`, or GOOGLE_TTS_VOICE; ElevenLabs: ELEVENLABS_VOICE_ID or the stock Rachel voice)."),
  provider: VoiceoverProviderSchema.optional().describe("Force one provider. Absent: the factory's defaultProvider, then VOICEOVER_PROVIDER, then whichever of Google (authorize) / ElevenLabs (ELEVENLABS_API_KEY) is configured."),
  speakingRate: z.number().min(0.7).max(1.3).default(1.0).describe("Speech tempo multiplier, 1.0 = natural. Applied by Google Cloud TTS; ElevenLabs' multilingual v2 request carries no rate field, so it is ignored there."),
});
export type SynthesizeVoiceInput = z.infer<typeof SynthesizeVoiceInputSchema>;

export interface SynthesizeVoiceResult {
  outputPath: string;
  /** The provider that actually produced the file — after a fallback, NOT the one first asked. */
  provider: VoiceoverProvider;
  /** The concrete voice id/name sent to that provider, defaults resolved. */
  voice: string;
  charCount: number;
  /** ffprobe'd from the written MP3; null when probing fails (the file is still there). */
  durationSeconds: number | null;
  /** Set when the primary provider failed with a vendor error and the other one answered instead. */
  fallbackFrom?: VoiceoverProvider;
}

export interface CreateSynthesizeVoiceOptions extends KarosVideoToolOptions {
  fetchImpl?: SynthesizeVoiceFetchImpl;
  /**
   * Mints the `Authorization` header value for Google Cloud Text-to-Speech —
   * `"Bearer ya29…"` — and is the ONLY thing that makes the Google provider
   * available. Injected by the composition root (which owns the service
   * account / ADC decision) rather than read from env here: this package
   * never sees a credential, only a function that produces a header, so
   * tests and workflows can substitute it without touching `process.env`.
   */
  authorize?: () => Promise<string>;
  /** Overrides the per-request deadline. Exists so a test can bound it in milliseconds. */
  timeoutMs?: number;
  /** Wins over `VOICEOVER_PROVIDER` when the input names no provider. */
  defaultProvider?: VoiceoverProvider;
}

/**
 * Google's Chirp 3 HD voices are named `<lang>-Chirp3-HD-<persona>`. Charon
 * (a low male voice) for English, Aoede (female) elsewhere — both exist in
 * every Chirp 3 locale, which is why they are the defaults and not a
 * per-language table that would rot. `GOOGLE_TTS_VOICE` overrides for a
 * deployment, `input.voice` overrides per call.
 */
export function defaultChirpVoice(language: string): string {
  return /^en(-|$)/i.test(language) ? `${language}-Chirp3-HD-Charon` : `${language}-Chirp3-HD-Aoede`;
}

type VendorAttempt = { ok: true; bytes: Uint8Array; voice: string; usage: ToolUnitUsage } | { ok: false; reason: string };

function describeFetchError(vendor: string, err: unknown, timeoutMs: number): string {
  const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  return timedOut ? `${vendor} did not respond within ${timeoutMs / 1000}s` : `${vendor} could not be reached: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * `video.synthesizeVoice` — a voiceover MP3 from a script, via Google Cloud
 * Text-to-Speech (Chirp 3 HD) or ElevenLabs (multilingual v2).
 *
 * ## Why two providers, and why fallback
 *
 * The tiktok pipeline's voiceover is a per-run dependency on a live vendor,
 * and a vendor 5xx must cost one retry, not the run. Two providers configured
 * means a failed primary is answered by the other one in the same call; the
 * result records BOTH who answered (`provider`) and who was asked first
 * (`fallbackFrom`), so the billing row and the trace agree on which SKU was
 * actually consumed. Only vendor errors (non-2xx, network, timeout) trigger
 * the fallback — a sandbox violation or a missing key never does, because
 * neither is something the other vendor can fix.
 *
 * ## Failure classification (the `transcribe.ts` line)
 *
 * No provider configured is `not_available`: an operator sets `authorize` /
 * `ELEVENLABS_API_KEY`, retrying will not help. Every provider tried and
 * failed is `tooling_error`, with each vendor's reason in the message. The
 * path is sandboxed BEFORE any vendor is called, so a rejected `outputPath`
 * never spends a character of billing.
 */
export function createSynthesizeVoice(options: CreateSynthesizeVoiceOptions = {}) {
  const runtime: KarosVideoRuntime = resolveRuntime(options);
  const env = runtime.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SYNTHESIZE_TIMEOUT_MS;
  const authorize = options.authorize;

  const isConfigured = (provider: VoiceoverProvider): boolean => (provider === "google" ? authorize !== undefined : Boolean(env["ELEVENLABS_API_KEY"]));

  async function synthesizeGoogle(input: SynthesizeVoiceInput): Promise<VendorAttempt> {
    if (!authorize) return { ok: false, reason: "Google Cloud TTS: no authorize() configured" };
    const voice = input.voice ?? env["GOOGLE_TTS_VOICE"] ?? defaultChirpVoice(input.language);
    let authorization: string;
    try {
      authorization = await authorize();
    } catch (err) {
      return { ok: false, reason: `Google Cloud TTS: authorize() failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    let response: Response;
    try {
      response = await fetchImpl(GOOGLE_TTS_ENDPOINT, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text: input.text },
          voice: { languageCode: input.language, name: voice },
          audioConfig: { audioEncoding: "MP3", speakingRate: input.speakingRate },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { ok: false, reason: describeFetchError("Google Cloud TTS", err, timeoutMs) };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, reason: `Google Cloud TTS returned ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 1000)}` : ""}` };
    }
    const body = (await response.json().catch(() => ({}))) as { audioContent?: unknown };
    if (typeof body.audioContent !== "string" || body.audioContent.length === 0) {
      return { ok: false, reason: "Google Cloud TTS returned 200 without audioContent" };
    }
    return {
      ok: true,
      bytes: new Uint8Array(Buffer.from(body.audioContent, "base64")),
      voice,
      usage: { model: GOOGLE_TTS_SKU, unit: "character", quantity: input.text.length },
    };
  }

  async function synthesizeElevenLabs(input: SynthesizeVoiceInput): Promise<VendorAttempt> {
    const apiKey = env["ELEVENLABS_API_KEY"];
    if (!apiKey) return { ok: false, reason: "ElevenLabs: no ELEVENLABS_API_KEY configured" };
    const voice = input.voice ?? env["ELEVENLABS_VOICE_ID"] ?? ELEVENLABS_DEFAULT_VOICE_ID;
    let response: Response;
    try {
      response = await fetchImpl(`${ELEVENLABS_TTS_ENDPOINT}/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: input.text, model_id: ELEVENLABS_MODEL_ID }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { ok: false, reason: describeFetchError("ElevenLabs text-to-speech", err, timeoutMs) };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, reason: `ElevenLabs text-to-speech returned ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 1000)}` : ""}` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return { ok: false, reason: "ElevenLabs text-to-speech returned 200 with an empty body" };
    return { ok: true, bytes, voice, usage: { model: ELEVENLABS_TTS_SKU, unit: "character", quantity: input.text.length } };
  }

  const synthesizeWith = (provider: VoiceoverProvider, input: SynthesizeVoiceInput) => (provider === "google" ? synthesizeGoogle(input) : synthesizeElevenLabs(input));

  return defineTool<SynthesizeVoiceInput, SynthesizeVoiceResult>({
    name: "video.synthesizeVoice",
    description:
      "Synthesizes a voiceover MP3 from a script via Google Cloud TTS (Chirp 3 HD) or ElevenLabs (multilingual v2), falling back to the other provider on a vendor error. not_available when neither is configured, tooling_error when every configured vendor failed. Reports per-character usage against the provider that answered.",
    version: TOOL_VERSION,
    inputSchema: SynthesizeVoiceInputSchema,
    async execute(input, { ctx }) {
      // Sandbox first: a refused path must never reach a billed vendor call.
      await assertToolPath(runtime, ctx.clientSlug, input.outputPath, "outputPath");

      const envProvider = env["VOICEOVER_PROVIDER"];
      const parsedEnvProvider = envProvider !== undefined ? VoiceoverProviderSchema.safeParse(envProvider) : undefined;
      if (parsedEnvProvider !== undefined && !parsedEnvProvider.success) {
        // An operator typo, not a vendor fault — the same "who acts" test as
        // an unset key, so the same classification.
        return notAvailable(`VOICEOVER_PROVIDER="${envProvider}" is not one of google|elevenlabs — fix the env var or pass provider explicitly`);
      }
      const primary: VoiceoverProvider | undefined =
        input.provider ?? options.defaultProvider ?? parsedEnvProvider?.data ?? (authorize ? "google" : env["ELEVENLABS_API_KEY"] ? "elevenlabs" : undefined);
      if (primary === undefined) {
        return notAvailable(
          "this deployment has not enabled voiceover synthesis — configure Google Cloud TTS (pass `authorize` at the composition root) or ElevenLabs (set ELEVENLABS_API_KEY)",
        );
      }
      if (!isConfigured(primary)) {
        return notAvailable(
          primary === "google"
            ? "voiceover provider google was requested but no `authorize` is configured for Google Cloud TTS — wire it at the composition root, or set ELEVENLABS_API_KEY and choose elevenlabs"
            : "voiceover provider elevenlabs was requested but ELEVENLABS_API_KEY is not set — set it, or configure Google Cloud TTS `authorize` and choose google",
        );
      }

      let attempt = await synthesizeWith(primary, input);
      let answeredBy: VoiceoverProvider = primary;
      let fallbackFrom: VoiceoverProvider | undefined;
      if (!attempt.ok) {
        const other: VoiceoverProvider = primary === "google" ? "elevenlabs" : "google";
        if (!isConfigured(other)) {
          return toolingError(`video.synthesizeVoice: ${attempt.reason} (no other provider configured to fall back to)`);
        }
        const primaryReason = attempt.reason;
        attempt = await synthesizeWith(other, input);
        if (!attempt.ok) {
          return toolingError(`video.synthesizeVoice: ${primaryReason}; fallback ${attempt.reason}`);
        }
        answeredBy = other;
        fallbackFrom = primary;
      }

      await fs.mkdir(path.dirname(path.resolve(input.outputPath)), { recursive: true });
      await fs.writeFile(input.outputPath, attempt.bytes);
      // A probe failure (ffprobe absent, odd container) is not a synthesis
      // failure — the MP3 was written and billed; the duration is simply unknown.
      const durationSeconds = await probeDuration(runtime, input.outputPath).catch(() => null);

      return success<SynthesizeVoiceResult>(
        {
          outputPath: input.outputPath,
          provider: answeredBy,
          voice: attempt.voice,
          charCount: input.text.length,
          durationSeconds,
          ...(fallbackFrom !== undefined ? { fallbackFrom } : {}),
        },
        [attempt.usage],
      );
    },
  });
}
