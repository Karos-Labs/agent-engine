import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FinishReason, type GoogleGenAI } from "@google/genai";
import {
  AnthropicAdapter,
  DefaultModelRouter,
  GeminiAdapter,
  GEMINI_DEFAULT_MAX_TOKENS,
  MockAgent,
  OutputLimitExceededError,
  computeStepCostUsd,
  type AgentContext,
  type AgentStepConfig,
  type BaseAgentRuntime,
  type MessagesApiClient,
  type ModelAdapter,
} from "../src/index.js";

/**
 * A truncated turn must book what it burned (Phase 5.5, brief items B + G).
 *
 * ## The defect, measured
 *
 * Both adapters threw a bare `Error` on `stop_reason: "max_tokens"` /
 * `FinishReason.MAX_TOKENS` *before* resolving the response's usage block, and
 * `BaseAgent`'s generic catch books `costUsd: 0` with zero tokens for anything
 * that is not a `StructuredOutputValidationError`. So the one failure mode
 * that is GUARANTEED to have spent its entire output ceiling was also the one
 * that reported spending nothing.
 *
 * Across the six prep Instagram runs of 2026-09-16, SEVENTEEN model calls died
 * this way and every one of them recorded $0.000000 with `inputTokens
 * {cached: 0, uncached: 0}`:
 *
 * | step | ceiling | calls | ≈ each |
 * |---|---|---|---|
 * | `05-write-copy-attempt-{1,2,3}` | 16,384 | 7 | $0.34 |
 * | `00c3-write-design-brief` | 4,000 | 4 | $0.09 |
 * | `00d2-derive-visual-direction` | 3,000 | 3 | $0.07 |
 * | `00b2-write-client-brief` | 8,000 | 2 | $0.22 |
 * | `04b-research-extract-facts` (Gemini) | 16,384 | 1 | $0.06 |
 *
 * ≈$3.4 unreported over six runs — ≈$0.57 a run, against runs that reported
 * $0.41-$0.99 — and the budget ladder those figures fed was cutting the
 * generated images out of the post to stay under a target it could not
 * actually see. (Each per-call figure is reconstructed from the sibling
 * attempt of the same step that did complete, at the ceiling for output; the
 * exact arithmetic for the copy attempt is pinned in `COPY_ATTEMPT_COST_USD`
 * below.)
 *
 * ## What is asserted here
 *
 * Nothing in this file mocks the code under test. The stubs are transports —
 * a `MessagesApiClient` and a `GoogleGenAI`-shaped object — and the path runs
 * through the real adapter, the real `DefaultModelRouter` and the real
 * `BaseAgent`, so a regression anywhere along it fails here.
 *
 * The last `describe` is the control: it reads both adapters' source and
 * asserts the usage block is resolved ABOVE the truncation throw. Move the
 * throw back where it was and this suite refuses, which is the only reason to
 * trust the rest of it (`guards-that-cannot-fail`).
 */

const OutputSchema = z.object({ body: z.string() });
type Output = z.infer<typeof OutputSchema>;

const ctx: AgentContext = {
  runId: "run_truncated",
  clientSlug: "karoslabs",
  productId: "instagram",
  runKind: "recurring",
  metadata: {},
};

/**
 * The real shape of a truncated `05-write-copy` attempt, taken from the
 * attempt that DID complete in the same step of prep run
 * `pubsub-21868533047825082` (27,526 uncached + 23,167 cached in, and the
 * 16,384-token ceiling out, because a truncated turn by definition spent all
 * of it). Reconstructing the figure from a sibling rather than inventing one
 * is what makes the dollar assertion below evidence instead of a round number.
 */
const COPY_ATTEMPT_USAGE = {
  uncachedInput: 27_526,
  cachedInput: 23_167,
  ceiling: 16_384,
} as const;

/** 27,526 × $3/1M + 23,167 × $0.30/1M + 16,384 × $15/1M, at sonnet-4-6's `MODEL_PRICING` row. */
const COPY_ATTEMPT_COST_USD = 0.335_288;

function anthropicTruncation(
  usage: Record<string, number> = { input_tokens: COPY_ATTEMPT_USAGE.uncachedInput, cache_read_input_tokens: COPY_ATTEMPT_USAGE.cachedInput, output_tokens: COPY_ATTEMPT_USAGE.ceiling },
): MessagesApiClient {
  return {
    messages: {
      create: async () => ({
        model: "claude-sonnet-4-6",
        stop_reason: "max_tokens",
        // What the API actually returns when a long-form draft runs out of
        // room: a tool_use block whose input was cut off before a field landed.
        content: [{ type: "tool_use", name: "emit_output", input: {} }],
        usage,
      }),
    },
    // The stub is a transport, deliberately narrower than the SDK's own
    // `Message` type; everything the adapter reads off it is present.
  } as unknown as MessagesApiClient;
}

