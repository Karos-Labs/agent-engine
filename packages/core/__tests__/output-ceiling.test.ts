import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  MockAgent,
  OutputLimitExceededError,
  THOUGHT_MAX_CHARS,
  raisedOutputLimit,
  type AgentContext,
  type AgentStepConfig,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelRouter,
} from "../src/index.js";
import { OUTPUT_LIMIT_RETRY_CEILING } from "../src/router/adapters/structured-output.js";

/**
 * What happens when a model turn runs out of room to answer in.
 *
 * Until 2026-09-16 the answer was: the step dies, its real spend is recorded
 * as $0, and the error tells whoever eventually reads the run report to go and
 * raise a number in the source. Three prep Instagram runs that morning lost
 * eleven steps between them to exactly that — two client briefs, two design
 * briefs, two visual directions, five copy attempts — and each one was a
 * ceiling the engine could have raised itself.
 */

const DraftOutput = z.object({ body: z.string() });
type DraftOutput = z.infer<typeof DraftOutput>;

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "x", runKind: "recurring", metadata: {} };

/** A real ceiling failure: usage is what the provider billed for the truncated attempt, never zero. */
function truncatedTurn(attemptedMaxTokens: number) {
  return () => {
    throw new OutputLimitExceededError(`anthropic: model "claude-sonnet-4-6" hit the ${attemptedMaxTokens}-token output limit`, {
      attemptedMaxTokens,
      usage: { modelUsed: "claude-sonnet-4-6", inputTokens: { cached: 0, uncached: 1_000 }, outputTokens: attemptedMaxTokens },
    });
  };
}

function finalTurn(output: unknown): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: 1_000 },
    outputTokens: 500,
  });
}

function fakeRouter(turns: Array<() => CompletionResult<unknown>>) {
  const queue = [...turns];
  const maxTokensSeen: Array<number | undefined> = [];
  const complete = vi.fn(async (_prompt: string, _schema: unknown, _policy: unknown, opts?: { maxTokens?: number }) => {
    maxTokensSeen.push(opts?.maxTokens);
    const next = queue.shift();
    if (!next) throw new Error("fakeRouter: exhausted configured turns");
    return next();
  });
  return { complete, maxTokensSeen, router: { complete, completeAlias: vi.fn() } as unknown as ModelRouter };
}

function config(overrides: Partial<AgentStepConfig<DraftOutput>> = {}): AgentStepConfig<DraftOutput> {
  return {
    id: "draft-post",
    description: "Draft one post",
    allowedTools: [],
    outputSchema: DraftOutput,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    ...overrides,
  };
}

const runtimeFor = (router: ModelRouter): BaseAgentRuntime => ({ router, tools: {} });

describe("raisedOutputLimit", () => {
  it("takes a too-small ceiling straight to the engine default rather than doubling towards it", () => {
    // The three ceilings that killed `instagram-agent`'s setup on 2026-09-16.
    expect(raisedOutputLimit(3_000)).toBe(16_384);
    expect(raisedOutputLimit(4_000)).toBe(16_384);
    expect(raisedOutputLimit(8_000)).toBe(16_384);
  });

  it("doubles a ceiling that is already the default, up to the hard stop", () => {
    // The doubling used to be invisible here: 16,384 doubles to 32,768, which
    // the old 32,000 stop clamped straight back to the stop itself, so the
    // assertion read as "goes to the ceiling". With the stop at 64,000 the
    // raise is the double it always was.
    expect(raisedOutputLimit(16_384)).toBe(32_768);
    expect(raisedOutputLimit(40_000)).toBe(OUTPUT_LIMIT_RETRY_CEILING);
  });

  it("refuses to raise a ceiling that is already at the stop — that step is over-specified, not under-budgeted", () => {
    expect(raisedOutputLimit(OUTPUT_LIMIT_RETRY_CEILING)).toBeUndefined();
    expect(raisedOutputLimit(OUTPUT_LIMIT_RETRY_CEILING + 1)).toBeUndefined();
  });
});

