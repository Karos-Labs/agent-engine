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
  CutClipInputSchema,
  SelfEvalGateInputSchema,
  TranscribeInputSchema,
  UploadDeliverableInputSchema,
} from "@agent-engine/tool-karos-video";
import {
  BRAND_LOGO_CONTRAST_FLOOR,
  GenerateVideoInputSchema,
  HarvestVideoInputSchema,
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

/** 90 seconds of one-second sentences, so a legal 20-120s clip exists. */
function transcriptWords(): Array<{ text: string; start: number; end: number }> {
  return Array.from({ length: 90 }, (_, i) => ({ text: `word${i}.`, start: i, end: i + 1 }));
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
  reserveFails?: boolean;
  forbiddenTopics?: string[];
  /** Register `media.harvestVideo` answering success (Tier 2b serves). */
  harvestServes?: boolean;
  /** Register `video.generateClip` answering success (Tier 3 serves). */
  generateServes?: boolean;
  /** Register `video.uploadDeliverable` (a media store is configured). */
  withUpload?: boolean;
}

/** Records every tool call so a test can assert what did and did not happen. */
interface Harness {
  tools: AgentToolRegistry;
  calls: string[];
  /** Every `ledger.writeDeliverable` payload, for asserting what shipped. */
  deliverables: Array<Record<string, unknown>>;
}

function stubTools(opts: StubOptions = {}): Harness {
  const calls: string[] = [];
  const deliverables: Array<Record<string, unknown>> = [];
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const pass = (name: string) =>
    opts.failingGate === name
      ? { verdict: "content_fail" as const, reason: `${name} said no` }
      : { verdict: "pass" as const, reason: "" };

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
    "topics.release": tool("topics.release", () => ok({ released: true })),
    "video.transcribe": tool("video.transcribe", () => ok({ words: opts.transcriptWords ?? transcriptWords() }), TranscribeInputSchema),
    "video.cutClip": tool("video.cutClip", (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40 }), CutClipInputSchema),
    "video.brandFrame": tool(
      "video.brandFrame",
      (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40, applied: ["bars"] }),
      BrandFrameInputSchema,
    ),
    "video.selfEvalGate": tool("video.selfEvalGate", () => ok(pass("video.selfEvalGate")), SelfEvalGateInputSchema),
    "gate.lintPost": tool("gate.lintPost", () => ok(pass("gate.lintPost"))),
    "gate.brandCompliance": tool("gate.brandCompliance", () => ok(pass("gate.brandCompliance"))),
    "gate.noPlaceholder": tool("gate.noPlaceholder", () => ok(pass("gate.noPlaceholder"))),
    "gate.leakCheck": tool("gate.leakCheck", () => ok(pass("gate.leakCheck"))),
    "ledger.writeDeliverable": tool("ledger.writeDeliverable", (args) => {
      deliverables.push((args as { deliverable: Record<string, unknown> }).deliverable);
      return ok({ id: "deliv-1", created: true });
    }),
    "memory.appendDecision": tool("memory.appendDecision", () => ok({ id: "dec-1" })),
  };
  if (opts.harvestServes !== undefined) {
    tools["media.harvestVideo"] = tool(
      "media.harvestVideo",
      () =>
        opts.harvestServes
          ? ok({ path: ".media-cache/run/harvested-clip.mp4", sourceUrl: "https://example.com/talk" })
          : { status: "content_fail" as const, reason: "nothing usable found" },
      HarvestVideoInputSchema,
    );
  }
  if (opts.generateServes !== undefined) {
    tools["video.generateClip"] = tool(
      "video.generateClip",
      () =>
        opts.generateServes
          ? ok({ path: ".media-cache/run/generated-clip.mp4", model: "veo-2.0-generate-001" })
          : { status: "not_available" as const, reason: "no Vertex project configured" },
      GenerateVideoInputSchema,
    );
  }
  if (opts.withUpload) {
    tools["video.uploadDeliverable"] = tool(
      "video.uploadDeliverable",
      (args) => ok({ gcsUri: `gs://media/${(args as { objectPath: string }).objectPath}`, signedUrl: "https://signed.example/clip.mp4" }),
      UploadDeliverableInputSchema,
    );
  }
  return { tools: tools as unknown as AgentToolRegistry, calls, deliverables };
}

