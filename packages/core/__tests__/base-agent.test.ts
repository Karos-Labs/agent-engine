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

const DraftOutput = z.object({ body: z.string() });
type DraftOutput = z.infer<typeof DraftOutput>;

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

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

function finalTurn(output: unknown, model = "claude-sonnet-4-6"): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: model,
    inputTokens: { cached: 0, uncached: 100 },
    outputTokens: 20,
  });
}

function toolCallTurn(tool: string, args: unknown, model = "claude-sonnet-4-6"): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "tool_call", tool, args },
    modelUsed: model,
    inputTokens: { cached: 0, uncached: 100 },
    outputTokens: 20,
  });
}

function fakeTool(
  name: string,
  execute: (args: unknown, context: { ctx: AgentContext }) => Promise<AgentToolOutcome<unknown>>,
  version = "1.0.0",
): AgentTool {
  return { name, version, inputSchema: z.unknown(), execute: vi.fn(execute) };
}

function baseConfig(overrides: Partial<AgentStepConfig<DraftOutput>> = {}): AgentStepConfig<DraftOutput> {
  return {
    id: "draft-post",
    description: "Draft a LinkedIn post",
    allowedTools: ["research.pull", "gate.test"],
    outputSchema: DraftOutput,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    ...overrides,
  };
}

describe("BaseAgent — happy path", () => {
  it("reaches the terminal schema in at most maxSteps, recording telemetry for every turn", async () => {
    const research = fakeTool("research.pull", async () => ({ status: "success", result: { hits: 3 } }));
    const router = fakeRouter([
      toolCallTurn("research.pull", { query: "linkedin trends" }),
      finalTurn({ body: "hello world" }),
    ]);
    const runtime: BaseAgentRuntime = { router, tools: { "research.pull": research } };

    const agent = new MockAgent(runtime, baseConfig());
    const result = await agent.run(ctx, { topic: "linkedin trends" });

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ body: "hello world" });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.toolCall?.name).toBe("research.pull");
    expect(result.steps[0]?.status).toBe("success");
    expect(result.steps[1]?.status).toBe("success");
    expect(research.execute).toHaveBeenCalledTimes(1);
    expect(research.execute).toHaveBeenCalledWith({ query: "linkedin trends" }, { ctx });
    expect(result.totalTokens.input).toBeGreaterThan(0);
  });
});

describe("BaseAgent — maxSteps budget", () => {
  it("returns budget_exceeded when the loop never reaches a terminal turn", async () => {
    const research = fakeTool("research.pull", async () => ({ status: "success", result: { hits: 1 } }));
    const router = fakeRouter([
      toolCallTurn("research.pull", { query: "1" }),
      toolCallTurn("research.pull", { query: "2" }),
      toolCallTurn("research.pull", { query: "3" }),
    ]);
    const runtime: BaseAgentRuntime = { router, tools: { "research.pull": research } };

    const agent = new MockAgent(runtime, baseConfig({ maxSteps: 3 }));
    const result = await agent.run(ctx, { topic: "x" });

    expect(result.status).toBe("budget_exceeded");
    expect(result.finalOutput).toBeNull();
    expect(result.steps).toHaveLength(3);
    expect(research.execute).toHaveBeenCalledTimes(3);
  });
});

