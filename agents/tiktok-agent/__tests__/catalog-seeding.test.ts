import { describe, expect, it, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type AgentContext, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosTopicsTools } from "@agent-engine/tool-karos-topics";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";
import { CLIP_LANE } from "../src/workflow/types.js";

/**
 * SCRUM-239 (T-A12): `topics.topUp` had exactly one production caller in this
 * repo before this fix — `topics.reserve`'s own proactive top-up, which
 * passes an empty array (`packages/tools/karos-topics/src/reserve.ts`, "Fix
 * 1"). That is a documented no-op: the `commentary-clip` lane this agent
 * reserves from could never gain a row on its own, so every reservation
 * breached `LANE_FLOOR` and every real run held, forever, regardless of what
 * the client actually configured.
 *
 * These tests use the REAL `karos-topics` tool set (a real `WorkspaceStore`
 * on a temp dir, not a stub) so a passing test here is proof that real rows
 * — the client's own `guestWatchlist` entries — actually reach the catalog
 * file on disk and actually get reserved/committed by a real run, not just
 * that a stubbed `topics.reserve` was called. Every other tool (video/gates/
 * ledger/memory) is still stubbed, matching `workflow.test.ts`'s own
 * documented reason for keeping ffmpeg/Python out of these tests.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.join(HERE, "..", "prompts");
const PARAMS = { clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring" as const };

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

function goodCommentary(sourceCredit: string) {
  return {
    caption: `Our read on this: the number is right and the conclusion is wrong. Via ${sourceCredit}.`,
    about: "A clip where a guest gives a figure we disagree with the framing of.",
    sourceCredit,
  };
}

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

interface Env {
  store: WorkspaceStore;
  rootDir: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tiktok-agent-catalog-"));
  return {
    store: new WorkspaceStore(rootDir),
    rootDir,
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}

/** Builds a full tool registry: REAL topics.* (backed by `store`), everything else stubbed. */
function buildTools(store: WorkspaceStore, config: unknown): AgentToolRegistry {
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const pass = { verdict: "pass" as const, reason: "" };
  const tool = (name: string, run: (args: never) => unknown) => ({
    name,
    version: "1.0.0",
    inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    async execute(args: never) {
      return run(args);
    },
  });

  const topicsTools = createKarosTopicsTools(store);

  return {
    "client.getConfig": tool("client.getConfig", () => ok(config)),
    "client.getVoiceRules": tool("client.getVoiceRules", () => ok({ tone: "direct" })),
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [] })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    ...topicsTools,
    "video.transcribe": tool("video.transcribe", () => ok({ words: transcriptWords() })),
    "video.cutGate": tool("video.cutGate", () => ok(pass)),
    "video.render": tool("video.render", () => ok({ outputPath: "/tmp/clip.mp4" })),
    "video.selfEvalGate": tool("video.selfEvalGate", () => ok(pass)),
    "video.brandGate": tool("video.brandGate", () => ok(pass)),
    "gate.lintPost": tool("gate.lintPost", () => ok(pass)),
    "gate.brandCompliance": tool("gate.brandCompliance", () => ok(pass)),
    "gate.noPlaceholder": tool("gate.noPlaceholder", () => ok(pass)),
    "gate.leakCheck": tool("gate.leakCheck", () => ok(pass)),
    "ledger.writeDeliverable": tool("ledger.writeDeliverable", () => ok({ id: "deliv-1", created: true })),
    "memory.appendDecision": tool("memory.appendDecision", () => ok({ id: "dec-1" })),
  } as unknown as AgentToolRegistry;
}

async function runWorkflow(tools: AgentToolRegistry, runId: string, sourceCreditForCommentary: string) {
  const workflow = createTikTokAgentWorkflow({
    tools,
    promptStore: new FilePromptStore(PROMPTS_ROOT),
    router: smartFakeRouter([GOOD_MOMENT, goodCommentary(sourceCreditForCommentary)]),
    autoApprove: true,
  });
  return new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
    ...PARAMS,
    runId,
    input: { sourcePath: "/tmp/episode.mp4" },
  });
}

