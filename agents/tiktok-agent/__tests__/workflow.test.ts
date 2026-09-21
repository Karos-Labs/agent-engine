import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import type { ZodType } from "zod";
import { FilePromptStore, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import {
  BrandFrameInputSchema,
  ComposeSequenceInputSchema,
  CutClipInputSchema,
  SelfEvalGateInputSchema,
  SynthesizeVoiceInputSchema,
  TranscribeInputSchema,
  UploadDeliverableInputSchema,
} from "@agent-engine/tool-karos-video";
import {
  BRAND_LOGO_CONTRAST_FLOOR,
  FindStockClipInputSchema,
  HarvestVideoInputSchema,
  VisualQaGateInputSchema,
  contrastRatio,
} from "@agent-engine/tool-karos-media";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";

/**
 * The clip pipeline end to end, against stubbed tools.
 *
 * Every video/media stub validates its arguments against the REAL tool's
 * input schema — never a permissive fake. The previous generation of this
 * suite used schema-less stubs, and that is exactly how three calls with the
 * wrong argument shapes (`video.render {sourcePath, cuts…}` against the real
 * `{profilePath, jobPath}`) sat green in CI while never once succeeding in
 * production. A contract drift now fails here, loudly, before it ships.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.join(HERE, "..", "prompts");

const PARAMS = { clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring" as const };

/**
 * 90 seconds of speech at three words a second, so a legal 20-120s clip
 * exists and the window it cuts is dense enough to be watchable.
 *
 * It used to be one word a SECOND, which is not speech — it is a recording
 * with a three-second gap between every word, and it scored 1.0 against the
 * moment floor's 1.6 (2026-09-18). Every clean-run assertion in this file was
 * therefore describing a clip the floor would now refuse. Real conversational
 * English runs 2.3-3.3 words a second; three is the middle of that.
 *
 * Each word is its own sentence (the trailing full stop) so `bestLegalWindow`
 * and `boundsFromTranscript` have a boundary everywhere, which is what lets a
 * test ask for an arbitrary window and get it snapped exactly.
 */
const WORDS_PER_SECOND = 3;
function transcriptWords(): Array<{ text: string; start: number; end: number }> {
  const step = 1 / WORDS_PER_SECOND;
  return Array.from({ length: 90 * WORDS_PER_SECOND }, (_, i) => ({ text: `word${i}.`, start: i * step, end: (i + 1) * step }));
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

/** A three-beat original short, silent by the model's own call — so the voice tools are not needed to complete it. */
const GOOD_SCRIPT = {
  hook: "Nobody tells you the first hire is the one you fire.",
  beats: [
    { narration: "Nobody tells you the first hire is the one you fire.", onScreenText: "The first hire is a bet", visualBrief: "Empty office at dawn, one desk lamp on, slow push-in across a row of dark monitors.", seconds: 4 as const },
    { narration: "You hire for the company you have, and by month six it is a different company.", onScreenText: "Month six changes everything", visualBrief: "Whiteboard being wiped clean, marker residue catching window light, handheld drift.", seconds: 6 as const },
    { narration: "So write the role for the company you are becoming, not the one you are.", onScreenText: "Hire for who you're becoming", visualBrief: "City street at blue hour, storefront lights coming on one by one, wide static frame.", seconds: 6 as const },
  ],
  caption: "The first hire is a bet on a company that will not exist in six months. Hire for the one you're becoming.",
  about: "An original short arguing founders should write early roles for the company they are turning into.",
  voiceover: false,
  voiceoverRationale: "Three blunt claims that land as on-screen text; a voice would slow them down.",
  language: "en-US",
};

/** Serves each bounded agent by matching the requested schema against a pool. */
function smartFakeRouter(candidates: readonly unknown[]): ModelRouter {
  return {
    async complete(_prompt, schema, policy) {
      for (const candidate of candidates) {
        const parsed = schema.safeParse({ type: "final", output: candidate });
        if (parsed.success) {
          return {
            output: parsed.data,
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
  } as ModelRouter;
}

interface StubOptions {
  config?: unknown;
  transcriptWords?: Array<{ text: string; start: number; end: number }>;
  failingGate?: string;
  /**
   * What `failingGate` reports as its offending literal(s).
   *
   * Absent means "objects, names nothing", which is a real shape a gate can
   * take and the one the sweep above relies on. Present means the gate reports
   * the span as it appears in the draft, which is what the deterministic
   * redaction floor needs to do anything at all - so a test that does not set
   * this is not testing the floor.
   */
  failingGateEvidence?: string[];
  reserveFails?: boolean;
  /**
   * Register the three tools `01c-discover-topics` needs before it can
   * propose anything (`topics.topUp`, `topics.list`, `research.pull`).
   *
   * Without them discovery returns at its first line, which is what every
   * older test in this file relies on — so it is opt-in.
   */
  discoveryTools?: boolean;
  forbiddenTopics?: string[];
  /**
   * Register `media.harvestVideo`: `true` serves, `false` finds nothing,
   * `"resolve-fails"` serves a SEARCH but cannot resolve a pasted page, and
   * `"allowlist-dry"` is the karoslabs shape — the client's own source list
   * yields nothing and an open search of the same query does.
   */
  harvestServes?: boolean | "resolve-fails" | "allowlist-dry";
  /** Register `video.findStockClip` answering success (Tier 3, the original short over stock footage, serves). `false` registers it answering not_available. */
  stockServes?: boolean;
  /** 1-based beat the stock library refuses to serve, whatever query it is asked — the "one dark beat" case, as opposed to a library that is down entirely. */
  stockMissesBeat?: number;
  /** Register `video.uploadDeliverable` (a media store is configured). */
  withUpload?: boolean;
  /** Register `video.synthesizeVoice` (a TTS provider is configured). */
  withVoice?: boolean;
  /** Register `video.visualQaGate`; `"fail"` makes it send the clip back. */
  withVisualQa?: boolean | "fail";
  /** What the visual QA reports about where the CUT falls. Absent: the model had no opinion. */
  qaMoment?: { opensOnCompleteThought: boolean; closesAfterPayoff: boolean; note: string };
  /** What this client has already published, for the dedupe check to score against. */
  outputHistory?: Array<{ runId: string; excerpt: string }>;
}

/** Records every tool call so a test can assert what did and did not happen. */
interface Harness {
  tools: AgentToolRegistry;
  calls: string[];
  /** Every `video.visualQaGate` payload, for asserting what the model was actually asked. */
  qaArgs: Array<Record<string, unknown>>;
  /** Every `media.harvestVideo` payload, for asserting which search posture a run took. */
  harvestArgs: Array<Record<string, unknown>>;
  /** Every `ledger.writeDeliverable` payload, for asserting what shipped. */
  deliverables: Array<Record<string, unknown>>;
}

function stubTools(opts: StubOptions = {}): Harness {
  const calls: string[] = [];
  const deliverables: Array<Record<string, unknown>> = [];
  const qaArgs: Array<Record<string, unknown>> = [];
  const harvestArgs: Array<Record<string, unknown>> = [];
  const ok = (result: unknown) => ({ status: "success" as const, result });
  /**
   * A gate's verdict on the text it was actually handed.
   *
   * `text` matters: a gate that keeps objecting after its own offending span
   * is gone would make the redaction floor untestable, because
   * `runCheckWithRepair` keeps a repair only when strictly fewer pieces of
   * evidence survive. A stub that never changes its mind would discard every
   * repair and the test would pass for the wrong reason.
   */
  const pass = (name: string, text?: string) => {
    if (opts.failingGate !== name) return { verdict: "pass" as const, evidence: [], toolVersion: "1.0.0" };
    const evidence = opts.failingGateEvidence ?? [];
    const stillThere = evidence.filter((span) => (text ?? "").includes(span));
    if (evidence.length > 0 && stillThere.length === 0) {
      return { verdict: "pass" as const, evidence: [], toolVersion: "1.0.0" };
    }
    return { verdict: "content_fail" as const, evidence: stillThere.length > 0 ? stillThere : evidence, reason: `${name} said no`, toolVersion: "1.0.0" };
  };

  const tool = (name: string, run: (args: never) => unknown, schema?: ZodType) => ({
    name,
    version: "1.0.0",
    inputSchema: schema ?? { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    async execute(args: never) {
      calls.push(name);
      // The fakeRenderCarousel discipline: a real tool validates its input at
      // execute, so the fake must too — a ZodError here IS the test failing.
      if (schema) schema.parse(args);
      return run(args);
    },
  });

  const config =
    opts.config === undefined
      ? { tiktokClips: { sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] }, ...(opts.forbiddenTopics ? { forbiddenTopics: opts.forbiddenTopics } : {}) }
      : opts.config;

  const tools: Record<string, unknown> = {
    "client.getConfig": tool("client.getConfig", () => ok(config)),
    "client.getVoiceRules": tool("client.getVoiceRules", () => ok({ tone: "direct" })),
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [], colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" }, handle: "acmeco" })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    "topics.reserve": tool("topics.reserve", () =>
      opts.reserveFails
        ? { status: "content_fail" as const, reason: "catalog empty" }
        : ok({ reservationKey: "res-1", topics: ["The Show ep. 12 — the margin call moment"] }),
    ),
    "topics.commit": tool("topics.commit", () => ok({ committed: true })),
    ...(opts.discoveryTools
      ? {
          "topics.topUp": tool("topics.topUp", (args) => ok({ added: (args as { topics: string[] }).topics.length, catalogSize: 4 })),
          "topics.list": tool("topics.list", () => ok({ rows: [] })),
          // `01c` skips research entirely without an industry ("no honest
          // research query to run"), and then returns before the scout for
          // want of anything to discover FROM.
          "client.getProfile": tool("client.getProfile", () => ok({ name: "Acme", industry: "B2B SaaS marketing", description: "Acme sells a CMO platform." })),
          "research.pull": tool("research.pull", () =>
            ok({ result: { documents: [{ title: "CFOs are cutting AI budgets", url: "https://example.com/cfo", description: "Three surveys this week." }] } }),
          ),
        }
      : {}),
    "topics.release": tool("topics.release", () => ok({ released: true })),
    "video.transcribe": tool("video.transcribe", () => ok({ words: opts.transcriptWords ?? transcriptWords() }), TranscribeInputSchema),
    "video.cutClip": tool("video.cutClip", (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40 }), CutClipInputSchema),
    "video.brandFrame": tool(
      "video.brandFrame",
      (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40, applied: ["bars"] }),
      BrandFrameInputSchema,
    ),
    "video.selfEvalGate": tool("video.selfEvalGate", () => ok(pass("video.selfEvalGate")), SelfEvalGateInputSchema),
    // The original-short assembler, validated against the REAL input schema
    // like every other video stub — a plate list with the wrong shape fails
    // here, not in production.
    "video.composeSequence": tool(
      "video.composeSequence",
      (args) => {
        const input = args as { outputPath: string; clips: unknown[]; voiceoverPath?: string };
        return ok({ outputPath: input.outputPath, durationSeconds: 24, clipsUsed: input.clips.length, hasVoiceover: input.voiceoverPath !== undefined });
      },
      ComposeSequenceInputSchema,
    ),
    "gate.lintPost": tool("gate.lintPost", (args) => ok(pass("gate.lintPost", (args as { text?: string }).text))),
    "gate.brandCompliance": tool("gate.brandCompliance", (args) => ok(pass("gate.brandCompliance", (args as { text?: string }).text))),
    "gate.noPlaceholder": tool("gate.noPlaceholder", (args) => ok(pass("gate.noPlaceholder", (args as { text?: string }).text))),
    "gate.leakCheck": tool("gate.leakCheck", (args) => ok(pass("gate.leakCheck", (args as { text?: string }).text))),
    "ledger.writeDeliverable": tool("ledger.writeDeliverable", (args) => {
      deliverables.push((args as { deliverable: Record<string, unknown> }).deliverable);
      return ok({ id: "deliv-1", created: true });
    }),
    "memory.appendDecision": tool("memory.appendDecision", () => ok({ id: "dec-1" })),
  };
  if (opts.harvestServes !== undefined) {
    tools["media.harvestVideo"] = tool(
      "media.harvestVideo",
      (args) => {
        harvestArgs.push(args as unknown as Record<string, unknown>);
        // A pasted page and a search are different calls on one tool, and a
        // deployment can do one and not the other — yt-dlp resolving a dead
        // or private URL is the ordinary case.
        if ((args as { sourceUrl?: string }).sourceUrl !== undefined && opts.harvestServes === "resolve-fails") {
          return { status: "content_fail" as const, reason: "the video is private or removed" };
        }
        // A sourcePool naming a show that does not exist where the harvester
        // searches. The allowlist leg comes back with nothing and the same
        // query, searched openly, finds a real podcast.
        if (opts.harvestServes === "allowlist-dry" && (args as { discovery?: string }).discovery === "allowlist") {
          return { status: "content_fail" as const, reason: "The Karos Labs Podcast: 0 result(s), 0 from another channel" };
        }
        return opts.harvestServes
          ? ok({
              path: ".media-cache/run/harvested-clip.mp4",
              sourceUrl: "https://example.com/talk",
              title: "The margin call nobody saw coming",
              channel: "Some Business Podcast",
            })
          : { status: "content_fail" as const, reason: "nothing usable found" };
      },
      HarvestVideoInputSchema,
    );
  }
  if (opts.stockServes !== undefined) {
    let stockCalls = 0;
    tools["video.findStockClip"] = tool(
      "video.findStockClip",
      (args) => {
        const input = args as { outputName: string; query: string };
        stockCalls += 1;
        // `outputName` is `plate-<beat>` / `plate-<beat>-b` / `plate-<beat>-repick`,
        // so the beat a search belongs to is readable off it — which is what
        // lets a test starve ONE beat rather than the whole library.
        if (opts.stockMissesBeat !== undefined && new RegExp(`^plate-${opts.stockMissesBeat}(\\b|-)`).test(input.outputName)) {
          return { status: "not_available" as const, reason: `nothing in the library for "${input.query}"` };
        }
        return opts.stockServes
          ? ok({ path: `.media-cache/run/${input.outputName}.mp4`, pexelsId: 1000 + stockCalls, durationSeconds: 9, width: 1080, height: 1920, sourceUrl: `https://www.pexels.com/video/${1000 + stockCalls}/`, photographer: "Someone", license: "Pexels", query: input.query })
          : { status: "not_available" as const, reason: "PEXELS_API_KEY is not set" };
      },
      FindStockClipInputSchema,
    );
  }
  if (opts.withVoice) {
    tools["video.synthesizeVoice"] = tool(
      "video.synthesizeVoice",
      (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, provider: "google", voice: "en-US-Chirp3-HD-Charon", charCount: 120, durationSeconds: 14.2 }),
      SynthesizeVoiceInputSchema,
    );
  }
  if (opts.withVisualQa) {
    tools["video.visualQaGate"] = tool(
      "video.visualQaGate",
      (args) => {
        qaArgs.push(args as unknown as Record<string, unknown>);
        const moment = opts.qaMoment !== undefined ? { moment: opts.qaMoment } : {};
        return opts.withVisualQa === "fail"
          ? ok({ verdict: "content_fail" as const, evidence: ["looksAiGenerated: obviously"], reason: "the clip obviously looks AI-generated", toolVersion: "1.5.0", ...moment })
          : ok({ verdict: "pass" as const, evidence: ["overallScore: 9"], toolVersion: "1.5.0", ...moment });
      },
      VisualQaGateInputSchema,
    );
  }
  if (opts.outputHistory !== undefined) {
    // The real tool returns `{ entries }`, not `{ excerpts }` — a fake with
    // the wrong key reads as an empty history and the test passes for the
    // wrong reason.
    tools["ledger.listOutputExcerpts"] = tool("ledger.listOutputExcerpts", () => ok({ entries: opts.outputHistory }));
  }
  if (opts.withUpload) {
    tools["video.uploadDeliverable"] = tool(
      "video.uploadDeliverable",
      (args) => ok({ gcsUri: `gs://media/${(args as { objectPath: string }).objectPath}`, signedUrl: "https://signed.example/clip.mp4" }),
      UploadDeliverableInputSchema,
    );
  }
  return { tools: tools as unknown as AgentToolRegistry, calls, qaArgs, harvestArgs, deliverables };
}

/**
 * `variant` is the D08 product split: `clipping` and `content-design` are
 * separate cards that pin what the run produces, and `auto` is the legacy
 * `tiktok-agent` that decides from whichever sourcing tier answers.
 *
 * It was not a parameter here until 2026-09-20, so every test in this file
 * ran `auto` — and `formatForVariant("auto")` returns undefined, which sent
 * all of them down the `??` fallback that reads `sourceTier`. The pin that
 * the two NAMED variants apply was therefore never executed by any test, and
 * a clipping run whose cascade landed on stock reached `08-render` in prep
 * with `videoPath: undefined`.
 */
async function run(
  harness: Harness,
  runId: string,
  input: Record<string, unknown> = {},
  candidates: unknown[] = [GOOD_MOMENT, GOOD_COMMENTARY],
  repoRoot?: string,
  variant?: "clipping" | "content-design" | "auto",
) {
  const workflow = createTikTokAgentWorkflow({
    tools: harness.tools,
    promptStore: new FilePromptStore(PROMPTS_ROOT),
    router: smartFakeRouter(candidates),
    autoApprove: true,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    ...(variant !== undefined ? { variant } : {}),
  });
  return new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
    ...PARAMS,
    runId,
    input: { sourcePath: "/tmp/episode.mp4", ...input },
  });
}

