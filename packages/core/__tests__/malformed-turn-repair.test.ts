import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  MockAgent,
  StructuredOutputValidationError,
  type AgentContext,
  type AgentStepConfig,
  type AgentTool,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelRouter,
} from "../src/index.js";

/**
 * The repair path for a model turn that comes back complete but shaped wrong.
 *
 * Before this existed, one malformed turn ended the whole run: the adapter's
 * `schema.parse` threw, `BaseAgent` returned `tooling_error` immediately, and
 * the workflow surfaced `draft step resolved to "tooling_error"` — with the
 * offending payload discarded and the turn's real token spend recorded as
 * zero. prep runs pubsub-21532935275023108 (x-agent) and
 * pubsub-21066167120415191 (linkedin-agent) both died that way, 3 and 1 turns
 * into an 8-turn budget respectively.
 */

const DraftOutput = z.object({ body: z.string() });
type DraftOutput = z.infer<typeof DraftOutput>;

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "x",
  runKind: "recurring",
  metadata: {},
};

const USAGE = { modelUsed: "claude-sonnet-4-6", inputTokens: { cached: 100, uncached: 900 }, outputTokens: 250 };

function malformedTurn(rawPayload: unknown = { turn: { body: "no envelope" } }, usage: typeof USAGE | null = USAGE) {
  return () => {
    throw new StructuredOutputValidationError(
      'anthropic: model "claude-sonnet-4-6" returned a malformed structured output — it did not match the step\'s turn schema: ' +
        '[{"code":"invalid_union","note":"No matching discriminator","path":["type"]}]',
      { rawPayload, ...(usage ? { usage } : {}) },
    );
  };
}

function finalTurn(output: unknown): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: 100 },
    outputTokens: 20,
  });
}

/**
 * Records every prompt (the uncached per-turn user message) and every system
 * block (the cached prefix — see SCRUM-298) the agent sends, so the repair
 * feedback and the response contract can each be asserted against the one
 * they actually land in on the wire.
 */
function fakeRouter(turns: Array<() => CompletionResult<unknown> | Promise<CompletionResult<unknown>>>) {
  const queue = [...turns];
  const prompts: string[] = [];
  const systems: string[] = [];
  const complete = vi.fn(async (prompt: string, _schema: unknown, _policy: unknown, opts?: { system?: string }) => {
    prompts.push(prompt);
    systems.push(opts?.system ?? "");
    const next = queue.shift();
    if (!next) throw new Error("fakeRouter: exhausted configured turns");
    return next();
  });
  return {
    prompts,
    systems,
    complete,
    router: { complete, completeAlias: vi.fn() } as unknown as ModelRouter,
  };
}

function config(overrides: Partial<AgentStepConfig<DraftOutput>> = {}): AgentStepConfig<DraftOutput> {
  return {
    id: "draft-post",
    description: "Draft one post",
    allowedTools: ["render.preview"],
    outputSchema: DraftOutput,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    ...overrides,
  };
}

const renderPreview: AgentTool = {
  name: "render.preview",
  description: "Test double for render.preview.",
  version: "1.0.0",
  inputSchema: z.unknown(),
  execute: vi.fn(async () => ({ status: "success" as const, result: { withinLimit: true } })),
};

function runtimeFor(router: ModelRouter): BaseAgentRuntime {
  return { router, tools: { "render.preview": renderPreview } };
}

