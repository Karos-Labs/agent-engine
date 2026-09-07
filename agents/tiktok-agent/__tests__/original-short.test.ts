import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import type { ZodType } from "zod";
import { FilePromptStore, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { BrandFrameInputSchema, ComposeSequenceInputSchema, SelfEvalGateInputSchema, SynthesizeVoiceInputSchema, TranscribeInputSchema } from "@agent-engine/tool-karos-video";
import { GenerateVideoInputSchema, VisualQaGateInputSchema } from "@agent-engine/tool-karos-media";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";

/**
 * The ORIGINAL-SHORT production pass in detail: the voiceover decision, the
 * plate-per-beat generation, captions timed from the voice's own words, the
 * hold arithmetic that stretches the plates to cover the speech, and the
 * visual QA gate watching the result. Every video stub validates against the
 * REAL tool schema, so a request shape the tools would reject fails here.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.join(HERE, "..", "prompts");
const PARAMS = { clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring" as const };

const VOICED_SCRIPT = {
  hook: "Nobody tells you the first hire is the one you fire.",
  beats: [
    { narration: "Nobody tells you the first hire is the one you fire.", onScreenText: "The first hire is a bet", visualBrief: "Empty office at dawn, one desk lamp on, slow push-in across a row of dark monitors.", seconds: 4 as const },
    { narration: "You hire for the company you have, and by month six it is a different company entirely.", onScreenText: "Month six changes everything", visualBrief: "Whiteboard being wiped clean, marker residue catching window light, handheld drift.", seconds: 6 as const },
    { narration: "So write the role for the company you are becoming.", onScreenText: "Hire for who you're becoming", visualBrief: "City street at blue hour, storefront lights coming on one by one, wide static frame.", seconds: 6 as const },
  ],
  caption: "The first hire is a bet on a company that will not exist in six months. Hire for the one you're becoming.",
  about: "An original short arguing founders should write early roles for the company they are turning into.",
  voiceover: true,
  voiceoverRationale: "A narrative with a turn in it; a voice carries the 'so' in beat three.",
  language: "en-US",
};

/** The voiceover's words as the transcriber would time them — 30 words over ~13 s. */
function voiceWords(): Array<{ type: string; text: string; start: number; end: number }> {
  const text = VOICED_SCRIPT.beats.map((b) => b.narration).join(" ");
  return text.split(/\s+/).map((word, i) => ({ type: "word", text: word, start: i * 0.43, end: i * 0.43 + 0.4 }));
}

function sequentialFakeRouter(candidates: readonly unknown[]): ModelRouter {
  const queue = [...candidates];
  return {
    async complete(_prompt, _schema, policy) {
      const next = queue.shift();
      if (next === undefined) throw new Error("sequentialFakeRouter: exhausted configured turns");
      return {
        output: { type: "final", output: next },
        modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
        inputTokens: { cached: 0, uncached: 100 },
        outputTokens: 30,
      } as CompletionResult<unknown>;
    },
    async completeAlias() {
      throw new Error("completeAlias is not used here");
    },
  } as ModelRouter;
}

interface Harness {
  tools: AgentToolRegistry;
  calls: string[];
  generateArgs: Array<Record<string, unknown>>;
  composeArgs: Array<Record<string, unknown>>;
  voiceArgs: Array<Record<string, unknown>>;
  transcribedPaths: string[];
  frameArgs: Array<Record<string, unknown>>;
  qaArgs: Array<Record<string, unknown>>;
  deliverables: Array<Record<string, unknown>>;
}

function stubTools(opts: { voiceoverPolicy?: "auto" | "always" | "never"; transcribeVoice?: boolean; qa?: "pass" | "fail" | "none"; declinePlate?: number } = {}): Harness {
  const calls: string[] = [];
  const generateArgs: Array<Record<string, unknown>> = [];
  const composeArgs: Array<Record<string, unknown>> = [];
  const voiceArgs: Array<Record<string, unknown>> = [];
  const transcribedPaths: string[] = [];
  const frameArgs: Array<Record<string, unknown>> = [];
  const qaArgs: Array<Record<string, unknown>> = [];
  const deliverables: Array<Record<string, unknown>> = [];
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const pass = { verdict: "pass" as const, evidence: [], toolVersion: "1.0.0" };
  const tool = (name: string, run: (args: never) => unknown, schema?: ZodType) => ({
    name,
    version: "1.0.0",
    inputSchema: schema ?? { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    async execute(args: never) {
      calls.push(name);
      if (schema) schema.parse(args);
      return run(args);
    },
  });

  let plateCalls = 0;
  const tools: Record<string, unknown> = {
    "client.getConfig": tool("client.getConfig", () =>
      ok({ tiktokClips: { mode: "original", voiceover: opts.voiceoverPolicy ?? "auto", voiceLanguage: "en-GB", voiceName: "en-GB-Chirp3-HD-Charon", sourcePool: [], guestWatchlist: [], narrowing: [] } }),
    ),
    "client.getProfile": tool("client.getProfile", () => ok({ name: "Acme", industry: "founder programs" })),
    "client.getVoiceRules": tool("client.getVoiceRules", () => ok({ tone: "direct" })),
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [], colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" }, handle: "acmeco", language: "en" })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    "topics.reserve": tool("topics.reserve", () => ok({ reservationKey: "res-1", topics: ["the first hire"] })),
    "topics.commit": tool("topics.commit", () => ok({ committed: true })),
    "topics.release": tool("topics.release", () => ok({ released: true })),
    "video.generateClip": tool(
      "video.generateClip",
      (args) => {
        const input = args as { outputName: string; durationSeconds: number };
        generateArgs.push(input as unknown as Record<string, unknown>);
        plateCalls += 1;
        if (opts.declinePlate !== undefined && plateCalls === opts.declinePlate) {
          return { status: "content_fail" as const, reason: "safety: the scene was declined" };
        }
        return ok({ path: `.media-cache/run/${input.outputName}.mp4`, model: "veo-3.1-generate-001", resolution: "1080p", durationSeconds: input.durationSeconds });
      },
      GenerateVideoInputSchema,
    ),
    "video.synthesizeVoice": tool(
      "video.synthesizeVoice",
      (args) => {
        voiceArgs.push(args as Record<string, unknown>);
        return ok({ outputPath: (args as { outputPath: string }).outputPath, provider: "google", voice: "en-GB-Chirp3-HD-Charon", charCount: 160, durationSeconds: 13.1 });
      },
      SynthesizeVoiceInputSchema,
    ),
    "video.transcribe": tool(
      "video.transcribe",
      (args) => {
        transcribedPaths.push((args as { videoPath: string }).videoPath);
        return opts.transcribeVoice === false ? { status: "not_available" as const, reason: "no ELEVENLABS_API_KEY" } : ok({ words: voiceWords() });
      },
      TranscribeInputSchema,
    ),
    "video.composeSequence": tool(
      "video.composeSequence",
      (args) => {
        const input = args as { outputPath: string; clips: unknown[]; voiceoverPath?: string };
        composeArgs.push(input as unknown as Record<string, unknown>);
        return ok({ outputPath: input.outputPath, durationSeconds: 13.5, clipsUsed: input.clips.length, hasVoiceover: input.voiceoverPath !== undefined });
      },
      ComposeSequenceInputSchema,
    ),
    "video.brandFrame": tool(
      "video.brandFrame",
      (args) => {
        frameArgs.push(args as Record<string, unknown>);
        return ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 13.5, applied: ["bars", "captions"] });
      },
      BrandFrameInputSchema,
    ),
    "video.selfEvalGate": tool("video.selfEvalGate", () => ok(pass), SelfEvalGateInputSchema),
    "gate.lintPost": tool("gate.lintPost", () => ok(pass)),
    "gate.brandCompliance": tool("gate.brandCompliance", () => ok(pass)),
    "gate.noPlaceholder": tool("gate.noPlaceholder", () => ok(pass)),
    "gate.leakCheck": tool("gate.leakCheck", () => ok(pass)),
    "ledger.writeDeliverable": tool("ledger.writeDeliverable", (args) => {
      deliverables.push((args as { deliverable: Record<string, unknown> }).deliverable);
      return ok({ id: "deliv-1", created: true });
    }),
    "memory.appendDecision": tool("memory.appendDecision", () => ok({ id: "dec-1" })),
  };
  if ((opts.qa ?? "pass") !== "none") {
    tools["video.visualQaGate"] = tool(
      "video.visualQaGate",
      (args) => {
        qaArgs.push(args as Record<string, unknown>);
        return opts.qa === "fail"
          ? ok({ verdict: "content_fail" as const, evidence: ["artifacts: warped hands in beat 2"], reason: "rendering artefacts on an original short: warped hands in beat 2", toolVersion: "1.0.0" })
          : ok({ verdict: "pass" as const, evidence: ["overallScore: 9"], toolVersion: "1.0.0" });
      },
      VisualQaGateInputSchema,
    );
  }
  return { tools: tools as unknown as AgentToolRegistry, calls, generateArgs, composeArgs, voiceArgs, transcribedPaths, frameArgs, qaArgs, deliverables };
}

