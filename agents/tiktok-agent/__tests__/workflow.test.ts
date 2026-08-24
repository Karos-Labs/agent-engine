import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { FilePromptStore, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";

/**
 * The clip pipeline end to end, against stubbed tools.
 *
 * The video tools are stubbed rather than real because the real ones shell out
 * to a Python engine and ffmpeg; what is worth testing here is the workflow's
 * own decisions — which failures are `held` versus `blocked_intake` versus
 * `tooling_error`, whether a reservation survives a failed run, and whether a
 * gate can be reached without the one before it passing.
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
}

/** Records every tool call so a test can assert what did and did not happen. */
interface Harness {
  tools: AgentToolRegistry;
  calls: string[];
}

function stubTools(opts: StubOptions = {}): Harness {
  const calls: string[] = [];
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const pass = (name: string) =>
    opts.failingGate === name
      ? { verdict: "content_fail" as const, reason: `${name} said no` }
      : { verdict: "pass" as const, reason: "" };

  const tool = (name: string, run: (args: never) => unknown) => ({
    name,
    version: "1.0.0",
    inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    async execute(args: never) {
      calls.push(name);
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
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [] })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    "topics.reserve": tool("topics.reserve", () =>
      opts.reserveFails
        ? { status: "content_fail" as const, reason: "catalog empty" }
        : ok({ reservationKey: "res-1", topics: ["The Show ep. 12 — the margin call moment"] }),
    ),
    "topics.commit": tool("topics.commit", () => ok({ committed: true })),
    "topics.release": tool("topics.release", () => ok({ released: true })),
    "video.transcribe": tool("video.transcribe", () => ok({ words: opts.transcriptWords ?? transcriptWords() })),
    "video.cutGate": tool("video.cutGate", () => ok(pass("video.cutGate"))),
    "video.render": tool("video.render", () => ok({ outputPath: "/tmp/clip.mp4" })),
    "video.selfEvalGate": tool("video.selfEvalGate", () => ok(pass("video.selfEvalGate"))),
    "video.brandGate": tool("video.brandGate", () => ok(pass("video.brandGate"))),
    "gate.lintPost": tool("gate.lintPost", () => ok(pass("gate.lintPost"))),
    "gate.brandCompliance": tool("gate.brandCompliance", () => ok(pass("gate.brandCompliance"))),
    "gate.noPlaceholder": tool("gate.noPlaceholder", () => ok(pass("gate.noPlaceholder"))),
    "gate.leakCheck": tool("gate.leakCheck", () => ok(pass("gate.leakCheck"))),
    "ledger.writeDeliverable": tool("ledger.writeDeliverable", () => ok({ id: "deliv-1", created: true })),
    "memory.appendDecision": tool("memory.appendDecision", () => ok({ id: "dec-1" })),
  };
  return { tools: tools as unknown as AgentToolRegistry, calls };
}

async function run(harness: Harness, runId: string, input: Record<string, unknown> = {}, candidates: unknown[] = [GOOD_MOMENT, GOOD_COMMENTARY]) {
  const workflow = createTikTokAgentWorkflow({
    tools: harness.tools,
    promptStore: new FilePromptStore(PROMPTS_ROOT),
    router: smartFakeRouter(candidates),
    autoApprove: true,
  });
  return new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
    ...PARAMS,
    runId,
    input: { sourcePath: "/tmp/episode.mp4", ...input },
  });
}

describe("tiktok-agent clip pipeline", () => {
  it("produces one credited, gated clip on the happy path", async () => {
    const h = stubTools();
    const result = await run(h, "run-tt-happy");

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { deliverableId: string; lane: string; durationSeconds: number };
    expect(output.deliverableId).toBe("deliv-1");
    expect(output.lane).toBe("commentary-clip");
    expect(output.durationSeconds).toBeGreaterThanOrEqual(20);

    // The reservation is burned only because a clip actually shipped.
    expect(h.calls).toContain("topics.commit");
    expect(h.calls).not.toContain("topics.release");
  });

  it("blocks intake when the client has no clip config, rather than clipping anything it likes", async () => {
    // Which shows a client may draw on is a rights decision someone makes.
    const h = stubTools({ config: {} });
    const result = await run(h, "run-tt-noconfig");

    expect(result.status).toBe("blocked_intake");
    expect(h.calls).not.toContain("video.render");
  });

  it("blocks intake when the run carries no source media", async () => {
    const h = stubTools();
    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router: smartFakeRouter([GOOD_MOMENT, GOOD_COMMENTARY]),
      autoApprove: true,
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
      ...PARAMS,
      runId: "run-tt-nosource",
      input: {},
    });

    expect(result.status).toBe("blocked_intake");
  });

  it("holds rather than lowering the bar when the catalog has no candidate", async () => {
    // The legacy rule: a run with no candidate "logs that fact and exits
    // cleanly. It never lowers the bar to ship something."
    const h = stubTools({ reserveFails: true });
    const result = await run(h, "run-tt-nocandidate");

    expect(result.status).toBe("held");
    expect(h.calls).not.toContain("video.render");
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
    expect(h.calls).not.toContain("video.render");
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
    expect(h.calls).not.toContain("video.render");
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
    expect(h.calls).not.toContain("video.render");
  });

  it.each([["video.selfEvalGate"], ["video.brandGate"]])("holds when the blocking QA gate %s fails", async (gate) => {
    const h = stubTools({ failingGate: gate });
    const result = await run(h, `run-tt-${gate.replace(".", "-")}`);

    expect(result.status).toBe("held");
    expect(h.calls).toContain("topics.release");
    expect(h.calls).not.toContain("ledger.writeDeliverable");
  });

  it("never persists a deliverable for a run that did not clear every gate", async () => {
    // Swept across every gate rather than asserted once: the property is that
    // no single failing gate has a path to the ledger.
    for (const gate of ["video.cutGate", "gate.lintPost", "gate.leakCheck", "video.selfEvalGate", "video.brandGate"]) {
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
        inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
        async execute(args: unknown) {
          transcribedPaths.push((args as { videoPath: string }).videoPath);
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

  it("blocks intake when a run attaches neither an asset nor a sourcePath", async () => {
    const h = stubTools();
    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router: smartFakeRouter([GOOD_MOMENT, GOOD_COMMENTARY]),
      autoApprove: true,
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
      ...PARAMS,
      runId: "run-tt-noasset",
      input: { mediaAssets: [{ role: "source" }] },
    });

    // The malformed asset is dropped rather than crashing the run, and the
    // run then blocks honestly on having no source at all.
    expect(result.status).toBe("blocked_intake");
  });

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