describe("BaseAgent — malformed turn repair", () => {
  it("re-prompts once and completes, instead of ending the run on the first malformed turn", async () => {
    const { router, prompts } = fakeRouter([malformedTurn(), finalTurn({ body: "the repaired post" })]);

    const result = await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ body: "the repaired post" });
    // Both turns are recorded — the failure is not swept out of the report.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.status).toBe("tooling_error");
    expect(result.steps[1]!.status).toBe("success");
    expect(prompts).toHaveLength(2);
  });

  it("tells the repair turn what was wrong and what it actually sent", async () => {
    const { router, prompts } = fakeRouter([
      malformedTurn({ turn: { body: "bare output, no type field" } }),
      finalTurn({ body: "fixed" }),
    ]);

    await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    const repairPrompt = prompts[1]!;
    expect(repairPrompt).toContain("malformed_turn");
    expect(repairPrompt).toContain("No matching discriminator");
    // The model's own offending payload, echoed back so it can see the mistake.
    expect(repairPrompt).toContain("bare output, no type field");
  });

  it("records the failed turn's real token spend rather than zeroing it", async () => {
    const { router } = fakeRouter([malformedTurn(), finalTurn({ body: "ok" })]);

    const result = await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    const failed = result.steps[0]!;
    expect(failed.modelUsed).toBe("claude-sonnet-4-6");
    expect(failed.inputTokens).toEqual({ cached: 100, uncached: 900 });
    expect(failed.outputTokens).toBe(250);
    expect(failed.costUsd).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(failed.error).toMatch(/malformed model turn.*raw payload:/s);
  });

  it("falls back to zeroed usage, without throwing, when the provider reported none", async () => {
    const { router } = fakeRouter([malformedTurn({ turn: {} }, null), finalTurn({ body: "ok" })]);

    const result = await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    expect(result.status).toBe("completed");
    expect(result.steps[0]!.costUsd).toBe(0);
    expect(result.steps[0]!.inputTokens).toEqual({ cached: 0, uncached: 0 });
  });

  it("gives up as a tooling_error once the repair budget is spent", async () => {
    const { router, complete } = fakeRouter([malformedTurn(), malformedTurn(), finalTurn({ body: "never reached" })]);

    const result = await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    expect(result.status).toBe("tooling_error");
    expect(result.finalOutput).toBeNull();
    // Two attempts, then it stops — it does not burn the rest of maxSteps.
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.steps).toHaveLength(2);
  });

  it("counts malformed turns across the whole step, not per consecutive run", async () => {
    const { router } = fakeRouter([
      malformedTurn(),
      () => ({ output: { type: "tool_call", tool: "render.preview", args: {} }, modelUsed: "claude-sonnet-4-6", inputTokens: { cached: 0, uncached: 10 }, outputTokens: 5 }),
      malformedTurn(),
      finalTurn({ body: "never reached" }),
    ]);

    const result = await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    expect(result.status).toBe("tooling_error");
  });

  it("honours maxMalformedTurns: 0 as the old fail-on-first behaviour", async () => {
    const { router, complete } = fakeRouter([malformedTurn(), finalTurn({ body: "never reached" })]);

    const result = await new MockAgent(runtimeFor(router), config({ maxMalformedTurns: 0 })).run(ctx, { topic: "ai" });

    expect(result.status).toBe("tooling_error");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("honours a raised repair budget", async () => {
    const { router } = fakeRouter([malformedTurn(), malformedTurn(), finalTurn({ body: "third time" })]);

    const result = await new MockAgent(runtimeFor(router), config({ maxMalformedTurns: 2 })).run(ctx, { topic: "ai" });

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ body: "third time" });
  });

  // The repair budget must not become a general-purpose retry: a dead
  // provider, bad auth, or an exhausted output ceiling are all conditions
  // where re-asking the same question cannot help.
  it("does not repair an ordinary model-call failure", async () => {
    const { router, complete } = fakeRouter([
      () => {
        throw new Error("anthropic: model hit the 16384-token output limit before completing its structured output");
      },
      finalTurn({ body: "never reached" }),
    ]);

    const result = await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    expect(result.status).toBe("tooling_error");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.steps[0]!.error).toMatch(/model call failed:.*token output limit/s);
  });

  it("still respects maxSteps when every turn is malformed under a large repair budget", async () => {
    const { router, complete } = fakeRouter(Array.from({ length: 10 }, () => malformedTurn()));

    const result = await new MockAgent(runtimeFor(router), config({ maxSteps: 3, maxMalformedTurns: 99 })).run(ctx, { topic: "ai" });

    expect(result.status).toBe("budget_exceeded");
    expect(complete).toHaveBeenCalledTimes(3);
  });
});

// SCRUM-298: the response contract and the tool schemas are constant for the
// life of a run, so they now live in the CACHED `system` block instead of
// being re-serialized into the per-turn (uncached) prompt — see
// `buildSystemPromptWithContract`. `prompts` stays free of this content;
// `systems` is where it belongs now.
describe("BaseAgent — response contract in the system prompt", () => {
  it("states the envelope, the required discriminator, and the `turn` wrapper for a tool-bearing step", async () => {
    const { router, prompts, systems } = fakeRouter([finalTurn({ body: "ok" })]);

    await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    const system = systems[0]!;
    expect(system).toContain("responseContract");
    expect(system).toContain('{\\"turn\\": <turn-object>}');
    expect(system).toContain('\\"type\\" is REQUIRED');
    expect(system).toContain("tool_call");
    expect(system).toContain("never a JSON-encoded string in place of an object");
    expect(system).toContain("allowedTools names");
    // And it's actually gone from the per-turn prompt, not merely duplicated.
    expect(prompts[0]!).not.toContain("responseContract");
  });

  // Building the prompt happens outside `runOneTurn`'s try/catch, so a schema
  // `z.toJSONSchema()` cannot represent must degrade, never throw — otherwise
  // describing the envelope would be a worse failure than not describing it.
  it("degrades instead of crashing the step when the output schema can't be rendered as JSON Schema", async () => {
    const unrepresentable = z.custom<{ body: string }>(() => true);
    const { router, systems } = fakeRouter([finalTurn({ body: "ok" })]);

    const result = await new MockAgent(runtimeFor(router), {
      ...config(),
      outputSchema: unrepresentable,
    }).run(ctx, { topic: "ai" });

    expect(result.status).toBe("completed");
    // Still describes the wrapped envelope, from the rule buildTurnSchema guarantees.
    expect(systems[0]!).toContain('{\\"turn\\": <turn-object>}');
  });

  // A step with no tools gets an object-rooted schema that is never wrapped —
  // telling it to nest under `turn` would manufacture the exact failure this
  // contract exists to prevent.
  it("describes an unwrapped root, and no tool_call variant, for a step with no tools", async () => {
    const { router, systems } = fakeRouter([finalTurn({ body: "ok" })]);

    await new MockAgent(runtimeFor(router), config({ allowedTools: [] })).run(ctx, { topic: "ai" });

    const system = systems[0]!;
    expect(system).toContain("Return the turn object itself, at the root.");
    expect(system).not.toContain('{\\"turn\\": <turn-object>}');
    expect(system).not.toContain("tool_call");
  });
});