describe("tiktok-agent clip pipeline", () => {
  it("produces one credited, gated, branded clip on the happy path", async () => {
    const h = stubTools({ withUpload: true });
    const result = await run(h, "run-tt-happy");

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { deliverableId: string; lane: string; durationSeconds: number };
    expect(output.deliverableId).toBe("deliv-1");
    expect(output.lane).toBe("commentary-clip");
    expect(output.durationSeconds).toBeGreaterThanOrEqual(20);

    // The real render path ran: cut, branded frame, blocking QA, upload.
    expect(h.calls).toContain("video.cutClip");
    expect(h.calls).toContain("video.brandFrame");
    expect(h.calls).toContain("video.selfEvalGate");
    expect(h.calls).toContain("video.uploadDeliverable");

    // The deliverable carries what the portal materializer needs.
    expect(h.deliverables[0]).toMatchObject({
      sourceTier: "user-asset",
      signedUrl: "https://signed.example/clip.mp4",
      gcsUri: "gs://media/tiktok/acme/run-tt-happy/clip.mp4",
      durationSeconds: 40,
    });

    // The reservation is burned only because a clip actually shipped.
    expect(h.calls).toContain("topics.commit");
    expect(h.calls).not.toContain("topics.release");
  });

  it("still completes without an upload tool — no media store configured is not a failure", async () => {
    const h = stubTools();
    const result = await run(h, "run-tt-no-store");
    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).not.toHaveProperty("signedUrl");
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "user-asset" });
    // The client handed the file over, so the provenance says so. The
    // contrast with the harvested run below is the whole reason the field
    // exists — both were `user-asset` or `web-harvest` and told a reviewer
    // nothing about whose recording they were about to publish.
    expect(h.deliverables[0]).toMatchObject({ licenseConfidence: "client-provided" });
  });

  it("runs a client with no tiktokClips block at all when footage was handed to it — the block gates other people's shows, not the client's own recording", async () => {
    const h = stubTools({ config: {} });
    const result = await run(h, "run-tt-noconfig");

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "user-asset" });
  });

  it("still blocks intake on a tiktokClips block that is present but does not parse — someone wrote settings and got them wrong", async () => {
    const h = stubTools({ config: { tiktokClips: { sourcePool: "not-a-list", mode: "sideways" } } });
    const result = await run(h, "run-tt-badconfig");

    expect(result.status).toBe("blocked_intake");
    expect(h.calls).not.toContain("video.cutClip");
  });

  it("searches the OPEN web for a client with no sourcePool, and tells the reviewer it did (RFC-25)", async () => {
    // This test asserted the opposite until 2026-09-20: a client with no
    // sourcePool got no search at all, because which shows they may draw on
    // was a rights decision nobody had made. The owner weighed that exposure
    // and chose reach — see docs/RFC-25-tiktok-clipping-sources.md. What did
    // NOT change is that a person approves the clip before anything ships,
    // and that the reviewer is told how the footage was found.
    const h = stubTools({ config: {}, harvestServes: true, stockServes: true });
    const result = await run(h, "run-tt-nopool", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    expect(h.calls).toContain("media.harvestVideo");
    const harvest = h.harvestArgs[0]!;
    expect(harvest["discovery"]).toBe("open");
    expect(harvest["allowedSources"]).toEqual([]);
    // The catalog row is a poor query for a video search; the builder anchors it.
    expect(harvest["query"]).toContain("podcast");

    // It is a real commentary clip off harvested footage, not an original short.
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "web-harvest", format: "commentary-clip" });
    // Provenance as a FIELD, not only as a sentence inside a repair: a tier
    // name does not distinguish a show the client clears from one a search
    // found, and the portal cannot render a distinction it is not sent.
    expect(h.deliverables[0]).toMatchObject({ licenseConfidence: "unknown" });
    // …and the provenance rides on the deliverable, which outlives the gate.
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; detail: string }>;
    const provenance = repairs.find((r) => r.check === "source-discovery");
    expect(provenance?.detail).toContain("open search");
    expect(provenance?.detail).toContain("Some Business Podcast");
    expect(provenance?.detail).toContain("licenseConfidence: unknown");
  }, 20_000);

  it("keeps the ALLOWLIST posture for a client who named the shows they may clip", async () => {
    // Setting a sourcePool is how a client opts back out of open discovery,
    // with no code change — RFC-25 §4. A client who has told us which shows
    // they may clip has made a statement about rights, and an open search
    // would quietly widen it.
    const h = stubTools({ harvestServes: true, stockServes: true });
    const result = await run(h, "run-tt-withpool", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    const harvest = h.harvestArgs[0]!;
    expect(harvest["discovery"]).toBe("allowlist");
    expect(harvest["allowedSources"]).toEqual(["The Show"]);
    // Inside an allowlist search the show name does the narrowing, so the raw
    // topic is the better query and the anchor would only starve it.
    expect(harvest["query"]).not.toContain("podcast");
    // No provenance note: nothing here needs explaining to a reviewer.
    const repairs = (h.deliverables[0]!["contentRepairs"] as Array<{ check: string }> | undefined) ?? [];
    expect(repairs.map((r) => r.check)).not.toContain("source-discovery");
  }, 20_000);

  it("with footage in hand, an empty catalog is a missing hint, not a missing subject: the topic is named from the recording", async () => {
    const h = stubTools({ reserveFails: true });
    const result = await run(h, "run-tt-nocandidate-footage", {}, [{ ...GOOD_MOMENT, topicLabel: "why the margin call was the real story" }, GOOD_COMMENTARY]);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { topic: string; topicSource: string };
    expect(output.topicSource).toBe("footage");
    expect(output.topic).toBe("why the margin call was the real story");
    // Nothing was reserved, so nothing is committed or released — and no
    // research was run to invent a subject the footage already had.
    expect(h.calls).not.toContain("topics.commit");
    expect(h.calls).not.toContain("research.pull");
  });

  it("holds only when there is nothing left to widen to, and says what to add", async () => {
    // REVERSED 2026-09-21. This asserted the hold whenever the lane was
    // empty, quoting the legacy loop: "a run with no candidate logs that fact
    // and exits cleanly. It never lowers the bar to ship something." The
    // 2026-09-17 ruling supersedes that and names this case — "no candidate
    // topic → widen and deliver annotated".
    //
    // The hold that REMAINS is the carve-out: no catalog, no footage, no
    // research, no intel and no content pillars means the run knows nothing
    // about this client to be about. That is "nobody to write for", and the
    // reason now names the thing a person can add.
    const h = stubTools({ reserveFails: true, harvestServes: true });
    const result = await run(h, "run-tt-nocandidate", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("nothing to widen to");
    expect(result.reason).toContain("add a content pillar");
    // Still refused before spending anything: no search, no cut.
    expect(h.calls).not.toContain("media.harvestVideo");
    expect(h.calls).not.toContain("video.cutClip");
  });

  it("holds on a silent source only when the run has no topic to write over it (2026-09-10), and says what to add", async () => {
    // No catalog topic and no typed one: the attached footage IS the topic, and a silent file has none to give.
    const h = stubTools({ transcriptWords: [], reserveFails: true });
    const result = await run(h, "run-tt-silent-no-topic");
    expect(result.status).toBe("held");
    expect(JSON.stringify(result)).toContain("no spoken words");
    expect(JSON.stringify(result)).toContain("requestedTopic");
  });

  it("a silent source WITH a topic is no longer a hold: the run keeps its reservation and goes on as an original short over the client's footage", async () => {
    // This harness stubs the commentary lane only, so the original-short lane
    // cannot finish here; what this proves is the decision — no hold, no
    // release — which is where the audit's two silent-footage runs died.
    const h = stubTools({ transcriptWords: [] });
    const result = await run(h, "run-tt-silent-with-topic");
    expect(result.status).not.toBe("held");
    expect(JSON.stringify(result)).not.toContain("no spoken words");
    expect(h.calls).toContain("video.transcribe");
  });

  it("cuts the densest legal window when the picked moment is too short, rather than ending the run", async () => {
    // The owner's always-deliver rule (2026-09-17). A three-second proposal is
    // a bad PROPOSAL, not an unusable recording: the transcript is in hand and
    // paid for, and some run of whole sentences in it is a legal clip.
    const h = stubTools();
    const result = await run(h, "run-tt-short", {}, [{ ...GOOD_MOMENT, startSeconds: 10, endSeconds: 13 }, GOOD_COMMENTARY]);

    expect(result.status).toBe("completed");
    expect(h.calls).toContain("video.cutClip");
    expect(h.calls).not.toContain("topics.release");
    // …and the client is told the cut was chosen by code, not picked.
    const repairs = h.deliverables[0]?.["contentRepairs"] as Array<{ check: string; action: string }> | undefined;
    expect(repairs?.map((r) => r.check)).toContain("moment-selection");
    expect(h.deliverables[0]?.["momentFallback"]).toMatch(/not clippable/);
  });

  it("appends the source credit the caption forgot instead of refusing the clip", async () => {
    // The one failure here with a party outside this system — which is exactly
    // why it is repaired rather than held on. The rule protects the person
    // whose footage this is, and a dead run protects them no better than a
    // credited caption while costing the client the clip.
    const h = stubTools();
    const result = await run(h, "run-tt-uncredited", {}, [
      GOOD_MOMENT,
      { ...GOOD_COMMENTARY, caption: "Our read on this: the number is right and the conclusion is wrong." },
    ]);

    expect(result.status).toBe("completed");
    expect(h.calls).toContain("video.cutClip");
    expect(h.deliverables[0]?.["caption"]).toContain("Jane Doe on The Show ep. 12");
    const repairs = h.deliverables[0]?.["contentRepairs"] as Array<{ check: string; action: string }>;
    expect(repairs.find((r) => r.check === "source-credit")?.action).toBe("rewritten");
  });

  it.each([
    ["gate.lintPost"],
    ["gate.brandCompliance"],
    ["gate.noPlaceholder"],
    ["gate.leakCheck"],
  ])("delivers the clip flagged when %s objects, instead of holding the run", async (gate) => {
    const h = stubTools({ failingGate: gate });
    const result = await run(h, `run-tt-${gate.replace(".", "-")}`);

    // These four are quality events, not faults (RFC-19's carve-out): the
    // client gets the clip, carrying the gate's own sentence.
    expect(result.status).toBe("completed");
    expect(h.calls).not.toContain("topics.release");
    expect(h.calls).toContain("video.cutClip");
    const repairs = h.deliverables[0]?.["contentRepairs"] as Array<{ check: string; action: string; detail: string }>;
    // This harness's gates object with NO evidence here, so there is no span
    // to redact and the honest end of the ladder is `unresolved` — delivered,
    // and said so. A gate that names its spans redacts instead; see
    // "redacts the sentence carrying a flagged span" below.
    const objection = repairs.find((r) => r.check === "tiktok-text-gates");
    expect(objection?.action).toBe("unresolved");
    expect(objection?.detail).toContain(gate);
  });

  it("delivers the clip flagged when the bitstream QA video.selfEvalGate objects", async () => {
    const h = stubTools({ failingGate: "video.selfEvalGate" });
    const result = await run(h, "run-tt-video-selfEvalGate");

    // A file this gate dislikes, that a person can watch, beats no file and a
    // sentence — and the gate has no authority a reviewer watching the same
    // clip lacks.
    expect(result.status).toBe("completed");
    expect(h.calls).toContain("ledger.writeDeliverable");
    const repairs = h.deliverables[0]?.["contentRepairs"] as Array<{ check: string; action: string }>;
    expect(repairs.find((r) => r.check === "video.selfEvalGate")?.action).toBe("unresolved");
  });

  it("always persists a deliverable, and always says what it had to repair", async () => {
    // The inverse of the property this test used to assert. Swept across every
    // gate rather than asserted once: the property is that no single failing
    // content gate has a path to a run that ends with nothing in the client's
    // hands, and that none of them ships silently either.
    for (const gate of ["gate.lintPost", "gate.leakCheck", "video.selfEvalGate"]) {
      const h = stubTools({ failingGate: gate });
      const result = await run(h, `run-tt-sweep-${gate.replace(".", "-")}`);
      expect(result.status, gate).toBe("completed");
      expect(h.calls, gate).toContain("ledger.writeDeliverable");
      expect(h.calls, gate).toContain("topics.commit");
      expect((h.deliverables[0]?.["contentRepairs"] as unknown[] | undefined)?.length, gate).toBeGreaterThan(0);
    }
  });

  it("redacts the sentence carrying a flagged span and ships the rest of the caption", async () => {
    // The floor doing real work, as opposed to the `unresolved` end of the
    // ladder the sweep above exercises. `gate.brandCompliance` names the
    // offending literal, the sentence carrying it goes, the sentence that does
    // not is kept verbatim, and the gate then passes — so the repair is
    // recorded `redacted`, not `unresolved`.
    const h = stubTools({ failingGate: "gate.brandCompliance", failingGateEvidence: ["world-class"] });
    const result = await run(h, "run-tt-redact", {}, [
      GOOD_MOMENT,
      {
        ...GOOD_COMMENTARY,
        caption: "Our read on this: the number is right and the conclusion is wrong. This is world-class analysis. Via Jane Doe on The Show ep. 12.",
      },
    ]);

    expect(result.status).toBe("completed");
    const caption = h.deliverables[0]?.["caption"] as string;
    expect(caption).not.toContain("world-class");
    expect(caption).toContain("the number is right and the conclusion is wrong");
    // …and the credit survived the redaction, because it was in its own sentence.
    expect(caption).toContain("Jane Doe on The Show ep. 12");
    const repairs = h.deliverables[0]?.["contentRepairs"] as Array<{ check: string; action: string; detail: string }>;
    const redaction = repairs.find((r) => r.check === "tiktok-text-gates");
    expect(redaction?.action).toBe("redacted");
    expect(redaction?.detail).toContain("world-class");
  });

  it("keeps a field the floor would empty, and records the objection unresolved", async () => {
    // A caption is a required field. When every sentence in it carries the
    // flagged span there is nothing to keep, and an empty caption is a broken
    // deliverable rather than a repaired one — so the original stands and the
    // gate's objection rides to the reviewer instead. This is the asymmetry
    // that stops "always deliver" from turning into "deliver anything".
    const h = stubTools({ failingGate: "gate.leakCheck", failingGateEvidence: ["Our read"] });
    const result = await run(h, "run-tt-would-empty", {}, [
      GOOD_MOMENT,
      { ...GOOD_COMMENTARY, caption: "Our read.", about: "Our read." },
    ]);

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]?.["caption"]).toContain("Our read");
    const repairs = h.deliverables[0]?.["contentRepairs"] as Array<{ check: string; action: string }>;
    expect(repairs.find((r) => r.check === "tiktok-text-gates")?.action).toBe("unresolved");
  });

  it("attaches no repair ledger at all to a clean run", async () => {
    // The asymmetry that keeps the marker readable: absent, never empty. A
    // ledger attached unconditionally is the silent-degradation failure in
    // reverse — shouting `repaired` at every clean clip until nobody reads it.
    const h = stubTools();
    const result = await run(h, "run-tt-clean-no-ledger");

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).not.toHaveProperty("contentRepairs");
    expect(h.deliverables[0]).not.toHaveProperty("momentFallback");
  });

  it("runs the terminal topic guardrail before the human ever sees the clip", async () => {
    const h = stubTools({ forbiddenTopics: ["cryptocurrency"] });
    const result = await run(h, "run-tt-guardrail", {}, [GOOD_MOMENT, GOOD_COMMENTARY, { violatedTopics: [] }]);

    expect(result.status).toBe("completed");
  });

  it("fails the run when the guardrail finds the clip engages a forbidden topic", async () => {
    // A clip of someone ELSE saying it is still the client's account saying it.
    const h = stubTools({ forbiddenTopics: ["cryptocurrency"] });
    const result = await run(h, "run-tt-violation", {}, [
      GOOD_MOMENT,
      GOOD_COMMENTARY,
      { violatedTopics: ["cryptocurrency"] },
    ]);

    expect(result.status).not.toBe("completed");
    expect(h.calls).not.toContain("ledger.writeDeliverable");
    expect(h.calls).toContain("topics.release");
  });

  it("ingests an attached episode and transcribes the ingested file, not its URI", async () => {
    // What the portal's upload surface sends: a gs:// object, not a local path.
    //
    // The URI must NOT reach the video tools. `video.transcribe` does a plain
    // readFile on whatever it is handed, so forwarding the URI fails with
    // ENOENT three steps later and blames the transcriber for the caller's
    // format. This asserts the substitution actually happened.
    const h = stubTools();
    const transcribedPaths: string[] = [];
    const tools = {
      ...(h.tools as unknown as Record<string, unknown>),
      "media.ingestAssets": {
        name: "media.ingestAssets",
        version: "1.0.0",
        inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
        async execute(args: unknown) {
          const input = args as { kind?: string; assets: Array<{ uri: string; slot: number }> };
          // The clip pipeline needs the video tables and the video ceiling; the
          // image ones would refuse a real episode twice over.
          expect(input.kind).toBe("video");
          expect(input.assets).toEqual([{ uri: "gs://bucket/episode-12.mp4", slot: 1 }]);
          return { status: "success" as const, result: { candidates: [{ path: ".media-cache/run-tt-asset/n1-client0.mp4" }], unmet: [] } };
        },
      },
      "video.transcribe": {
        name: "video.transcribe",
        version: "1.0.0",
        inputSchema: TranscribeInputSchema,
        async execute(args: unknown) {
          transcribedPaths.push(TranscribeInputSchema.parse(args).videoPath);
          return { status: "success" as const, result: { words: transcriptWords() } };
        },
      },
    };

    const workflow = createTikTokAgentWorkflow({
      tools: tools as unknown as AgentToolRegistry,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router: smartFakeRouter([GOOD_MOMENT, GOOD_COMMENTARY]),
      autoApprove: true,
      repoRoot: "/srv/workspace",
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
      ...PARAMS,
      runId: "run-tt-asset",
      input: { mediaAssets: [{ uri: "gs://bucket/episode-12.mp4", role: "source" }] },
    });

    expect(result.status).toBe("completed");
    // Absolute, because the video tools resolve against the process cwd rather
    // than the agent workspace — the ingester returns the repo-relative form
    // every renderer wants, and the join happens in the workflow.
    expect(transcribedPaths[0]).not.toContain("gs://");
    expect(transcribedPaths[0]).toMatch(/n1-client0\.mp4$/);
    expect(transcribedPaths[0]!.startsWith("/srv/workspace") || /^[A-Za-z]:/.test(transcribedPaths[0]!)).toBe(true);
  }, 20_000);

  it("blocks an attached episode this deployment cannot ingest, instead of failing at the transcriber", async () => {
    // No repoRoot and no ingester: the previous behaviour handed the gs:// URI
    // to `video.transcribe` and got an ENOENT several steps in. Refusing at
    // intake says what is actually wrong, and says it before spending anything.
    const h = stubTools();
    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router: smartFakeRouter([GOOD_MOMENT, GOOD_COMMENTARY]),
      autoApprove: true,
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
      ...PARAMS,
      runId: "run-tt-no-ingest",
      input: { mediaAssets: [{ uri: "gs://bucket/episode-12.mp4", role: "source" }] },
    });

    expect(result.status).toBe("blocked_intake");
    expect(h.calls).not.toContain("video.transcribe");
  });

  // ── "Only media I upload for this job" (mediaSource: "client", 2026-09-06) ──

  it("client media only with no footage: refuses intake before the topic claim, naming the missing episode", async () => {
    const h = stubTools({ harvestServes: true, stockServes: true });
    const result = await run(h, "run-tt-client-only-empty", { mediaSource: "client", sourcePath: undefined });
    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/client-provided media only, but no source video was attached/);
    // Nothing downstream was touched: no reservation burned, no harvest, no generation, no transcript.
    for (const tool of ["topics.reserve", "media.harvestVideo", "video.findStockClip", "video.transcribe"]) {
      expect(h.calls, tool).not.toContain(tool);
    }
  });

  it("client media only with footage in hand: the user-asset tier serves and the run completes exactly as before", async () => {
    const h = stubTools({ harvestServes: true, stockServes: true });
    const result = await run(h, "run-tt-client-only-footage", { mediaSource: "client" });
    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "user-asset" });
    expect(h.calls).not.toContain("media.harvestVideo");
    expect(h.calls).not.toContain("video.findStockClip");
  }, 20_000);

  it("still takes a plain sourcePath, which needs no ingest at all", async () => {
    // The path every hand-rolled and scheduled dispatch uses. Adding the upload
    // surface must not have made repoRoot a requirement for it.
    const h = stubTools();
    const result = await run(h, "run-tt-plain-path");
    expect(result.status).toBe("completed");
  }, 20_000);

  it("uses a typed custom prompt as the run's direction", async () => {
    const h = stubTools();
    const result = await run(h, "run-tt-prompt", { customPrompt: "the bit where she disagrees about pricing" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect((result.output as { topic: string }).topic).toBe("the bit where she disagrees about pricing");
    // A typed direction means the catalog is not consulted at all.
    expect(h.calls).not.toContain("topics.reserve");
  }, 20_000);

  it("prefers an explicitly requested moment over the catalog", async () => {
    const h = stubTools();
    const result = await run(h, "run-tt-requested", { requestedTopic: "the bit about margin calls" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect((result.output as { topic: string }).topic).toBe("the bit about margin calls");
    // Nothing was reserved, so there is nothing to commit or release.
    expect(h.calls).not.toContain("topics.reserve");
    expect(h.calls).not.toContain("topics.commit");
  });
});

describe("tiered source cascade", () => {
  const REPO_ROOT = os.tmpdir();

  it("Tier 2a: with no attached asset, ingests the first owned-footage URI from the sourcePool", async () => {
    const h = stubTools({
      config: { tiktokClips: { sourcePool: ["The Show", "https://cdn.acme.co/keynote-2026.mp4"], guestWatchlist: [], narrowing: [] } },
    });
    const ingested: string[] = [];
    (h.tools as unknown as Record<string, unknown>)["media.ingestAssets"] = {
      name: "media.ingestAssets",
      version: "1.0.0",
      inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
      async execute(args: unknown) {
        ingested.push((args as { assets: Array<{ uri: string }> }).assets[0]!.uri);
        return { status: "success" as const, result: { candidates: [{ path: ".media-cache/run-tt-pool/n1-client0.mp4" }], unmet: [] } };
      },
    };
    const result = await run(h, "run-tt-pool", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("completed");
    expect(ingested).toEqual(["https://cdn.acme.co/keynote-2026.mp4"]);
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "owned-footage" });
  }, 20_000);

  it("Tier 2b: falls through to a web harvest when the pool holds no footage URIs, confined to the shows in the pool", async () => {
    const h = stubTools({ harvestServes: true });
    let harvestArgs: Record<string, unknown> | undefined;
    const original = (h.tools as unknown as Record<string, { execute: (a: never, c: never) => unknown }>)["media.harvestVideo"]!;
    (h.tools as unknown as Record<string, unknown>)["media.harvestVideo"] = {
      ...original,
      async execute(args: never, callCtx: never) {
        harvestArgs = HarvestVideoInputSchema.parse(args) as unknown as Record<string, unknown>;
        return original.execute(args, callCtx);
      },
    };
    const result = await run(h, "run-tt-harvest", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("completed");
    expect(h.calls).toContain("media.harvestVideo");
    // The rights scope travels with the query: only the pool's shows.
    expect(harvestArgs!["allowedSources"]).toEqual(["The Show"]);
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "web-harvest", sourceContext: { url: "https://example.com/talk" } });
  }, 20_000);

  it("Tier 3: nothing to clip becomes an original short — a script, one stock plate per beat, no transcript, no cut", async () => {
    const h = stubTools({ harvestServes: false, stockServes: true });
    const result = await run(h, "run-tt-stock", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // No speech to mine: nothing to transcribe, no moment agent, no cut. The
    // plates are assembled, framed and gated like any other clip.
    expect(h.calls).not.toContain("video.transcribe");
    expect(h.calls).not.toContain("video.cutClip");
    // One search per beat, plus a second shot for each beat of six seconds or more (two of the three).
    expect(h.calls.filter((c) => c === "video.findStockClip")).toHaveLength(GOOD_SCRIPT.beats.length + 2);
    expect(h.calls).toContain("video.composeSequence");
    expect(h.calls).toContain("video.brandFrame");
    expect(h.calls).toContain("video.selfEvalGate");
    // The script said "silent", the client's config said "auto": no voice.
    expect(h.calls).not.toContain("video.synthesizeVoice");
    const output = result.output as { format: string; voiceover: boolean; script?: { beats: unknown[] } };
    expect(output.format).toBe("original-short");
    expect(output.voiceover).toBe(false);
    expect(output.script?.beats).toHaveLength(3);
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "stock", format: "original-short", voiceover: false });
    // The cost facts travel with the deliverable: what it cost, what the plan was priced at, and the ceiling.
    expect(typeof (h.deliverables[0] as { costSoFarUsd?: unknown }).costSoFarUsd).toBe("number");
    expect(typeof (h.deliverables[0] as { estimatedCostUsd?: unknown }).estimatedCostUsd).toBe("number");
    expect(h.deliverables[0]).toMatchObject({ maxCostUsd: 2 });
    // An original short has no one else's words in it, so no source credit.
    expect(h.deliverables[0]).not.toHaveProperty("sourceCredit");
  }, 20_000);

  it("holds honestly when every tier is dry, naming each tier's outcome, and releases the moment", async () => {
    // Harvest answers empty and the stock library is not wired at all: the
    // cascade has nowhere left to go.
    const h = stubTools({ harvestServes: false });
    const result = await run(h, "run-tt-dry", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    for (const tier of ["user-asset", "owned-footage", "web-harvest", "stock"]) {
      expect(result.reason).toContain(tier);
    }
    // The moment goes back — a dry cascade must not burn it.
    expect(h.calls).toContain("topics.release");
  });

  it("reports a tooling failure, not a content verdict, when NOTHING can picture any beat", async () => {
    // The end of the ladder, and the one branch the always-deliver rule does
    // not reach: the library cannot serve, no still may be bought and the free
    // text plate is not registered either, so there is no picture anywhere in
    // the short and nothing to stand in for anything. That is RFC-19's
    // carve-out #3 — a genuine tooling failure where no output exists at all —
    // and it names which tools are missing rather than blaming the beat.
    const h = stubTools({ harvestServes: false, stockServes: false });
    const result = await run(h, "run-tt-stock-down", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("unreachable");
    expect(result.failureReason).toContain("no plate could be made for any");
    expect(result.failureReason).toContain("video.textPlate is not registered");
    expect(h.calls).toContain("topics.release");
    expect(h.calls).not.toContain("ledger.writeDeliverable");
  }, 20_000);

  it("stands a neighbouring shot in for the ONE beat nothing could picture, and ships", async () => {
    // The same failure, one beat instead of all of them: the library answers
    // for beats 1 and 3 and misses beat 2. A repeated shot is a worse short;
    // no short is no deliverable, and the owner's rule settles which we ship.
    const h = stubTools({ harvestServes: false, stockServes: true, stockMissesBeat: 2 });
    const result = await run(h, "run-tt-one-beat-dark", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("completed");
    const repairs = h.deliverables[0]?.["contentRepairs"] as Array<{ check: string; action: string; detail: string }>;
    const stood = repairs.find((r) => r.check === "beat-footage");
    expect(stood?.action).toBe("substituted");
    expect(stood?.detail).toContain("beat 2");
    expect(stood?.detail).toContain("beat 1");
  }, 20_000);

  it("mode \"commentary\" prefers not to generate, and delivers anyway when there is nothing to clip", async () => {
    // REVERSED 2026-09-20. This test used to assert the run HELD here, and
    // the workflow comment beneath the throw called that hold "honest". It
    // was honest and it was still wrong: the owner's standing ruling
    // (2026-09-17) is that an agent never ends a run with no deliverable, and
    // it names this shape explicitly — a domain-level dead end is "fall back
    // and annotate", not one of the three carve-outs. A held clipping run
    // bills a client an error message in place of the work.
    //
    // The mode still means something. It is tried first, it is only
    // abandoned once every clippable tier is dry, and the substitution is
    // announced (see the `clip-mode` repair below). What it is no longer is
    // a reason to ship nothing.
    const h = stubTools({
      config: { tiktokClips: { mode: "commentary", sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] } },
      harvestServes: false,
      stockServes: true,
    });
    const result = await run(h, "run-tt-commentary-only", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "stock", format: "original-short" });
    expect(h.calls).toContain("video.findStockClip");
  }, 20_000);

  it("mode \"original\" never touches anyone else's footage: no harvest, straight to a scripted short", async () => {
    const h = stubTools({
      config: { tiktokClips: { mode: "original", sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] } },
      harvestServes: true,
      stockServes: true,
    });
    const result = await run(h, "run-tt-original-only", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("completed");
    expect(h.calls).not.toContain("media.harvestVideo");
    expect(h.deliverables[0]).toMatchObject({ format: "original-short" });
  }, 20_000);

  it("holds with every tier named even when the video tiers are not wired at all", async () => {
    // No repoRoot, no harvest/generate tools: the pre-cascade deployment shape.
    const h = stubTools();
    const result = await run(h, "run-tt-unwired", { sourcePath: undefined });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("web-harvest: not wired");
    expect(result.reason).toContain("stock: not wired");
  });
});