async function run(harness: Harness, runId: string, input: Record<string, unknown> = {}, candidates: unknown[] = [GOOD_MOMENT, GOOD_COMMENTARY], repoRoot?: string) {
  const workflow = createTikTokAgentWorkflow({
    tools: harness.tools,
    promptStore: new FilePromptStore(PROMPTS_ROOT),
    router: smartFakeRouter(candidates),
    autoApprove: true,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
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
  });

  it("blocks intake when the client has no clip config, rather than clipping anything it likes", async () => {
    // Which shows a client may draw on is a rights decision someone makes.
    const h = stubTools({ config: {} });
    const result = await run(h, "run-tt-noconfig");

    expect(result.status).toBe("blocked_intake");
    expect(h.calls).not.toContain("video.cutClip");
  });

  it("holds rather than lowering the bar when the catalog has no candidate", async () => {
    // The legacy rule: a run with no candidate "logs that fact and exits
    // cleanly. It never lowers the bar to ship something."
    const h = stubTools({ reserveFails: true });
    const result = await run(h, "run-tt-nocandidate");

    expect(result.status).toBe("held");
    expect(h.calls).not.toContain("video.cutClip");
  });

  it("holds on a silent source instead of guessing a moment out of a blank timeline", async () => {
    const h = stubTools({ transcriptWords: [] });
    const result = await run(h, "run-tt-silent");

    expect(result.status).toBe("held");
    // And gives the moment back, because nothing was produced from it.
    expect(h.calls).toContain("topics.release");
  });

  it("holds when the selected moment is too short to be a clip", async () => {
    const h = stubTools();
    const result = await run(h, "run-tt-short", {}, [{ ...GOOD_MOMENT, startSeconds: 10, endSeconds: 13 }, GOOD_COMMENTARY]);

    expect(result.status).toBe("held");
    expect(h.calls).toContain("topics.release");
    expect(h.calls).not.toContain("video.cutClip");
  });

  it("refuses a caption that does not name the source, even though a gate did not object", async () => {
    // The one failure here with a party outside this system. Checked in code
    // rather than asked of the model that wrote the caption.
    const h = stubTools();
    const result = await run(h, "run-tt-uncredited", {}, [
      GOOD_MOMENT,
      { ...GOOD_COMMENTARY, caption: "Our read on this: the number is right and the conclusion is wrong." },
    ]);

    expect(result.status).toBe("held");
    expect(h.calls).not.toContain("video.cutClip");
    expect(h.calls).toContain("topics.release");
  });

  it.each([
    ["gate.lintPost"],
    ["gate.brandCompliance"],
    ["gate.noPlaceholder"],
    ["gate.leakCheck"],
  ])("holds and releases the moment when %s fails", async (gate) => {
    const h = stubTools({ failingGate: gate });
    const result = await run(h, `run-tt-${gate.replace(".", "-")}`);

    expect(result.status).toBe("held");
    expect(h.calls).toContain("topics.release");
    // Compliance runs before the render: a clip that cannot ship is never made.
    expect(h.calls).not.toContain("video.cutClip");
  });

  it("holds when the blocking QA gate video.selfEvalGate fails", async () => {
    const h = stubTools({ failingGate: "video.selfEvalGate" });
    const result = await run(h, "run-tt-video-selfEvalGate");

    expect(result.status).toBe("held");
    expect(h.calls).toContain("topics.release");
    expect(h.calls).not.toContain("ledger.writeDeliverable");
  });

  it("never persists a deliverable for a run that did not clear every gate", async () => {
    // Swept across every gate rather than asserted once: the property is that
    // no single failing gate has a path to the ledger.
    for (const gate of ["gate.lintPost", "gate.leakCheck", "video.selfEvalGate"]) {
      const h = stubTools({ failingGate: gate });
      const result = await run(h, `run-tt-sweep-${gate.replace(".", "-")}`);
      expect(result.status, gate).toBe("held");
      expect(h.calls, gate).not.toContain("ledger.writeDeliverable");
      expect(h.calls, gate).not.toContain("topics.commit");
    }
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

  it("Tier 2b: falls through to a web harvest when the pool holds no footage URIs", async () => {
    const h = stubTools({ harvestServes: true });
    const result = await run(h, "run-tt-harvest", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("completed");
    expect(h.calls).toContain("media.harvestVideo");
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "web-harvest" });
  }, 20_000);

  it("Tier 3: a generated plate skips transcription and the cut entirely — the commentary carries the message", async () => {
    const h = stubTools({ harvestServes: false, generateServes: true });
    const result = await run(h, "run-tt-generated", { sourcePath: undefined }, [GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("completed");
    // No speech: nothing to transcribe, no moment agent, no cut. The plate IS
    // the clip, and it still goes through the branded frame and the QA gate.
    expect(h.calls).not.toContain("video.transcribe");
    expect(h.calls).not.toContain("video.cutClip");
    expect(h.calls).toContain("video.brandFrame");
    expect(h.calls).toContain("video.selfEvalGate");
    expect(h.deliverables[0]).toMatchObject({ sourceTier: "generated" });
  }, 20_000);

  it("holds honestly when every tier is dry, naming each tier's outcome, and releases the moment", async () => {
    const h = stubTools({ harvestServes: false, generateServes: false });
    const result = await run(h, "run-tt-dry", { sourcePath: undefined }, [GOOD_MOMENT, GOOD_COMMENTARY], REPO_ROOT);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    for (const tier of ["user-asset", "owned-footage", "web-harvest", "generated"]) {
      expect(result.reason).toContain(tier);
    }
    // The moment goes back — a dry cascade must not burn it.
    expect(h.calls).toContain("topics.release");
  });

  it("holds with every tier named even when the video tiers are not wired at all", async () => {
    // No repoRoot, no harvest/generate tools: the pre-cascade deployment shape.
    const h = stubTools();
    const result = await run(h, "run-tt-unwired", { sourcePath: undefined });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("web-harvest: not wired");
    expect(result.reason).toContain("generated: not wired");
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
    // 40 words in the clip window → an SRT was written and passed.
    expect(typeof frameArgs!["srtPath"]).toBe("string");
    const srt = await fs.readFile(frameArgs!["srtPath"] as string, "utf8");
    expect(srt).toContain("word10.");
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
