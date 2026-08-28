import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CompletionResult, MockAgent, ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "../src/index.js";
import type { WorkflowContext } from "../src/index.js";
import { fakeRouterSequence, makeAgent, makeSimpleAgent, DraftOutputSchema } from "./test-helpers.js";

/**
 * SCRUM-361 item 3, precondition 1 — the producer half.
 *
 * `servedBy` is produced per TURN by `resilient-claude-adapter` and carried on
 * `AgentStepTelemetry` (core/src/types/agent-step.ts:138). It survives all the
 * way into the checkpointed `AgentExecutionResult`, and is then DROPPED at one
 * seam: `runStepAgent`'s `recordCostAndTokens(...)` call, which reads
 * `result.steps.at(-1)?.modelUsed` and nothing else off the turns.
 *
 * ## The attribution rule under test, and why it is not the obvious one
 *
 * `model` on the row is the LAST turn's model. Hop is NOT — a step is
 * attributed to the fallback if ANY of its turns was, because the question the
 * reconciliation asks is "was any part of this cost billed by someone other
 * than Google", not "who answered last". The second test below is the one that
 * separates those two rules: its final turn is primary-served and its first
 * turn is not, so a last-turn implementation passes test 1 and fails test 2.
 *
 * ## What makes these fail
 *
 * Test 1 fails if the seam drops `servedBy` at all (today's behaviour).
 * Test 2 fails additionally if hop is taken from the last turn.
 * Test 3 fails if a primary-only step invents a hop value — which would make
 * every row look failed-over and swing the reconciliation the other way.
 */

const captured: Record<string, unknown>[] = [];

vi.mock("@agent-engine/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agent-engine/telemetry")>();
  return {
    ...actual,
    recordCostAndTokens: (_span: unknown, attrs: Record<string, unknown>) => {
      captured.push(attrs);
    },
  };
});

beforeEach(() => {
  captured.length = 0;
});

const baseParams = { runId: "run_hop_1", clientSlug: "acme", productId: "instagram", runKind: "recurring" as const };

/** One `final` turn, served by the given hop. Mirrors what `resilient-claude-adapter` returns. */
function routerServedBy(
  hop: "primary" | "secondary" | "tertiary",
  adapter: string,
  opts: { model?: string } = {},
): ModelRouter {
  return {
    complete: vi.fn(
      async (): Promise<CompletionResult<unknown>> => ({
        output: { type: "final", output: { body: "drafted" } },
        modelUsed: opts.model ?? "claude-sonnet-4-6",
        inputTokens: { cached: 0, uncached: 100 },
        outputTokens: 50,
        provenance: { hop, servedBy: adapter, failedOver: hop === "primary" ? [] : [{ from: "vertex-claude", errorClass: "rate_limited", status: 429 }] },
      }),
    ),
    completeAlias: vi.fn(async () => {
      throw new Error("not used");
    }),
  } as unknown as ModelRouter;
}

/** A no-op tool, purely so an agent can be made to take two turns. */
const NOOP_TOOL = {
  name: "noop.ping",
  version: "1.0.0",
  inputSchema: z.object({}),
  execute: async () => ({ status: "success" as const, result: { ok: true } }),
};

// Generic over the agent output, not `BaseAgent<unknown>`: SCRUM-299 added
// `selfCritique.gateInput: (draft: TOutput) => unknown`, which makes `BaseAgent<T>`
// INVARIANT in T — a `MockAgent<DraftOutput>` is no longer assignable to the
// `unknown` instantiation that `Parameters<...>[1]` collapses the generic to.
// `step.agent` itself is generic, so inferring TOutput here matches how every
// real call site is typed.
async function runOneAgentStep<TOutput>(agent: MockAgent<TOutput>): Promise<void> {
  const engine = new WorkflowEngine(new MemoryDurableStepStore());
  const result = await engine.run(async (wf: WorkflowContext) => wf.step.agent("draft", agent, {}), baseParams);
  expect(result.status, "the workflow itself must have completed — otherwise the telemetry call never ran").toBe("completed");
  // Proves the intervention took effect before its result is read.
  expect(captured.length, "recordCostAndTokens must have been called exactly once").toBe(1);
}

describe("step.agent attributes its BI row to the hop that served it", () => {
  it("passes the fallback hop and adapter through to the agent_runs_bi row", async () => {
    await runOneAgentStep(makeSimpleAgent(DraftOutputSchema, routerServedBy("secondary", "anthropic")));

    expect(captured[0]!["servedByHop"]).toBe("secondary");
    expect(captured[0]!["servingAdapter"]).toBe("anthropic");
  });

  it("attributes the step to the fallback when ANY turn was, even if the LAST turn was primary", async () => {
    // Turn 1: tool call, served by the direct-Anthropic hop — billed by Anthropic.
    // Turn 2: final answer, served normally by Vertex — billed by Google.
    // The row's `model` follows the last turn; the hop must not.
    const router = fakeRouterSequence([
      () => ({
        output: { type: "tool_call", tool: "noop.ping", args: {} },
        modelUsed: "claude-sonnet-4-6",
        inputTokens: { cached: 0, uncached: 80 },
        outputTokens: 20,
        provenance: { hop: "secondary", servedBy: "anthropic", failedOver: [{ from: "vertex-claude", errorClass: "rate_limited", status: 429 }] },
      }),
      () => ({
        output: { type: "final", output: { body: "drafted" } },
        modelUsed: "claude-sonnet-4-6",
        inputTokens: { cached: 0, uncached: 120 },
        outputTokens: 15,
      }),
    ] as never);
    const agent = makeAgent(DraftOutputSchema, router, { tools: { "noop.ping": NOOP_TOOL as never } }, { allowedTools: ["noop.ping"] });

    await runOneAgentStep(agent);

    expect(captured[0]!["servedByHop"], "a step with any fallback-served turn is Anthropic-billed in part").toBe("secondary");
    expect(captured[0]!["servingAdapter"]).toBe("anthropic");
  });

  it("leaves hop and adapter unset when every turn was primary-served — absent must not read as failed over", async () => {
    await runOneAgentStep(makeSimpleAgent(DraftOutputSchema, routerServedBy("primary", "vertex-claude")));

    expect(captured[0]!["servedByHop"]).toBeUndefined();
    expect(captured[0]!["servingAdapter"]).toBeUndefined();
  });
});