describe("branded frame inputs", () => {
  it("feeds the client's brand into video.brandFrame and burns captions from the clip's own words", async () => {
    const h = stubTools();
    let frameArgs: Record<string, unknown> | undefined;
    const original = (h.tools as unknown as Record<string, { execute: (a: never, c: never) => unknown }>)["video.brandFrame"]!;
    (h.tools as unknown as Record<string, unknown>)["video.brandFrame"] = {
      ...original,
      async execute(args: never, callCtx: never) {
        frameArgs = BrandFrameInputSchema.parse(args) as unknown as Record<string, unknown>;
        return original.execute(args, callCtx);
      },
    };
    const result = await run(h, "run-tt-brand");

    expect(result.status).toBe("completed");
    expect(frameArgs).toBeDefined();
    const brand = frameArgs!["brand"] as Record<string, unknown>;
    expect(brand["ground"]).toBe("#101418");
    expect(brand["fg"]).toBe("#F2F0EA");
    expect(brand["handle"]).toBe("@acmeco");
    // The clip window is GOOD_MOMENT's 10s-50s, so the captions must carry the
    // words that actually fall inside it and none from outside. Derived from
    // the fixture's own rate rather than hard-coded: a literal "word10." was
    // silently describing a one-word-a-second transcript, and quietly became
    // wrong the moment the fixture started producing real speech.
    expect(typeof frameArgs!["srtPath"]).toBe("string");
    const srt = await fs.readFile(frameArgs!["srtPath"] as string, "utf8");
    expect(srt).toContain(`word${10 * WORDS_PER_SECOND}.`);
    expect(srt).not.toContain(`word${10 * WORDS_PER_SECOND - 2}.`);
    expect(srt).toContain(" --> ");
  });

  it("falls back to the default grounds when the client has no brand colors — furniture never holds a run", async () => {
    const h = stubTools();
    (h.tools as unknown as Record<string, unknown>)["client.getBrand"] = {
      name: "client.getBrand",
      version: "1.0.0",
      inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
      async execute() {
        return { status: "not_available" as const, reason: "no brand.json yet" };
      },
    };
    let frameArgs: Record<string, unknown> | undefined;
    const original = (h.tools as unknown as Record<string, { execute: (a: never, c: never) => unknown }>)["video.brandFrame"]!;
    (h.tools as unknown as Record<string, unknown>)["video.brandFrame"] = {
      ...original,
      async execute(args: never, callCtx: never) {
        frameArgs = BrandFrameInputSchema.parse(args) as unknown as Record<string, unknown>;
        return original.execute(args, callCtx);
      },
    };
    const result = await run(h, "run-tt-nobrand");

    expect(result.status).toBe("completed");
    const brand = frameArgs!["brand"] as Record<string, unknown>;
    expect(brand["ground"]).toBe("#17181C");
    expect(brand["fg"]).toBe("#F4F2EC");
    expect(brand["handle"]).toBeUndefined();
  });

  /**
   * AU38 (SCRUM-322) — the video cover's logo gets the same enforced
   * contrast the carousel's does, against the bar color it actually lands on.
   *
   * Two solid 16x16 RGBA PNGs, encoded for these tests, so the decoded ink is
   * exactly `#000000` / `#FFFFFF` and the ratio against this client's
   * `#101418` bars is a number this test recomputes from the published WCAG
   * formula rather than reading back off the implementation.
   */
  const BLACK_MARK = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVR4nGNgYGD4TyEeNWDUgFEDhocBAJvM/wGi6G+mAAAAAElFTkSuQmCC";
  const WHITE_MARK = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg==";

  async function frameBrandForLogo(runId: string, markBase64: string): Promise<Record<string, unknown>> {
    const h = stubTools();
    (h.tools as unknown as Record<string, unknown>)["client.getBrand"] = {
      name: "client.getBrand",
      version: "1.0.0",
      inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
      async execute() {
        return {
          status: "success" as const,
          result: { colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" }, logoUrl: "https://logos.example/mark.png" },
        };
      },
    };
    let frameArgs: Record<string, unknown> | undefined;
    const original = (h.tools as unknown as Record<string, { execute: (a: never, c: never) => unknown }>)["video.brandFrame"]!;
    (h.tools as unknown as Record<string, unknown>)["video.brandFrame"] = {
      ...original,
      async execute(args: never, callCtx: never) {
        frameArgs = BrandFrameInputSchema.parse(args) as unknown as Record<string, unknown>;
        return original.execute(args, callCtx);
      },
    };
    const bytes = Buffer.from(markBase64, "base64");
    const fetchImpl = (async () => ({
      ok: true,
      headers: { get: (n: string) => (n === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })) as unknown as typeof fetch;

    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router: smartFakeRouter([GOOD_MOMENT, GOOD_COMMENTARY]),
      autoApprove: true,
      fetchImpl,
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
      ...PARAMS,
      runId,
      input: { sourcePath: "/tmp/episode.mp4" },
    });
    expect(result.status).toBe("completed");
    expect(frameArgs, "video.brandFrame must have been called").toBeDefined();
    return frameArgs!["brand"] as Record<string, unknown>;
  }

  /**
   * SCRUM-383's other half.
   *
   * instagram-agent fixed this in `brand-render-tokens.ts` and its comment
   * cites tiktok's own derivation as the precedent — true of the accept rule
   * ("only https://"), and not of the diagnostic. So a client whose BrandKit
   * carried a `gs://` logoUrl got a cover with no logo, no error, no held run
   * and nothing in the trace: indistinguishable from a client who never
   * configured a logo at all.
   */
  async function videoBrandStepOutput(runId: string, brandResult: Record<string, unknown>): Promise<Record<string, unknown>> {
    const h = stubTools();
    (h.tools as unknown as Record<string, unknown>)["client.getBrand"] = {
      name: "client.getBrand",
      version: "1.0.0",
      inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
      async execute() {
        return { status: "success" as const, result: brandResult };
      },
    };
    const store = new MemoryDurableStepStore();
    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router: smartFakeRouter([GOOD_MOMENT, GOOD_COMMENTARY]),
      autoApprove: true,
    });
    const result = await new WorkflowEngine(store).run(workflow, {
      ...PARAMS,
      runId,
      input: { sourcePath: "/tmp/episode.mp4" },
    });
    expect(result.status).toBe("completed");
    const step = (await store.listSteps(runId)).find((s) => s.stepId === "07b-load-video-brand");
    expect(step, "07b-load-video-brand must have run").toBeDefined();
    return step!.output as Record<string, unknown>;
  }

  it("records WHY it dropped a gs:// logo instead of looking like a client with no logo", async () => {
    const brand = await videoBrandStepOutput("run-tt-logo-gs", {
      colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" },
      logoUrl: "gs://karos-brand-assets/acme/logo.svg",
    });

    // No logo is still the outcome — brand furniture never holds a run.
    expect(brand["logoUrl"]).toBeUndefined();
    // But the reason is now a fact in the trace, and it names the URL, so the
    // thing to fix is readable off the run rather than guessed at.
    expect(brand["rejectedLogoUrlReason"]).toContain("gs://karos-brand-assets/acme/logo.svg");
    expect(brand["rejectedLogoUrlReason"]).toContain("https://");
  });

  it("says nothing when there is nothing to say — a good logo and no logo both leave the field unset", async () => {
    // The distinction only means something if it is absent in the ordinary
    // cases. A reason on every run is a reason nobody reads.
    const good = await videoBrandStepOutput("run-tt-logo-ok", {
      colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" },
      logoUrl: "https://logos.example/mark.png",
    });
    expect(good["logoUrl"]).toBe("https://logos.example/mark.png");
    expect(good["rejectedLogoUrlReason"]).toBeUndefined();

    const none = await videoBrandStepOutput("run-tt-logo-none", {
      colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" },
    });
    expect(none["logoUrl"]).toBeUndefined();
    expect(none["rejectedLogoUrlReason"]).toBeUndefined();
  });

  it("leaves a javascript: logoUrl failing exactly the way it always has", async () => {
    // Scoped to gs:// on purpose, the same scoping SCRUM-383 chose: a
    // javascript:/file:// value is not a BrandKit misconfiguration anybody
    // makes, and widening the "loud" class is a different change from this one.
    const brand = await videoBrandStepOutput("run-tt-logo-js", {
      colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" },
      logoUrl: "javascript:alert(1)",
    });
    expect(brand["logoUrl"]).toBeUndefined();
    expect(brand["rejectedLogoUrlReason"]).toBeUndefined();
  });

  it("overlays a mark that clears the floor on the bar with no plate behind it", async () => {
    expect(contrastRatio("#FFFFFF", "#101418")).toBeGreaterThanOrEqual(BRAND_LOGO_CONTRAST_FLOOR);
    const brand = await frameBrandForLogo("run-tt-logo-legible", WHITE_MARK);
    expect(typeof brand["logoPath"]).toBe("string");
    expect(brand["logoScrim"]).toBeUndefined();
  });

  it("CATCHES a mark that would vanish into the bar and hands the compositor a verified plate", async () => {
    // The plant, as a real number: a black mark on #101418 bars is 1.14:1.
    const measured = contrastRatio("#000000", "#101418");
    expect(measured).toBeCloseTo(1.14, 2);
    expect(measured).toBeLessThan(BRAND_LOGO_CONTRAST_FLOOR);

    const brand = await frameBrandForLogo("run-tt-logo-illegible", BLACK_MARK);
    expect(typeof brand["logoPath"]).toBe("string");
    // The kit's own fg, chosen because the mark demonstrably clears the floor
    // against it — not because it is a nice color.
    expect(brand["logoScrim"]).toBe("#F2F0EA");
    expect(contrastRatio("#000000", brand["logoScrim"] as string)).toBeGreaterThanOrEqual(BRAND_LOGO_CONTRAST_FLOOR);
  });
});

