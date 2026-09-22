import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ABORT_SIGNAL_METADATA_KEY,
  MockAgent,
  agentAbortReason,
  type AgentContext,
  type AgentStepConfig,
  type AgentTool,
  type AgentToolOutcome,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelRouter,
} from "../src/index.js";

/**
 * Consuming the step's cancellation (2026-09-22).
 *
 * `step.agent` has aborted a signal on a timeout since AU5/SCRUM-316, and for
 * as long as that shipped, its own doc comment said what it was: "the
 * cancellation is now PROPAGATED, not yet CONSUMED". The agent kept taking
 * turns and kept calling tools for a step whose result had already been
 * written off as a `tooling_error` — on an instagram or tiktok step, real
 * images and real footage bought for output nobody would ever read.
 *
 * These tests are the consumer. Each one asserts something did NOT happen
 * after the abort, which is the only thing worth asserting here: an agent that
 * "handles" cancellation by noting it and carrying on has not handled it.
 */

const DraftOutput = z.object({ body: z.string() });
type DraftOutput = z.infer<typeof DraftOutput>;

const TIMEOUT_REASON = 'step "06-images" did not complete within 600000ms';

/** A context carrying the step's abort signal, exactly as `runStepAgent` builds it. */
function ctxWithSignal(signal: AbortSignal): AgentContext {
  return { runId: "run_1", clientSlug: "acme", productId: "instagram", runKind: "recurring", metadata: { [ABORT_SIGNAL_METADATA_KEY]: signal } };
}

function fakeRouter(turns: Array<() => CompletionResult<unknown> | Promise<CompletionResult<unknown>>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouter: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeRouter: completeAlias not used in these tests");
    }),
  } as unknown as ModelRouter;
}

function toolCallTurn(tool: string, args: unknown): () => CompletionResult<unknown> {
  return () => ({ output: { type: "tool_call", tool, args }, modelUsed: "claude-sonnet-4-6", inputTokens: { cached: 0, uncached: 100 }, outputTokens: 20 });
}

function finalTurn(output: unknown): () => CompletionResult<unknown> {
  return () => ({ output: { type: "final", output }, modelUsed: "claude-sonnet-4-6", inputTokens: { cached: 0, uncached: 100 }, outputTokens: 20 });
}

function fakeTool(name: string, execute: (args: unknown, context: { ctx: AgentContext }) => Promise<AgentToolOutcome<unknown>>): AgentTool {
  return { name, description: `Test double for ${name}.`, version: "1.0.0", inputSchema: z.unknown(), execute: vi.fn(execute) };
}

function config(overrides: Partial<AgentStepConfig<DraftOutput>> = {}): AgentStepConfig<DraftOutput> {
  return {
    id: "draft-post",
    description: "Draft a post",
    allowedTools: ["image.generate"],
    outputSchema: DraftOutput,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    ...overrides,
  };
}

describe("agentAbortReason", () => {
  it("is undefined outside a step, and undefined while the step still wants the result", () => {
    expect(agentAbortReason({ metadata: {} })).toBeUndefined();
    const controller = new AbortController();
    expect(agentAbortReason({ metadata: { [ABORT_SIGNAL_METADATA_KEY]: controller.signal } })).toBeUndefined();
  });

  it("carries the engine's own abort reason through, so a reader can tell cancelled from failed", () => {
    const controller = new AbortController();
    controller.abort(new Error(TIMEOUT_REASON));
    expect(agentAbortReason({ metadata: { [ABORT_SIGNAL_METADATA_KEY]: controller.signal } })).toMatch(/did not complete within 600000ms/);
  });
});

describe("BaseAgent — a cancelled step stops", () => {
  it("takes no turn at all when the step was already written off before the agent started", async () => {
    const controller = new AbortController();
    controller.abort(new Error(TIMEOUT_REASON));
    const router = fakeRouter([finalTurn({ body: "should never be produced" })]);
    const agent = new MockAgent({ router, tools: {} } as BaseAgentRuntime, config());

    const result = await agent.run(ctxWithSignal(controller.signal), { topic: "x" });

    expect(result.status).toBe("tooling_error");
    expect(router.complete).not.toHaveBeenCalled();
    expect(result.steps.at(-1)?.error).toMatch(/stopped: .*did not complete within 600000ms/);
  });

  it("stops after the turn that was in flight, instead of taking the next one", async () => {
    const controller = new AbortController();
    const image = fakeTool("image.generate", async () => ({ status: "success", result: { url: "https://example.test/1.png" } }));
    // The step times out WHILE the first turn is being served — the ordinary
    // shape, since the timeout is what stopped the engine waiting for this
    // very call.
    const router = fakeRouter([
      () => {
        controller.abort(new Error(TIMEOUT_REASON));
        return toolCallTurn("image.generate", { prompt: "a plate" })();
      },
      finalTurn({ body: "a second turn that must never happen" }),
    ]);
    const agent = new MockAgent({ router, tools: { "image.generate": image } } as BaseAgentRuntime, config());

    const result = await agent.run(ctxWithSignal(controller.signal), { topic: "x" });

    expect(result.status).toBe("tooling_error");
    // One turn served, one refused: the second queued turn is still queued.
    expect(router.complete).toHaveBeenCalledTimes(1);
    // And the money: the tool that turn asked for was never executed.
    expect(image.execute).not.toHaveBeenCalled();
  });

  it("does not execute a tool the cancelled turn had already chosen", async () => {
    const controller = new AbortController();
    const image = fakeTool("image.generate", async () => ({ status: "success", result: { url: "https://example.test/1.png" } }));
    // Aborted between the model answering and the tool running — the window a
    // between-turns check alone would miss, and the one where the spend is.
    const router = fakeRouter([
      () => {
        controller.abort(new Error(TIMEOUT_REASON));
        return toolCallTurn("image.generate", { prompt: "a plate" })();
      },
    ]);
    const agent = new MockAgent({ router, tools: { "image.generate": image } } as BaseAgentRuntime, config());

    const result = await agent.run(ctxWithSignal(controller.signal), { topic: "x" });

    expect(result.status).toBe("tooling_error");
    expect(image.execute).not.toHaveBeenCalled();
    expect(result.steps.some((step) => step.error?.includes("stopped before calling image.generate") === true)).toBe(true);
  });

  it("leaves an uncancelled step completely unchanged", async () => {
    const controller = new AbortController();
    const image = fakeTool("image.generate", async () => ({ status: "success", result: { url: "https://example.test/1.png" } }));
    const router = fakeRouter([toolCallTurn("image.generate", { prompt: "a plate" }), finalTurn({ body: "shipped" })]);
    const agent = new MockAgent({ router, tools: { "image.generate": image } } as BaseAgentRuntime, config());

    const result = await agent.run(ctxWithSignal(controller.signal), { topic: "x" });

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ body: "shipped" });
    expect(image.execute).toHaveBeenCalledTimes(1);
  });
});