describe("BaseAgent — tenant write-fence", () => {
  it("blocks a tool call whose arguments name a different tenant, without invoking the tool", async () => {
    const ledger = fakeTool("ledger.write", async () => ({ status: "success", result: { ok: true } }));
    const router = fakeRouter([toolCallTurn("ledger.write", { clientSlug: "someone-elses-company", data: "x" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "ledger.write": ledger } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["ledger.write"] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(result.finalOutput).toBeNull();
    expect(ledger.execute).not.toHaveBeenCalled();
    expect(result.steps[0]?.status).toBe("tooling_error");
    const blockResult = result.steps[0]?.toolCall?.result as { blocked: boolean; reason: string };
    expect(blockResult.blocked).toBe(true);
    expect(blockResult.reason).toMatch(/tenant/i);
  });

  it("blocks a tool call whose arguments contain path traversal", async () => {
    const files = fakeTool("karos-client.read", async () => ({ status: "success", result: { contents: "secret" } }));
    const router = fakeRouter([toolCallTurn("karos-client.read", { path: "../../etc/passwd" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "karos-client.read": files } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["karos-client.read"] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(result.finalOutput).toBeNull();
    expect(files.execute).not.toHaveBeenCalled();
  });
});

describe("BaseAgent — self-critique gate", () => {
  it("revises exactly once on content_fail, then completes once the gate passes", async () => {
    let gateCalls = 0;
    const gate = fakeTool("gate.test", async () => {
      gateCalls++;
      if (gateCalls === 1) {
        return {
          status: "success",
          result: { verdict: "content_fail", evidence: ["banned word"], reason: "contains a banned word", toolVersion: "1.0.0" },
        };
      }
      return { status: "success", result: { verdict: "pass", evidence: ["clean"], toolVersion: "1.0.0" } };
    });
    const router = fakeRouter([finalTurn({ body: "draft v1 (banned word)" }), finalTurn({ body: "draft v2 (fixed)" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.test": gate } };

    const agent = new MockAgent(runtime, baseConfig({ selfCritique: { gateTool: "gate.test", maxRevisions: 1 } }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ body: "draft v2 (fixed)" });
    expect(gate.execute).toHaveBeenCalledTimes(2);
    expect(router.complete).toHaveBeenCalledTimes(2);
    // draft turn, gate content_fail, revision turn, gate pass
    expect(result.steps).toHaveLength(4);
  });

  it("returns content_fail once maxRevisions is exhausted and the gate still fails", async () => {
    const gate = fakeTool("gate.test", async () => ({
      status: "success",
      result: { verdict: "content_fail", evidence: ["still bad"], reason: "still contains a banned word", toolVersion: "1.0.0" },
    }));
    const router = fakeRouter([finalTurn({ body: "draft v1" }), finalTurn({ body: "draft v2" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.test": gate } };

    const agent = new MockAgent(runtime, baseConfig({ selfCritique: { gateTool: "gate.test", maxRevisions: 1 } }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("content_fail");
    expect(result.finalOutput).toBeNull();
    expect(gate.execute).toHaveBeenCalledTimes(2);
  });

  it("propagates a gate tooling_error cleanly, preserving the draft and never attempting a revision", async () => {
    const gate = fakeTool("gate.test", async () => ({ status: "tooling_error", reason: "gate service unreachable" }));
    const router = fakeRouter([finalTurn({ body: "draft only, never judged" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.test": gate } };

    const agent = new MockAgent(runtime, baseConfig({ selfCritique: { gateTool: "gate.test", maxRevisions: 1 } }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(result.finalOutput).toEqual({ body: "draft only, never judged" });
    expect(gate.execute).toHaveBeenCalledTimes(1);
    expect(router.complete).toHaveBeenCalledTimes(1);
  });

  it("also treats a gate-internal tooling_error verdict as tooling_error, not content_fail", async () => {
    const gate = fakeTool("gate.test", async () => ({
      status: "success",
      result: { verdict: "tooling_error", reason: "the checker itself crashed", toolVersion: "1.0.0" },
    }));
    const router = fakeRouter([finalTurn({ body: "draft only" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.test": gate } };

    const agent = new MockAgent(runtime, baseConfig({ selfCritique: { gateTool: "gate.test", maxRevisions: 1 } }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(result.finalOutput).toEqual({ body: "draft only" });
    expect(router.complete).toHaveBeenCalledTimes(1);
  });
});

describe("BaseAgent — final output validation", () => {
  it("rejects a final turn whose output fails the step's own outputSchema", async () => {
    const router = fakeRouter([finalTurn({ body: 42 })]);
    const runtime: BaseAgentRuntime = { router, tools: {} };

    const agent = new MockAgent(runtime, baseConfig());
    // The router mock bypasses the adapter's own schema.parse(), so an invalid
    // "final" turn can reach BaseAgent — the explicit re-validation must still catch it.
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("content_fail");
    expect(result.finalOutput).toBeNull();
  });
});
