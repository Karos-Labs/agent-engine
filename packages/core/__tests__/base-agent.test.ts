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

  it("blocks a tool call whose path-like argument is an absolute filesystem path", async () => {
    const video = fakeTool("video.writeJsonFile", async () => ({ status: "success", result: { ok: true } }));
    const router = fakeRouter([toolCallTurn("video.writeJsonFile", { path: "/etc/cron.d/x", content: {} })]);
    const runtime: BaseAgentRuntime = { router, tools: { "video.writeJsonFile": video } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["video.writeJsonFile"] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(video.execute).not.toHaveBeenCalled();
    const blockResult = result.steps[0]?.toolCall?.result as { blocked: boolean; reason: string };
    expect(blockResult.blocked).toBe(true);
    expect(blockResult.reason).toMatch(/absolute or URL-shaped path/i);
  });

  it("blocks a tool call whose path-like argument is a file:// URI", async () => {
    const video = fakeTool("video.readJsonFile", async () => ({ status: "success", result: {} }));
    const router = fakeRouter([toolCallTurn("video.readJsonFile", { jobPath: "file:///etc/passwd" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "video.readJsonFile": video } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["video.readJsonFile"] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(video.execute).not.toHaveBeenCalled();
  });

  it("does not block a legitimate http(s) URL argument that isn't a path-like field", async () => {
    const renderCheck = fakeTool("landing.renderCheck", async () => ({ status: "success", result: { pass: true } }));
    const router = fakeRouter([toolCallTurn("landing.renderCheck", { baseUrl: "http://localhost:3005" }), finalTurn({ body: "ok" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "landing.renderCheck": renderCheck } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["landing.renderCheck"] }));
    const result = await agent.run(ctx, {});

    expect(renderCheck.execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
  });
});

describe("BaseAgent — allowedTools enforcement", () => {
  it("rejects a tool call for a tool outside this step's allowedTools, without invoking it", async () => {
    // Present in the runtime's full registry, but not declared in this step's allowedTools —
    // the fake router bypasses the adapter's own schema.parse(), so this exercises the
    // explicit runOneTurn membership check, not just buildTurnSchema()'s z.enum.
    const ledger = fakeTool("ledger.writeDeliverable", async () => ({ status: "success", result: { ok: true } }));
    const router = fakeRouter([toolCallTurn("ledger.writeDeliverable", { data: "x" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "ledger.writeDeliverable": ledger } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["research.pull"] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(result.finalOutput).toBeNull();
    expect(ledger.execute).not.toHaveBeenCalled();
    expect(result.steps[0]?.status).toBe("tooling_error");
    const blocked = result.steps[0]?.toolCall?.result as { error: string };
    expect(blocked.error).toMatch(/not in this step's allowedTools/i);
  });

  it("rejects any tool call when the step declares no tools at all", async () => {
    const ledger = fakeTool("ledger.writeDeliverable", async () => ({ status: "success", result: { ok: true } }));
    const router = fakeRouter([toolCallTurn("ledger.writeDeliverable", { data: "x" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "ledger.writeDeliverable": ledger } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: [] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(result.finalOutput).toBeNull();
    expect(ledger.execute).not.toHaveBeenCalled();
  });

  it("still permits a tool call for a tool that is genuinely in allowedTools", async () => {
    const research = fakeTool("research.pull", async () => ({ status: "success", result: { hits: 1 } }));
    const router = fakeRouter([toolCallTurn("research.pull", { query: "x" }), finalTurn({ body: "ok" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "research.pull": research } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["research.pull"] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("completed");
    expect(research.execute).toHaveBeenCalledTimes(1);
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

/**
 * A hallucinated tool name and malformed arguments are model mistakes, not
 * broken infrastructure. Before these were recoverable, a single bad guess
 * ended the whole step — which made real runs non-deterministic: the same
 * input succeeded or failed purely on how the model happened to shape one
 * tool call. The tool must still never execute with arguments that failed
 * its own schema.
 */
describe("BaseAgent — recoverable model mistakes", () => {
  const strictTool = (name: string) =>
    ({
      name,
      version: "1.0.0",
      inputSchema: z.object({ text: z.string(), sources: z.array(z.string()) }),
      execute: vi.fn(async () => ({ status: "success", result: { verdict: "pass" } }) as AgentToolOutcome<unknown>),
    }) satisfies AgentTool;

  it("feeds a schema violation back as an observation and lets the next turn succeed", async () => {
    const gate = strictTool("gate.numbersSourced");
    const router = fakeRouter([
      // The exact mistake seen in a real run: the tool declares {text, sources[]}.
      toolCallTurn("gate.numbersSourced", { claim: "40% boost", sourceText: "a study" }),
      toolCallTurn("gate.numbersSourced", { text: "40% boost", sources: ["a study"] }),
      finalTurn({ body: "drafted" }),
    ]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["gate.numbersSourced"] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ body: "drafted" });
    // Never executed with the invalid arguments — only with the corrected ones.
    expect(gate.execute).toHaveBeenCalledTimes(1);
    expect(gate.execute).toHaveBeenCalledWith({ text: "40% boost", sources: ["a study"] }, { ctx });
  });

  it("names the offending field in the observation, so the retry is informed", async () => {
    const gate = strictTool("gate.numbersSourced");
    const router = fakeRouter([toolCallTurn("gate.numbersSourced", { claim: "40%" }), finalTurn({ body: "drafted" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["gate.numbersSourced"] }));
    const result = await agent.run(ctx, {});

    const failure = result.steps[0]?.toolCall?.result as { error: string };
    expect(failure.error).toMatch(/text/);
    expect(failure.error).toMatch(/sources/);
    expect(result.steps[0]?.status).toBe("tooling_error");
  });

  it("recovers from a hallucinated tool name, telling the model which tools exist", async () => {
    const gate = strictTool("gate.numbersSourced");
    const router = fakeRouter([toolCallTurn("gate.doesNotExist", {}), finalTurn({ body: "drafted" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["gate.numbersSourced"] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("completed");
    const failure = result.steps[0]?.toolCall?.result as { error: string };
    expect(failure.error).toMatch(/gate\.numbersSourced/);
  });

  it("still exhausts maxSteps rather than looping forever on a model that never corrects itself", async () => {
    const gate = strictTool("gate.numbersSourced");
    const router = fakeRouter(Array.from({ length: 3 }, () => toolCallTurn("gate.numbersSourced", { wrong: true })));
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["gate.numbersSourced"], maxSteps: 3 }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("budget_exceeded");
    expect(result.steps).toHaveLength(3);
    expect(gate.execute).not.toHaveBeenCalled();
  });

  it("keeps a write-fence block fatal — a tenant boundary is not a model typo to retry", async () => {
    const ledger = fakeTool("ledger.write", async () => ({ status: "success", result: { ok: true } }));
    const router = fakeRouter([toolCallTurn("ledger.write", { clientSlug: "someone-else" }), finalTurn({ body: "drafted" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "ledger.write": ledger } };

    const agent = new MockAgent(runtime, baseConfig({ allowedTools: ["ledger.write"] }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
    expect(ledger.execute).not.toHaveBeenCalled();
  });
});

describe("BaseAgent — tool advertisement", () => {
  it("sends each allowed tool's input schema, not just its name", async () => {
    const gate: AgentTool = {
      name: "gate.numbersSourced",
      version: "1.0.0",
      inputSchema: z.object({ text: z.string(), sources: z.array(z.string()) }),
      execute: vi.fn(async () => ({ status: "success", result: {} }) as AgentToolOutcome<unknown>),
    };
    const router = fakeRouter([finalTurn({ body: "drafted" })]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    await new MockAgent(runtime, baseConfig({ allowedTools: ["gate.numbersSourced"] })).run(ctx, {});

    const prompt = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string;
    const advertised = JSON.parse(prompt).allowedTools as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
    expect(advertised[0]?.name).toBe("gate.numbersSourced");
    expect(Object.keys(advertised[0]?.inputSchema?.properties ?? {})).toEqual(["text", "sources"]);
  });
});
