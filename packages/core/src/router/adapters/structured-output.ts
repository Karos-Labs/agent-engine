import { ZodError } from "zod";
import type { TokenUsage, ZodSchema } from "../../types/agent-step.js";
import { normalizeJsonString, unwrapRootPayload } from "./root-object-schema.js";

/**
 * How much of the model's raw payload is echoed into telemetry and into the
 * repair prompt. Big enough to show the actual shape mistake (a missing
 * `type`, a stringified object, a bare output payload), small enough that a
 * long-form draft doesn't bloat every persisted step record — the whole
 * payload is already lost today, so a bounded excerpt is strictly more than
 * what any run report could previously show.
 */
export const RAW_PAYLOAD_EXCERPT_LIMIT = 2000;

/** Best-effort one-line rendering of whatever the model returned, truncated to `limit`. */
export function excerptRawPayload(raw: unknown, limit: number = RAW_PAYLOAD_EXCERPT_LIMIT): string {
  let text: string;
  try {
    text = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? String(raw));
  } catch {
    // A payload carrying a circular reference or a BigInt still has to be
    // describable — a diagnostic path must never be the thing that throws.
    text = String(raw);
  }
  return text.length > limit ? `${text.slice(0, limit)}… [truncated, ${text.length} chars total]` : text;
}

/** The provider-reported usage of the turn that produced an unparseable payload. */
export interface StructuredOutputUsage {
  modelUsed: string;
  inputTokens: TokenUsage;
  outputTokens: number;
}

export interface StructuredOutputValidationErrorOptions {
  /** Exactly what the provider handed back, before unwrapping — the thing no previous run report captured. */
  rawPayload: unknown;
  /** Usage for the failed turn, when the adapter had it. Absent only if the failure predates a usable usage block. */
  usage?: StructuredOutputUsage;
  cause?: unknown;
}

/**
 * A model turn that came back complete but shaped wrong: a missing/invalid
 * `type` discriminator, the bare `output` object in place of the
 * `{type:"final", output}` envelope, a payload the model serialized as a JSON
 * string that doesn't parse, or non-JSON text where JSON was demanded.
 *
 * Distinct from every other adapter failure on purpose. A 429 or a dead
 * socket is already handled (`withRetry`); an exhausted output ceiling is
 * `OutputLimitExceededError`, which is re-asked with more room rather than
 * re-asked as-is. A malformed turn is the failure the model itself can fix
 * when told what it got wrong, so `BaseAgent` catches this type specifically
 * and spends one bounded repair turn on it instead of ending the run
 * (RFC-01 §5.3's loop stays bounded by `maxSteps` either way).
 */
export class StructuredOutputValidationError extends Error {
  readonly rawPayloadExcerpt: string;
  readonly usage: StructuredOutputUsage | undefined;

  constructor(message: string, options: StructuredOutputValidationErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "StructuredOutputValidationError";
    this.rawPayloadExcerpt = excerptRawPayload(options.rawPayload);
    this.usage = options.usage;
  }
}

/**
 * The output ceiling the engine will raise a truncated step to, and the hard
 * stop on that raise. 32k is what `intel-report-agent` already asks for and
 * gets from both vendors in production, so it is a ceiling with a precedent
 * rather than a guess; a step that truncates at 32k has a schema problem, not
 * a budget problem, and is allowed to fail loudly.
 */
export const OUTPUT_LIMIT_RETRY_FLOOR = 16_384;
export const OUTPUT_LIMIT_RETRY_CEILING = 32_000;

/**
 * The one raise a truncated turn is allowed, or `undefined` when the attempt
 * was already at the ceiling. Doubling alone is too timid from a 3k step —
 * three doublings to reach a workable size, each one a full re-billed turn —
 * so the raise goes straight to at least the adapters' own default and never
 * past the ceiling.
 */
export function raisedOutputLimit(attemptedMaxTokens: number): number | undefined {
  if (!Number.isFinite(attemptedMaxTokens) || attemptedMaxTokens >= OUTPUT_LIMIT_RETRY_CEILING) return undefined;
  return Math.min(Math.max(attemptedMaxTokens * 2, OUTPUT_LIMIT_RETRY_FLOOR), OUTPUT_LIMIT_RETRY_CEILING);
}

