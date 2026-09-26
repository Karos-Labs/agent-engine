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

  // prep runs pubsub-21498863468155660 / pubsub-21496486967745987: the
  // control-character pass alone shipped, and both still failed, because the
  // hand-serialized JSON carried ONE unescaped quote thousands of characters
  // in ("the paper "GEO: Generative Engine Optimization" was presented").
  it("parses a stringified output whose string values carry an unescaped quote", () => {
    const raw = '{"text": "The paper "GEO: Generative Engine Optimization" was presented at KDD 2024.", "n": 2}';
    expect(() => JSON.parse(raw)).toThrow();
    const out = parseStructuredOutput(objectRoot, { output: raw }, false, ctx);
    expect(out.output).toEqual({ text: 'The paper "GEO: Generative Engine Optimization" was presented at KDD 2024.', n: 2 });
  });

  it("parses a stringified turn with trailing prose after the object", () => {
    const raw = `${JSON.stringify({ type: "final", output: { text: "hi" } })}\n\nReturned as requested.`;
    const out = parseStructuredOutput(turnSchema, { turn: raw }, true, ctx);
    expect(out).toEqual({ type: "final", output: { text: "hi" } });
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

/**
 * A house-style length cap is not a correctness rule, and throwing the whole
 * turn away over one is how prep run pubsub-21864573169935321 lost its
 * Template Studio: `00c3-write-design-brief` came back with two `gaps` lines
 * a few characters past `.max(200)`, was rejected, was re-prompted, came back
 * over the cap again, and took the step's whole budget with it.
 */
describe("parseStructuredOutput — a cap the answer overshoots is applied, not asserted", () => {
  const capped = z.object({
    type: z.literal("final"),
    output: z.object({
      gaps: z.array(z.string().max(200)).max(3),
      title: z.string().min(1),
    }),
  });

  it("trims an over-long string to the declared maximum and accepts the turn", () => {
    const gap = "x".repeat(214);
    const out = parseStructuredOutput(capped, { turn: { type: "final", output: { gaps: [gap], title: "t" } } }, true, ctx);
    expect(out.output.gaps[0]).toHaveLength(200);
    expect(out.output.title).toBe("t");
  });

  it("trims every offending entry, not just the first", () => {
    const out = parseStructuredOutput(
      capped,
      { turn: { type: "final", output: { gaps: ["a".repeat(260), "short", "b".repeat(9_000)], title: "t" } } },
      true,
      ctx,
    );
    expect(out.output.gaps.map((g) => g.length)).toEqual([200, 5, 200]);
  });

  it("slices an over-long array to the declared maximum", () => {
    const out = parseStructuredOutput(capped, { turn: { type: "final", output: { gaps: ["a", "b", "c", "d", "e"], title: "t" } } }, true, ctx);
    expect(out.output.gaps).toEqual(["a", "b", "c", "d"].slice(0, 3));
  });

  it("does not invent data — a genuinely wrong shape still fails, and reports its own issues", () => {
    // `title` is missing: not a length overshoot, and nothing here can supply it.
    expect(() => parseStructuredOutput(capped, { turn: { type: "final", output: { gaps: ["x".repeat(500)] } } }, true, ctx)).toThrow(
      /invalid_type|"title"/,
    );
  });

  it("leaves a too-SHORT value alone — that is the model's answer, not an overshoot", () => {
    const floored = z.object({ type: z.literal("final"), output: z.object({ body: z.string().min(50) }) });
    expect(() => parseStructuredOutput(floored, { turn: { type: "final", output: { body: "too short" } } }, true, ctx)).toThrow(
      StructuredOutputValidationError,
    );
  });

  it("leaves a numeric cap alone — clamping a score would fabricate a verdict rather than trim a sentence", () => {
    const scored = z.object({ type: z.literal("final"), output: z.object({ score: z.number().max(10) }) });
    expect(() => parseStructuredOutput(scored, { turn: { type: "final", output: { score: 97 } } }, true, ctx)).toThrow(
      StructuredOutputValidationError,
    );
  });
});

describe("parseStructuredOutput — a turn nested inside its own output (prep batch 7, 2026-09-25)", () => {
  // `BaseAgent`'s no-tool turn: `type` defaults to "final".
  const noToolTurn = z.object({ type: z.literal("final").default("final"), output: z.object({ caption: z.string(), slides: z.array(z.string()) }) });
  const ctx = { providerId: "google-agent-platform", model: "claude-sonnet-4-6" };

  it("unwraps {output: {type: 'final', output: draft}} and returns the draft sitti's copy step threw away twice", () => {
    const raw = { output: { type: "final", output: { caption: "c", slides: ["one", "two"] } } };
    expect(parseStructuredOutput(noToolTurn, raw, false, ctx)).toEqual({ type: "final", output: { caption: "c", slides: ["one", "two"] } });
  });

  it("never rewrites a payload that parses as sent, and still refuses one that is wrong for another reason", () => {
    const fine = { type: "final", output: { caption: "c", slides: ["a"] } };
    expect(parseStructuredOutput(noToolTurn, fine, false, ctx)).toEqual(fine);
    expect(() => parseStructuredOutput(noToolTurn, { output: { type: "final", output: { caption: 3 } } }, false, ctx)).toThrow(StructuredOutputValidationError);
  });
});

describe("an over-long string is cut at a whole piece, never mid-word (2026-09-26)", () => {
  it("cuts at the last clause in the allowance, then at the last word, and hard only when there is no space", async () => {
    const { cutAtBoundary } = await import("../src/router/adapters/structured-output.js");
    // XO Digital prep batch 8: an 80-character label cut to "...impulsionadas p".
    const label = "das emissões de renda fixa digital em 2025 abaixo de R$ 500 mil, impulsionadas por novos investidores";
    expect(cutAtBoundary(label, 80)).toBe("das emissões de renda fixa digital em 2025 abaixo de R$ 500 mil");
    expect(cutAtBoundary("one two three four five six seven eight", 20)).toBe("one two three four");
    expect(cutAtBoundary("x".repeat(214), 200)).toHaveLength(200);
    expect(cutAtBoundary("short", 80)).toBe("short");
    for (const t of [label, "a, b, c, d, e, f, g, h, i, j, k, l", "word ".repeat(40)]) expect(cutAtBoundary(t, 30).length).toBeLessThanOrEqual(30);
  });
});
