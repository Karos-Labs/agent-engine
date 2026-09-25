import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import { FilePromptStore, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";
import { formatForVariant, modeForVariant } from "../src/workflow/types.js";

/**
 * D08's split and C7's loop, on the two TikTok agents that share this
 * workspace (SCRUM-455/459/460).
 *
 * The four assertions `docs/AGENT-ARCHITECTURE.md` §5 requires, plus the ones
 * the split itself owes: a product's format is the product, not whatever the
 * sourcing cascade happened to answer, and a clipping run does not quietly
 * become a scripted short.
 *
 * The tools here are stubs rather than a real workspace, like the rest of this
 * suite — every assertion reads a drafting input, a persisted deliverable or
 * the run record the workflow handed to `ledger.writeRunState`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.join(HERE, "..", "prompts");
const PARAMS = { clientSlug: "acme", runKind: "recurring" as const };

function ok<T>(result: T) {
  return { status: "success" as const, result };
}
function pass(name: string) {
  return { verdict: "pass" as const, evidence: [`${name}: ok`], toolVersion: "1.0.0" };
}
function tool(name: string, execute: (args: unknown) => unknown) {
  return { name, description: name, version: "1.0.0", inputSchema: { parse: (v: unknown) => v } as never, execute: (async (args: unknown) => execute(args)) as never };
}

const GOOD_MOMENT = {
  startSeconds: 10,
  endSeconds: 50,
  hookLine: "word10.",
  hookType: "surprising-number" as const,
  rationale: "The figure reframes the whole discussion.",
};
const GOOD_COMMENTARY = {
  caption: "Our read on this: the number is right and the conclusion is wrong. Via Jane Doe on The Show ep. 12.",
  about: "A clip where a guest gives a figure we disagree with the framing of.",
  sourceCredit: "Jane Doe on The Show ep. 12",
};

function transcriptWords(): Array<{ text: string; start: number; end: number }> {
  return Array.from({ length: 90 }, (_, i) => ({ text: `word${i}.`, start: i, end: i + 1 }));
}

/**
 * Serves each bounded agent by matching the requested schema against a pool —
 * the same router `workflow.test.ts` uses, and deliberately the same, because
 * a looser fake here would let a drafting input change pass unnoticed.
 *
 * `drafting` collects what each step was actually asked, which is what the C7
 * assertions read: the contract is about what reaches the prompt.
 */
function smartFakeRouter(candidates: readonly unknown[], drafting: Array<Record<string, unknown>>): ModelRouter {
  return {
    async complete(prompt: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, policy: { policy: string; model?: string }) {
      try {
        const parsed = JSON.parse(prompt) as { input?: Record<string, unknown> };
        if (parsed.input !== undefined) drafting.push(parsed.input);
      } catch {
        // A prompt that is not JSON is not a drafting input; nothing to record.
      }
      for (const candidate of candidates) {
        const attempt = schema.safeParse({ type: "final", output: candidate });
        if (attempt.success) {
          return {
            output: attempt.data,
            modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
            inputTokens: { cached: 0, uncached: 100 },
            outputTokens: 30,
          } as CompletionResult<unknown>;
        }
      }
      throw new Error("smartFakeRouter: no candidate matches the requested schema");
    },
    async completeAlias() {
      throw new Error("completeAlias is not used here");
    },
  } as unknown as ModelRouter;
}

interface Harness {
  tools: AgentToolRegistry;
  deliverables: Array<Record<string, unknown>>;
  records: Array<Record<string, unknown>>;
  drafting: Array<Record<string, unknown>>;
}

/** A three-beat original short, silent by the model's own call, so the voice tools are not needed. */
const GOOD_SCRIPT = {
  hook: "Nobody tells you the first hire is the one you fire.",
  beats: [
    { narration: "Nobody tells you the first hire is the one you fire.", onScreenText: "The first hire is a bet", visualBrief: "Empty office at dawn, one desk lamp on, slow push-in across a row of dark monitors.", seconds: 4 as const },
    { narration: "You hire for the company you have, and by month six it is a different company.", onScreenText: "Month six changes everything", visualBrief: "Whiteboard being wiped clean, marker residue catching window light, handheld drift.", seconds: 6 as const },
    { narration: "So write the role for the company you are becoming, not the one you are.", onScreenText: "Hire for who you're becoming", visualBrief: "City street at blue hour, storefront lights coming on one by one, wide static frame.", seconds: 6 as const },
  ],
  caption: "The first hire is a bet on a company that will not exist in six months. Hire for the one you're becoming.",
  about: "Why the first hire is the one most founders get wrong.",
  voiceover: false,
  voiceoverRationale: "Three blunt claims that land as on-screen text; a voice would slow them down.",
  language: "en-US",
};

function stubTools(learning?: Record<string, unknown>, opts: { silentSource?: boolean; forContentDesign?: boolean } = {}): Harness {
  const deliverables: Array<Record<string, unknown>> = [];
  const records: Array<Record<string, unknown>> = [];
  const drafting: Array<Record<string, unknown>> = [];
  const tools: Record<string, unknown> = {
    "client.getConfig": tool("client.getConfig", () => ok({ tiktokClips: { sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] } })),
    "client.getVoiceRules": tool("client.getVoiceRules", () => ok({ tone: "direct" })),
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [], colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" }, handle: "acmeco" })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    "client.getProfile": tool("client.getProfile", () => ok({ name: "Acme", industry: "B2B SaaS" })),
    "topics.reserve": tool("topics.reserve", () => ok({ reservationKey: "res-1", topics: ["The Show ep. 12 — the margin call moment"] })),
    "topics.commit": tool("topics.commit", () => ok({ committed: true })),
    "topics.release": tool("topics.release", () => ok({ released: true })),
    "video.transcribe": tool("video.transcribe", () => ok({ words: opts.silentSource ? [] : transcriptWords() })),
    "video.cutClip": tool("video.cutClip", (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40 })),
    "video.brandFrame": tool("video.brandFrame", (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40, applied: ["bars"] })),
    "video.selfEvalGate": tool("video.selfEvalGate", () => ok(pass("video.selfEvalGate"))),
    "gate.lintPost": tool("gate.lintPost", () => ok(pass("gate.lintPost"))),
    "gate.brandCompliance": tool("gate.brandCompliance", () => ok(pass("gate.brandCompliance"))),
    "gate.noPlaceholder": tool("gate.noPlaceholder", () => ok(pass("gate.noPlaceholder"))),
    "gate.leakCheck": tool("gate.leakCheck", () => ok(pass("gate.leakCheck"))),
    "ledger.writeDeliverable": tool("ledger.writeDeliverable", (args) => {
      deliverables.push((args as { deliverable: Record<string, unknown> }).deliverable);
      return ok({ id: "deliv-1", created: true });
    }),
    "ledger.writeRunState": tool("ledger.writeRunState", (args) => {
      records.push(args as Record<string, unknown>);
      return ok({ path: "state/runs/x", created: true });
    }),
    "memory.appendDecision": tool("memory.appendDecision", () => ok({ id: "dec-1" })),
  };
  if (opts.forContentDesign) {
    // Content design never touches anyone else's footage, so the sourcing
    // cascade drops to stock and the run assembles rather than cuts. Without
    // these two it holds honestly at "no source footage from any tier", which
    // is the correct answer and not what this fixture is about.
    let stockCalls = 0;
    tools["video.findStockClip"] = tool("video.findStockClip", (args) => {
      const input = args as { outputName: string; query: string };
      stockCalls += 1;
      return ok({
        path: `.media-cache/run/${input.outputName}.mp4`,
        pexelsId: 1000 + stockCalls,
        durationSeconds: 9,
        width: 1080,
        height: 1920,
        sourceUrl: `https://www.pexels.com/video/${1000 + stockCalls}/`,
        photographer: "Someone",
        license: "Pexels",
        query: input.query,
      });
    });
    tools["video.composeSequence"] = tool("video.composeSequence", (args) => {
      const input = args as { outputPath: string; clips: unknown[]; voiceoverPath?: string };
      return ok({ outputPath: input.outputPath, durationSeconds: 24, clipsUsed: input.clips.length, hasVoiceover: input.voiceoverPath !== undefined });
    });
  }
  if (learning !== undefined) {
    tools["client.getLearningContext"] = tool("client.getLearningContext", () => ok(learning));
  }
  return { tools: tools as unknown as AgentToolRegistry, deliverables, records, drafting };
}

