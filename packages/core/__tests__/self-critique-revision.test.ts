import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  MockAgent,
  type AgentContext,
  type AgentStepConfig,
  type AgentTool,
  type AgentToolOutcome,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelRouter,
} from "../src/index.js";

/**
 * The revision phase of self-critique (RFC-01 §5.6).
 *
 * It used to allow the reviser exactly one turn and demand a `final` from it:
 * anything else — including a perfectly successful tool call — ended the run
 * as a `tooling_error`, and since the offending turn had *succeeded*, nothing
 * in the step record explained it. prep run pubsub-20272673526122768
 * (newsletter-agent, `09-draft-post`) died exactly that way: draft → gate
 * content_fail → revision turn called `render.preview` to re-check the
 * revised text's length → run dead, four healthy turns, no error recorded.
 */

const DraftOutput = z.object({ body: z.string() });
type DraftOutput = z.infer<typeof DraftOutput>;

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "newsletter", runKind: "recurring", metadata: {} };

function fakeRouter(turns: Array<() => CompletionResult<unknown>>) {
  const queue = [...turns];
  const complete = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fakeRouter: exhausted configured turns");
    return next();
  });
  return { complete, router: { complete, completeAlias: vi.fn() } as unknown as ModelRouter };
}

const finalTurn = (output: unknown) => () => ({
  output: { type: "final", output },
  modelUsed: "claude-sonnet-4-6",
  inputTokens: { cached: 0, uncached: 100 },
  outputTokens: 20,
});

const toolCallTurn = (tool: string, args: unknown = {}) => () => ({
  output: { type: "tool_call", tool, args },
  modelUsed: "claude-sonnet-4-6",
  inputTokens: { cached: 0, uncached: 50 },
  outputTokens: 10,
});

function fakeTool(name: string, execute: (args: unknown) => Promise<AgentToolOutcome<unknown>>): AgentTool {
  return { name, description: `Test double for ${name}.`, version: "1.0.0", inputSchema: z.unknown(), execute: vi.fn(execute) };
}

/** Fails its first verdict, passes every one after — the shape that drives exactly one revision. */
function failThenPassGate(): AgentTool {
  let calls = 0;
  return fakeTool("gate.test", async () => {
    calls++;
    return {
      status: "success",
      result:
        calls === 1
          ? { verdict: "content_fail", reason: "over the character limit", evidence: ["399 chars"], toolVersion: "1.0.0" }
          : { verdict: "pass", evidence: [], toolVersion: "1.0.0" },
    };
  });
}

function config(overrides: Partial<AgentStepConfig<DraftOutput>> = {}): AgentStepConfig<DraftOutput> {
  return {
    id: "draft-post",
    description: "Draft one post",
    allowedTools: ["render.preview", "gate.test"],
    outputSchema: DraftOutput,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    selfCritique: { gateTool: "gate.test", maxRevisions: 1 },
    ...overrides,
  };
}

