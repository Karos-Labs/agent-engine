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
import { beatsNamedIn, createTikTokAgentWorkflow, dropRepeatedBeats, isFootageOnlyFeedback, repairScriptStructure, salesPitchIssues, scriptVoiceIssues, shotVarietyIssues } from "../src/workflow/create-tiktok-agent-workflow.js";

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
    { narration: "You hire for the company you have. By month six it is a different company entirely.", onScreenText: "Month six changes everything", visualBrief: "Whiteboard being wiped clean, marker residue catching window light, handheld drift.", seconds: 6 as const },
    { narration: "So write the role for the company you are becoming.", onScreenText: "Hire for who you're becoming", visualBrief: "City street at blue hour, storefront lights coming on one by one, wide static frame.", seconds: 6 as const },
  ],
  caption: "The first hire is a bet on a company that will not exist in six months. Hire for the one you're becoming.",
  about: "An original short arguing founders should write early roles for the company they are turning into.",
  format: "footage" as const,
  voiceover: true,
  voiceoverRationale: "A narrative with a turn in it; a voice carries the 'so' in beat three.",
  language: "en-US",
};

/** The same piece as a text-led short: every beat is its line on the brand ground, no footage searched. */
const TEXT_LED_SCRIPT = { ...VOICED_SCRIPT, format: "text-led" as const, formatRationale: "Three blunt claims; the words are the picture.", voiceover: false };

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
    qa?: "pass" | "fail" | "none" | "down" | "weak-beat" | "weak-beat-sticky";
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
    let qaCalls = 0;
    tools["video.visualQaGate"] = tool(
      "video.visualQaGate",
      (args) => {
        qaArgs.push(args as Record<string, unknown>);
        qaCalls += 1;
        if (opts.qa === "down") return { status: "tooling_error" as const, reason: "the vision model call failed — 403 Lightning dunning decision is deny" };
        // "weak-beat": beat 2 does not fit the first time, and the re-render (a second call) is clean. "weak-beat-sticky": it never fits.
        if (opts.qa === "weak-beat" && qaCalls > 1) {
          return ok({
            verdict: "pass" as const,
            evidence: ["overallScore: 9", "beat 1 relevance: 9", "beat 2 relevance: 8", "beat 3 relevance: 8"],
            toolVersion: "1.2.0",
            beats: [
              { index: 1, relevance: 9, note: "" },
              { index: 2, relevance: 8, note: "" },
              { index: 3, relevance: 8, note: "" },
            ],
          });
        }
        if (opts.qa === "weak-beat" || opts.qa === "weak-beat-sticky") {
          return ok({
            verdict: "pass" as const,
            evidence: ["overallScore: 8", "beat 1 relevance: 9", "beat 2 relevance: 3 (a concert under a line about hiring)", "beat 3 relevance: 8"],
            toolVersion: "1.2.0",
            beats: [
              { index: 1, relevance: 9, note: "" },
              { index: 2, relevance: 3, note: "a concert under a line about hiring" },
              { index: 3, relevance: 8, note: "" },
            ],
          });
        }
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

describe("footage-only revision (2026-09-10)", () => {
  const workflowFor = (h: Harness, turns: unknown[], prompts: string[]) =>
    createTikTokAgentWorkflow({ tools: h.tools, promptStore: new FilePromptStore(PROMPTS_ROOT), router: sequentialFakeRouter(turns, prompts), repoRoot: os.tmpdir(), fetchImpl: fakeAudioFetch });
  const at = () => new Date().toISOString();

  it("tells a footage note from one that touches the words, in English and Hebrew, and reads the beats it names", () => {
    expect(isFootageOnlyFeedback("Beat 2's footage does not fit the line, the concert is wrong.")).toBe(true);
    expect(isFootageOnlyFeedback("הפוטג' בביט 2 לא מתאים")).toBe(true);
    expect(isFootageOnlyFeedback("Swap the clip in beat 2 and shorten the hook.")).toBe(false);
    expect(isFootageOnlyFeedback("Lead with the disagreement, not the number.")).toBe(false);
    expect(beatsNamedIn("beat 2 and beat 3 footage, shot 1 too, ביט 4")).toEqual([2, 3, 1, 4]);
    expect(beatsNamedIn("the footage is generic")).toEqual([]);
  });

  it("a revise whose only complaint is footage keeps the approved words, never asks the writer again, and re-sources the named beat with its old clip excluded", async () => {
    const h = stubTools();
    const prompts: string[] = [];
    const workflow = workflowFor(h, [VOICED_SCRIPT, VOICED_SCRIPT], prompts);
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const runId = "run-os-footage-revise";

    const r0 = await engine.run(workflow, { ...PARAMS, runId, input: {} });
    expect(r0.status).toBe("awaiting_gate");
    const round0 = [...h.stockArgs];
    const beat2FirstCall = round0.findIndex((a) => a["outputName"] === "plate-2");
    const beat2Id = 1001 + beat2FirstCall; // the stub numbers clips 1001, 1002, … in call order
    await engine.resolveGate(runId, "11-clip-review-r0", { decision: "revise", actor: "jane@karoslabs.com", feedback: "Beat 2's footage does not fit the line. Keep everything else.", at: at() });

    const r1 = await engine.run(workflow, { ...PARAMS, runId, input: {} });
    expect(r1.status).toBe("awaiting_gate");
    // The writer was asked once, on round 0.
    expect(prompts).toHaveLength(1);
    const round1 = h.stockArgs.slice(round0.length);
    expect(round1.length).toBeGreaterThan(0);
    // Beat 2 is searched again with its turned-down clip excluded; beat 1 is free to find the same clip it had.
    expect(round1.find((a) => a["outputName"] === "plate-2")!["excludeIds"]).toContain(beat2Id);
    expect(round1.find((a) => a["outputName"] === "plate-1")!["excludeIds"]).not.toContain(1001);
    const ids = (await store.listSteps(runId)).map((s) => s.stepId);
    expect(ids).toContain("03s-script-r1");
    expect(ids).not.toContain("03u-script-r1");
    expect(ids).toContain("04p-plate-2-r1");
    expect(ids).toContain("08-render-r1");

    await engine.resolveGate(runId, "11-clip-review-r1", { decision: "approve", actor: "jane@karoslabs.com", at: at() });
    const final = await engine.run(workflow, { ...PARAMS, runId, input: {} });
    expect(final.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ revisionKind: "footage-only" });
    expect((h.deliverables[0] as { script?: { hook?: string } }).script?.hook).toBe(VOICED_SCRIPT.hook);
  }, 30_000);

  it("a revise that touches the words still goes to the writer, and the plates are re-sourced for the new round", async () => {
    const h = stubTools();
    const prompts: string[] = [];
    const workflow = workflowFor(h, [VOICED_SCRIPT, VOICED_SCRIPT], prompts);
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const runId = "run-os-words-revise";
    await engine.run(workflow, { ...PARAMS, runId, input: {} });
    await engine.resolveGate(runId, "11-clip-review-r0", { decision: "revise", actor: "jane@karoslabs.com", feedback: "Swap the clip in beat 2 and shorten the hook.", at: at() });
    const r1 = await engine.run(workflow, { ...PARAMS, runId, input: {} });
    expect(r1.status).toBe("awaiting_gate");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("shorten the hook");
    const ids = (await store.listSteps(runId)).map((s) => s.stepId);
    expect(ids).toContain("03u-script-r1");
    expect(ids).toContain("04p-plate-1-r1");
    expect(ids).toContain("04h-hook-plate-r1");
  }, 30_000);
});

describe("salesPitchIssues (prep run pubsub-21157235573121560)", () => {
  const lastBeat = (narration: string, onScreenText = "Plan first.") => ({
    ...VOICED_SCRIPT,
    beats: [VOICED_SCRIPT.beats[0]!, VOICED_SCRIPT.beats[1]!, { ...VOICED_SCRIPT.beats[2]!, narration, onScreenText }],
  });

  it("names a beat that pitches anywhere, and a last beat about what the client offers; a clean script has none", () => {
    expect(salesPitchIssues(VOICED_SCRIPT, undefined)).toEqual([]);
    const sells = salesPitchIssues(lastBeat("We show you the plan before anything else. No pitch, just a plan."), undefined);
    expect(sells).toHaveLength(1);
    expect(sells[0]).toContain('the last beat sells ("We show you the plan before anything else.');
    expect(sells[0]).toContain("not what the client offers");
    expect(salesPitchIssues(lastBeat("Ask for the plan first.", "karoslabs.com"), undefined)[0]).toContain("beat 3 pitches (a website address)");
    const middle = { ...VOICED_SCRIPT, beats: [VOICED_SCRIPT.beats[0]!, { ...VOICED_SCRIPT.beats[1]!, narration: "Book a call and we will walk you through it." }, VOICED_SCRIPT.beats[2]!] };
    expect(salesPitchIssues(middle, undefined)[0]).toContain("beat 2 pitches (book a call)");
    // A middle beat may say "we" without selling; only the last beat is held to that.
    const weInMiddle = { ...VOICED_SCRIPT, beats: [VOICED_SCRIPT.beats[0]!, { ...VOICED_SCRIPT.beats[1]!, narration: "We can see the pattern in every hiring cycle." }, VOICED_SCRIPT.beats[2]!] };
    expect(salesPitchIssues(weInMiddle, undefined)).toEqual([]);
  });

  it("a run that asked for a call to action lifts the rule", () => {
    const pitch = lastBeat("Book a call and we will show you the plan.");
    expect(salesPitchIssues(pitch, "End with a call to action to book a call.")).toEqual([]);
    expect(salesPitchIssues(pitch, "סיים עם קריאה לפעולה")).toEqual([]);
    expect(salesPitchIssues(pitch, "Keep it under 25 seconds.")).toHaveLength(1);
  });

  it("a draft that ends on a pitch is redrafted ONCE with the beat named, and the clean redraft ships", async () => {
    const h = stubTools();
    const prompts: string[] = [];
    const result = await run(h, "run-os-pitch-fix", [lastBeat("We show you the plan before anything else. No pitch, just a plan."), VOICED_SCRIPT], prompts);
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Pitch problem in your last draft");
    expect(prompts[1]).toContain("the last beat sells");
    expect(prompts[1]).not.toContain("Voice problem");
    expect((h.deliverables[0] as { script?: { beats: Array<{ narration: string }> } }).script?.beats[2]?.narration).toBe(VOICED_SCRIPT.beats[2]!.narration);
  }, 20_000);
});

describe("stat beats (2026-09-10)", () => {
  it("a beat that is one figure renders as a stat card on the brand ground, searches no library, and is left out of the still estimate", async () => {
    const withStat = {
      ...VOICED_SCRIPT,
      beats: [VOICED_SCRIPT.beats[0]!, { ...VOICED_SCRIPT.beats[1]!, stat: { value: "47%", label: "of first hires leave in a year" } }, VOICED_SCRIPT.beats[2]!],
    };
    const h = stubTools();
    const result = await run(h, "run-os-stat", [withStat]);
    expect(result.status).toBe("completed");
    const card = h.textArgs.find((a) => String(a["outputPath"]).endsWith("plate-2-stat.mp4"))!;
    expect(card).toBeDefined();
    expect(card["stat"]).toEqual({ value: "47%", label: "of first hires leave in a year" });
    expect(card["text"]).toBe("of first hires leave in a year");
    expect(card["durationSeconds"]).toBe(withStat.beats[1]!.seconds);
    expect(h.stockArgs.some((a) => a["outputName"] === "plate-2" || a["outputName"] === "plate-2-b")).toBe(false);
    const sources = (h.deliverables[0] as { plateSources?: string[] }).plateSources!;
    expect(sources[0]).toBe("stock");
    expect(sources).toContain("text");
  }, 20_000);
});

describe("scriptVoiceIssues", () => {
  it("names a hook too long for the screen, a sentence past a breath, and the conference-slide register; a clean script has none", () => {
    expect(scriptVoiceIssues(VOICED_SCRIPT)).toEqual([]);
    const off = {
      ...VOICED_SCRIPT,
      hook: "In today's fast-moving founder landscape, the real question is whether your first hire can scale with you.",
      beats: [
        { ...VOICED_SCRIPT.beats[0]!, narration: "The compliance question is what your AI is allowed to do, and the strategy question is what you have decided it should do, and most brands have not asked the second one." },
        { ...VOICED_SCRIPT.beats[1]!, onScreenText: "Leverage the ecosystem" },
        VOICED_SCRIPT.beats[2]!,
      ],
    };
    const issues = scriptVoiceIssues(off);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatch(/the hook is 17 words/);
    expect(issues[1]).toMatch(/beat 1 has a 32-word sentence/);
    expect(issues[2]).toContain("corporate cadence");
    expect(issues[2]).toContain("leverage");
    expect(issues[2]).toContain("ecosystem");
    expect(issues[2]).toContain("in today's");
    expect(issues[2]).toContain("the real X is");
  });
});

describe("shotVarietyIssues (prep run pubsub-21156942503403946)", () => {
  const withQueries = (queries: string[]) => ({
    ...VOICED_SCRIPT,
    beats: queries.map((q, i) => ({ ...VOICED_SCRIPT.beats[i % VOICED_SCRIPT.beats.length]!, stockQuery: q })),
  });

  it("names the place three or more beats share, ignoring how each shot is lit or framed", () => {
    const issues = shotVarietyIssues(withQueries(["empty office desk night monitor glow", "empty office chair desk morning window blind", "analog clock wall office close", "empty office corridor fluorescent ceiling receding"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('4 of 4 shots are set in the same place ("office")');
  });

  it("is quiet for beats in different places, for two beats that share one, for text-led shorts and for beats without a query", () => {
    expect(shotVarietyIssues(withQueries(["empty office desk night", "city intersection rain", "hands typing laptop", "warehouse forklift"]))).toEqual([]);
    expect(shotVarietyIssues(withQueries(["empty office desk night", "office corridor", "city street rain"]))).toEqual([]);
    expect(shotVarietyIssues({ ...withQueries(["office desk", "office chair", "office wall"]), format: "text-led" as const })).toEqual([]);
    expect(shotVarietyIssues(VOICED_SCRIPT)).toEqual([]);
  });

  it("a one-room draft is redrafted ONCE with the place named, alongside any voice issue, and the redraft ships", async () => {
    const oneRoom = withQueries(["empty office desk night", "office chair window", "office corridor"]);
    const h = stubTools();
    const prompts: string[] = [];
    const result = await run(h, "run-os-one-room", [oneRoom, VOICED_SCRIPT], prompts);
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Shot problem in your last draft");
    expect(prompts[1]).toContain("3 of 3 shots are set in the same place");
    expect(prompts[1]).toContain("office");
    expect(prompts[1]).not.toContain("Voice problem");
    expect(h.calls).toContain("ledger.writeDeliverable");
  }, 20_000);
});

describe("repairScriptStructure (prep run pubsub-21157255126300088)", () => {
  const base = { ...VOICED_SCRIPT, beats: VOICED_SCRIPT.beats.map((b) => ({ ...b })) };

  it("puts the hook in beat 1 when the writer left it in `hook` only (which alone resolves the prep run's beat-1/beat-2 repeat), and flags two later beats with the same line", () => {
    const prep = {
      ...base,
      hook: "Everyone is worried about privacy. It's not the urgent risk.",
      beats: [
        { ...base.beats[0]!, narration: "AI can now optimize your copy to exploit patterns buyers don't know they have." },
        { ...base.beats[1]!, narration: "AI can now optimize your copy to exploit patterns buyers don't know they have." },
        base.beats[2]!,
      ],
    };
    const fixed = repairScriptStructure(prep);
    expect(fixed.repaired.beats[0]!.narration).toBe(prep.hook);
    expect(fixed.issues).toEqual([]);

    const later = { ...base, beats: [base.beats[0]!, base.beats[1]!, { ...base.beats[2]!, narration: base.beats[1]!.narration }] };
    const { repaired, issues } = repairScriptStructure(later);
    expect(repaired.beats[0]!.narration).toBe(base.beats[0]!.narration);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("beats 2 and 3 have the same narration");
    // A clean script comes back untouched with no issues.
    const clean = repairScriptStructure(base);
    expect(clean.issues).toEqual([]);
    expect(clean.repaired.beats.map((b) => b.narration)).toEqual(base.beats.map((b) => b.narration));
  });

  it("drops a later repeated beat only while three remain", () => {
    const four = { ...base, beats: [...base.beats, { ...base.beats[1]! }] };
    expect(dropRepeatedBeats(four).beats).toHaveLength(3);
    const three = { ...base, beats: [base.beats[0]!, base.beats[1]!, { ...base.beats[1]! }] };
    expect(dropRepeatedBeats(three).beats).toHaveLength(3);
  });
});

describe("original short: script → plates → voice → captions → sequence → frame → QA", () => {
  it("a draft that reads like a slide is redrafted ONCE with the lines named; what the redraft still gets wrong ships to the reviewer", async () => {
    const slide = { ...VOICED_SCRIPT, beats: [VOICED_SCRIPT.beats[0]!, { ...VOICED_SCRIPT.beats[1]!, narration: "You need to leverage a strategy layer that aligns the whole ecosystem before the platform decides it for you at scale." }, VOICED_SCRIPT.beats[2]!] };
    const h = stubTools();
    const prompts: string[] = [];
    const result = await run(h, "run-os-voice-fix", [slide, slide], prompts);
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Voice problem in your last draft");
    expect(prompts[1]).toContain("beat 2 has a 21-word sentence");
    expect(prompts[1]).toContain("leverage");
    expect(prompts[1]).not.toContain("Structure problem");
    // The redraft came back the same: it ships (the reviewer hears it), it is not held.
    expect(h.calls).toContain("ledger.writeDeliverable");
  }, 20_000);

  it("a draft whose beats repeat a line is redrafted ONCE with the beats named, and the clean redraft ships", async () => {
    const dup = { ...VOICED_SCRIPT, beats: [VOICED_SCRIPT.beats[0]!, { ...VOICED_SCRIPT.beats[1]!, narration: VOICED_SCRIPT.beats[0]!.narration }, VOICED_SCRIPT.beats[2]!] };
    const h = stubTools();
    const prompts: string[] = [];
    const result = await run(h, "run-os-structure-fix", [dup, VOICED_SCRIPT], prompts);
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("beats 1 and 2 have the same narration");
    const shipped = h.deliverables[0] as { script: { beats: Array<{ narration: string }> } };
    expect(new Set(shipped.script.beats.map((b) => b.narration)).size).toBe(3);
  }, 20_000);

  it("voices the script when the model asks for it, captions the SCRIPT's words on the voice's timings, and stretches the plates to cover the speech", async () => {
    const h = stubTools();
    const prompts: string[] = [];
    const result = await run(h, "run-os-voiced", [VOICED_SCRIPT], prompts);

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
    // The writer was handed the client's documents in its input and fetched nothing itself.
    expect(prompts[0]).toContain('"voiceRules":{"tone":"direct"}');
    expect(prompts[0]).toContain('"handle":"acmeco"');
    expect(h.calls.filter((c) => c === "client.getVoiceRules")).toHaveLength(1);
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
    // No caption while the cold open is on screen: the first cue starts when the hook plate ends (2s; beat 1's hold is ~4s).
    expect(srt).toMatch(/^1\n00:00:02,0\d\d --> /);
    expect(srt).not.toContain("Nobody tells you the");
    expect(srt).toContain("one you fire.");
    expect(srt).toContain("becoming.");
    // The cold open replaces the title card: the hook, large, for beat 1's first half.
    expect(h.frameArgs[0]!["overlays"]).toBeUndefined();
    expect(h.textArgs[0]).toMatchObject({ text: VOICED_SCRIPT.hook, durationSeconds: 2, ground: "#101418" });

    // The sequence covers the voice: holds sum to voice + tail, proportional
    // to how much each beat says; the cold open takes its seconds out of beat 1.
    // Beat 2 says the most, so its hold (~6s) is long enough to cut in two;
    // beat 3's hold (~3.5s) is not, so its second shot is left unused.
    const compose = h.composeArgs[0]!;
    const clips = compose["clips"] as Array<{ path: string; holdSeconds: number }>;
    expect(clips.map((c) => path.basename(c.path))).toEqual(["plate-hook.mp4", "plate-1.mp4", "plate-2.mp4", "plate-2-b.mp4", "plate-3.mp4"]);
    const total = clips.reduce((sum, c) => sum + c.holdSeconds, 0);
    expect(total).toBeCloseTo(13.1 + 0.4, 1);
    expect(clips.every((c) => c.holdSeconds >= 1.9)).toBe(true);
    expect(clips[0]!.holdSeconds).toBeCloseTo(clips[1]!.holdSeconds, 1);
    expect(clips[2]!.holdSeconds + clips[3]!.holdSeconds).toBeGreaterThan(clips[0]!.holdSeconds + clips[1]!.holdSeconds);
    expect(clips[2]!.holdSeconds).toBeCloseTo(clips[3]!.holdSeconds, 2);
    expect(compose["voiceoverPath"]).toMatch(/voiceover\.mp3$/);

    // The visual QA watched the framed file with the right expectations.
    expect(h.qaArgs).toHaveLength(1);
    const expectations = h.qaArgs[0]!["expectations"] as Record<string, unknown>;
    expect(expectations["format"]).toBe("original-short");
    expect(expectations["voiceoverExpected"]).toBe(true);
    expect(expectations["captionsExpected"]).toBe(true);
    expect(expectations["hookLine"]).toBe(VOICED_SCRIPT.hook);

    expect(h.deliverables[0]).toMatchObject({ format: "original-short", voiceover: true, sourceTier: "stock", plateSources: ["stock", "stock", "stock", "stock", "stock"], maxCostUsd: 2 });
    // Why stock and not the client's own footage: what every higher tier said, carried to the reviewer.
    const notes = (h.deliverables[0] as { sourceNotes?: string[] }).sourceNotes!;
    expect(notes[0]).toBe("user-asset: no media attached to this run");
    expect(notes.some((n) => n.startsWith("owned-footage"))).toBe(true);
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
    // Silent: the script's own seconds stand; the cold open takes two of beat 1's four, and each six-second beat is two three-second shots.
    expect(clips.map((c) => c.holdSeconds)).toEqual([2, 2, 3, 3, 3, 3]);
    expect(h.composeArgs[0]!["voiceoverPath"]).toBeUndefined();
    const srt = await fs.readFile(h.frameArgs[0]!["srtPath"] as string, "utf8");
    // Beat 1's caption waits for the cold open to end.
    expect(srt).toMatch(/^1\n00:00:02,000 --> /);
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
    const beatPlates = h.textArgs.filter((a) => !String(a["outputPath"]).includes("plate-hook"));
    expect(beatPlates.map((a) => a["text"])).toEqual(["Month six changes everything", "Hire for who you're becoming"]);
    expect(beatPlates[0]).toMatchObject({ ground: "#101418", fg: "#F2F0EA", durationSeconds: 6 });
    expect((h.deliverables[0] as { plateSources?: string[] }).plateSources).toEqual(["stock", "text", "text"]);
  }, 20_000);

  it("a Hebrew client's text plates are set in the Hebrew face", async () => {
    const h = stubTools({ maxRunCostUsd: 0.05, stock: "miss", voiceLanguage: "he-IL" });
    const result = await run(h, "run-os-text-hebrew", [VOICED_SCRIPT, VOICED_SCRIPT, VOICED_SCRIPT]);
    expect(result.status).toBe("completed");
    // Three beat plates and the cold open, all in the Hebrew face.
    expect(h.textArgs).toHaveLength(4);
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

  it("the visual QA is told each beat's window and line; a beat whose footage does not fit is RE-SOURCED once with every used clip excluded, re-rendered under its own steps, and the clean re-render ships", async () => {
    const h = stubTools({ qa: "weak-beat" });
    const result = await run(h, "run-os-weak-beat");
    expect(result.status).toBe("completed");
    const expectations = h.qaArgs[0]!["expectations"] as { beats?: Array<{ index: number; start: number; end: number; narration: string }> };
    expect(expectations.beats).toHaveLength(3);
    expect(expectations.beats![0]).toMatchObject({ index: 1, start: 0, narration: VOICED_SCRIPT.beats[0]!.narration });
    expect(expectations.beats![1]!.start).toBeCloseTo(expectations.beats![0]!.end, 2);
    expect(expectations.beats![2]!.end).toBeCloseTo(13.5, 1);
    // The re-pick: beat 2 searched again after the QA, every clip this run had used excluded, judged against its own line.
    const repickSearch = h.stockArgs[h.stockArgs.length - 1]!;
    expect(repickSearch["outputName"]).toBe("plate-2-repick");
    expect(repickSearch["query"]).toBe(h.stockArgs.find((a) => a["outputName"] === "plate-2")!["query"]);
    expect(repickSearch["excludeIds"]).toEqual(h.stockArgs.slice(0, -1).map((_, i) => 1001 + i));
    expect(repickSearch["relevance"]).toEqual({ brief: VOICED_SCRIPT.beats[1]!.visualBrief, narration: VOICED_SCRIPT.beats[1]!.narration });
    // Rendered and watched twice; the second cut carries the new plate for beat 2 alone.
    expect(h.composeArgs).toHaveLength(2);
    expect(h.qaArgs).toHaveLength(2);
    const secondClips = h.composeArgs[1]!["clips"] as Array<{ path: string }>;
    expect(secondClips.some((c) => c.path.endsWith("plate-2-repick.mp4"))).toBe(true);
    expect(secondClips.some((c) => c.path.endsWith("plate-2.mp4"))).toBe(false);
    // The clean re-render is what ships, and the reviewer is told what was swapped and why.
    const shipped = h.deliverables[0] as { visualQa?: { passed: boolean; weakBeats?: unknown }; repick?: { beats: number[]; note: string } };
    expect(shipped.visualQa?.passed).toBe(true);
    expect(shipped.visualQa?.weakBeats).toBeUndefined();
    expect(shipped.repick?.beats).toEqual([2]);
    expect(shipped.repick?.note).toContain("beat 2 re-sourced after the visual QA scored the footage under 5");
    expect(shipped.repick?.note).toContain("the re-render scored clean");
  }, 20_000);

  it("a beat still weak after its second clip ships NAMED to the reviewer; there is no second re-pick", async () => {
    const h = stubTools({ qa: "weak-beat-sticky" });
    const result = await run(h, "run-os-weak-beat-sticky");
    expect(result.status).toBe("completed");
    expect(h.qaArgs).toHaveLength(2);
    expect(h.composeArgs).toHaveLength(2);
    expect(h.stockArgs.filter((a) => String(a["outputName"]).endsWith("-repick"))).toHaveLength(1);
    const shipped = h.deliverables[0] as { visualQa?: { passed: boolean; weakBeats?: Array<{ index: number; relevance: number }> }; repick?: { beats: number[]; note: string } };
    expect(shipped.visualQa?.weakBeats).toEqual([{ index: 2, relevance: 3, note: "a concert under a line about hiring" }]);
    expect(shipped.repick?.beats).toEqual([2]);
    expect(shipped.repick?.note).toContain("the re-render still names beat 2");
  }, 20_000);

  it("when the library has nothing else for the weak beat, the first cut ships with the beat named and the miss explained", async () => {
    const h = stubTools({ qa: "weak-beat-sticky", stock: "hit-then-miss" });
    const result = await run(h, "run-os-weak-beat-no-stock");
    expect(result.status).toBe("completed");
    expect(h.qaArgs).toHaveLength(1);
    expect(h.composeArgs).toHaveLength(1);
    const shipped = h.deliverables[0] as { repick?: { beats: number[]; note: string } };
    expect(shipped.repick?.beats).toEqual([]);
    expect(shipped.repick?.note).toContain("the library had nothing else");
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
    expect(h.textArgs.filter((a) => !String(a["outputPath"]).includes("plate-hook"))).toHaveLength(3);
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
    expect(h.textArgs.filter((a) => !String(a["outputPath"]).includes("plate-hook"))).toHaveLength(3);
    expect((h.deliverables[0] as { plateSources?: string[] }).plateSources).toEqual(["text", "text", "text"]);
  });

  it("a text-led short never searches the library: every beat is its own line on the brand ground, no cold open, no stills in the estimate", async () => {
    const h = stubTools({ voiceoverPolicy: "never" });
    const result = await run(h, "run-os-text-led", [TEXT_LED_SCRIPT]);
    expect(result.status).toBe("completed");
    expect(h.calls).not.toContain("video.findStockClip");
    expect(h.calls).not.toContain("image.generate");
    expect(h.textArgs.map((a) => a["text"])).toEqual(["The first hire is a bet", "Month six changes everything", "Hire for who you're becoming"]);
    expect(h.textArgs.map((a) => a["durationSeconds"])).toEqual([4, 6, 6]);
    expect(h.frameArgs[0]!["overlays"]).toBeUndefined();
    expect((h.deliverables[0] as { plateSources?: string[]; script?: { format?: string } }).plateSources).toEqual(["text", "text", "text"]);
    expect((h.deliverables[0] as { script?: { format?: string } }).script?.format).toBe("text-led");
    // No cold open: the first caption cue starts at zero, and the clips are the three beats at their scripted seconds.
    const clips = h.composeArgs[0]!["clips"] as Array<{ path: string; holdSeconds: number }>;
    expect(clips.map((c) => c.holdSeconds)).toEqual([4, 6, 6]);
    const srt = await fs.readFile(h.frameArgs[0]!["srtPath"] as string, "utf8");
    expect(srt).toMatch(/^1\n00:00:00,000 --> /);
  }, 20_000);

  it("a beat 1 too short to share skips the cold open and keeps the title card", async () => {
    // A 4-second beat with a two-second cold open leaves two seconds of footage: fine. Force a
    // tighter beat 1 so the remainder falls under the floor and the card stands in.
    const tight = { ...VOICED_SCRIPT, voiceover: false, beats: [{ ...VOICED_SCRIPT.beats[0]!, seconds: 4 as const }, ...VOICED_SCRIPT.beats.slice(1)] };
    const h = stubTools({ voiceoverPolicy: "never" });
    h.tools["video.textPlate"] = undefined as unknown as AgentToolRegistry[string];
    const result = await run(h, "run-os-no-text-tool", [tight]);
    expect(result.status).toBe("completed");
    const clips = h.composeArgs[0]!["clips"] as Array<{ holdSeconds: number }>;
    expect(clips.map((c) => c.holdSeconds)).toEqual([4, 3, 3, 3, 3]);
  }, 20_000);
});
