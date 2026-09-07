import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RAW_PAYLOAD_EXCERPT_LIMIT,
  StructuredOutputValidationError,
  excerptRawPayload,
  parseStructuredOutput,
  parseStructuredOutputText,
} from "../src/router/adapters/structured-output.js";

/**
 * The exact shape `BaseAgent.buildTurnSchema()` produces for a step that
 * declares tools: a root discriminated union, which `toRootObjectJsonSchema`
 * nests under `turn` before it goes on the wire. Every case below is a real
 * payload shape observed failing in production, not an invented one.
 */
const turnSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_call"), thought: z.string().optional(), tool: z.enum(["render.preview"]), args: z.unknown() }),
  z.object({ type: z.literal("final"), thought: z.string().optional(), output: z.object({ text: z.string() }) }),
]);

const ctx = {
  providerId: "anthropic",
  model: "claude-sonnet-4-6",
  usage: { modelUsed: "claude-sonnet-4-6", inputTokens: { cached: 10, uncached: 90 }, outputTokens: 25 },
};

describe("parseStructuredOutput — happy paths", () => {
  it("unwraps the `turn` property and returns the validated turn", () => {
    const out = parseStructuredOutput(turnSchema, { turn: { type: "final", output: { text: "hello" } } }, true, ctx);
    expect(out).toEqual({ type: "final", output: { text: "hello" } });
  });

  it("still normalizes a turn the model serialized as a JSON string, the pre-existing documented quirk", () => {
    const out = parseStructuredOutput(turnSchema, { turn: JSON.stringify({ type: "final", output: { text: "hi" } }) }, true, ctx);
    expect(out).toEqual({ type: "final", output: { text: "hi" } });
  });

  it("passes an unwrapped object root straight through when the schema was never wrapped", () => {
    const objectRoot = z.object({ type: z.literal("final"), output: z.object({ text: z.string() }) });
    const out = parseStructuredOutput(objectRoot, { type: "final", output: { text: "hi" } }, false, ctx);
    expect(out).toEqual({ type: "final", output: { text: "hi" } });
  });
});