async function run(h: Harness, runId: string, turns: unknown[] = [VOICED_SCRIPT]) {
  const workflow = createTikTokAgentWorkflow({
    tools: h.tools,
    promptStore: new FilePromptStore(PROMPTS_ROOT),
    router: sequentialFakeRouter(turns),
    autoApprove: true,
    repoRoot: os.tmpdir(),
  });
  return new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, { ...PARAMS, runId, input: {} });
}

describe("original short: script → plates → voice → captions → sequence → frame → QA", () => {
  it("voices the script when the model asks for it, times the captions from the voice's own words, and stretches the plates to cover the speech", async () => {
    const h = stubTools();
    const result = await run(h, "run-os-voiced");

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { voiceover: boolean; format: string; script: { beats: unknown[] } };
    expect(output.voiceover).toBe(true);
    expect(output.format).toBe("original-short");

    // One plate per beat, into distinct files, each the beat's own length.
    expect(h.generateArgs.map((a) => a["outputName"])).toEqual(["plate-1", "plate-2", "plate-3"]);
    expect(h.generateArgs.map((a) => a["durationSeconds"])).toEqual([4, 6, 6]);
    expect(h.generateArgs.every((a) => a["aspectRatio"] === "9:16")).toBe(true);

    // The voice: the whole narration, in the client's configured language and
    // voice — not the script's guess and not the brand kit's.
    expect(h.voiceArgs).toHaveLength(1);
    expect(h.voiceArgs[0]!["language"]).toBe("en-GB");
    expect(h.voiceArgs[0]!["voice"]).toBe("en-GB-Chirp3-HD-Charon");
    expect(String(h.voiceArgs[0]!["text"])).toContain("Nobody tells you the first hire");
    expect(String(h.voiceArgs[0]!["text"])).toContain("write the role for the company");

    // Timed by transcribing the very MP3 that will play.
    expect(h.transcribedPaths).toHaveLength(1);
    expect(h.transcribedPaths[0]).toMatch(/voiceover\.mp3$/);

    // The captions came from those word timings, clip-relative from zero.
    const srtPath = h.frameArgs[0]!["srtPath"] as string;
    const srt = await fs.readFile(srtPath, "utf8");
    expect(srt.startsWith("1\n00:00:00,000 --> ")).toBe(true);
    // Three words a cue — phrases, not a strobing single word.
    expect(srt).toContain("Nobody tells you");
    expect(srt).toContain("the first hire");

    // The sequence covers the voice: holds sum to voice + tail, each ≥ 2s,
    // proportional to how much each beat says.
    const compose = h.composeArgs[0]!;
    const clips = compose["clips"] as Array<{ path: string; holdSeconds: number }>;
    expect(clips).toHaveLength(3);
    expect(clips.map((c) => path.basename(c.path))).toEqual(["plate-1.mp4", "plate-2.mp4", "plate-3.mp4"]);
    const total = clips.reduce((sum, c) => sum + c.holdSeconds, 0);
    expect(total).toBeCloseTo(13.1 + 0.4, 1);
    expect(clips.every((c) => c.holdSeconds >= 2)).toBe(true);
    expect(clips[1]!.holdSeconds).toBeGreaterThan(clips[0]!.holdSeconds);
    expect(compose["voiceoverPath"]).toMatch(/voiceover\.mp3$/);

    // The visual QA watched the framed file with the right expectations.
    expect(h.qaArgs).toHaveLength(1);
    const expectations = h.qaArgs[0]!["expectations"] as Record<string, unknown>;
    expect(expectations["format"]).toBe("original-short");
    expect(expectations["voiceoverExpected"]).toBe(true);
    expect(expectations["captionsExpected"]).toBe(true);
    expect(expectations["hookLine"]).toBe(VOICED_SCRIPT.hook);

    expect(h.deliverables[0]).toMatchObject({ format: "original-short", voiceover: true, sourceTier: "generated" });
    expect(h.calls).toContain("topics.commit");
  }, 20_000);

  it("the client's voiceover config outranks the model: \"never\" runs silent with per-beat captions, and no TTS call is made", async () => {
    const h = stubTools({ voiceoverPolicy: "never" });
    const result = await run(h, "run-os-silent");

    expect(result.status).toBe("completed");
    expect(h.calls).not.toContain("video.synthesizeVoice");
    expect(h.calls).not.toContain("video.transcribe");
    const clips = h.composeArgs[0]!["clips"] as Array<{ holdSeconds: number }>;
    expect(clips.map((c) => c.holdSeconds)).toEqual([4, 6, 6]);
    expect(h.composeArgs[0]!["voiceoverPath"]).toBeUndefined();
    const srt = await fs.readFile(h.frameArgs[0]!["srtPath"] as string, "utf8");
    expect(srt).toContain("The first hire is a bet");
    expect(srt).toContain("Hire for who you're becoming");
    expect(h.deliverables[0]).toMatchObject({ voiceover: false });
  }, 20_000);

  it("falls back to per-beat captions when the voice cannot be timed, rather than shipping unsynced word captions", async () => {
    const h = stubTools({ transcribeVoice: false });
    const result = await run(h, "run-os-untimed");

    expect(result.status).toBe("completed");
    expect(h.calls).toContain("video.synthesizeVoice");
    const srt = await fs.readFile(h.frameArgs[0]!["srtPath"] as string, "utf8");
    expect(srt).toContain("Month six changes everything");
    expect(srt).not.toContain("Nobody tells you the first");
  }, 20_000);

  it("gives a declined scene ONE plainer retake before holding", async () => {
    const h = stubTools({ declinePlate: 2 });
    const result = await run(h, "run-os-retake");

    expect(result.status).toBe("completed");
    // Beat 2 was declined once, retaken once (4 generate calls for 3 beats).
    expect(h.generateArgs).toHaveLength(4);
    expect(String(h.generateArgs[2]!["brief"])).toContain("Wide establishing shot");
    expect(h.generateArgs[2]!["allowPeople"]).toBe(false);
  }, 20_000);

  it("ships a clip the visual QA gate dislikes FLAGGED with the model's reason, never held (prep run pubsub-21756184831102737)", async () => {
    // Until 2026-09-07 a content_fail here held the run. Gemini scored a
    // finished, in-brand short 6/10 for "unnatural movement in plant growth
    // animation", a taste call on generated b-roll that the reviewer at
    // 11-clip-review exists to make and was never shown.
    const h = stubTools({ qa: "fail" });
    const result = await run(h, "run-os-qa-fail");

    expect(result.status).toBe("completed");
    expect(h.calls).toContain("video.visualQaGate");
    expect(h.calls).toContain("ledger.writeDeliverable");
    expect(h.calls).not.toContain("topics.release");
    const shipped = h.deliverables[0] as { visualQa?: { passed: boolean; reason?: string } };
    expect(shipped.visualQa?.passed).toBe(false);
    expect(shipped.visualQa?.reason).toContain("warped hands");
  }, 20_000);

  it("proceeds to the human gate unreviewed — recorded, not pretended — when no visual QA gate is registered", async () => {
    const h = stubTools({ qa: "none" });
    const result = await run(h, "run-os-no-qa");

    expect(result.status).toBe("completed");
    expect(h.calls).not.toContain("video.visualQaGate");
  }, 20_000);
});