/**
 * The watchability floor, in the workflow (2026-09-18).
 *
 * The measures themselves are unit-tested in `moment-floor.test.ts`. What is
 * pinned here is what the run DOES with a refusal: re-pick in code, never
 * hold, and tell the reviewer either way.
 */
describe("moment floor", () => {
  /** A transcript with a dead first half and real speech in the second. */
  function lopsidedTranscript(): Array<{ text: string; start: number; end: number }> {
    const sparse = Array.from({ length: 30 }, (_, i) => ({ text: `slow${i}.`, start: i * 1.4, end: i * 1.4 + 0.3 }));
    const dense = Array.from({ length: 150 }, (_, i) => ({ text: `fast${i}.`, start: 45 + i / 3, end: 45 + (i + 1) / 3 }));
    return [...sparse, ...dense];
  }

  it("re-picks in code when the model chose a window that is mostly silence", async () => {
    const h = stubTools({ transcriptWords: lopsidedTranscript() });
    // The model points at the dead half: 0-42s at well under a word a second.
    const result = await run(h, "run-tt-floor-repick", {}, [{ ...GOOD_MOMENT, startSeconds: 0, endSeconds: 42 }, GOOD_COMMENTARY]);

    expect(result.status).toBe("completed");
    const cut = h.deliverables[0]!;
    // The cut that shipped is the dense half, not the one that was picked.
    expect(cut["momentFallback"]).toContain("watchability floor");
    const repairs = cut["contentRepairs"] as Array<{ check: string; action: string }>;
    expect(repairs.find((r) => r.check === "moment-selection")?.action).toBe("substituted");
  }, 20_000);

  it("keeps the model's choice when nothing in the transcript scores better, and flags it", async () => {
    // A recording that is sparse end to end. There is no better window, so
    // the model's judgment stands — code does not override a human-shaped
    // decision with a density number when it has nothing better to offer —
    // and the reviewer is told exactly what is wrong with what they are
    // about to watch.
    const sparse = Array.from({ length: 40 }, (_, i) => ({ text: `slow${i}.`, start: i * 2, end: i * 2 + 0.4 }));
    const h = stubTools({ transcriptWords: sparse });
    const result = await run(h, "run-tt-floor-nothing-better", {}, [{ ...GOOD_MOMENT, startSeconds: 0, endSeconds: 60 }, GOOD_COMMENTARY]);

    expect(result.status).toBe("completed");
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; action: string; detail: string }>;
    const flagged = repairs.find((r) => r.check === "moment-floor");
    expect(flagged?.action).toBe("unresolved");
    expect(flagged?.detail).toContain("a second");
    expect(h.deliverables[0]).not.toHaveProperty("momentFallback");
  }, 20_000);

  it("says nothing on an ordinary dense clip", async () => {
    const h = stubTools();
    await run(h, "run-tt-floor-quiet");
    expect(h.deliverables[0]).not.toHaveProperty("contentRepairs");
    expect(h.deliverables[0]).not.toHaveProperty("momentNotes");
  }, 20_000);
});

