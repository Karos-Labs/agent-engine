import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { FilePromptStore, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";

/**
 * SCRUM-303 / AU19: tiktok-agent adopts `runReviewCycle` on top of the
 * terminal topic guardrail it already had. Before this, step 11 was a
 * single-shot approve/reject gate with no `revise` path — a reviewer who
 * wanted a different caption had no option but to reject the whole clip and
 * have someone dispatch a fresh run that knew nothing about why.
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

const FIRST_COMMENTARY = {
  caption: "Our read on this: the number is right and the conclusion is wrong. Via Jane Doe on The Show ep. 12.",
  about: "A clip where a guest gives a figure we disagree with the framing of.",
  sourceCredit: "Jane Doe on The Show ep. 12",
};

const REVISED_COMMENTARY = {
  caption: "The number holds up, the takeaway does not — here's why. Via Jane Doe on The Show ep. 12.",
  about: "A shorter, punchier take on the same disagreement, per the reviewer's note.",
  sourceCredit: "Jane Doe on The Show ep. 12",
};

/** Answers each router call with the next candidate in order, ignoring the schema — the calling sequence is deterministic. */
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
}

function stubTools(): Harness {
  const calls: string[] = [];
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const pass = { verdict: "pass" as const, reason: "" };

  const tool = (name: string, run: (args: never) => unknown) => ({
    name,
    version: "1.0.0",
    inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    async execute(args: never) {
      calls.push(name);
      return run(args);
    },
  });

  const tools: Record<string, unknown> = {
    "client.getConfig": tool("client.getConfig", () => ok({ tiktokClips: { sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] } })),
    "client.getVoiceRules": tool("client.getVoiceRules", () => ok({ tone: "direct" })),
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [] })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    "topics.reserve": tool("topics.reserve", () => ok({ reservationKey: "res-1", topics: ["The Show ep. 12 — the margin call moment"] })),
    "topics.commit": tool("topics.commit", () => ok({ committed: true })),
    "topics.release": tool("topics.release", () => ok({ released: true })),
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
    "memory.appendFeedback": tool("memory.appendFeedback", () => ok({ id: "fb-1" })),
  };
  return { tools: tools as unknown as AgentToolRegistry, calls };
}

describe("tiktok-agent review cycle (runReviewCycle)", () => {
  it("rewrites the commentary and re-renders on a revise decision, then delivers on approval", async () => {
    const h = stubTools();
    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      // moment, then commentary r0, then commentary r1 — in the order the
      // workflow itself calls the router.
      router: sequentialFakeRouter([GOOD_MOMENT, FIRST_COMMENTARY, REVISED_COMMENTARY]),
    });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "run-tt-revise";

    const r0 = await engine.run(workflow, { ...PARAMS, runId, input: { sourcePath: "/tmp/episode.mp4" } });
    expect(r0.status).toBe("awaiting_gate");
    if (r0.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r0.pendingGateId).toContain("11-clip-review-r0");

    await engine.resolveGate(runId, "11-clip-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Shorten the caption and lead with the disagreement, not the number.",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflow, { ...PARAMS, runId, input: { sourcePath: "/tmp/episode.mp4" } });
    expect(r1.status).toBe("awaiting_gate");
    if (r1.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r1.pendingGateId).toContain("11-clip-review-r1");

    await engine.resolveGate(runId, "11-clip-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflow, { ...PARAMS, runId, input: { sourcePath: "/tmp/episode.mp4" } });
    expect(final.status).toBe("completed");
    if (final.status !== "completed") throw new Error("unreachable");
    expect((final.output as { commentary: { caption: string } }).commentary.caption).toBe(REVISED_COMMENTARY.caption);

    const ids = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    // Round 1's COMPOSE steps are revision-scoped, so they genuinely re-ran —
    // including a real second render, not a reused one.
    expect(ids).toContain("06-commentary");
    expect(ids).toContain("06-commentary-r1");
    expect(ids).toContain("08-render-r1");
    expect(ids).toContain("09-qa-gate-r1");
    // Everything upstream of the draft loop kept its id and ran exactly once.
    expect(ids.filter((i) => i === "03-select-moment")).toHaveLength(1);
    expect(ids).not.toContain("03-select-moment-r1");
    expect(ids.filter((i) => i === "04-cut-bounds")).toHaveLength(1);

    // The moment was never released — a clip genuinely shipped.
    expect(h.calls).toContain("topics.commit");
    expect(h.calls).not.toContain("topics.release");
    // Two full renders, one per round.
    expect(h.calls.filter((c) => c === "video.render")).toHaveLength(2);
  }, 30000);

  it("saves the reviewer's words to client memory, on a revision and on an approval alike", async () => {
    const h = stubTools();
    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router: sequentialFakeRouter([GOOD_MOMENT, FIRST_COMMENTARY]),
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "run-tt-memory";

    await engine.run(workflow, { ...PARAMS, runId, input: { sourcePath: "/tmp/episode.mp4" } });
    await engine.resolveGate(runId, "11-clip-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      feedback: "The disagreement framing is working, keep doing that.",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflow, { ...PARAMS, runId, input: { sourcePath: "/tmp/episode.mp4" } });
    expect(final.status).toBe("completed");

    expect(h.calls).toContain("memory.appendFeedback");
  }, 30000);

  it("releases the reservation on an outright rejection, exactly once", async () => {
    const h = stubTools();
    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router: sequentialFakeRouter([GOOD_MOMENT, FIRST_COMMENTARY]),
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "run-tt-reject";

    await engine.run(workflow, { ...PARAMS, runId, input: { sourcePath: "/tmp/episode.mp4" } });
    await engine.resolveGate(runId, "11-clip-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "off-brand this week",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflow, { ...PARAMS, runId, input: { sourcePath: "/tmp/episode.mp4" } });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/review rejected/i);

    expect(h.calls.filter((c) => c === "topics.release")).toHaveLength(1);
    expect(h.calls).not.toContain("ledger.writeDeliverable");
  }, 30000);
});

describe("tiktok-agent terminal topic guardrail preload (runTopicGuardrail)", () => {
  it("reads forbiddenTopics from client.getConfig once at intake, not a second time inside the guardrail", async () => {
    const h = stubTools();
    (h.tools as unknown as Record<string, unknown>)["client.getConfig"] = {
      name: "client.getConfig",
      version: "1.0.0",
      inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
      async execute() {
        h.calls.push("client.getConfig");
        return {
          status: "success" as const,
          result: { tiktokClips: { sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] }, forbiddenTopics: ["cryptocurrency"] },
        };
      },
    };

    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router: sequentialFakeRouter([GOOD_MOMENT, FIRST_COMMENTARY, { violatedTopics: [] }]),
      autoApprove: true,
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, {
      ...PARAMS,
      runId: "run-tt-guardrail-preload",
      input: { sourcePath: "/tmp/episode.mp4" },
    });

    expect(result.status).toBe("completed");
    // Exactly one client.getConfig call for the whole run — the guardrail
    // used what step 00 already loaded rather than reading it again.
    expect(h.calls.filter((c) => c === "client.getConfig")).toHaveLength(1);
  }, 30000);
});
