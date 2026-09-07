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

/**
 * `JSON.parse`, then once more after `repairLooseJson`, then once more on the
 * first balanced `{...}` the text contains (a model that appended prose after
 * the object). `undefined` when nothing parses.
 */
export function parseJsonLeniently(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the repaired attempts
  }
  const repaired = repairLooseJson(text);
  try {
    return JSON.parse(repaired);
  } catch {
    // fall through
  }
  const balanced = firstBalancedObject(repaired);
  if (balanced === undefined) return undefined;
  try {
    return JSON.parse(balanced);
  } catch {
    return undefined;
  }
}

/**
 * The two mistakes a model makes when it hand-serializes an object INSIDE a
 * string, fixed by walking the text with a quote tracker:
 *
 * 1. Raw control characters inside a string literal (a real line break where
 *    `\n` was owed). Escaped in place.
 * 2. An unescaped `"` inside a string literal (a quoted title in a paragraph
 *    the model already had to double-escape, and did not, once, 6,000
 *    characters in). A `"` met inside a string closes it only when the next
 *    non-blank character is structural (`,` `}` `]` `:`) or the text ends;
 *    otherwise it is content and is escaped. Prep runs pubsub-21498863468155660
 *    (newsletter, `output` quoted, every round) and pubsub-21496486967745987
 *    (linkedin, the whole `turn` quoted) were both rejected by JSON.parse for
 *    exactly this, after the control-character pass alone had shipped.
 *
 * Structural whitespace and everything outside strings is left untouched, so
 * valid JSON round-trips unchanged.
 */
export function repairLooseJson(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      out += ch + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text[j] === "\n" || text[j] === "\r" || text[j] === "\t")) j++;
      const next = text[j];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** The first `{ ... }` with balanced braces outside string literals, or `undefined`. */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
