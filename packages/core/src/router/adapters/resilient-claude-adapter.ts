import { addSpanEvent, logWarning } from "@agent-engine/telemetry";
import { extractHttpStatus } from "./retry.js";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.js";

/**
 * A 429 (quota exhausted) or 404 (model/region not served) from a transport
 * that already ran its own internal `withRetry` (every `ModelAdapter` in
 * this package does) means retrying that SAME transport again would just
 * fail the same way a third time — the only thing worth trying next is a
 * DIFFERENT transport. Any other error (a schema the model can't satisfy, a
 * genuine 4xx auth/request problem) is a real failure, not a routing
 * problem, and must propagate as-is.
 */
function isFailoverWorthy(err: unknown): boolean {
  const status = extractHttpStatus(err);
  return status === 429 || status === 404;
}

/**
 * The error classes worth distinguishing when a hop fails (AU61 / SCRUM-360).
 * A 429 means the primary is out of capacity; a 404 means it is misrouted or
 * the model name is wrong. Those are different problems with different fixes,
 * and a failover count that merges them is only half a signal.
 */
function classifyFailover(err: unknown): { errorClass: string; status?: number } {
  const status = extractHttpStatus(err);
  if (status === 429) return { errorClass: "rate_limited", status };
  if (status === 404) return { errorClass: "not_served", status };
  if (status !== undefined) return { errorClass: "http_error", status };
  const name = err instanceof Error ? err.name : "unknown";
  return { errorClass: /timeout|abort/i.test(name) ? "timeout" : "other" };
}

function describeHop(from: string, err: unknown): { from: string; errorClass: string; status?: number } {
  const { errorClass, status } = classifyFailover(err);
  return { from, errorClass, ...(status !== undefined ? { status } : {}) };
}

/**
 * Makes a failover audible (AU61 / SCRUM-360).
 *
 * Before this, `complete()` caught, failed over, and returned in silence. A
 * fallback whose firing is invisible is not resilience — it is a way of not
 * finding out: never firing and firing constantly look identical from outside,
 * and in the second case output is coming from a different route than anyone
 * believes while every dashboard stays green.
 *
 * That silence is why "has it ever fired?" had to be reconstructed from Vertex
 * error metrics over a 30-day window instead of simply queried. And Claude on
 * Vertex emits NO publisher metrics at all — verified across
 * model_invocation_count, token_count and consumed_throughput, where the only
 * model that appears is gemini-2.5-flash-image — so this log line is not
 * merely the best signal for a Claude failover, it is the ONLY one.
 *
 * `event` is a stable string so a Cloud Monitoring log-based metric can count
 * it as a rate over time:
 *
 *   gcloud logging metrics create model_failover \
 *     --project=<project> \
 *     --description="ResilientClaudeAdapter hops" \
 *     --log-filter='jsonPayload.event="model.failover"'
 *
 * The active span also gets an event, so a failover is visible inside the
 * trace of the step that triggered it, next to that step's cost and latency.
 */
function recordFailover(details: { from: string; to: string; model: string; toModel?: string; err: unknown }): void {
  const { errorClass, status } = classifyFailover(details.err);
  const fields = {
    event: "model.failover",
    from: details.from,
    to: details.to,
    model: details.model,
    ...(details.toModel && details.toModel !== details.model ? { toModel: details.toModel } : {}),
    errorClass,
    ...(status !== undefined ? { status } : {}),
  };

  logWarning(`model failover: ${details.from} -> ${details.to} (${errorClass}${status ? ` ${status}` : ""}) for ${details.model}`, fields);

  // Visible inside the trace of the step that triggered it, beside that
  // step's own cost and latency. Best-effort: instrumentation must never turn
  // a successful failover into a failure.
  addSpanEvent("model.failover", fields);
}

export interface ResilientClaudeAdapterOptions {
  /** Vertex AI Model Garden / Agent Platform — the ADC-only route, and since SCRUM-358 the only route to Claude. */
  primary: ModelAdapter;
  /**
   * Vertex AI Gemini — the last-resort fallback once the Claude route is
   * exhausted. A genuinely different model family, so `tertiaryModel` is sent
   * instead of `req.model` (asking Gemini to serve a Claude model id would
   * just be a second, differently-shaped failure).
   *
   * Still called `tertiary`, deliberately, after SCRUM-358 removed the
   * direct-Anthropic hop that used to sit between it and `primary`. The name
   * is the PERSISTED hop vocabulary (`AgentStepTelemetrySchema.servedBy.hop`
   * in `types/agent-step.ts`), not a count of the hops that happen to exist
   * this month. Renumbering it to `secondary` would silently change what
   * every already-stored step record means, and would make a Gemini-served
   * deliverable from last week incomparable with one from today.
   */
  tertiary?: ModelAdapter;
  tertiaryModel?: string;
}

/**
 * Wraps the `anthropic` vendor's adapter with a single last-resort fallback:
 * Vertex AI Model Garden primary, Vertex AI Gemini on a 429/404. Lives
 * entirely inside the single `anthropic` `ModelAdapter` slot
 * `create-model-router-from-env.ts` builds — `ModelPolicy`,
 * `DefaultModelRouter`, and every step's own `vendor`/`model` selection are
 * unaware this exists.
 *
 * SCRUM-358 (Vertex-only, part 2) removed the middle hop, the direct
 * Anthropic API. What is left is honest about its cost: the ONE remaining
 * fallback CHANGES MODEL IDENTITY. Before, a 429 on Vertex was absorbed by
 * the same model on another transport and RFC-01 §5.4's "a pinned step never
 * silently swaps models" held for the first hop. It no longer does — a
 * failover now means a different model family produced the deliverable, which
 * is exactly why `provenance` (AU61 / SCRUM-360) is not optional decoration
 * here but the only way to know what you are holding.
 */
export class ResilientClaudeAdapter implements ModelAdapter {
  readonly providerId = "anthropic-resilient";

  constructor(private readonly options: ResilientClaudeAdapterOptions) {}

  async complete<TOutput>(req: CompletionRequest<TOutput>): Promise<CompletionResult<TOutput>> {
    try {
      const result = await this.options.primary.complete(req);
      return { ...result, provenance: { hop: "primary", servedBy: this.options.primary.providerId, failedOver: [] } };
    } catch (primaryErr) {
      if (!this.options.tertiary || !isFailoverWorthy(primaryErr)) throw primaryErr;

      const failedOver = [describeHop(this.options.primary.providerId, primaryErr)];
      const tertiaryModel = this.options.tertiaryModel ?? req.model;
      recordFailover({
        from: this.options.primary.providerId,
        to: this.options.tertiary.providerId,
        model: req.model,
        toModel: tertiaryModel,
        err: primaryErr,
      });

      const result = await this.options.tertiary.complete({ ...req, model: tertiaryModel });
      return { ...result, provenance: { hop: "tertiary", servedBy: this.options.tertiary.providerId, failedOver } };
    }
  }
}