function geminiTruncation(usage: Record<string, number> = { promptTokenCount: 71_686, candidatesTokenCount: 4_000, thoughtsTokenCount: 12_384 }): GoogleGenAI {
  const generateContent = vi.fn().mockResolvedValue({
    candidates: [{ finishReason: FinishReason.MAX_TOKENS }],
    text: undefined,
    usageMetadata: usage,
  });
  return { models: { generateContent } } as unknown as GoogleGenAI;
}

function runtimeFor(anthropic: ModelAdapter, gemini?: ModelAdapter): BaseAgentRuntime {
  return { router: new DefaultModelRouter({ anthropic, ...(gemini ? { gemini } : {}) }), tools: {} };
}

function config(overrides: Partial<AgentStepConfig<Output>> = {}): AgentStepConfig<Output> {
  return {
    id: "write-copy",
    description: "Draft one carousel",
    allowedTools: [],
    outputSchema: OutputSchema,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    ...overrides,
  };
}

describe("the Anthropic route: a truncated turn carries its usage", () => {
  it("throws an OutputLimitExceededError with the provider's own usage, not a bare Error", async () => {
    const adapter = new AnthropicAdapter(anthropicTruncation());

    const err = await adapter
      .complete({ prompt: "write the carousel", schema: OutputSchema, model: "claude-sonnet-4-6", maxTokens: COPY_ATTEMPT_USAGE.ceiling })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err, "the truncation branch must still throw").toBeInstanceOf(OutputLimitExceededError);
    const truncated = err as OutputLimitExceededError;
    expect(truncated.attemptedMaxTokens).toBe(COPY_ATTEMPT_USAGE.ceiling);
    expect(truncated.usage).toEqual({
      modelUsed: "claude-sonnet-4-6",
      inputTokens: { cached: COPY_ATTEMPT_USAGE.cachedInput, uncached: COPY_ATTEMPT_USAGE.uncachedInput },
      outputTokens: COPY_ATTEMPT_USAGE.ceiling,
    });
  });

  it("folds a cache WRITE into the usage it carries, premium and all", async () => {
    // A truncated first attempt is also the attempt that paid to WRITE the
    // cache — 23,167 tokens of system prompt and tool list at 1.25x. Dropping
    // that on the failure path would understate the most expensive turn of the
    // step by the premium on its whole prefix.
    const adapter = new AnthropicAdapter(
      anthropicTruncation({ input_tokens: 24_000, cache_creation_input_tokens: 23_167, output_tokens: 16_384 }),
    );

    const err = (await adapter
      .complete({ prompt: "p", schema: OutputSchema, model: "claude-sonnet-4-6", maxTokens: 16_384 })
      .catch((e: unknown) => e)) as OutputLimitExceededError;

    const usage = err.usage!;
    expect(usage.inputTokens).toEqual({ cached: 0, uncached: 47_167, cacheWrite: 23_167 });
    // The premium is real money: 23,167 × $3/1M × 0.25 = $0.017375 that the
    // old path threw away along with everything else.
    expect(computeStepCostUsd(usage.modelUsed, usage.inputTokens, usage.outputTokens)).toBeGreaterThan(
      computeStepCostUsd(usage.modelUsed, { cached: 0, uncached: 47_167 }, usage.outputTokens),
    );
  });

  it("keeps the actionable message every existing caller reads", async () => {
    const adapter = new AnthropicAdapter(anthropicTruncation());

    await expect(
      adapter.complete({ prompt: "p", schema: OutputSchema, model: "claude-sonnet-4-6", maxTokens: 16_384 }),
    ).rejects.toThrow(/anthropic: model "claude-sonnet-4-6" hit the 16384-token output limit/);
  });
});