describe("BaseAgent — a reviser may use tools", () => {
  // The newsletter-agent reproduction, turn for turn.
  it("completes when the revision calls a tool before producing its revised draft", async () => {
    const render = fakeTool("render.preview", async () => ({ status: "success", result: { characterCount: 240, withinLimit: true } }));
    const gate = failThenPassGate();
    const { router } = fakeRouter([
      finalTurn({ body: "draft v1, too long" }), // draft
      toolCallTurn("render.preview", { text: "revised" }), // revision checks itself first — previously fatal
      finalTurn({ body: "draft v2, within limit" }), // revised draft
    ]);
    const runtime: BaseAgentRuntime = { router, tools: { "render.preview": render, "gate.test": gate } };

    const result = await new MockAgent(runtime, config()).run(ctx, {});

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ body: "draft v2, within limit" });
    expect(render.execute).toHaveBeenCalledTimes(1);
    // draft, gate content_fail, revision tool_call, revision final, gate pass
    expect(result.steps).toHaveLength(5);
  });

  it("lets the reviser take several tool turns, still bounded by the step's shared maxSteps", async () => {
    const render = fakeTool("render.preview", async () => ({ status: "success", result: { withinLimit: true } }));
    const gate = failThenPassGate();
    const { router, complete } = fakeRouter([
      finalTurn({ body: "v1" }),
      toolCallTurn("render.preview"),
      toolCallTurn("render.preview"),
      finalTurn({ body: "v2" }),
    ]);
    const runtime: BaseAgentRuntime = { router, tools: { "render.preview": render, "gate.test": gate } };

    const result = await new MockAgent(runtime, config({ maxSteps: 8 })).run(ctx, {});

    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(4);
  });

  // The gate turns consume the same allowance as the model turns, so a
  // revision cannot reset the budget and run the step past its bound.
  it("reports budget_exceeded, not tooling_error, when the reviser runs out of shared steps", async () => {
    const render = fakeTool("render.preview", async () => ({ status: "success", result: { withinLimit: false } }));
    const gate = failThenPassGate();
    const { router } = fakeRouter([
      finalTurn({ body: "v1" }),
      toolCallTurn("render.preview"),
      toolCallTurn("render.preview"),
      toolCallTurn("render.preview"),
    ]);
    const runtime: BaseAgentRuntime = { router, tools: { "render.preview": render, "gate.test": gate } };

    const result = await new MockAgent(runtime, config({ maxSteps: 4 })).run(ctx, {});

    expect(result.status).toBe("budget_exceeded");
    expect(result.finalOutput).toBeNull();
  });

  it("still returns content_fail when the gate rejects the revised draft too", async () => {
    const gate = fakeTool("gate.test", async () => ({
      status: "success",
      result: { verdict: "content_fail", reason: "still banned phrasing", evidence: [], toolVersion: "1.0.0" },
    }));
    const { router } = fakeRouter([finalTurn({ body: "v1" }), finalTurn({ body: "v2" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.test": gate } };

    const result = await new MockAgent(runtime, config({ allowedTools: ["gate.test"] })).run(ctx, {});

    expect(result.status).toBe("content_fail");
    expect(result.finalOutput).toBeNull();
  });
});

describe("BaseAgent — gate failures explain themselves", () => {
  it("names the missing gate tool in the telemetry error", async () => {
    const { router } = fakeRouter([finalTurn({ body: "draft" })]);
    const runtime: BaseAgentRuntime = { router, tools: {} };

    const result = await new MockAgent(runtime, config({ allowedTools: [] })).run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(result.steps.at(-1)!.error).toMatch(/gate "gate\.test" is not registered/);
  });

  it("carries the gate tool's own failure reason into the telemetry error", async () => {
    const gate = fakeTool("gate.test", async () => ({ status: "tooling_error", reason: "gate service unreachable" }));
    const { router } = fakeRouter([finalTurn({ body: "draft" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.test": gate } };

    const result = await new MockAgent(runtime, config({ allowedTools: ["gate.test"] })).run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(result.steps.at(-1)!.error).toMatch(/gate "gate\.test" did not return a verdict.*gate service unreachable/s);
  });

  it("flags a malformed GateVerdict in the telemetry error", async () => {
    const gate = fakeTool("gate.test", async () => ({ status: "success", result: { nonsense: true } }));
    const { router } = fakeRouter([finalTurn({ body: "draft" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.test": gate } };

    const result = await new MockAgent(runtime, config({ allowedTools: ["gate.test"] })).run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(result.steps.at(-1)!.error).toMatch(/malformed GateVerdict/);
  });

  it("explains a gate-internal tooling_error verdict, and leaves a passing verdict with no error at all", async () => {
    const broken = fakeTool("gate.test", async () => ({
      status: "success",
      result: { verdict: "tooling_error", reason: "the checker itself crashed", toolVersion: "1.0.0" },
    }));
    const { router } = fakeRouter([finalTurn({ body: "draft" })]);
    const failed = await new MockAgent(
      { router, tools: { "gate.test": broken } } as BaseAgentRuntime,
      config({ allowedTools: ["gate.test"] }),
    ).run(ctx, {});

    expect(failed.steps.at(-1)!.error).toMatch(/returned "tooling_error".*the checker itself crashed/s);

    const passing = fakeTool("gate.test", async () => ({ status: "success", result: { verdict: "pass", evidence: [], toolVersion: "1.0.0" } }));
    const second = fakeRouter([finalTurn({ body: "draft" })]);
    const ok = await new MockAgent(
      { router: second.router, tools: { "gate.test": passing } } as BaseAgentRuntime,
      config({ allowedTools: ["gate.test"] }),
    ).run(ctx, {});

    expect(ok.status).toBe("completed");
    expect(ok.steps.at(-1)!.error).toBeUndefined();
  });
});
