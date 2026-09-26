import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicAdapter } from "../src/router/adapters/anthropic-adapter.js";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_THINKING_RESERVE_TOKENS,
  resolveThinking,
} from "../src/router/adapters/messages-api-adapter.js";
import {
  OUTPUT_LIMIT_RETRY_CEILING,
  StructuredOutputValidationError,
  clampThinkingReserve,
} from "../src/router/adapters/structured-output.js";
import { MODEL_CAPABILITIES } from "../src/router/model-capabilities.js";
import type { CompletionRequest } from "../src/router/adapters/types.js";

/**
 * ── THE PARAMETER NOBODY SENT. ──
 *
 * Omitting `thinking` means "do not reason" on `claude-sonnet-4-6` and
 * `claude-opus-4-8`, and "reason adaptively" on `claude-sonnet-5` and
 * `claude-opus-5`. This adapter has never sent the parameter, so the day a
 * step's model id moves one generation forward, every step inherits reasoning
 * it never asked for — billed as output, and charged against the same
 * `max_tokens` the answer has to fit inside.
 *
 * `instagram-concept` declares 1,200 of those tokens. `newsletter-editor`
 * declares 4,000. Neither number was chosen with a second writer in mind, and
 * the way that fails is a payload cut mid-JSON: unparseable, and naming
 * nothing about the cause.
 *
 * These assert the two halves of the fix — the policy is always stated, and
 * `maxTokens` always means room for the ANSWER — plus the failure paths that
 * have to stay survivable when it is stated wrong.
 */

const OutputSchema = z.object({ body: z.string() });

function request(overrides: Partial<CompletionRequest<z.infer<typeof OutputSchema>>> = {}): CompletionRequest<z.infer<typeof OutputSchema>> {
  return { prompt: "draft something", schema: OutputSchema, model: "claude-sonnet-4-6", ...overrides };
}

function goodResponse() {
  return {
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", name: "emit_output", input: { body: "hello world" } }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
  };
}