/**
 * The four audit leftovers that were only ever half-built (2026-09-19).
 *
 * Each of these is a rule the code already stated somewhere — in a comment, a
 * prompt or a step name — and never actually carried out.
 */
describe("audit leftovers", () => {
  it("tells the reviewer when the caption is still a near-duplicate after its redraft", async () => {
    // `draftWithVerifiedDedupe`'s own doc comment has always claimed that on
    // the final attempt a `similar` draft "ships FLAGGED rather than held".
    // The verdict went to a step checkpoint and nowhere else, so a caption 70%
    // identical to last week's reached the reviewer looking clean.
    const h = stubTools({
      outputHistory: [{ runId: "run-tt-last-week", excerpt: GOOD_COMMENTARY.caption }],
    });
    const result = await run(h, "run-tt-dedupe-surfaced");

    expect(result.status).toBe("completed");
    const repairs = h.deliverables[0]?.["contentRepairs"] as Array<{ check: string; action: string; detail: string }>;
    const flagged = repairs.find((r) => r.check === "output-dedupe");
    expect(flagged?.action).toBe("unresolved");
    expect(flagged?.detail).toContain("run-tt-last-week");
    expect(flagged?.detail).toMatch(/\d+% similar/);
  }, 20_000);

  it("says nothing about dedupe on a caption with no history to repeat", async () => {
    const h = stubTools();
    await run(h, "run-tt-dedupe-quiet");
    const repairs = (h.deliverables[0]?.["contentRepairs"] as Array<{ check: string }> | undefined) ?? [];
    expect(repairs.map((r) => r.check)).not.toContain("output-dedupe");
  }, 20_000);

  it("flags a cut the reviewer model says is in the wrong place", async () => {
    // Every other expectation on the QA call is about the TREATMENT, and a
    // clipping run's whole product is the choice of moment — so a clip could
    // score 9 with perfect captions while opening mid-sentence.
    const h = stubTools({ withVisualQa: true, qaMoment: { opensOnCompleteThought: false, closesAfterPayoff: true, note: "starts four words into the sentence" } });
    const result = await run(h, "run-tt-moment-fit");

    expect(result.status).toBe("completed");
    // The clip's own words were sent, or the model had nothing to judge against.
    expect((h.qaArgs[0]!["expectations"] as Record<string, unknown>)["clipText"]).toBeTruthy();
    const repairs = h.deliverables[0]?.["contentRepairs"] as Array<{ check: string; detail: string }>;
    const fit = repairs.find((r) => r.check === "moment-fit");
    expect(fit?.detail).toContain("opens part-way through a thought");
    expect(fit?.detail).toContain("starts four words into the sentence");
  }, 20_000);

  it("never asks an original short whether its cut is in the right place", async () => {
    // An original short is ASSEMBLED from beats rather than cut out of a
    // recording, so "does it open on a complete thought" is a question about
    // writing that the script checks already answer, not about an edit.
    const h = stubTools({ withVisualQa: true, stockServes: true, harvestServes: false });
    await run(h, "run-tt-no-moment-for-shorts", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], os.tmpdir());
    expect((h.qaArgs[0]!["expectations"] as Record<string, unknown>)["clipText"]).toBeUndefined();
  }, 20_000);
});