async function run(h: Harness, runId: string, productId: string, variant: "clipping" | "content-design" | "auto", input: Record<string, unknown> = {}) {
  const workflow = createTikTokAgentWorkflow({
    tools: h.tools,
    promptStore: new FilePromptStore(PROMPTS_ROOT),
    router: smartFakeRouter([GOOD_MOMENT, GOOD_COMMENTARY, GOOD_SCRIPT], h.drafting),
    autoApprove: true,
    // A scripted short plates into a bounds root; `original-short.test.ts`
    // uses the same one. Harmless for the clipping runs, which never write
    // there.
    repoRoot: os.tmpdir(),
    variant,
  });
  return new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
    ...PARAMS,
    productId,
    runId,
    input: { sourcePath: "/tmp/episode.mp4", ...input },
  });
}

describe("D08: the variant is the product, and the product decides the format", () => {
  it("pins the format and the sourcing mode, so neither falls out of which tier answered", () => {
    // Pure, and worth pinning on its own: before the split, `format` was
    // derived from `intake.sourceTier` — so what a client received depended on
    // whether a stock lookup happened to succeed, which is not a thing anyone
    // pressing a button could predict.
    expect(formatForVariant("clipping")).toBe("commentary-clip");
    expect(formatForVariant("content-design")).toBe("original-short");
    expect(formatForVariant("auto")).toBeUndefined();

    // The client's own `mode` is a preference about what they are comfortable
    // with; the variant is which card they pressed. A card that says clipping
    // may not answer with a generated short because the block says `original`.
    expect(modeForVariant("clipping", "original")).toBe("commentary");
    expect(modeForVariant("content-design", "commentary")).toBe("original");
    expect(modeForVariant("auto", "commentary")).toBe("commentary");
  });

  it("the clipping agent writes over a silent source rather than holding on it", async () => {
    // REVERSED 2026-09-21. This asserted a hold, reasoning that the clipping
    // agent does not write scripts and that delivering one would hand back a
    // different product than the one asked for.
    //
    // The owner's standing ruling (2026-09-17) settles it the other way: a
    // domain-level dead end is fall-back-and-annotate, not one of the three
    // carve-outs. Keeping this hold after PR #170 also left the agent
    // answering two identical situations differently — no footage at all
    // delivered an original short, footage with no words in it held.
    //
    // The variant pin is NOT weakened by this. It still decides the format
    // whenever there is anything to clip; what it no longer does is insist on
    // a product the run has no material for.
    // This harness registers none of the plate tools, so the run cannot
    // finish a short here — and that is fine for what this file pins. What
    // matters is that it is no longer HELD on the silence and that it pivoted
    // into original-short production, which the plate complaint proves it
    // reached. `workflow.test.ts`'s "the clipping variant" block asserts the
    // finished deliverable and the `clip-mode` note against a full harness.
    const h = stubTools(undefined, { silentSource: true });
    const result = await run(h, "tt-clip-silent", "tiktok-clipping-agent", "clipping");
    expect(result.status).not.toBe("held");
    if (result.status !== "degraded") throw new Error(`expected the plate-less harness to degrade, got ${result.status}`);
    expect(result.failureReason).toMatch(/no plate could be made/);
    expect(result.failureReason).not.toMatch(/no speech to clip/);
  });

  it("records which card was pressed on the deliverable, not only what came out", async () => {
    const h = stubTools();
    const result = await run(h, "tt-clip-variant", "tiktok-clipping-agent", "clipping");
    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ variant: "clipping", format: "commentary-clip" });
  });
});