function fakeClient(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

/** A model id the catalog records as reasoning by default. Read from the catalog rather than hardcoded, so this test cannot outlive the row it depends on. */
const THINKS_BY_DEFAULT = Object.entries(MODEL_CAPABILITIES).find(([, c]) => c.thinkingDefault === "on")?.[0];

describe("resolveThinking: the policy is always decided, never inherited", () => {
  it("sends nothing at all for a model that does not reason by default, so today's steps are byte-identical", () => {
    // This is every Claude step in the repo right now. The change must be
    // invisible to them — not "equivalent", literally the same request body.
    expect(resolveThinking("claude-sonnet-4-6", undefined)).toEqual({ thinking: undefined, effort: undefined, reserveTokens: 0 });
    expect(resolveThinking("claude-opus-4-8", undefined)).toEqual({ thinking: undefined, effort: undefined, reserveTokens: 0 });
    expect(resolveThinking("claude-haiku-4-5-20251001", undefined)).toEqual({ thinking: undefined, effort: undefined, reserveTokens: 0 });
  });

  it("states the policy explicitly for a model that DOES reason by default, and pays for it out of its own reserve", () => {
    // The whole point. A model that reasons anyway gets told to reason at the
    // cheapest setting, and gets extra ceiling to do it in — rather than
    // reasoning silently out of the answer's budget.
    expect(THINKS_BY_DEFAULT).toBeDefined();
    expect(resolveThinking(THINKS_BY_DEFAULT!, undefined)).toEqual({
      thinking: { type: "adaptive" },
      effort: "low",
      reserveTokens: DEFAULT_THINKING_RESERVE_TOKENS,
    });
  });

  it("never resolves to disabled on its own, because a disabled 5-generation model answers in prose", () => {
    // `{type: "disabled"}` has a documented failure mode on the 5 generation:
    // the model writes its tool call into visible text. This adapter REQUIRES
    // a tool_use block, so defaulting to disabled would trade a truncation we
    // retry for a wrong answer we cannot see. Only an explicit `0` gets it.
    expect(THINKS_BY_DEFAULT).toBeDefined();
    expect(resolveThinking(THINKS_BY_DEFAULT!, undefined).thinking).not.toEqual({ type: "disabled" });
    expect(resolveThinking("claude-sonnet-4-6", undefined).thinking).not.toEqual({ type: "disabled" });
  });

  it("honours an explicit zero as 'no reasoning', on any model", () => {
    expect(resolveThinking("claude-sonnet-4-6", 0).thinking).toEqual({ type: "disabled" });
    expect(resolveThinking(THINKS_BY_DEFAULT!, 0)).toEqual({ thinking: { type: "disabled" }, effort: undefined, reserveTokens: 0 });
  });

  it("honours a positive budget as the reserve, since 4.6-and-later removed budget_tokens", () => {
    // The number cannot be sent as a cap (a 400 on 4.7+), so it is honoured as
    // the half of it that still protects the answer: ceiling headroom.
    expect(resolveThinking("claude-sonnet-4-6", 6_000)).toEqual({ thinking: { type: "adaptive" }, effort: "low", reserveTokens: 6_000 });
  });

  it("treats an uncatalogued model as not reasoning, which is the branch that changes nothing", () => {
    expect(resolveThinking("some-model-nobody-catalogued", undefined)).toEqual({ thinking: undefined, effort: undefined, reserveTokens: 0 });
  });
});

describe("clampThinkingReserve: the reserve can never build a request the provider rejects", () => {
  it("keeps answer + reserve inside the ceiling every served vendor accepts", () => {
    // Gemini 3's output cap is 64k and `landing-build` declares 60,000. An
    // unclamped reserve would turn a recoverable truncation into a 400.
    expect(clampThinkingReserve(60_000, 8_192)).toBe(OUTPUT_LIMIT_RETRY_CEILING - 60_000);
    expect(60_000 + clampThinkingReserve(60_000, 8_192)).toBe(OUTPUT_LIMIT_RETRY_CEILING);
  });

  it("gives a step already at the ceiling no reserve at all, leaving it exactly the request it sends today", () => {
    expect(clampThinkingReserve(OUTPUT_LIMIT_RETRY_CEILING, 8_192)).toBe(0);
    expect(clampThinkingReserve(OUTPUT_LIMIT_RETRY_CEILING + 10_000, 8_192)).toBe(0);
  });

  it("leaves a reserve that already fits completely alone", () => {
    expect(clampThinkingReserve(16_384, 4_096)).toBe(4_096);
  });

  it("returns zero for a zero or negative reserve rather than inventing one", () => {
    expect(clampThinkingReserve(1_000, 0)).toBe(0);
    expect(clampThinkingReserve(1_000, -5)).toBe(0);
  });
});

describe("the Anthropic request body", () => {
  it("carries no thinking and no output_config for a model that does not reason by default", async () => {
    const create = vi.fn().mockResolvedValue(goodResponse());
    await new AnthropicAdapter(fakeClient(create), { delay: () => Promise.resolve() }).complete(request());

    const sent = create.mock.calls[0]![0] as Record<string, unknown>;
    expect("thinking" in sent).toBe(false);
    expect("output_config" in sent).toBe(false);
    // And the ceiling is untouched: no reserve, so `max_tokens` is the step's
    // own number exactly as it has always been.
    expect(sent["max_tokens"]).toBe(DEFAULT_MAX_TOKENS);
  });

  it("states adaptive reasoning at low effort, and adds the reserve on top of the answer's room, when a step asks for reasoning", async () => {
    const create = vi.fn().mockResolvedValue(goodResponse());
    await new AnthropicAdapter(fakeClient(create), { delay: () => Promise.resolve() }).complete(request({ maxTokens: 20_000, thinkingBudget: 6_000 }));

    const sent = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent["thinking"]).toEqual({ type: "adaptive" });
    expect(sent["output_config"]).toEqual({ effort: "low" });
    // 20,000 still means twenty thousand tokens of ANSWER.
    expect(sent["max_tokens"]).toBe(26_000);
    // Forced tool use survives alongside reasoning — that pairing is only
    // restricted on Bedrock, and this engine routes through Agent Platform.
    expect(sent["tool_choice"]).toEqual({ type: "tool", name: "emit_output" });
  });

  it("says disabled, explicitly, when a step asks for no reasoning", async () => {
    const create = vi.fn().mockResolvedValue(goodResponse());
    await new AnthropicAdapter(fakeClient(create), { delay: () => Promise.resolve() }).complete(request({ maxTokens: 8_000, thinkingBudget: 0 }));

    const sent = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent["thinking"]).toEqual({ type: "disabled" });
    expect(sent["max_tokens"]).toBe(8_000);
  });
});

describe("a turn that answered in prose is repairable, not fatal", () => {
  it("raises a StructuredOutputValidationError carrying what the model said instead of the tool call", async () => {
    // Was a bare `Error`, which `BaseAgent` can only end the step on: the
    // client gets nothing, and the one thing that would have fixed it —
    // showing the model its own mistake and asking again — never happened.
    const create = vi.fn().mockResolvedValue({
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "I'll call emit_output with body: hello" }],
      usage: { input_tokens: 90, output_tokens: 12, cache_read_input_tokens: 0 },
    });

    const err = await new AnthropicAdapter(fakeClient(create), { delay: () => Promise.resolve() }).complete(request()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StructuredOutputValidationError);
    expect((err as Error).message).toMatch(/did not return a "emit_output" tool_use block/);
    // The repair prompt needs the offending payload to show the model.
    expect((err as StructuredOutputValidationError).rawPayloadExcerpt).toMatch(/I'll call emit_output/);
    // And the turn's real spend, not the zeros a post-validation read leaves.
    expect((err as StructuredOutputValidationError).usage).toEqual({
      modelUsed: "claude-sonnet-4-6",
      inputTokens: { cached: 0, uncached: 90 },
      outputTokens: 12,
    });
  });
});