describe("BaseAgent — a truncated turn is re-asked with more room", () => {
  it("raises the ceiling and completes, where the step used to die", async () => {
    const { router, maxTokensSeen } = fakeRouter([truncatedTurn(8_000), finalTurn({ body: "the brief that fits" })]);

    const result = await new MockAgent(runtimeFor(router), config({ maxTokens: 8_000 })).run(ctx, { topic: "ai" });

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ body: "the brief that fits" });
    expect(maxTokensSeen).toEqual([8_000, 16_384]);
  });

  it("bills the truncated attempt onto the step instead of losing it", async () => {
    const { router } = fakeRouter([truncatedTurn(8_000), finalTurn({ body: "ok" })]);

    const result = await new MockAgent(runtimeFor(router), config({ maxTokens: 8_000 })).run(ctx, { topic: "ai" });

    // 8,000 thrown-away output tokens plus the 500 that survived. A step that
    // paid twice must not read as a step that paid once.
    expect(result.steps[0]!.outputTokens).toBe(8_500);
    expect(result.steps[0]!.costUsd).toBeGreaterThan(0);
  });

  it("raises once, not until it works", async () => {
    const { router, complete } = fakeRouter([truncatedTurn(8_000), truncatedTurn(16_384), finalTurn({ body: "never reached" })]);

    const result = await new MockAgent(runtimeFor(router), config({ maxTokens: 8_000 })).run(ctx, { topic: "ai" });

    expect(result.status).toBe("tooling_error");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("still reports what an unraisable truncation actually spent", async () => {
    const { router } = fakeRouter([truncatedTurn(OUTPUT_LIMIT_RETRY_CEILING)]);

    const result = await new MockAgent(runtimeFor(router), config({ maxTokens: OUTPUT_LIMIT_RETRY_CEILING })).run(ctx, { topic: "ai" });

    expect(result.status).toBe("tooling_error");
    expect(result.steps[0]!.outputTokens).toBe(OUTPUT_LIMIT_RETRY_CEILING);
    expect(result.steps[0]!.costUsd).toBeGreaterThan(0);
  });
});

describe("BaseAgent — the `thought` field is a note, not a workspace", () => {
  it("tells the model what `thought` is for, in the cached contract", async () => {
    const systems: string[] = [];
    const complete = vi.fn(async (_p: string, _s: unknown, _pol: unknown, opts?: { system?: string }) => {
      systems.push(opts?.system ?? "");
      return finalTurn({ body: "ok" })();
    });
    const router = { complete, completeAlias: vi.fn() } as unknown as ModelRouter;

    await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    expect(systems[0]).toContain(`at most ${THOUGHT_MAX_CHARS} characters`);
    expect(systems[0]).toContain("nothing downstream reads it");
  });

  it("carries the bound into the schema the model is handed, so it is a limit and not a wish", async () => {
    let handedSchema: z.ZodTypeAny | undefined;
    const complete = vi.fn(async (_p: string, schema: z.ZodTypeAny) => {
      handedSchema = schema;
      return finalTurn({ body: "ok" })();
    });
    const router = { complete, completeAlias: vi.fn() } as unknown as ModelRouter;

    await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });

    // The 50,520-character `thought` measured on prep run
    // pubsub-21868183257380937 does not validate; a real note does.
    expect(handedSchema!.safeParse({ type: "final", thought: "x".repeat(50_520), output: { body: "ok" } }).success).toBe(false);
    expect(handedSchema!.safeParse({ type: "final", thought: "a paragraph", output: { body: "ok" } }).success).toBe(true);
  });
});

describe("BaseAgent: `omitThought` takes the field out of the schema (2026-09-23)", () => {
  it("hands the model a schema with no `thought` and a contract that says so, and the answer still parses", async () => {
    let handedSchema: z.ZodTypeAny | undefined;
    const systems: string[] = [];
    const complete = vi.fn(async (_p: string, schema: z.ZodTypeAny, _pol: unknown, opts?: { system?: string }) => {
      handedSchema = schema;
      systems.push(opts?.system ?? "");
      return finalTurn({ body: "ok" })();
    });
    const router = { complete, completeAlias: vi.fn() } as unknown as ModelRouter;
    const result = await new MockAgent(runtimeFor(router), config({ omitThought: true })).run(ctx, { topic: "ai" });
    expect(result.status).toBe("completed");
    // zod strips an unknown key, so the proof is the parsed value: a thought
    // the model tried to write does not survive, and the shape has no such key.
    const parsed = handedSchema!.parse({ type: "final", thought: "a paragraph", output: { body: "ok" } }) as Record<string, unknown>;
    expect("thought" in parsed).toBe(false);
    expect(Object.keys((handedSchema as unknown as z.ZodObject<z.ZodRawShape>).shape)).toEqual(["type", "output"]);
    // The contract reaches the model as JSON, so the quotes arrive escaped.
    expect(systems[0]).toContain('There is no \\"thought\\" field');
    expect(systems[0]).not.toContain("nothing downstream reads it");
  });

  it("leaves every other agent exactly as it was (the premise)", async () => {
    let handedSchema: z.ZodTypeAny | undefined;
    const complete = vi.fn(async (_p: string, schema: z.ZodTypeAny) => {
      handedSchema = schema;
      return finalTurn({ body: "ok" })();
    });
    const router = { complete, completeAlias: vi.fn() } as unknown as ModelRouter;
    await new MockAgent(runtimeFor(router), config()).run(ctx, { topic: "ai" });
    expect(Object.keys((handedSchema as unknown as z.ZodObject<z.ZodRawShape>).shape)).toEqual(["type", "thought", "output"]);
  });
});