describe("tiktok and the learning loop (C7)", () => {
  it("the client's standing feedback reaches the commentary step beside the run's direction, not inside it", async () => {
    // It used to travel only as an agent-service context file, which the
    // engine path never sent.
    const h = stubTools();
    const standing = "# Client feedback — TikTok Agent\n\n## Applies to everything this agent makes\n- Never say game-changer.";
    const result = await run(h, "tt-standing-1", "tiktok-clipping-agent", "clipping", { standingFeedback: standing, customPrompt: "keep it dry" });
    expect(result.status).toBe("completed");
    // Every step that was handed the run's direction was handed the standing
    // feedback with it, and the direction itself is only what was typed.
    const directed = h.drafting.filter((i) => i.runDirection !== undefined);
    expect(directed.length).toBeGreaterThan(0);
    for (const input of directed) {
      expect(input.clientStandingFeedback).toBe(standing);
      expect(input.runDirection).toBe("keep it dry");
    }
  });

  it("with nothing projected, the run completes as before and the record says all seven are absent", async () => {
    const h = stubTools();
    const result = await run(h, "tt-learn-1", "tiktok-clipping-agent", "clipping");
    expect(result.status).toBe("completed");

    expect(h.records).toHaveLength(1);
    // `writeRunState` sends `{ runId, ...record }`, flattened — so the stub
    // captures the record's own fields at the top level.
    const record = h.records[0]!;
    expect(record.readiness).toEqual({
      present: [],
      absent: ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft", "preferences"],
    });
    expect(record.platform).toBe("tiktok");
  });

  it("all three TikTok products write under the one platform key, because the client has one account", async () => {
    // If clipping wrote under `tiktok-clipping` and content design under
    // `tiktok-content-design`, the anti-repetition window would not see across
    // them and the two agents could publish the same subject in the same week.
    const clipping = stubTools();
    await run(clipping, "tt-learn-key-1", "tiktok-clipping-agent", "clipping");
    const design = stubTools(undefined, { forContentDesign: true });
    const designed = await run(design, "tt-learn-key-2", "tiktok-content-design-agent", "content-design");
    expect(designed.status, "the content-design fixture must actually complete").toBe("completed");
    expect(design.deliverables[0]).toMatchObject({ variant: "content-design", format: "original-short" });
    expect(clipping.records[0]!.platform).toBe("tiktok");
    expect(design.records[0]!.platform).toBe("tiktok");
  });

  it("the goal line reaches the client's card as a field, and the record agrees with it (C3 / D11)", async () => {
    const h = stubTools();
    const result = await run(h, "tt-learn-goal", "tiktok-clipping-agent", "clipping");
    expect(result.status).toBe("completed");

    const goalLine = h.deliverables[0]!.goalLine as Record<string, unknown>;
    expect(goalLine).toBeDefined();
    expect(goalLine.goal).toBe("attention");
    expect(goalLine.goalText).toBe("earn attention");
    expect(typeof goalLine.whyNow).toBe("string");

    // One resolution, two surfaces — they cannot disagree about why a clip
    // exists, which is the whole reason `resolveGoalLine` is called once.
    const record = h.records[0]! as unknown as { deliverable: Record<string, unknown>; subjectRow: Record<string, unknown> };
    expect(record.deliverable).toMatchObject({ kind: "tiktok-clip", goal: goalLine.goal, whyNow: goalLine.whyNow });
    expect(record.subjectRow).toMatchObject({ status: "drafted", assetKind: "tiktok-clip", stage: "attention" });
  });

  it("a typed request for a never-topic HOLDS, before any model call", async () => {
    const h = stubTools({
      platform: "tiktok",
      preferences: { neverTopics: ["layoffs"] },
      sources: {},
      readiness: { present: ["preferences"], absent: ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft"] },
    });
    const result = await run(h, "tt-learn-never", "tiktok-clipping-agent", "clipping", { requestedTopic: "how we handled layoffs" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/never-topic/);
    expect(result.reason).toMatch(/layoffs/);
    // Nothing was transcribed, nothing was drafted, nothing was rendered.
    expect(h.deliverables).toHaveLength(0);
  });
});
