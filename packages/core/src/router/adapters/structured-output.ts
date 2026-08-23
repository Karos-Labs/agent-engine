import { ZodError } from "zod";
import type { TokenUsage, ZodSchema } from "../../types/agent-step.js";
import { unwrapRootPayload } from "./root-object-schema.js";

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
 * Distinct from every other adapter failure on purpose. A 429, a dead socket,
 * or an output-token ceiling are all conditions where re-asking the *same*
 * question is either already handled (`withRetry`) or provably useless (the
 * ceiling). A malformed turn is the one failure the model itself can fix when
 * told what it got wrong, so `BaseAgent` catches this type specifically and
 * spends one bounded repair turn on it instead of ending the run
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
 * does *before* calling this: a `max_tokens`/`MAX_TOKENS` stop reason keeps
 * throwing a plain `Error`, because raising `maxTokens` or narrowing the
 * output schema is a config fix and no amount of re-prompting will produce a
 * complete payload from an exhausted budget.
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
    unwrapped = unwrapRootPayload(rawPayload, wrapped);
  } catch (err) {
    throw failure(err instanceof Error ? err.message : String(err), err);
  }

  try {
    return schema.parse(unwrapped);
  } catch (err) {
    if (err instanceof ZodError) {
      // `ZodError.message` is already the serialized issue list; naming the
      // issues explicitly keeps the string stable if that ever changes.
      throw failure(`it did not match the step's turn schema: ${JSON.stringify(err.issues)}`, err);
    }
    throw err;
  }
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
