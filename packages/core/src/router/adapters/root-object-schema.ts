import { z } from "zod";
import type { ZodSchema } from "../../types/agent-step.js";

/** The single property a non-object root schema is nested under before it goes on the wire. */
export const WRAPPED_ROOT_PROPERTY = "turn";

export interface RootObjectJsonSchema {
  /** The JSON Schema to send as the provider's tool-input / response-format schema. */
  schema: Record<string, unknown>;
  /** True when the model's raw payload has to be unwrapped from `WRAPPED_ROOT_PROPERTY` before `schema.parse()`. */
  wrapped: boolean;
}

/**
 * Converts a step's Zod schema into a JSON Schema every provider will actually
 * accept as a structured-output root.
 *
 * Both providers require that root to be a plain object: Anthropic rejects
 * anything else outright with `input_schema does not support oneOf, allOf, or
 * anyOf at the top level`, and OpenAI's Structured Outputs has the same
 * object-root rule. `BaseAgent.buildTurnSchema()` — the only caller that
 * matters in practice — always produces a `z.discriminatedUnion` (a ReAct turn
 * is either a `tool_call` or a `final`), which `z.toJSONSchema()` emits as a
 * root-level `oneOf` with no `type` at all. Passing that straight through is
 * what made every real agent run fail on its first model call with an
 * otherwise-unexplained `tooling_error`.
 *
 * So: object roots go out unchanged, and any other root is nested one level
 * under `turn`, which is a legal object schema carrying the identical union.
 * `unwrapRootPayload()` below reverses it, and the two must always be used as
 * a pair.
 *
 * `$schema` is dropped — it's JSON Schema dialect metadata neither provider's
 * schema validator needs, and it is not part of what either one validates
 * against.
 */
export function toRootObjectJsonSchema(schema: ZodSchema<unknown>): RootObjectJsonSchema {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;

  if (json["type"] === "object") {
    return { schema: json, wrapped: false };
  }

  return {
    schema: {
      type: "object",
      properties: { [WRAPPED_ROOT_PROPERTY]: json },
      required: [WRAPPED_ROOT_PROPERTY],
      additionalProperties: false,
    },
    wrapped: true,
  };
}

/**
 * Reverses `toRootObjectJsonSchema`'s wrapping, then normalizes a payload the
 * model serialized as a JSON string instead of a nested object.
 *
 * That stringification is a real, observed behaviour, not a defensive guess:
 * against the largest output schema in this system (the blog draft — ten
 * fields including a full markdown body) the model reliably returns
 * `{"turn": "{\"type\":\"final\",...}"` — valid JSON, just quoted. The
 * declared schema says object, so a string that parses to one is the model's
 * encoding quirk rather than real data, and unquoting it here keeps every
 * caller's `schema.parse()` working. A string that isn't JSON, or that parses
 * to a non-object, is passed through untouched so a genuinely string-valued
 * payload still reaches the schema as-is.
 */
export function unwrapRootPayload(raw: unknown, wrapped: boolean): unknown {
  if (!wrapped) return normalizeJsonString(raw);
  if (typeof raw !== "object" || raw === null || !(WRAPPED_ROOT_PROPERTY in raw)) {
    throw new Error(
      `structured output was wrapped under "${WRAPPED_ROOT_PROPERTY}" but the model returned no such property — got ${JSON.stringify(raw)?.slice(0, 200)}`,
    );
  }
  return normalizeJsonString((raw as Record<string, unknown>)[WRAPPED_ROOT_PROPERTY]);
}

/**
 * A string the model meant as an object, parsed back to one; anything else
 * is returned untouched.
 *
 * Two observed shapes. The common one is valid JSON in quotes. The second is
 * the same thing with RAW newlines inside its string values: the model wrote
 * a multi-paragraph `text` field, then serialized the whole object as a
 * string without escaping the line breaks it had just written (prep run
 * pubsub-21711702970427669, x-agent, two turns in a row). `JSON.parse`
 * rejects a raw control character inside a string literal, so the payload
 * used to fall through as a string, fail the schema with "expected object,
 * received string", and cost a repair turn that repeated the mistake. The
 * lenient pass escapes control characters that sit INSIDE a string literal
 * (tracked by walking the quotes) and leaves structural whitespace alone.
 */
export function normalizeJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  const parsed = parseJsonLeniently(trimmed);
  return typeof parsed === "object" && parsed !== null ? parsed : value;
}

/** `JSON.parse`, then once more with raw control characters inside string literals escaped. */
export function parseJsonLeniently(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the repaired attempt
  }
  try {
    return JSON.parse(escapeControlCharactersInStrings(text));
  } catch {
    return undefined;
  }
}

function escapeControlCharactersInStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") {
        out += ch + (text[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}