describe("00b-seed-catalog: real rows actually reach the commentary-clip catalog (SCRUM-239)", () => {
  let env: Env;

  afterEach(async () => {
    await env.cleanup();
  });

  it("seeds the empty commentary-clip lane from guestWatchlist and lets the run reserve+commit a real row", async () => {
    env = await setupEnv();
    const config = {
      tiktokClips: {
        sourcePool: ["The Show"],
        guestWatchlist: ["Jane Doe", "John Smith", "Ada Lee", "Sam Diaz", "Ravi Rao", "Kim Park", "Lee Wu"],
        narrowing: [],
      },
    };
    const tools = buildTools(env.store, config);

    // Ground truth before the run: nothing was ever written for this client.
    expect(await env.store.readJson<unknown[]>("acme", ["topics", "catalog"])).toBeUndefined();

    const result = await runWorkflow(tools, "run-tt-seed-1", "Jane Doe on The Show ep. 12");

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { topic: string; lane: string };
    expect(output.lane).toBe(CLIP_LANE);
    // The reserved topic is one of the client's own real names, never invented.
    expect(config.tiktokClips.guestWatchlist).toContain(output.topic);

    // Prove it on disk, not just via the workflow's return value: the real
    // catalog file now has one row per guestWatchlist entry, in the right
    // lane, and exactly one of them is committed (the one this run shipped).
    const catalog = await env.store.readJson<Array<{ topic: string; lane: string; status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog).toBeDefined();
    const clipRows = catalog!.filter((r) => r.lane === CLIP_LANE);
    expect(clipRows).toHaveLength(7);
    expect(clipRows.map((r) => r.topic).sort()).toEqual([...config.tiktokClips.guestWatchlist].sort());
    expect(clipRows.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(clipRows.filter((r) => r.status === "available")).toHaveLength(6);
  });

  it("never repeats a name it already committed across two separate runs", async () => {
    env = await setupEnv();
    const config = {
      tiktokClips: {
        sourcePool: ["The Show"],
        // 7 names: the floor is 5, so two single-topic reservations (7 -> 6 -> 5) both clear it.
        guestWatchlist: ["Jane Doe", "John Smith", "Ada Lee", "Sam Diaz", "Ravi Rao", "Kim Park", "Lee Wu"],
        narrowing: [],
      },
    };
    const tools = buildTools(env.store, config);

    const first = await runWorkflow(tools, "run-tt-seed-a", "first guest, real show");
    const second = await runWorkflow(tools, "run-tt-seed-b", "second guest, real show");

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") throw new Error("unreachable");

    const firstTopic = (first.output as { topic: string }).topic;
    const secondTopic = (second.output as { topic: string }).topic;
    expect(secondTopic).not.toBe(firstTopic);

    const catalog = await env.store.readJson<Array<{ topic: string; lane: string; status: string }>>("acme", ["topics", "catalog"]);
    const clipRows = catalog!.filter((r) => r.lane === CLIP_LANE);
    expect(clipRows.filter((r) => r.status === "committed").map((r) => r.topic).sort()).toEqual([firstTopic, secondTopic].sort());
    // Seeding ran again on the second run (00b-seed-catalog is unconditional)
    // but added nothing new: every real name was already known.
    expect(clipRows).toHaveLength(7);
  });

  it("re-running seeding on an already-seeded catalog adds no duplicate rows (idempotent)", async () => {
    env = await setupEnv();
    const config = {
      tiktokClips: {
        sourcePool: ["The Show"],
        guestWatchlist: ["Jane Doe", "John Smith", "Ada Lee", "Sam Diaz", "Ravi Rao", "Kim Park"],
        narrowing: [],
      },
    };
    const tools = buildTools(env.store, config);

    // Two runs' worth of 00b-seed-catalog against the same 6-name list -- the
    // second reservation will breach the floor (6 -> 5 -> 4 < 5) and hold, but
    // seeding itself must still be a clean no-op, not a duplicate write.
    await runWorkflow(tools, "run-tt-idem-a", "guest one");
    await runWorkflow(tools, "run-tt-idem-b", "guest two");

    const catalog = await env.store.readJson<Array<{ topic: string; lane: string }>>("acme", ["topics", "catalog"]);
    const clipRows = catalog!.filter((r) => r.lane === CLIP_LANE);
    expect(clipRows).toHaveLength(6);
  });

  it("holds honestly, seeding nothing, when the client's guestWatchlist is empty", async () => {
    env = await setupEnv();
    const config = {
      tiktokClips: { sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] },
    };
    const tools = buildTools(env.store, config);

    const result = await runWorkflow(tools, "run-tt-no-watchlist", "unused");

    expect(result.status).toBe("held");
    // No fabricated row landed in the catalog on this client's behalf.
    const catalog = await env.store.readJson<unknown[]>("acme", ["topics", "catalog"]);
    expect(catalog ?? []).toHaveLength(0);
  });

  it("does not touch a healthy catalog's other lanes (a client sharing this clientSlug with another channel agent)", async () => {
    env = await setupEnv();
    // Simulate instagram-agent having already written its own lane for this
    // same clientSlug, keyed only on clientSlug (not product) -- exactly the
    // shared-catalog-store situation this fix's own doc comment names.
    const seedCtx: AgentContext = { runId: "seed", ...PARAMS, metadata: {} };
    const preexisting = createKarosTopicsTools(env.store);
    await preexisting["topics.topUp"]!.execute(
      { topics: ["quarterly wins", "onboarding story", "launch recap", "team spotlight", "roadmap update", "customer win"], lane: "general" },
      { ctx: seedCtx },
    );

    const config = {
      tiktokClips: {
        sourcePool: ["The Show"],
        guestWatchlist: ["Jane Doe", "John Smith", "Ada Lee", "Sam Diaz", "Ravi Rao", "Kim Park", "Lee Wu"],
        narrowing: [],
      },
    };
    const tools = buildTools(env.store, config);

    const result = await runWorkflow(tools, "run-tt-multi-tenant", "Jane Doe on The Show ep. 12");

    // If the seeding step had gated on whole-catalog size (already 6 rows from
    // the "general" lane) it would have skipped seeding, and this reservation
    // -- CLIP_LANE still at zero -- would have held instead of completing.
    expect(result.status).toBe("completed");

    const catalog = await env.store.readJson<Array<{ topic: string; lane: string }>>("acme", ["topics", "catalog"]);
    const clipRows = catalog!.filter((r) => r.lane === CLIP_LANE);
    const generalRows = catalog!.filter((r) => r.lane === "general");
    expect(clipRows).toHaveLength(7);
    expect(generalRows).toHaveLength(6);
  });
});