/**
 * A turn the model was still writing when its output budget ran out. The JSON
 * is cut mid-object and unparseable, so this is NOT a `StructuredOutputValidationError`:
 * re-asking the same question inside the same budget produces the same cut.
 *
 * It is classified apart from every other adapter failure because it is the
 * one failure whose fix is mechanical and knowable from the error itself —
 * ask again with more room. Until 2026-09-16 the message said exactly that
 * ("raise the step's `maxTokens`") and addressed it to a human reading a run
 * report days later, which is how three of `instagram-agent`'s four setup
 * steps spent a month failing on ceilings of 3k, 4k and 8k against schemas
 * that do not fit in them. `BaseAgent` now reads this type and does the raise
 * itself, once, in the same step.
 *
 * `usage` is whatever the provider reported for the truncated attempt. It is
 * never zero in practice — a turn that hit its ceiling burned every token of
 * it — and recording it is the difference between a step that looks free and
 * one that shows what the raise actually cost.
 */
export class OutputLimitExceededError extends Error {
  readonly attemptedMaxTokens: number;
  readonly usage: StructuredOutputUsage | undefined;

  constructor(message: string, options: { attemptedMaxTokens: number; usage?: StructuredOutputUsage }) {
    super(message);
    this.name = "OutputLimitExceededError";
    this.attemptedMaxTokens = options.attemptedMaxTokens;
    this.usage = options.usage;
  }
}

/**
 * Unwraps `toRootObjectJsonSchema`'s `turn` nesting and validates the result,
 * converting either failure into a `StructuredOutputValidationError` that
 * carries the raw payload and the turn's usage.
 *
 * Every adapter parses structured output through here rather than calling
 * `schema.parse(unwrapRootPayload(...))` itself, so the repair path and the
 * payload capture can't be wired up on one provider and silently missing on
 * the next.
 *
 * Note the deliberate asymmetry with the truncation check each adapter still
 * does *before* calling this: a `max_tokens`/`MAX_TOKENS` stop reason throws
 * `OutputLimitExceededError` instead, because no amount of re-prompting
 * inside the same budget will produce a complete payload — that one is
 * re-asked with a raised ceiling, not with feedback.
 *
 * It carries its usage for the same reason `StructuredOutputValidationError`
 * does: until 2026-09-16 a truncated turn threw before usage was resolved, so
 * every one of them booked $0 — seventeen calls across the six Instagram prep
 * runs of that day, about $0.57 a run of real money the meter could not see,
 * on runs whose budget ladder was deleting the post's pictures to stay under a
 * target it could not actually measure.
 */
export function parseStructuredOutput<TOutput>(
  schema: ZodSchema<TOutput>,
  rawPayload: unknown,
  wrapped: boolean,
  context: { providerId: string; model: string; usage?: StructuredOutputUsage },
): TOutput {
  const { providerId, model, usage } = context;
  const describe = (detail: string) => `${providerId}: model "${model}" returned a malformed structured output — ${detail}`;
  const failure = (detail: string, cause: unknown) =>
    new StructuredOutputValidationError(describe(detail), {
      rawPayload,
      ...(usage ? { usage } : {}),
      cause,
    });

  let unwrapped: unknown;
  try {
    unwrapped = repairStringifiedFields(unwrapRootPayload(rawPayload, wrapped));
  } catch (err) {
    throw failure(err instanceof Error ? err.message : String(err), err);
  }

  try {
    return schema.parse(unwrapped);
  } catch (err) {
    if (err instanceof ZodError) {
      const clamped = clampOversizeValues(unwrapped, err.issues);
      if (clamped !== undefined) {
        try {
          return schema.parse(clamped);
        } catch {
          // Fall through and report the ORIGINAL issue list: the clamp was
          // not the fix, and the second error would only describe a payload
          // this function invented.
        }
      }
      // `ZodError.message` is already the serialized issue list; naming the
      // issues explicitly keeps the string stable if that ever changes.
      throw failure(`it did not match the step's turn schema: ${JSON.stringify(err.issues)}`, err);
    }
    throw err;
  }
}

/**
 * The verbosity failure, repaired instead of rejected.
 *
 * A `.max(200)` on a `gaps[]` line, a `.max(6)` on a template list — these
 * caps exist to keep a field terse, and they are enforced by throwing the
 * entire turn away. A model that writes a 214-character gap has not returned
 * bad data; it has returned the right data 14 characters over a house style
 * rule, and the run then pays for a full repair turn, and on prep run
 * pubsub-21864573169935321 the repair came back over the cap again and took
 * step `00c3-write-design-brief` down with it. Two `too_big` issues on a
 * six-item string array cost that run its whole Template Studio.
 *
 * So a cap the payload overshoots is applied rather than asserted: strings
 * are cut to `maximum`, arrays sliced to `maximum`, and the turn re-validated.
 * The declared maximum is by definition an acceptable value, so nothing here
 * can produce a payload the schema would have rejected on length.
 *
 * Only `too_big` on strings and arrays. `too_small` is not repairable — a
 * missing array item cannot be invented, and a short string is the model's
 * answer, not an overshoot — and numbers are left alone because a numeric cap
 * is usually a scale (`score ≤ 10`) where silently clamping would fabricate a
 * verdict rather than trim a sentence.
 *
 * Returns `undefined` when nothing was clamped, so the caller can tell "the
 * repair did not apply" from "the repair applied and the payload still fails".
 */