/**
 * A pasted link (RFC-25 phase 4).
 *
 * `media.ingestAssets` does a plain HTTP GET, so an `https://` asset has to BE
 * the media. A YouTube watch page fetched that way wrote an HTML document with
 * an `.mp4` name and failed three steps later inside `video.transcribe` — so a
 * watch URL has never been something a client could hand this pipeline.
 */
describe("a pasted link", () => {
  const LINK = "https://www.youtube.com/watch?v=abc123";

  it("resolves a watch page through the harvester instead of fetching it as a file", async () => {
    const h = stubTools({ harvestServes: true });
    const result = await run(h, "run-tt-paste", { sourcePath: undefined, mediaAssets: [{ uri: LINK, role: "source" }] }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    // Resolved, not searched: the tool was handed the URL and no query posture.
    const harvest = h.harvestArgs[0]!;
    expect(harvest["sourceUrl"]).toBe(LINK);
    expect(h.calls).not.toContain("media.ingestAssets");
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "user-asset" });
  }, 20_000);

  it("still fetches a DIRECT media file the old way", async () => {
    // The distinction is what the URI says it IS. A `.mp4` is the media and
    // goes through the ingester; anything else is a page. `media.ingestAssets`
    // is not in the default harness, so it is registered here — without it the
    // assertion would pass on a run that failed for an unrelated reason.
    const h = stubTools({ harvestServes: true });
    const ingested: string[] = [];
    (h.tools as unknown as Record<string, unknown>)["media.ingestAssets"] = {
      name: "media.ingestAssets",
      description: "Pulls media a person attached directly to this run.",
      version: "1.0.0",
      inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
      async execute(args: unknown) {
        h.calls.push("media.ingestAssets");
        ingested.push((args as { assets: Array<{ uri: string }> }).assets[0]!.uri);
        return { status: "success" as const, result: { candidates: [{ path: ".media-cache/run/direct.mp4" }], unmet: [] } };
      },
    };
    const result = await run(h, "run-tt-paste-direct", { sourcePath: undefined, mediaAssets: [{ uri: "https://cdn.example.com/ep12.mp4", role: "source" }] }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    expect(ingested).toEqual(["https://cdn.example.com/ep12.mp4"]);
    expect(h.harvestArgs).toHaveLength(0);
  }, 20_000);

  it("carries on down the cascade when the link is dead, and says the clip came from somewhere else", async () => {
    // The standing rule: a run always hands the client something. They asked
    // for a specific video and got a different one, which is the single most
    // important thing on this deliverable — so it is on it.
    const h = stubTools({ harvestServes: "resolve-fails", stockServes: true });
    const result = await run(h, "run-tt-paste-dead", { sourcePath: undefined, mediaAssets: [{ uri: LINK, role: "source" }] }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; action: string; detail: string }>;
    const failed = repairs.find((r) => r.check === "pasted-link");
    expect(failed?.action).toBe("substituted");
    expect(failed?.detail).toContain(LINK);
    expect(failed?.detail).toContain("came from somewhere else");
  }, 20_000);

  it("refuses outright when the link is dead AND the run is client-media-only", async () => {
    // `mediaSource: "client"` is someone saying "only my media". Finding a
    // DIFFERENT video for them would be answering the request with something
    // else, which is the one thing this agent has never been willing to do.
    const h = stubTools({ harvestServes: "resolve-fails", stockServes: true });
    const result = await run(
      h,
      "run-tt-paste-dead-clientonly",
      { sourcePath: undefined, mediaSource: "client", mediaAssets: [{ uri: LINK, role: "source" }] },
      [GOOD_MOMENT, GOOD_COMMENTARY],
      os.tmpdir(),
    );

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toContain("client-provided media only");
    expect(h.calls).not.toContain("video.findStockClip");
  }, 20_000);
});

