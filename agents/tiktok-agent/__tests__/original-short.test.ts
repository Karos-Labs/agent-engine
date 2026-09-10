import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import type { ZodType } from "zod";
import { FilePromptStore, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { BrandFrameInputSchema, ComposeSequenceInputSchema, MixMusicInputSchema, SelfEvalGateInputSchema, StillToClipInputSchema, SynthesizeVoiceInputSchema, TextPlateInputSchema, TranscribeInputSchema } from "@agent-engine/tool-karos-video";
import { FindStockClipInputSchema, GenerateImageInputSchema, VisualQaGateInputSchema } from "@agent-engine/tool-karos-media";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";

/**
 * The ORIGINAL-SHORT production pass in detail: the voiceover decision, the
 * plate-per-beat sourcing (stock first, a generated still second, never
 * generated video), the pre-purchase cost estimate and ceiling, the SCRIPT's
 * words captioned on the voice's timings, the hold arithmetic that stretches
 * the plates to cover the speech, and the visual QA gate watching the result.
 * Every video stub validates against the REAL tool schema, so a request shape
 * the tools would reject fails here.
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

/** A router that answers from a queue and records every prompt it was shown, so a test can see what the writer was told. */
function sequentialFakeRouter(candidates: readonly unknown[], prompts: string[] = []): ModelRouter {
  const queue = [...candidates];
  return {
    async complete(prompt, _schema, policy) {
      prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
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
  musicArgs: Array<Record<string, unknown>>;
  textArgs: Array<Record<string, unknown>>;
  excerpts: Array<Record<string, unknown>>;
  imageArgs: Array<Record<string, unknown>>;
  stillArgs: Array<Record<string, unknown>>;
  stockArgs: Array<Record<string, unknown>>;
  composeArgs: Array<Record<string, unknown>>;
  voiceArgs: Array<Record<string, unknown>>;
  transcribedPaths: string[];
  frameArgs: Array<Record<string, unknown>>;
  qaArgs: Array<Record<string, unknown>>;
  deliverables: Array<Record<string, unknown>>;
}

function stubTools(
  opts: {
    voiceoverPolicy?: "auto" | "always" | "never";
    transcribeVoice?: boolean;
    /** `"down"` makes the TTS tool answer tooling_error, as every route did under the 2026-09-10 billing hold. */
    voice?: "ok" | "down";
    qa?: "pass" | "fail" | "none" | "down";
    /** How the stock library answers. Default `hit`; `none` leaves it unregistered. */
    stock?: "hit" | "miss" | "hit-then-miss" | "none";
    /** Whether the still tier (image.generate + video.stillToClip) is registered. Default true. */
    still?: boolean;
    /** The client's own ceiling on a run, in USD. */
    maxRunCostUsd?: number;
    /** The client's content language (BCP-47); default en-GB. */
    voiceLanguage?: string;
    /** A music track URL in the client's config; registers video.mixMusic too. */
    music?: string;
  } = {},
): Harness {
  const calls: string[] = [];
  const musicArgs: Array<Record<string, unknown>> = [];
  const textArgs: Array<Record<string, unknown>> = [];
  const excerpts: Array<Record<string, unknown>> = [];
  const imageArgs: Array<Record<string, unknown>> = [];
  const stillArgs: Array<Record<string, unknown>> = [];
  const stockArgs: Array<Record<string, unknown>> = [];
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

  const tools: Record<string, unknown> = {
    "client.getConfig": tool("client.getConfig", () =>
      ok({
        tiktokClips: {
          mode: "original",
          voiceover: opts.voiceoverPolicy ?? "auto",
          voiceLanguage: opts.voiceLanguage ?? "en-GB",
          voiceName: "en-GB-Chirp3-HD-Charon",
          voiceSpeakingRate: 1.1,
          ...(opts.music !== undefined ? { musicTrackUri: opts.music, musicGainDb: -18 } : {}),
          sourcePool: [],
          guestWatchlist: [],
          narrowing: [],
          ...(opts.maxRunCostUsd !== undefined ? { maxRunCostUsd: opts.maxRunCostUsd } : {}),
        },
      }),
    ),
    "client.getProfile": tool("client.getProfile", () => ok({ name: "Acme", industry: "founder programs" })),
    "client.getVoiceRules": tool("client.getVoiceRules", () => ok({ tone: "direct" })),
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [], colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" }, handle: "acmeco", language: "en" })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    "topics.reserve": tool("topics.reserve", () => ok({ reservationKey: "res-1", topics: ["the first hire"] })),
    "topics.commit": tool("topics.commit", () => ok({ committed: true })),
    "topics.release": tool("topics.release", () => ok({ released: true })),
    "video.synthesizeVoice": tool(
      "video.synthesizeVoice",
      (args) => {
        voiceArgs.push(args as Record<string, unknown>);
        if (opts.voice === "down") return { status: "tooling_error" as const, reason: "google: 403 Lightning dunning decision is deny; elevenlabs: 401" };
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
  if ((opts.stock ?? "hit") !== "none") {
    let stockCalls = 0;
    tools["video.findStockClip"] = tool(
      "video.findStockClip",
      (args) => {
        const input = args as { outputName: string; query: string; excludeIds: number[] };
        stockArgs.push(input as unknown as Record<string, unknown>);
        stockCalls += 1;
        if (opts.stock === "miss" || (opts.stock === "hit-then-miss" && stockCalls > 1)) {
          return { status: "content_fail" as const, reason: `no portrait clip matched "${input.query}"` };
        }
        return ok({ path: `.media-cache/run/${input.outputName}.mp4`, pexelsId: 1000 + stockCalls, durationSeconds: 9, width: 1080, height: 1920, sourceUrl: `https://www.pexels.com/video/${1000 + stockCalls}/`, photographer: "Someone", license: "Pexels", query: input.query });
      },
      FindStockClipInputSchema,
    );
  }
  tools["video.textPlate"] = tool(
    "video.textPlate",
    (args) => {
      const input = args as { outputPath: string; durationSeconds: number };
      textArgs.push(input as unknown as Record<string, unknown>);
      return ok({ outputPath: input.outputPath, durationSeconds: input.durationSeconds });
    },
    TextPlateInputSchema,
  );
  tools["ledger.recordOutputExcerpt"] = tool("ledger.recordOutputExcerpt", (args) => {
    excerpts.push(args as Record<string, unknown>);
    return ok({ recorded: true, total: excerpts.length });
  });
  if (opts.music !== undefined) {
    tools["video.mixMusic"] = tool(
      "video.mixMusic",
      (args) => {
        const input = args as { outputPath: string };
        musicArgs.push(input as unknown as Record<string, unknown>);
        return ok({ outputPath: input.outputPath, durationSeconds: 13.5, ducked: true });
      },
      MixMusicInputSchema,
    );
  }
  if (opts.still !== false) {
    tools["image.generate"] = tool(
      "image.generate",
      (args) => {
        const input = args as { needs: Array<{ n: number; prompt: string }> };
        imageArgs.push(input as unknown as Record<string, unknown>);
        return ok({ candidates: input.needs.map((need) => ({ path: `.media-cache/run/n${need.n}-gen1.png`, description: "generated", provider: "gemini", licenseConfidence: "generated" })), unmet: [], model: "gemini-2.5-flash-image" });
      },
      GenerateImageInputSchema,
    );
    tools["video.stillToClip"] = tool(
      "video.stillToClip",
      (args) => {
        const input = args as { outputPath: string; durationSeconds: number };
        stillArgs.push(input as unknown as Record<string, unknown>);
        return ok({ outputPath: input.outputPath, durationSeconds: input.durationSeconds });
      },
      StillToClipInputSchema,
    );
  }
  if ((opts.qa ?? "pass") !== "none") {
    tools["video.visualQaGate"] = tool(
      "video.visualQaGate",
      (args) => {
        qaArgs.push(args as Record<string, unknown>);
        if (opts.qa === "down") return { status: "tooling_error" as const, reason: "the vision model call failed — 403 Lightning dunning decision is deny" };
        return opts.qa === "fail"
          ? ok({ verdict: "content_fail" as const, evidence: ["artifacts: warped hands in beat 2"], reason: "rendering artefacts on an original short: warped hands in beat 2", toolVersion: "1.0.0" })
          : ok({ verdict: "pass" as const, evidence: ["overallScore: 9"], toolVersion: "1.0.0" });
      },
      VisualQaGateInputSchema,
    );
  }
  return { tools: tools as unknown as AgentToolRegistry, calls, musicArgs, textArgs, excerpts, imageArgs, stillArgs, stockArgs, composeArgs, voiceArgs, transcribedPaths, frameArgs, qaArgs, deliverables };
}

/** A silent version of the script (the schema's three-beat floor stands): what a writer told to cut cost would hand back. */
const CHEAP_SCRIPT = {
  ...VOICED_SCRIPT,
  voiceover: false,
  voiceoverRationale: "Re-planned for cost: three blunt claims read better silent.",
};

/** Serves any https URL as a small mp3, so a music track "downloads" without the network. */
const fakeAudioFetch = (async (input: string | URL) => {
  const url = String(input);
  if (url.endsWith(".mp3")) return new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "audio/mpeg" } });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function run(h: Harness, runId: string, turns: unknown[] = [VOICED_SCRIPT], prompts: string[] = []) {
  const workflow = createTikTokAgentWorkflow({
    tools: h.tools,
    promptStore: new FilePromptStore(PROMPTS_ROOT),
    router: sequentialFakeRouter(turns, prompts),
    autoApprove: true,
    repoRoot: os.tmpdir(),
    fetchImpl: fakeAudioFetch,
  });
  return new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, { ...PARAMS, runId, input: {} });
}

describe("original short: script → plates → voice → captions → sequence → frame → QA", () => {
  it("voices the script when the model asks for it, captions the SCRIPT's words on the voice's timings, and stretches the plates to cover the speech", async () => {
    const h = stubTools();
    const result = await run(h, "run-os-voiced");

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { voiceover: boolean; format: string; script: { beats: unknown[] } };
    expect(output.voiceover).toBe(true);
    expect(output.format).toBe("original-short");

    // One stock plate per beat, and a SECOND shot for each beat of six
    // seconds or more (same query, first clip excluded, half the length), so
    // the picture changes every few seconds. Nothing generated.
    expect(h.stockArgs.map((a) => a["outputName"])).toEqual(["plate-1", "plate-2", "plate-2-b", "plate-3", "plate-3-b"]);
    expect(h.stockArgs.map((a) => a["minDurationSeconds"])).toEqual([4, 6, 3, 6, 3]);
    expect(h.stockArgs[2]!["excludeIds"]).toEqual([1001, 1002]);
    // Every search carries what the library should judge a candidate against.
    expect(h.stockArgs[0]!["relevance"]).toEqual({ brief: VOICED_SCRIPT.beats[0]!.visualBrief, narration: VOICED_SCRIPT.beats[0]!.narration });
    expect(h.imageArgs).toHaveLength(0);
    expect(h.calls).not.toContain("video.generateClip");

    // The voice: the whole narration, in the client's configured language,
    // voice and tempo — not the script's guess and not the brand kit's.
    expect(h.voiceArgs).toHaveLength(1);
    expect(h.voiceArgs[0]!["language"]).toBe("en-GB");
    expect(h.voiceArgs[0]!["voice"]).toBe("en-GB-Chirp3-HD-Charon");
    expect(h.voiceArgs[0]!["speakingRate"]).toBe(1.1);
    expect(String(h.voiceArgs[0]!["text"])).toContain("Nobody tells you the first hire");
    expect(String(h.voiceArgs[0]!["text"])).toContain("write the role for the company");

    // Timed by transcribing the very MP3 that will play.
    expect(h.transcribedPaths).toHaveLength(1);
    expect(h.transcribedPaths[0]).toMatch(/voiceover\.mp3$/);

    // The captions are the script's words on those timings, clip-relative
    // from zero, cut at phrase boundaries (four words, or the end of a
    // sentence) rather than wherever a counter landed.
    const srtPath = h.frameArgs[0]!["srtPath"] as string;
    const srt = await fs.readFile(srtPath, "utf8");
    expect(srt.startsWith("1\n00:00:00,000 --> ")).toBe(true);
    expect(srt).toContain("Nobody tells you the");
    expect(srt).toContain("one you fire.");
    expect(srt).toContain("becoming.");
    // One title card, beat 1's on-screen line, for the first beat only.
    const overlays = h.frameArgs[0]!["overlays"] as Array<{ text: string; start: number }>;
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({ text: "The first hire is a bet", start: 0 });

    // The sequence covers the voice: holds sum to voice + tail, each ≥ 2s,
    // proportional to how much each beat says.
    // Beat 2 says the most, so its hold (~6s) is long enough to cut in two;
    // beat 3's hold (~3.5s) is not, so its second shot is left unused.
    const compose = h.composeArgs[0]!;
    const clips = compose["clips"] as Array<{ path: string; holdSeconds: number }>;
    expect(clips.map((c) => path.basename(c.path))).toEqual(["plate-1.mp4", "plate-2.mp4", "plate-2-b.mp4", "plate-3.mp4"]);
    const total = clips.reduce((sum, c) => sum + c.holdSeconds, 0);
    expect(total).toBeCloseTo(13.1 + 0.4, 1);
    expect(clips.every((c) => c.holdSeconds >= 2)).toBe(true);
    expect(clips[1]!.holdSeconds + clips[2]!.holdSeconds).toBeGreaterThan(clips[0]!.holdSeconds);
    expect(clips[1]!.holdSeconds).toBeCloseTo(clips[2]!.holdSeconds, 2);
    expect(compose["voiceoverPath"]).toMatch(/voiceover\.mp3$/);

    // The visual QA watched the framed file with the right expectations.
    expect(h.qaArgs).toHaveLength(1);
    const expectations = h.qaArgs[0]!["expectations"] as Record<string, unknown>;
    expect(expectations["format"]).toBe("original-short");
    expect(expectations["voiceoverExpected"]).toBe(true);
    expect(expectations["captionsExpected"]).toBe(true);
    expect(expectations["hookLine"]).toBe(VOICED_SCRIPT.hook);

    expect(h.deliverables[0]).toMatchObject({ format: "original-short", voiceover: true, sourceTier: "stock", plateSources: ["stock", "stock", "stock", "stock", "stock"], maxCostUsd: 2 });
    // Latin captions keep the frame's default font.
    expect(h.frameArgs[0]!["captionStyle"]).toBeUndefined();
    expect(h.calls).toContain("topics.commit");
  }, 20_000);

  it("the client's voiceover config outranks the model: \"never\" runs silent with per-beat captions, and no TTS call is made", async () => {
    const h = stubTools({ voiceoverPolicy: "never" });
    const result = await run(h, "run-os-silent");

    expect(result.status).toBe("completed");
    expect(h.calls).not.toContain("video.synthesizeVoice");
    expect(h.calls).not.toContain("video.transcribe");
    const clips = h.composeArgs[0]!["clips"] as Array<{ holdSeconds: number }>;
    // Silent: the script's own seconds stand, and each six-second beat is two three-second shots.
    expect(clips.map((c) => c.holdSeconds)).toEqual([4, 3, 3, 3, 3]);
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

  it("a plan priced over the ceiling goes back to the writer with the numbers, and the cheaper plan ships (one continuous run, no hold)", async () => {
    // Three voiced beats with three worst-case stills price at about $0.15;
    // a fourteen-cent ceiling cannot hold that, but the same three beats
    // silent ($0.12 of stills at worst, plus QA) can. The writer is handed
    // the breakdown and the target, answers with the silent script, and the
    // run carries on.
    const h = stubTools({ maxRunCostUsd: 0.14 });
    const prompts: string[] = [];
    const result = await run(h, "run-os-replan", [VOICED_SCRIPT, CHEAP_SCRIPT], prompts);

    if (result.status !== "completed") throw new Error(`unexpected ${result.status}: ${JSON.stringify(result)}`);
    expect(result.status).toBe("completed");
    // Two drafts: the original and one re-plan.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("budgetFeedback");
    expect(prompts[1]).toContain("budgetFeedback");
    expect(prompts[1]).toMatch(/priced at \$0\.1\d against a \$0\.14 ceiling/);
    expect(prompts[1]).toContain("lands under $0.11");
    // The cheaper plan is the one that shipped, stills still permitted, nothing held (three beats, two of them long enough for a second shot).
    expect(h.stockArgs).toHaveLength(5);
    expect(h.calls).not.toContain("video.synthesizeVoice");
    expect(h.deliverables[0]).toMatchObject({ budgetPlan: "replan", replans: 1, voiceover: false, maxCostUsd: 0.14 });
    expect(h.calls).not.toContain("topics.release");
  }, 20_000);

  it("after two re-plans that still price over the ceiling, a deterministic rule takes over: stock only, and the run still ships", async () => {
    // The writer keeps handing back the same expensive plan. Nobody is asked a
    // third time: stills are off the table, the beats take free stock, and
    // the client meets a finished clip, never a budget error.
    const h = stubTools({ maxRunCostUsd: 0.05 });
    const prompts: string[] = [];
    const result = await run(h, "run-os-fallback", [VOICED_SCRIPT, VOICED_SCRIPT, VOICED_SCRIPT], prompts);

    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("budgetFeedback");
    expect(h.imageArgs).toHaveLength(0);
    // Under a five-cent ceiling the voice ($0.02) plus QA fits once stills are gone, so it keeps its voice.
    expect(h.calls).toContain("video.synthesizeVoice");
    expect(h.deliverables[0]).toMatchObject({ budgetPlan: "stock-only", replans: 2, plateSources: ["stock", "stock", "stock", "stock", "stock"], voiceover: true });
    expect(h.calls).not.toContain("topics.release");
  }, 20_000);

  it("stock only, silent, when even the voice does not fit: the captions carry the words and the run ships", async () => {
    const h = stubTools({ maxRunCostUsd: 0.02 });
    const result = await run(h, "run-os-fallback-silent", [VOICED_SCRIPT, VOICED_SCRIPT, VOICED_SCRIPT]);

    expect(result.status).toBe("completed");
    expect(h.imageArgs).toHaveLength(0);
    expect(h.calls).not.toContain("video.synthesizeVoice");
    expect(h.deliverables[0]).toMatchObject({ budgetPlan: "stock-only-silent", replans: 2, voiceover: false });
    const srt = await fs.readFile(h.frameArgs[0]!["srtPath"] as string, "utf8");
    expect(srt).toContain("The first hire is a bet");
  }, 20_000);

  it("in stock-only mode a beat the library misses walks a free ladder (brief-derived query, then generic scenes), then becomes a TEXT plate: nothing bought, nothing held", async () => {
    const h = stubTools({ maxRunCostUsd: 0.05, stock: "hit-then-miss" });
    // `hit-then-miss` answers the first search only; the ladder then tries
    // the remaining queries per beat and every one misses, so beats 2 and 3
    // become the beat's own line on the brand ground.
    const result = await run(h, "run-os-fallback-ladder", [VOICED_SCRIPT, VOICED_SCRIPT, VOICED_SCRIPT]);
    expect(result.status).toBe("completed");
    expect(h.imageArgs).toHaveLength(0);
    // Beat 1 hit on its own query; beats 2 and 3 tried their query (here the brief-derived one, so the two coincide) and two generic scenes each.
    expect(h.stockArgs.map((a) => a["outputName"])).toEqual(["plate-1", "plate-2", "plate-2", "plate-2", "plate-3", "plate-3", "plate-3"]);
    expect(h.stockArgs.slice(1).map((a) => a["query"])).toContain("hands typing keyboard");
    expect(h.textArgs.map((a) => a["text"])).toEqual(["Month six changes everything", "Hire for who you're becoming"]);
    expect(h.textArgs[0]).toMatchObject({ ground: "#101418", fg: "#F2F0EA", durationSeconds: 6 });
    expect((h.deliverables[0] as { plateSources?: string[] }).plateSources).toEqual(["stock", "text", "text"]);
  }, 20_000);

  it("a Hebrew client's text plates are set in the Hebrew face", async () => {
    const h = stubTools({ maxRunCostUsd: 0.05, stock: "miss", voiceLanguage: "he-IL" });
    const result = await run(h, "run-os-text-hebrew", [VOICED_SCRIPT, VOICED_SCRIPT, VOICED_SCRIPT]);
    expect(result.status).toBe("completed");
    expect(h.textArgs).toHaveLength(3);
    expect(h.textArgs.every((a) => a["fontName"] === "Noto Sans Hebrew")).toBe(true);
  }, 20_000);

  it("a client's ceiling can lower the product's two dollars but never raise it", async () => {
    const h = stubTools({ maxRunCostUsd: 1 });
    const result = await run(h, "run-os-client-cap");
    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ maxCostUsd: 1 });
    // The schema refuses a ceiling above the product rule outright.
    const { TikTokClipConfigSchema } = await import("../src/workflow/types.js");
    expect(TikTokClipConfigSchema.safeParse({ maxRunCostUsd: 5 }).success).toBe(false);
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

  it("a TTS route outage runs the short silent with its captions, flagged to the reviewer, never a failed run (2026-09-10 billing hold)", async () => {
    const h = stubTools({ voice: "down" });
    const result = await run(h, "run-os-tts-down");
    expect(result.status).toBe("completed");
    expect(h.calls).toContain("video.synthesizeVoice");
    expect(h.calls).not.toContain("video.transcribe");
    expect(h.composeArgs[0]!["voiceoverPath"]).toBeUndefined();
    const srt = await fs.readFile(h.frameArgs[0]!["srtPath"] as string, "utf8");
    expect(srt).toContain("The first hire is a bet");
    expect(h.deliverables[0]).toMatchObject({ voiceover: false });
  }, 20_000);

  it("a visual QA route outage ships the clip to the human unreviewed, recorded as skipped, never a failed run", async () => {
    const h = stubTools({ qa: "down" });
    const result = await run(h, "run-os-qa-down");
    expect(result.status).toBe("completed");
    expect(h.calls).toContain("video.visualQaGate");
    expect(h.calls).toContain("ledger.writeDeliverable");
    expect((h.deliverables[0] as { visualQa?: unknown }).visualQa).toBeUndefined();
  }, 20_000);

  it("proceeds to the human gate unreviewed — recorded, not pretended — when no visual QA gate is registered", async () => {
    const h = stubTools({ qa: "none" });
    const result = await run(h, "run-os-no-qa");

    expect(result.status).toBe("completed");
    expect(h.calls).not.toContain("video.visualQaGate");
  }, 20_000);
});

describe("original short: real footage, then a still, never generated video (2026-09-09)", () => {
  it("takes every plate from the stock library when it answers, excludes clips already used, and fills the frame", async () => {
    const h = stubTools({ stock: "hit" });
    const result = await run(h, "run-os-stock");
    expect(result.status).toBe("completed");

    expect(h.calls).not.toContain("video.generateClip");
    expect(h.imageArgs).toHaveLength(0);
    expect(h.stockArgs.map((a) => a["outputName"])).toEqual(["plate-1", "plate-2", "plate-2-b", "plate-3", "plate-3-b"]);
    // Each beat's own query (derived from its brief here — the v4 prompt writes `stockQuery` itself).
    expect(String(h.stockArgs[0]!["query"])).toContain("office");
    // Every later search excludes every clip already taken, second shots included.
    expect(h.stockArgs[3]!["excludeIds"]).toEqual([1001, 1002, 1003]);
    // Portrait plates fill the picture area instead of sitting between side bars.
    expect(h.frameArgs[0]!["fit"]).toBe("cover");
    // The reviewer is told which plates are real.
    const deliverable = h.deliverables[0] as { plateSources?: string[] };
    expect(deliverable.plateSources).toEqual(["stock", "stock", "stock", "stock", "stock"]);
  });

  it("falls through to a generated STILL with a slow push-in for the beats the library cannot serve, beat by beat", async () => {
    const h = stubTools({ stock: "hit-then-miss" });
    const result = await run(h, "run-os-stock-partial");
    expect(result.status).toBe("completed");

    expect(h.stockArgs).toHaveLength(3);
    // One photograph per missed beat, portrait, briefed as a photograph with the generated tells ruled out.
    expect(h.imageArgs).toHaveLength(2);
    expect(h.imageArgs.every((a) => a["aspectRatio"] === "9:16")).toBe(true);
    const needs = h.imageArgs.map((a) => (a["needs"] as Array<{ n: number; prompt: string }>)[0]!);
    expect(needs.map((n) => n.n)).toEqual([2, 3]);
    expect(needs[0]!.prompt).toContain("Whiteboard being wiped clean");
    expect(needs[0]!.prompt).toContain("documentary photograph");
    expect(needs[0]!.prompt).toContain("No people.");
    // Each still is held for its beat's seconds, alternating the move.
    expect(h.stillArgs.map((a) => a["durationSeconds"])).toEqual([6, 6]);
    expect(h.stillArgs.map((a) => a["move"])).toEqual(["pull-back", "push-in"]);
    expect((h.deliverables[0] as { plateSources?: string[] }).plateSources).toEqual(["stock", "still", "still"]);
  });

  it("lays the client's music bed under the sequence before framing, ducked under the voice, and tells the reviewer", async () => {
    const h = stubTools({ music: "https://cdn.example.com/beds/calm.mp3" });
    const result = await run(h, "run-os-music");
    expect(result.status).toBe("completed");
    expect(h.musicArgs).toHaveLength(1);
    expect(String(h.musicArgs[0]!["videoPath"])).toMatch(/sequence\.mp4$/);
    expect(String(h.musicArgs[0]!["musicPath"])).toMatch(/music\.mp3$/);
    expect(h.musicArgs[0]!["musicGainDb"]).toBe(-18);
    // The framed file is the MIXED sequence, not the dry one.
    expect(String(h.frameArgs[0]!["videoPath"])).toMatch(/sequence-music\.mp4$/);
    expect(h.deliverables[0]).toMatchObject({ music: { applied: true } });
  }, 20_000);

  it("no track, no bed, no hold: the clip ships and the gate says why there is no music", async () => {
    const h = stubTools();
    const result = await run(h, "run-os-no-music");
    expect(result.status).toBe("completed");
    expect(h.calls).not.toContain("video.mixMusic");
    expect(String(h.frameArgs[0]!["videoPath"])).toMatch(/sequence\.mp4$/);
    expect(h.deliverables[0]).toMatchObject({ music: { applied: false, note: "no musicTrackUri in the client's tiktokClips config" } });
  }, 20_000);

  it("a track that cannot be fetched ships the clip dry with the reason, never held", async () => {
    const h = stubTools({ music: "https://cdn.example.com/beds/missing.wav" });
    const result = await run(h, "run-os-music-404");
    expect(result.status).toBe("completed");
    expect(h.calls).not.toContain("video.mixMusic");
    expect(h.deliverables[0]).toMatchObject({ music: { applied: false, note: "the music track could not be fetched (404)" } });
  }, 20_000);

  it("records the clip in the anti-repetition window BEFORE the gate, so a run waiting for approval already counts as said", async () => {
    const h = stubTools();
    const result = await run(h, "run-os-pending-excerpt");
    expect(result.status).toBe("completed");
    const firstRecord = h.calls.indexOf("ledger.recordOutputExcerpt");
    expect(firstRecord).toBeGreaterThan(-1);
    expect(firstRecord).toBeLessThan(h.calls.indexOf("ledger.writeDeliverable"));
    // Twice, idempotent on runId: once pending, once on commit with the shipped words.
    expect(h.excerpts).toHaveLength(2);
    expect(h.excerpts.every((e) => e["runId"] === "run-os-pending-excerpt")).toBe(true);
    expect(String(h.excerpts[0]!["excerpt"])).toContain(VOICED_SCRIPT.caption);
  }, 20_000);

  it("a Hebrew client's captions and furniture are set in a Hebrew face, so the frame is not assembled from fallback glyphs", async () => {
    const h = stubTools({ voiceLanguage: "he-IL" });
    const result = await run(h, "run-os-hebrew");
    expect(result.status).toBe("completed");
    expect(h.voiceArgs[0]!["language"]).toBe("he-IL");
    expect(h.frameArgs[0]!["captionStyle"]).toEqual({ fontName: "Noto Sans Hebrew" });
  }, 20_000);

  it("with no stock library registered the original short is not available at all: the run holds at sourcing, naming the missing key", async () => {
    const h = stubTools({ stock: "none" });
    const result = await run(h, "run-os-no-stock");
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("video.findStockClip is not registered");
    expect(h.imageArgs).toHaveLength(0);
    expect(h.calls).not.toContain("video.synthesizeVoice");
  });

  it("a still that cannot be made (image route down) becomes a text plate, never a hold", async () => {
    const h = stubTools({ stock: "miss" });
    h.tools["image.generate"] = {
      name: "image.generate",
      version: "1.0.0",
      inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
      async execute() {
        return { status: "tooling_error" as const, reason: "the image model call failed — 403 Lightning dunning decision is deny" };
      },
    } as unknown as AgentToolRegistry[string];
    const result = await run(h, "run-os-image-down");
    expect(result.status).toBe("completed");
    expect(h.textArgs).toHaveLength(3);
    expect((h.deliverables[0] as { plateSources?: string[] }).plateSources).toEqual(["text", "text", "text"]);
  }, 20_000);

  it("a beat the library cannot serve for a stock-only client becomes a text plate instead of a still or a hold", async () => {
    const h = stubTools({ stock: "miss" });
    h.tools["client.getConfig"] = {
      name: "client.getConfig",
      version: "1.0.0",
      inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
      async execute() {
        return { status: "success" as const, result: { tiktokClips: { mode: "original", footageSource: "stock", voiceover: "never", sourcePool: [], guestWatchlist: [], narrowing: [] } } };
      },
    } as unknown as AgentToolRegistry[string];
    const result = await run(h, "run-os-stock-only-miss");
    expect(result.status).toBe("completed");
    expect(h.imageArgs).toHaveLength(0);
    // The free ladder was walked first: the beat's query (the brief-derived one for this v3-shaped script) and two generic scenes.
    expect(h.stockArgs.filter((a) => a["outputName"] === "plate-1")).toHaveLength(3);
    expect(h.textArgs).toHaveLength(3);
    expect((h.deliverables[0] as { plateSources?: string[] }).plateSources).toEqual(["text", "text", "text"]);
  });
});
