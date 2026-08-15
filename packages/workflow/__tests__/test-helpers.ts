import { vi } from "vitest";
import { z } from "zod";
import { MockAgent, type AgentStepConfig, type BaseAgentRuntime, type CompletionResult, type ModelRouter } from "@agent-engine/core";

/** A router whose `.complete()` always returns a "final" turn with the given output — one call, one draft, no tool use. */
export function fakeRouterAlwaysFinal(output: unknown, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): ModelRouter {
  const model = opts.model ?? "claude-sonnet-4-6";
  return {
    complete: vi.fn(
      async (): Promise<CompletionResult<unknown>> => ({
        output: { type: "final", output },
        modelUsed: model,
        inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
        outputTokens: opts.outputTokens ?? 50,
      }),
    ),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeRouterAlwaysFinal: completeAlias not used in these tests");
    }),
  } as unknown as ModelRouter;
}

/** A router whose `.complete()` replays a fixed sequence of turns in order — for agents that call a tool before finishing. */
export function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouterSequence: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeRouterSequence: completeAlias not used in these tests");
    }),
  } as unknown as ModelRouter;
}

/** A router whose `.complete()` always throws — simulates a broken model call (tooling_error). */
export function fakeRouterAlwaysThrows(message = "model unavailable"): ModelRouter {
  return {
    complete: vi.fn(async () => {
      throw new Error(message);
    }),
    completeAlias: vi.fn(async () => {
      throw new Error(message);
    }),
  } as unknown as ModelRouter;
}

/** A trivial `MockAgent` that always produces `output` as its terminal result on the first turn. */
export function makeSimpleAgent<TOutput>(
  outputSchema: z.ZodType<TOutput>,
  router: ModelRouter,
  overrides: Partial<AgentStepConfig<TOutput>> = {},
): MockAgent<TOutput> {
  return makeAgent(outputSchema, router, {}, overrides);
}

/** A `MockAgent` wired to a real (or fake) tool registry — for exercising real Layer 3 tool calls / self-critique gates. */
export function makeAgent<TOutput>(
  outputSchema: z.ZodType<TOutput>,
  router: ModelRouter,
  runtimeOverrides: Partial<Omit<BaseAgentRuntime, "router">> = {},
  configOverrides: Partial<AgentStepConfig<TOutput>> = {},
): MockAgent<TOutput> {
  const runtime: BaseAgentRuntime = { router, tools: {}, ...runtimeOverrides };
  const config: AgentStepConfig<TOutput> = {
    id: "test-step",
    description: "A test step",
    allowedTools: [],
    outputSchema,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    ...configOverrides,
  };
  return new MockAgent(runtime, config);
}

export const DraftOutputSchema = z.object({ body: z.string() });
export type DraftOutput = z.infer<typeof DraftOutputSchema>;
