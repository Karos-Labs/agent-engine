import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { VideoTranscriptSchema, type VideoTranscript } from "../types.js";

const TOOL_VERSION = "1.0.0";
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

/**
 * Matches `capture-tool.ts`'s injectable-fetch pattern in `karos-reputation`.
 * Named distinctly (not `FetchImpl`) because `@agent-engine/tools`' barrel
 * re-exports every karos-* package with `export *`, and `karos-reputation`
 * already exports its own `FetchImpl` — two same-named type exports collide
 * there (TS2308) even though neither package imports the other directly.
 */
export type TranscribeFetchImpl = typeof fetch;

export const TranscribeInputSchema = z.object({
  videoPath: z.string().min(1),
  /** Overrides `env.ELEVENLABS_API_KEY` when set. */
  apiKey: z.string().min(1).optional(),
});
export type TranscribeInput = z.infer<typeof TranscribeInputSchema>;

export interface CreateTranscribeOptions {
  fetchImpl?: TranscribeFetchImpl;
  env?: Readonly<Record<string, string | undefined>>;
  readFileImpl?: (path: string) => Promise<Buffer>;
}

interface ElevenLabsWord {
  text: string;
  start: number;
  end: number;
  type: string;
}

interface ElevenLabsSpeechToTextResponse {
  words?: ElevenLabsWord[];
}

/**
 * `video.transcribe` (RFC-06 §2 stage 1 / SKILL.md's `credentials_required:
 * ["ELEVENLABS_API_KEY"]`): word-level transcription via ElevenLabs Scribe.
 *
 * RFC-06 §3/§5 flags the product's own `video-use` checkout (env
 * `VIDEO_USE_HELPERS`) as an unresolved external-vendoring decision, not
 * something this repo can shell out to yet. Rather than wrap an unverified
 * script contract, this tool calls ElevenLabs's documented Speech-to-Text
 * endpoint directly — the response's `words[]` (`text`/`start`/`end`/`type`,
 * `type: "word" | "spacing" | "audio_event"`) is exactly the shape
 * `cut_check.py`/`cutaway_check.py` already expect (`spoken_words` filters
 * on `type == "word"`), so no extra mapping layer is needed. video-use's own
 * phrase-level packing/caching is NOT reproduced here — out of scope until
 * the vendoring decision lands.
 */
export function createTranscribe(options: CreateTranscribeOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const readFileImpl = options.readFileImpl ?? ((path: string) => readFile(path));

  return defineTool<TranscribeInput, VideoTranscript>({
    name: "video.transcribe",
    version: TOOL_VERSION,
    inputSchema: TranscribeInputSchema,
    async execute({ videoPath, apiKey }) {
      const key = apiKey ?? env["ELEVENLABS_API_KEY"];
      if (!key) {
        return toolingError("no ElevenLabs API key available — set ELEVENLABS_API_KEY (SKILL.md's credentials_required) or pass apiKey");
      }

      const bytes = await readFileImpl(videoPath);
      const form = new FormData();
      form.append("model_id", "scribe_v1");
      // `Buffer`'s backing `ArrayBufferLike` isn't assignable to `BlobPart` under
      // this project's `Uint8Array<ArrayBuffer>` DOM lib target — the typed-array
      // constructor overload below copies into a plain `Uint8Array`/`ArrayBuffer`.
      form.append("file", new Blob([new Uint8Array(bytes)]), basename(videoPath));

      const response = await fetchImpl(ELEVENLABS_ENDPOINT, {
        method: "POST",
        headers: { "xi-api-key": key },
        body: form,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return toolingError(`ElevenLabs speech-to-text returned ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 1000)}` : ""}`);
      }

      const body = (await response.json()) as ElevenLabsSpeechToTextResponse;
      const words = (body.words ?? []).map((w) => ({ type: w.type, text: w.text, start: w.start, end: w.end }));
      const parsed = VideoTranscriptSchema.safeParse({ words });
      if (!parsed.success) {
        return toolingError(`ElevenLabs response did not match the expected transcript shape: ${parsed.error.message}`);
      }
      return success<VideoTranscript>(parsed.data);
    },
  });
}
