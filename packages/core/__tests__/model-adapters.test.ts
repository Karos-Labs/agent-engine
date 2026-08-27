import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MessagesApiAdapter,
  OpenAICompatibleAdapter,
  toRootObjectJsonSchema,
  unwrapRootPayload,
  WRAPPED_ROOT_PROPERTY,
} from "../src/router/adapters/index.js";
import type { RetryOptions } from "../src/router/adapters/retry.js";
import type { MessagesApiClient } from "../src/router/adapters/types.js";

/**
 * The exact schema `BaseAgent.buildTurnSchema()` produces for every real
 * agent: a ReAct turn is either a `tool_call` or a `final`, so the root is a
 * discriminated union — which `z.toJSONSchema()` emits as a root-level
 * `oneOf` carrying no `type`.
 *
 * Both providers reject that outright ("input_schema does not support oneOf,
 * allOf, or anyOf at the top level"), which is why every real agent run used
 * to die on its first model call with a bare `tooling_error`. These tests
 * exist because nothing previously asserted what actually goes on the wire —
 * every other test in this repo injects a fake `ModelRouter` and never
 * reaches an adapter at all.
 */
function turnSchema() {
  return z.discriminatedUnion("type", [
    z.object({ type: z.literal("tool_call"), thought: z.string().optional(), tool: z.string().min(1), args: z.unknown() }),
    z.object({ type: z.literal("final"), thought: z.string().optional(), output: z.object({ text: z.string(), hook: z.string() }) }),
  ]);
}

const objectSchema = z.object({ text: z.string() });

describe("toRootObjectJsonSchema", () => {
  it("never emits a union at the root — the shape both providers reject", () => {
    const { schema } = toRootObjectJsonSchema(turnSchema());

    expect(schema["type"]).toBe("object");
    expect(schema["oneOf"]).toBeUndefined();
    expect(schema["anyOf"]).toBeUndefined();
    expect(schema["allOf"]).toBeUndefined();
  });

  it("nests a union root under a single property, preserving both branches", () => {
    const { schema, wrapped } = toRootObjectJsonSchema(turnSchema());

    expect(wrapped).toBe(true);
    expect(schema["required"]).toEqual([WRAPPED_ROOT_PROPERTY]);
    const nested = (schema["properties"] as Record<string, { oneOf?: unknown[] }>)[WRAPPED_ROOT_PROPERTY];
    expect(nested?.oneOf).toHaveLength(2);
  });

  it("passes an object root through untouched, without wrapping", () => {
    const { schema, wrapped } = toRootObjectJsonSchema(objectSchema);

    expect(wrapped).toBe(false);
    expect(schema["type"]).toBe("object");
    expect(schema["properties"]).toHaveProperty("text");
  });

  it("drops $schema dialect metadata, which neither provider validates against", () => {
    expect(toRootObjectJsonSchema(objectSchema).schema["$schema"]).toBeUndefined();
    expect(toRootObjectJsonSchema(turnSchema()).schema["$schema"]).toBeUndefined();
  });

  it("round-trips a wrapped payload back to the raw turn", () => {
    const turn = { type: "final", output: { text: "hi", hook: "hi" } };

    expect(unwrapRootPayload({ [WRAPPED_ROOT_PROPERTY]: turn }, true)).toEqual(turn);
    expect(unwrapRootPayload(turn, false)).toEqual(turn);
  });

  it("fails loudly when a wrapped payload is missing the wrapper property", () => {
    expect(() => unwrapRootPayload({ type: "final" }, true)).toThrow(new RegExp(WRAPPED_ROOT_PROPERTY));
  });
});

/**
 * SCRUM-358 deleted `AnthropicAdapter` along with the direct-Anthropic route.
 * The behaviour these tests cover was never Anthropic-specific — it lives in
 * `MessagesApiAdapter`, the shared base the Vertex route still extends — so
 * the coverage is kept and repointed at the base class directly rather than
 * deleted with the subclass. `modelIds` defaults to the identity codec, which
 * is exactly what the deleted subclass pinned.
 */
function messagesApiAdapter(client: unknown, retryOptions: RetryOptions = {}, promptCaching = true): MessagesApiAdapter {
  return new MessagesApiAdapter({ providerId: "anthropic", client: client as MessagesApiClient, retryOptions, promptCaching });
}