describe("parseStructuredOutput — the failures that killed real runs", () => {
  // prep run pubsub-21532935275023108 (x-agent, 10-draft-post): the model
  // returned its output object with no envelope, and the discriminated union
  // rejected it with "Invalid discriminator value. Expected 'tool_call' | 'final'".
  it("classifies a bare output object with no `type` as a repairable validation error carrying the payload and usage", () => {
    const raw = { turn: { text: "AI marketing this quarter…", mainPostText: "AI marketing this quarter…" } };

    const err = (() => {
      try {
        parseStructuredOutput(turnSchema, raw, true, ctx);
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(StructuredOutputValidationError);
    const validationError = err as StructuredOutputValidationError;
    expect(validationError.message).toMatch(/malformed structured output.*did not match the step's turn schema/s);
    expect(validationError.message).toContain("invalid_union");
    expect(validationError.rawPayloadExcerpt).toContain("AI marketing this quarter");
    expect(validationError.usage).toEqual(ctx.usage);
  });

  // prep run pubsub-21066167120415191 (linkedin-agent, 09-draft-post): the
  // model stringified the payload *and* the string didn't parse, so the
  // normalizer correctly left it alone and the schema saw a string.
  it("classifies a stringified payload that isn't valid JSON as a repairable validation error", () => {
    const err = (() => {
      try {
        parseStructuredOutput(turnSchema, { turn: '{"type":"final","output":{"text":"trunc' }, true, ctx);
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(StructuredOutputValidationError);
    expect((err as Error).message).toMatch(/expected object, received string/i);
  });

  it("classifies a missing `turn` wrapper as a repairable validation error, not a bare Error", () => {
    const err = (() => {
      try {
        parseStructuredOutput(turnSchema, { type: "final", output: { text: "hi" } }, true, ctx);
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(StructuredOutputValidationError);
    expect((err as Error).message).toMatch(/wrapped under "turn".*no such property/s);
  });

  it("names a disallowed tool as a validation error — `allowedTools` narrowing still fails at the adapter", () => {
    expect(() =>
      parseStructuredOutput(turnSchema, { turn: { type: "tool_call", tool: "shell.exec", args: {} } }, true, ctx),
    ).toThrow(StructuredOutputValidationError);
  });

  it("omits usage when the adapter had none to report, rather than inventing zeros as real numbers", () => {
    const err = (() => {
      try {
        parseStructuredOutput(turnSchema, { turn: {} }, true, { providerId: "anthropic", model: "claude-sonnet-4-6" });
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect((err as StructuredOutputValidationError).usage).toBeUndefined();
  });
});

describe("parseStructuredOutputText", () => {
  it("parses valid JSON text", () => {
    expect(parseStructuredOutputText('{"turn":{"type":"final"}}', ctx)).toEqual({ turn: { type: "final" } });
  });

  it("classifies non-JSON text as a repairable validation error carrying the raw text", () => {
    const err = (() => {
      try {
        parseStructuredOutputText("Here is your post!", ctx);
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(StructuredOutputValidationError);
    expect((err as StructuredOutputValidationError).rawPayloadExcerpt).toBe("Here is your post!");
    expect((err as StructuredOutputValidationError).usage).toEqual(ctx.usage);
  });
});

describe("excerptRawPayload", () => {
  it("renders an object as JSON and a string as itself", () => {
    expect(excerptRawPayload({ a: 1 })).toBe('{"a":1}');
    expect(excerptRawPayload("plain")).toBe("plain");
  });

  it("truncates past the limit and says how much was dropped", () => {
    const excerpt = excerptRawPayload("x".repeat(RAW_PAYLOAD_EXCERPT_LIMIT + 500));
    expect(excerpt).toMatch(/… \[truncated, 2500 chars total\]$/);
    expect(excerpt.length).toBeLessThan(RAW_PAYLOAD_EXCERPT_LIMIT + 60);
  });

  // A diagnostic path must never be the thing that throws.
  it("describes a circular payload instead of throwing", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;
    expect(() => excerptRawPayload(circular)).not.toThrow();
  });
});

describe("parseStructuredOutput — the stringified `output`, repaired for free", () => {
  const objectRoot = z.object({ type: z.literal("final").default("final"), thought: z.string().optional(), output: z.object({ text: z.string(), n: z.number() }) });

  // prep run pubsub-21753432816018912 (newsletter-agent, claude-opus-4-8, a
  // no-tool step): on every editorial round the model wrote the edition
  // correctly and quoted it — `"output": "{\"subjectLine\": ..."` — then paid
  // a 46k-token repair turn to write it again. $5.47 and a failed run.
  it("unquotes an `output` the model serialized as a JSON string", () => {
    const out = parseStructuredOutput(objectRoot, { thought: "done", output: JSON.stringify({ text: "hi", n: 1 }) }, false, ctx);
    expect(out).toEqual({ type: "final", thought: "done", output: { text: "hi", n: 1 } });
  });

  it("unquotes a stringified `output` inside a wrapped turn too", () => {
    const out = parseStructuredOutput(turnSchema, { turn: { type: "final", output: JSON.stringify({ text: "hi" }) } }, true, ctx);
    expect(out).toEqual({ type: "final", output: { text: "hi" } });
  });

  // prep run pubsub-21711702970427669 (x-agent, claude-sonnet-4-6): the whole
  // turn as a string, with the post's line breaks left raw inside the quoted
  // JSON — which JSON.parse rejects, so the pre-existing unquoting never fired.
  it("parses a stringified turn whose string values carry raw line breaks", () => {
    const raw = '{"type":"final","output":{"text":"Line one.\nLine two.\n\nLine four."}}';
    expect(() => JSON.parse(raw)).toThrow();
    const out = parseStructuredOutput(turnSchema, { turn: raw }, true, ctx);
    expect(out).toEqual({ type: "final", output: { text: "Line one.\nLine two.\n\nLine four." } });
  });

  it("leaves a string `output` alone when it is not the JSON of an object, so the schema still names the real mistake", () => {
    expect(() => parseStructuredOutput(objectRoot, { output: "just prose" }, false, ctx)).toThrow(StructuredOutputValidationError);
    expect(() => parseStructuredOutput(objectRoot, { output: JSON.stringify([1, 2]) }, false, ctx)).toThrow(StructuredOutputValidationError);
  });

  it("unquotes a tool call's stringified `args` the same way", () => {
    const out = parseStructuredOutput(turnSchema, { turn: { type: "tool_call", tool: "render.preview", args: JSON.stringify({ text: "x" }) } }, true, ctx);
    expect(out).toEqual({ type: "tool_call", tool: "render.preview", args: { text: "x" } });
  });
});