export function clampOversizeValues(payload: unknown, issues: ZodError["issues"]): unknown | undefined {
  let working = payload;
  let changed = false;

  for (const issue of issues) {
    if (issue.code !== "too_big") continue;
    const maximum = Number(issue.maximum);
    if (!Number.isFinite(maximum) || maximum < 0) continue;
    const current = valueAtPath(working, issue.path);
    // `inclusive: false` means the cap is exclusive, so the last legal length
    // is one below it. Zod reports it on every `too_big`; default to the
    // inclusive reading, which is what `.max()` produces.
    const limit = issue.inclusive === false ? Math.floor(maximum) - 1 : Math.floor(maximum);
    if (limit < 0) continue;

    let replacement: unknown;
    if (typeof current === "string" && current.length > limit) {
      replacement = current.slice(0, limit).trimEnd();
    } else if (Array.isArray(current) && current.length > limit) {
      replacement = current.slice(0, limit);
    } else {
      continue;
    }

    const next = setAtPath(working, issue.path, replacement);
    if (next === undefined) continue;
    working = next;
    changed = true;
  }

  return changed ? working : undefined;
}

function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (cursor === null || (typeof cursor !== "object" && typeof cursor !== "function")) return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[key];
  }
  return cursor;
}

/**
 * A structurally-shared copy of `root` with `path` set to `value`. Copying
 * rather than mutating keeps the raw payload the error report echoes exactly
 * as the provider sent it — the repair must never rewrite the evidence.
 */
function setAtPath(root: unknown, path: readonly PropertyKey[], value: unknown): unknown | undefined {
  if (path.length === 0) return value;
  const [key, ...rest] = path as [PropertyKey, ...PropertyKey[]];
  if (Array.isArray(root)) {
    const index = typeof key === "number" ? key : Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= root.length) return undefined;
    const child = setAtPath(root[index], rest, value);
    if (child === undefined && rest.length > 0) return undefined;
    const copy = [...root];
    copy[index] = child;
    return copy;
  }
  if (typeof root !== "object" || root === null) return undefined;
  const record = root as Record<PropertyKey, unknown>;
  if (!(key in record)) return undefined;
  const child = setAtPath(record[key], rest, value);
  if (child === undefined && rest.length > 0) return undefined;
  return { ...record, [key]: child };
}

/**
 * The model's other stringification: the envelope is a real object, but the
 * `output` (or a tool call's `args`) inside it is the JSON of an object in
 * quotes. `{"thought": "...", "output": "{\"subjectLine\": ...}"}`.
 *
 * Observed on every round of prep run pubsub-21753432816018912
 * (newsletter-agent, claude-opus-4-8, no-tool step): the model wrote the
 * edition correctly, quoted it, failed the schema on "expected object,
 * received string", and the repair turn re-billed a 46k-token prompt to write
 * the same edition again. Three rounds of that were $5.47 and a failed run.
 * The declared schema says `output` is an object, so a string that parses to
 * one is an encoding quirk, not data, and is unquoted here for free. A string
 * that is not JSON, or that parses to something other than an object, is
 * left alone so a genuinely string-valued field still reaches the schema
 * as-is and fails with the right message.
 */
export function repairStringifiedFields(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  let repaired: Record<string, unknown> | undefined;
  for (const key of ["output", "args"] as const) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const parsed = normalizeJsonString(value);
    if (parsed === value) continue;
    repaired = { ...(repaired ?? record), [key]: parsed };
  }
  return repaired ?? payload;
}

/**
 * `JSON.parse` for providers that hand back structured output as text
 * (Gemini's `responseMimeType`, OpenAI's `json_schema` response format),
 * classified as a malformed turn rather than an opaque `SyntaxError` so
 * truncated or prose-wrapped JSON reaches the same repair path.
 */
export function parseStructuredOutputText(
  raw: string,
  context: { providerId: string; model: string; usage?: StructuredOutputUsage },
): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new StructuredOutputValidationError(
      `${context.providerId}: model "${context.model}" returned a malformed structured output — it is not valid JSON`,
      { rawPayload: raw, ...(context.usage ? { usage: context.usage } : {}), cause: err },
    );
  }
}