describe("the Gemini route: a truncated turn carries its usage", () => {
  it("throws an OutputLimitExceededError at the default ceiling with the provider's own usage", async () => {
    const adapter = new GeminiAdapter({ client: geminiTruncation(), retryOptions: { delay: () => Promise.resolve() } });

    const err = (await adapter
      .complete({ prompt: "extract the fact cards", schema: OutputSchema, model: "gemini-2.5-flash" })
      .catch((e: unknown) => e)) as OutputLimitExceededError;

    expect(err).toBeInstanceOf(OutputLimitExceededError);
    expect(err.attemptedMaxTokens).toBe(GEMINI_DEFAULT_MAX_TOKENS);
    expect(err.usage!.modelUsed).toBe("gemini-2.5-flash");
    expect(err.usage!.inputTokens).toEqual({ cached: 0, uncached: 71_686 });
  });

  it("counts THINKING tokens as output, which is what exhausted the ceiling", async () => {
    // `candidatesTokenCount` excludes `thoughtsTokenCount` (the SDK's own
    // `totalTokenCount` doc: prompt + candidates + toolUsePrompt + thoughts),
    // and thinking is billed at the output rate. This is how
    // `04b-research-extract-facts` truncated on geektime while its three
    // successful siblings returned only 3,059-3,263 VISIBLE output tokens:
    // most of the ceiling never appeared in `candidatesTokenCount` at all.
    const adapter = new GeminiAdapter({ client: geminiTruncation(), retryOptions: { delay: () => Promise.resolve() } });

    const err = (await adapter
      .complete({ prompt: "p", schema: OutputSchema, model: "gemini-2.5-flash" })
      .catch((e: unknown) => e)) as OutputLimitExceededError;

    expect(err.usage!.outputTokens, "4,000 visible + 12,384 thought").toBe(16_384);
  });

  it("counts thinking tokens on the SUCCESS path too — it is the same invoice", async () => {
    // The fold is not a truncation-only rule. A Gemini step that thinks hard
    // and answers briefly was under-reported by exactly the thinking, on every
    // successful call, for as long as the adapter has existed.
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: FinishReason.STOP }],
      text: JSON.stringify({ body: "twelve fact cards" }),
      usageMetadata: { promptTokenCount: 65_137, candidatesTokenCount: 3_059, thoughtsTokenCount: 2_400 },
    });
    const adapter = new GeminiAdapter({
      client: { models: { generateContent } } as unknown as GoogleGenAI,
      retryOptions: { delay: () => Promise.resolve() },
    });

    const result = await adapter.complete({ prompt: "p", schema: OutputSchema, model: "gemini-2.5-flash" });

    expect(result.outputTokens).toBe(5_459);
  });

  it("keeps the actionable message every existing caller reads", async () => {
    const adapter = new GeminiAdapter({ client: geminiTruncation(), retryOptions: { delay: () => Promise.resolve() } });

    await expect(adapter.complete({ prompt: "p", schema: OutputSchema, model: "gemini-2.5-flash" })).rejects.toThrow(
      new RegExp(`google-gemini: model "gemini-2\\.5-flash" hit the ${GEMINI_DEFAULT_MAX_TOKENS}-token output limit`),
    );
  });
});