/**
 * The source-fit judge (RFC-25 phase 3).
 *
 * Open discovery searches all of YouTube, and all of YouTube contains clip
 * farms, re-uploads and a competitor's own show. Nothing else in the pipeline
 * is positioned to notice: the moment picker answers "which forty seconds" and
 * the visual QA judges a finished render.
 *
 * It runs BEFORE `02-transcribe` on purpose — transcribing a two-hour podcast
 * is the most expensive step in the run, and a check placed after it can only
 * tell a reviewer the source was wrong once the run has paid to find out.
 */
describe("source fit", () => {
  const GOOD_FIT = { score: 9, reason: "A long-form business podcast with a named guest, squarely on the run's subject.", concerns: [] };
  const BAD_FIT = {
    score: 2,
    reason: "A channel that only re-posts other people's podcast clips; there is no original conversation here.",
    concerns: ["clip farm: the channel's whole output is other people's material"],
  };

  it("flags a poor source on the deliverable, and still ships the clip", async () => {
    // Marks, never blocks. The person at 11-clip-review is the one who can
    // tell "a competitor, do not touch" from "a competitor, and that is
    // exactly why the take lands".
    const h = stubTools({ config: {}, harvestServes: true, stockServes: true });
    const result = await run(h, "run-tt-fit-bad", { sourcePath: undefined }, [BAD_FIT, GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; action: string; detail: string }>;
    const fit = repairs.find((r) => r.check === "source-fit");
    expect(fit?.action).toBe("unresolved");
    expect(fit?.detail).toContain("2/10");
    expect(fit?.detail).toContain("clip farm");
  }, 20_000);

  it("says nothing about a source it judged fine", async () => {
    const h = stubTools({ config: {}, harvestServes: true, stockServes: true });
    await run(h, "run-tt-fit-good", { sourcePath: undefined }, [GOOD_FIT, GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    const repairs = (h.deliverables[0]!["contentRepairs"] as Array<{ check: string }> | undefined) ?? [];
    expect(repairs.map((r) => r.check)).not.toContain("source-fit");
  }, 20_000);

  it("flags a source with a CONCERN even when the score is high", async () => {
    // A competitor's show can score 9 for relevance and still be the thing a
    // reviewer most needs to be told about.
    const competitor = { score: 9, reason: "Exactly the right subject and format.", concerns: ["this is a direct competitor's own show"] };
    const h = stubTools({ config: {}, harvestServes: true, stockServes: true });
    await run(h, "run-tt-fit-concern", { sourcePath: undefined }, [competitor, GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; detail: string }>;
    expect(repairs.find((r) => r.check === "source-fit")?.detail).toContain("direct competitor");
  }, 20_000);

  it("leaves the run exactly as it was when the judge cannot answer", async () => {
    // No SourceFit candidate in the router at all, which is how every harvest
    // test in this file ran before the judge existed. A judge that is down
    // must not cost the clip — the always-deliver rule reaches this step too.
    const h = stubTools({ config: {}, harvestServes: true, stockServes: true });
    const result = await run(h, "run-tt-fit-down", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    const repairs = (h.deliverables[0]!["contentRepairs"] as Array<{ check: string }> | undefined) ?? [];
    expect(repairs.map((r) => r.check)).not.toContain("source-fit");
  }, 20_000);

  it("never second-guesses footage the client chose themselves", async () => {
    // An attached upload is somebody's own decision. Scoring it would be this
    // agent telling a client their own recording is a poor source.
    const h = stubTools();
    await run(h, "run-tt-fit-attached", {}, [BAD_FIT, GOOD_MOMENT, GOOD_COMMENTARY]);

    const repairs = (h.deliverables[0]!["contentRepairs"] as Array<{ check: string }> | undefined) ?? [];
    expect(repairs.map((r) => r.check)).not.toContain("source-fit");
  }, 20_000);
});


/**
 * The two ways a clipping run used to end with nothing.
 *
 * Both were found by the owner's first real prep run of the RFC-25 work
 * (`pubsub-21912059758236775`, 2026-09-20, client `karoslabs`), which held
 * with:
 *
 *     no source footage from any tier — user-asset: no media attached;
 *     owned-footage: sourcePool holds no gs://https:// footage URIs;
 *     web-harvest (allowlist, "..."): content_fail (The Karos Labs Podcast:
 *     0 result(s)); stock: disabled — mode is "commentary"
 */
describe("a clipping run that finds nothing", () => {
  // Same as the tiered-cascade block above: the plate work writes real
  // files, so it needs a real directory rather than a synthetic root.
  const REPO_ROOT = os.tmpdir();
  const POOLED_COMMENTARY = { tiktokClips: { mode: "commentary", sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] } };

  it("falls through from an empty allowlist to an open search", async () => {
    // RFC-25 §1 promised exactly this and the code did not do it: `discovery`
    // was chosen ONCE from whether the pool was empty, so a client WITH a
    // pool never reached the open branch — and the client the RFC named as
    // the case this fixes was the one case still broken.
    const h = stubTools({ harvestServes: "allowlist-dry", stockServes: true });
    const result = await run(h, "run-tt-allowlist-dry", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    // Two calls, in this order. The pool is a statement about rights, so it
    // is still tried FIRST; it is not a statement that the client would
    // rather have nothing.
    expect(h.harvestArgs).toHaveLength(2);
    expect(h.harvestArgs[0]!["discovery"]).toBe("allowlist");
    expect(h.harvestArgs[0]!["allowedSources"]).toEqual(["The Show"]);
    expect(h.harvestArgs[1]!["discovery"]).toBe("open");
    // The rights list is not sent into a search that does not honour it.
    expect(h.harvestArgs[1]!["allowedSources"]).toEqual([]);
    // …and the open leg gets the BUILT query, not the raw catalog row.
    expect(h.harvestArgs[1]!["query"]).toContain("podcast");

    expect(h.deliverables[0]).toMatchObject({ sourceTier: "web-harvest", licenseConfidence: "unknown" });
  }, 20_000);

  it("tells the reviewer the client's own source list came up empty", async () => {
    // The failed allowlist leg has to survive the tier that answered. A
    // reviewer looking at a clip from a show nobody cleared needs to know
    // the client's own list was tried and found nothing, or the open search
    // reads as the agent ignoring their configuration.
    const h = stubTools({ harvestServes: "allowlist-dry", stockServes: true });
    await run(h, "run-tt-allowlist-dry-notes", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    const notes = h.deliverables[0]!["sourceContext"] !== undefined ? (h.deliverables[0]!["sourceNotes"] as string[] | undefined) : undefined;
    expect(notes?.some((n) => n.includes("allowlist") && n.includes("0 result(s)"))).toBe(true);
  }, 20_000);

  it("keeps ONE call when the allowlist answers — the fallback is a fallback", async () => {
    // The cost guard. A pool that works must not also pay for an open search.
    const h = stubTools({ harvestServes: true, stockServes: true });
    await run(h, "run-tt-allowlist-ok", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());
    expect(h.harvestArgs).toHaveLength(1);
    expect(h.harvestArgs[0]!["discovery"]).toBe("allowlist");
  }, 20_000);

  it("ships an original short rather than holding when commentary mode has nothing to clip", async () => {
    // The owner's standing rule (2026-09-17): an agent never ends a run with
    // no deliverable. `mode: "commentary"` forbidding stock is a real product
    // rule, and it yields to that one — a held run bills the client an error
    // message in place of work.
    const h = stubTools({ config: POOLED_COMMENTARY, harvestServes: false, stockServes: true });
    const result = await run(h, "run-tt-commentary-dry", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "stock" });
  }, 20_000);

  it("says out loud that the client asked for a clip and is holding a different product", async () => {
    // The substitution is only defensible because it is announced. Without
    // this the deliverable reads `format: original-short` as if that had
    // been the plan all along.
    const h = stubTools({ config: POOLED_COMMENTARY, harvestServes: false, stockServes: true });
    await run(h, "run-tt-commentary-dry-said", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT);

    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; action: string; detail: string }>;
    const swap = repairs.find((r) => r.check === "clip-mode");
    expect(swap?.action).toBe("unresolved");
    expect(swap?.detail).toContain("commentary");
    expect(swap?.detail).toContain("original short");
  }, 20_000);

  it("still holds when there is no stock tier either — that one IS a tooling failure", async () => {
    // The remaining hold, and the reason it is allowed to remain: a
    // deployment with no `video.findStockClip` cannot make anything at all,
    // which is a fact about the deployment rather than about this client's
    // topic. `stockServes: false` registers the tool answering not_available.
    const h = stubTools({ config: POOLED_COMMENTARY, harvestServes: false });
    const result = await run(h, "run-tt-nothing-at-all", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("no source footage from any tier");
    // And the reservation is handed back, so the topic is not burned.
    expect(h.calls).toContain("topics.release");
  }, 20_000);
});


/**
 * The CLIPPING VARIANT's own paths (D08).
 *
 * Every other test in this file runs `variant: "auto"`, because until
 * 2026-09-20 `run()` could not pass one. `formatForVariant("auto")` returns
 * undefined, so all of them exercised the `??` fallback and none of them ever
 * executed the pin the two named variants apply — which is how prep run
 * `pubsub-21908845348121079` got to `08-render` and failed with
 * `videoPath: undefined`.
 */
describe("the clipping variant", () => {
  const REPO_ROOT = os.tmpdir();
  const POOLED_COMMENTARY = { tiktokClips: { mode: "commentary", sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] } };

  it("still produces a commentary clip when there is something to clip", async () => {
    // The pin doing its job: a clipping card answers with a clip, whatever
    // the client's own `mode` says.
    const h = stubTools({ config: { tiktokClips: { mode: "original", sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] } } });
    const result = await run(h, "run-tt-variant-clip", {}, [GOOD_MOMENT, GOOD_COMMENTARY], undefined, "clipping");

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ format: "commentary-clip" });
    expect(h.calls).toContain("video.cutClip");
  }, 20_000);

  it("makes an original short — not a clip with no file — when the cascade lands on stock", async () => {
    // THE PREP FAILURE. A `stock` intake has no source video at all: its
    // plates are found per beat once a script exists. Pinning the format to
    // the pressed button here does not produce a worse clip, it calls
    // `video.cutClip`/`video.brandFrame` with an undefined path.
    const h = stubTools({ config: POOLED_COMMENTARY, harvestServes: false, stockServes: true });
    const result = await run(h, "run-tt-variant-stock", { sourcePath: undefined }, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT, "clipping");

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "stock", format: "original-short" });
    // The composer ran, and the clip cutter never did: there was nothing to cut.
    expect(h.calls).toContain("video.composeSequence");
    expect(h.calls).not.toContain("video.cutClip");
    // …and the reviewer is told they are holding a different product.
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; detail: string }>;
    expect(repairs.find((r) => r.check === "clip-mode")?.detail).toContain("commentary");
  }, 20_000);

  it("writes over silent footage instead of holding on it", async () => {
    // REVERSED 2026-09-20 with the same reasoning as the dry cascade. This
    // threw `WorkflowHeld` ("the clipping agent does not write scripts"),
    // which left the agent answering two identical situations differently:
    // no footage → delivered, footage with no words → held.
    const h = stubTools({ transcriptWords: [], stockServes: true });
    const result = await run(h, "run-tt-variant-silent", {}, [GOOD_SCRIPT, GOOD_COMMENTARY], REPO_ROOT, "clipping");

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ format: "original-short" });
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; detail: string }>;
    const swap = repairs.find((r) => r.check === "clip-mode");
    expect(swap?.detail).toContain("no speech");
  }, 20_000);
});