describe("MessagesApiAdapter (the shared Messages-API mechanics)", () => {
  function fakeClient(capture: { request?: Record<string, never> }) {
    return {
      messages: {
        create: async (body: Record<string, never>) => {
          capture.request = body;
          return {
            model: "claude-sonnet-4-6",
            content: [
              {
                type: "tool_use",
                name: "emit_output",
                input: { [WRAPPED_ROOT_PROPERTY]: { type: "final", output: { text: "drafted", hook: "drafted" } } },
              },
            ],
            usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 20 },
          };
        },
      },
    };
  }

  it("sends an object-rooted input_schema for BaseAgent's union turn schema", async () => {
    const capture: { request?: Record<string, never> } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = messagesApiAdapter(fakeClient(capture) as any);

    await adapter.complete({ prompt: "draft it", schema: turnSchema(), model: "claude-sonnet-4-6" });

    const inputSchema = (capture.request as unknown as { tools: Array<{ input_schema: Record<string, unknown> }> }).tools[0]!.input_schema;
    expect(inputSchema["type"]).toBe("object");
    expect(inputSchema["oneOf"]).toBeUndefined();
  });

  it("unwraps the model's payload before parsing, returning the real turn", async () => {
    const capture: { request?: Record<string, never> } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = messagesApiAdapter(fakeClient(capture) as any);

    const result = await adapter.complete({ prompt: "draft it", schema: turnSchema(), model: "claude-sonnet-4-6" });

    expect(result.output).toEqual({ type: "final", output: { text: "drafted", hook: "drafted" } });
    expect(result.inputTokens).toEqual({ cached: 20, uncached: 120, cacheWrite: 0 });
    expect(result.outputTokens).toBe(30);
  });

  it("fails with an actionable message when the response is truncated at the token limit", async () => {
    const client = {
      messages: {
        create: async () => ({
          model: "claude-sonnet-4-6",
          stop_reason: "max_tokens",
          // What the API actually returns when a long-form draft runs out of room:
          // a tool_use block whose input was cut off before any field landed.
          content: [{ type: "tool_use", name: "emit_output", input: {} }],
          usage: { input_tokens: 100, output_tokens: 4096 },
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = messagesApiAdapter(client as any);

    await expect(adapter.complete({ prompt: "write a blog post", schema: turnSchema(), model: "claude-sonnet-4-6" })).rejects.toThrow(
      /output limit|maxTokens/i,
    );
  });

  it("honours a step's explicit maxTokens over the default", async () => {
    const capture: { request?: Record<string, never> } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = messagesApiAdapter(fakeClient(capture) as any);

    await adapter.complete({ prompt: "draft it", schema: turnSchema(), model: "claude-sonnet-4-6", maxTokens: 32000 });

    expect((capture.request as unknown as { max_tokens: number }).max_tokens).toBe(32000);
  });
});

describe("OpenAICompatibleAdapter", () => {
  it("sends an object-rooted json_schema and unwraps the response", async () => {
    let sent: Record<string, unknown> | undefined;
    const client = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            sent = body;
            return {
              model: "gpt-4o",
              choices: [
                {
                  message: {
                    content: JSON.stringify({ [WRAPPED_ROOT_PROPERTY]: { type: "final", output: { text: "hi", hook: "hi" } } }),
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 40 } },
            };
          },
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new OpenAICompatibleAdapter(client as any);

    const result = await adapter.complete({ prompt: "draft it", schema: turnSchema(), model: "gpt-4o" });

    const schema = (sent as unknown as { response_format: { json_schema: { schema: Record<string, unknown> } } }).response_format.json_schema.schema;
    expect(schema["type"]).toBe("object");
    expect(schema["oneOf"]).toBeUndefined();
    expect(result.output).toEqual({ type: "final", output: { text: "hi", hook: "hi" } });
    expect(result.inputTokens).toEqual({ cached: 40, uncached: 60 });
  });
});

/**
 * Observed against the blog agent's ten-field output schema: the model
 * returns the nested turn as a quoted JSON string rather than an object.
 */
describe("unwrapRootPayload — model-serialized payloads", () => {
  const turn = { type: "final", output: { text: "hi", hook: "hi" } };

  it("unquotes a wrapped payload the model returned as a JSON string", () => {
    expect(unwrapRootPayload({ [WRAPPED_ROOT_PROPERTY]: JSON.stringify(turn) }, true)).toEqual(turn);
  });

  it("unquotes an unwrapped payload the model returned as a JSON string", () => {
    expect(unwrapRootPayload(JSON.stringify(turn), false)).toEqual(turn);
  });

  it("leaves a genuine string that is not JSON alone", () => {
    expect(unwrapRootPayload({ [WRAPPED_ROOT_PROPERTY]: "just a sentence" }, true)).toBe("just a sentence");
  });

  it("leaves a JSON scalar alone rather than unwrapping it to a primitive", () => {
    expect(unwrapRootPayload({ [WRAPPED_ROOT_PROPERTY]: "42" }, true)).toBe("42");
  });
});