describe("BaseAgent books the truncated turn's spend", () => {
  it("records the real dollars for a truncated Anthropic turn instead of $0", async () => {
    const result = await new MockAgent(runtimeFor(new AnthropicAdapter(anthropicTruncation())), config()).run(ctx, {
      topic: "inbound response times",
    });

    expect(result.status).toBe("tooling_error");
    expect(result.steps).toHaveLength(1);
    const step = result.steps[0]!;

    expect(step.status).toBe("tooling_error");
    expect(step.modelUsed).toBe("claude-sonnet-4-6");
    expect(step.inputTokens).toEqual({ cached: COPY_ATTEMPT_USAGE.cachedInput, uncached: COPY_ATTEMPT_USAGE.uncachedInput });

    // TWO ceilings' worth, not one: this fixture truncates at every ceiling, so
    // `BaseAgent` spends the first attempt, raises the limit once
    // (`raisedOutputLimit`), spends the raised attempt, and gives up. Both are
    // real turns and the step books both — which is the whole point, because
    // the version of this code that reported $0 would have reported $0 twice.
    expect(step.outputTokens).toBe(COPY_ATTEMPT_USAGE.ceiling * 2);

    // The regression under test, stated twice: as "not zero", and as the exact
    // figure the pricing table produces for what was booked — the SUM of both
    // attempts, which is what the run's meter reads.
    expect(step.costUsd, "a truncated turn used to record exactly this as 0").toBeGreaterThan(0);
    expect(step.costUsd).toBeCloseTo(COPY_ATTEMPT_COST_USD * 2, 6);

    // Deliberately NOT asserted as `computeStepCostUsd(modelUsed, step.inputTokens,
    // step.outputTokens)`: `costUsd` sums both attempts while `inputTokens`
    // carries only the last one's, so recomputing the cost from the two
    // published token counts under-reports it by one attempt's input. The
    // dollars are the number the budget meter reads and they are right; the
    // token fields are a reporting inconsistency in the raise path, recorded
    // here so it is a known gap rather than a surprise.
    expect(computeStepCostUsd(step.modelUsed, step.inputTokens, step.outputTokens)).toBeLessThan(step.costUsd);
  });

  it("names the ceiling that was hit, so a failing run says what ran out", async () => {
    const result = await new MockAgent(runtimeFor(new AnthropicAdapter(anthropicTruncation())), config()).run(ctx, {});

    // The message no longer tells a human to raise `maxTokens` — since
    // `OutputLimitExceededError` landed, `BaseAgent` does that itself, once, in
    // the same step (`raisedOutputLimit`). What the message must still carry is
    // the ceiling, because that is the number a reader correlates with the
    // step's config when even the raised attempt did not fit.
    expect(result.steps.at(-1)!.error).toMatch(/model call failed: anthropic: .*-token output limit/);
  });

  it("spends ONE raised retry and no repair turn — an exhausted ceiling is re-asked with more room, never with feedback", async () => {
    // Distinct from a malformed turn, which gets one bounded REPAIR turn at the
    // same ceiling (`malformed-turn-repair.test.ts`). A truncation is the one
    // failure whose fix is knowable from the failure itself, so the second call
    // is the same question with a bigger budget — and `maxMalformedTurns: 2`
    // must not buy a third.
    const client = anthropicTruncation();
    const create = vi.spyOn(client.messages, "create");

    await new MockAgent(runtimeFor(new AnthropicAdapter(client)), config({ maxMalformedTurns: 2 })).run(ctx, {});

    expect(create).toHaveBeenCalledTimes(2);
    const [first, second] = create.mock.calls.map((c) => c[0] as { max_tokens: number });
    expect(second!.max_tokens, "the retry is a RAISE, not a repeat").toBeGreaterThan(first!.max_tokens);
  });

  it("records the real dollars for a truncated Gemini turn too", async () => {
    const anthropic = new AnthropicAdapter(anthropicTruncation());
    const gemini = new GeminiAdapter({ client: geminiTruncation(), retryOptions: { delay: () => Promise.resolve() } });

    const result = await new MockAgent(
      runtimeFor(anthropic, gemini),
      config({ id: "instagram-research", modelPolicy: { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" } }),
    ).run(ctx, {});

    const step = result.steps[0]!;
    expect(step.status).toBe("tooling_error");
    expect(step.modelUsed).toBe("gemini-2.5-flash");
    expect(step.inputTokens).toEqual({ cached: 0, uncached: 71_686 });
    // The first attempt at `GEMINI_DEFAULT_MAX_TOKENS` and the one raised retry
    // after it, both of which this fixture truncates — see the Anthropic case
    // above for why the sum is the honest figure.
    expect(step.outputTokens).toBe(16_384 * 2);
    expect(step.costUsd).toBeGreaterThan(0);
    // Both attempts: 2 × (71,686 × $0.30/1M + 16,384 × $2.50/1M). Small next to
    // the copy step, and it is the whole reason geektime's post shipped with no
    // fact cards.
    expect(step.costUsd).toBeCloseTo(computeStepCostUsd("gemini-2.5-flash", { cached: 0, uncached: 71_686 }, 16_384) * 2, 6);
    expect(step.costUsd).toBeCloseTo(0.124_932, 6);
  });

  it("still books $0 when the call never produced a response — the zeros stay correct where they are correct", async () => {
    // The premise assertion. Without it this suite could be passing because
    // BaseAgent started booking a cost for every failure, which would be a
    // different and worse bug: a dead provider, a 403 or a timeout has no
    // usage to report and inventing one would put a fictional number on the
    // gate payload.
    const dead = {
      messages: {
        create: async () => {
          throw Object.assign(new Error("Lightning dunning decision is deny for project"), { status: 403 });
        },
      },
    } as unknown as MessagesApiClient;

    const result = await new MockAgent(
      runtimeFor(new AnthropicAdapter(dead, { maxAttempts: 1, delay: () => Promise.resolve() })),
      config(),
    ).run(ctx, {});

    expect(result.steps[0]!.status).toBe("tooling_error");
    expect(result.steps[0]!.costUsd).toBe(0);
    expect(result.steps[0]!.inputTokens).toEqual({ cached: 0, uncached: 0 });
  });
});

/**
 * The control. Every assertion above passes if the usage block is resolved
 * before the throw — and the defect WAS the ordering, nothing else. So the
 * ordering itself is asserted, in the source, in both adapters: move either
 * throw back above its `reportedUsage` and this fails immediately, with the
 * reason in the message.
 */
describe("the guard can fail: usage is resolved above the truncation throw", () => {
  const adaptersDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "router", "adapters");
  const read = (file: string): string => readFileSync(path.join(adaptersDir, file), "utf8");

  it.each([
    ["messages-api-adapter.ts", 'response.stop_reason === "max_tokens"'],
    ["gemini-adapter.ts", "finishReason === FinishReason.MAX_TOKENS"],
  ])("%s resolves reportedUsage before it can throw on truncation", (file, truncationCheck) => {
    const source = read(file);
    const usageAt = source.indexOf("const reportedUsage = {");
    const throwAt = source.indexOf(truncationCheck);

    expect(usageAt, `${file}: no reportedUsage block found — this control is checking nothing`).toBeGreaterThan(-1);
    expect(throwAt, `${file}: no truncation check found — this control is checking nothing`).toBeGreaterThan(-1);
    expect(usageAt, `${file}: the truncation throw is above the usage block again — every truncated turn books $0`).toBeLessThan(throwAt);
  });
});