/**
 * WHEN NOTHING WAS RESERVED (the always-deliver widen, 2026-09-21).
 *
 * `01-claim-topic` used to throw `WorkflowHeld` here, quoting a rule the
 * owner's 2026-09-17 ruling had already superseded — "no candidate topic →
 * widen and deliver annotated" names this exact case. Three rungs, weakest
 * excuse first, each announced as a `topic-source` repair: a widened subject
 * that arrives looking like a chosen one is worse than the hold was.
 */
describe("widening the topic rather than holding", () => {
  /**
   * `TopicScoutOutputSchema` requires between DISCOVERY_CANDIDATE_MIN (6) and
   * 10 candidates — a shorter list is not a thin week, it is a scout that did
   * not do the job, and `smartFakeRouter` rightly refuses to parse one.
   */
  const SUBJECTS = [
    "Finance teams stopped believing the AI efficiency story",
    "Why your best channel is the one nobody reports on",
    "The pipeline review that should be a document",
    "Brand spend survives the quarter it cannot prove",
    "Attribution is a story your CFO already disbelieves",
    "The agency retainer nobody renegotiated",
  ];
  const SCOUT_CANDIDATES = SUBJECTS.map((topic, i) => ({
    topic,
    angle: `What ${topic.toLowerCase()} actually costs a marketing team`,
    hook: `Nobody warned you about this: ${topic.toLowerCase()}`,
    format: "commentary-clip" as const,
    whyNow: `Three CFO surveys landed this week (${i})`,
    evidenceUrls: ["https://example.com/cfo"],
    voiceoverRecommended: false,
  }));
  const SCOUT = { rationale: "one fresh angle off this week's CFO surveys", candidates: SCOUT_CANDIDATES };
  /** The same six, already published — so every one of them is dropped as a repeat. */
  const ALL_PUBLISHED = SCOUT_CANDIDATES.map((c, i) => ({ runId: `run-old-${i}`, excerpt: `${c.topic}\n${c.angle}\n${c.hook}` }));

  it("rung 1: runs on a discovered subject when only the CATALOG could not reserve it", async () => {
    // The subject is exactly as good as the one that would have been
    // reserved; what is missing is bookkeeping, and bookkeeping is not worth
    // a client's run.
    const h = stubTools({ reserveFails: true, discoveryTools: true, harvestServes: true, stockServes: true });
    const result = await run(h, "run-tt-widen-unreserved", { sourcePath: undefined }, [SCOUT, GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ topic: SCOUT_CANDIDATES[0]!.topic, topicSource: "widened" });
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; detail: string }>;
    expect(repairs.find((r) => r.check === "topic-source")?.detail).toContain("without a catalog reservation");
  }, 20_000);

  it("rung 2: takes the freshest REPEAT when every proposal was too close to recent output, and names it as one", async () => {
    // A poor answer — repetition across runs is the tell the dedupe exists to
    // remove — and still a better one than nothing, because the human gate is
    // where it gets refused. What makes that defensible is the annotation: a
    // reviewer told "this repeats what you published" can act on it.
    const h = stubTools({
      reserveFails: true,
      discoveryTools: true,
      harvestServes: true,
      stockServes: true,
      outputHistory: ALL_PUBLISHED,
    });
    const result = await run(h, "run-tt-widen-repeat", { sourcePath: undefined }, [SCOUT, GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ topicSource: "widened" });
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; detail: string }>;
    const note = repairs.find((r) => r.check === "topic-source")?.detail;
    expect(note).toContain("too close to something this client recently published");
    expect(note).toContain("check it against the recent posts before approving");
  }, 20_000);

  it("rung 3: falls back to one of the client's OWN content pillars when discovery proposed nothing", async () => {
    // Not an invented subject: a content pillar is the client's own declared
    // answer to "what should we be talking about".
    const h = stubTools({
      reserveFails: true,
      harvestServes: true,
      stockServes: true,
      config: { tiktokClips: { sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] }, contentPillars: ["how founders pick their first hire"] },
    });
    const result = await run(h, "run-tt-widen-pillar", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ topic: "how founders pick their first hire", topicSource: "widened" });
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; detail: string }>;
    expect(repairs.find((r) => r.check === "topic-source")?.detail).toContain("content pillars");
  }, 20_000);

  it("a scout that is DOWN costs the discovery, not the run", async () => {
    // It used to throw `WorkflowToolingFailure` and kill the run. The
    // always-deliver rule's tooling carve-out is for when nothing can be
    // produced; here the client's own content pillar still can be, so a
    // scout outage degrades to "discovery proposed nothing" and the ladder
    // takes it from there.
    //
    // The router is given NO scout-shaped candidate, so `01d-topic-scout`
    // cannot complete — the same shape as the model being unavailable.
    const h = stubTools({
      reserveFails: true,
      discoveryTools: true,
      harvestServes: true,
      stockServes: true,
      config: { tiktokClips: { sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] }, contentPillars: ["how founders pick their first hire"] },
    });
    const result = await run(h, "run-tt-scout-down", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], os.tmpdir());

    expect(result.status).toBe("completed");
    expect(h.deliverables[0]).toMatchObject({ topic: "how founders pick their first hire", topicSource: "widened" });
    const repairs = h.deliverables[0]!["contentRepairs"] as Array<{ check: string; detail: string }>;
    expect(repairs.find((r) => r.check === "topic-source")?.detail).toContain("topic scout");
  }, 20_000);

  it("says nothing about the topic on a run that reserved one normally", async () => {
    // Absent, never empty. A marker attached unconditionally is the "silently
    // shipping a degraded run" failure in reverse — shouting at every clean
    // run until nobody reads it.
    const h = stubTools();
    await run(h, "run-tt-topic-clean");

    const repairs = (h.deliverables[0]!["contentRepairs"] as Array<{ check: string }> | undefined) ?? [];
    expect(repairs.map((r) => r.check)).not.toContain("topic-source");
    expect(h.deliverables[0]).toMatchObject({ topicSource: "reserved" });
  }, 20_000);
});
