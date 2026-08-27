import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { getTracer } from "./tracer.js";
import { describeError } from "./errors.js";
import { biTable } from "./bigquery-client.js";

interface IdentityAttributes {
  runId: string;
  clientSlug: string;
  productId: string;
  slotId?: string;
}

/** Attributes for one Layer 1 workflow step span (RFC-01 §11). */
export interface WorkflowStepSpanAttributes extends IdentityAttributes {
  stepId: string;
  stepKind: "code" | "agent";
}

/** Attributes for one Layer 3 tool-call span (RFC-01 §11) — `toolVersion` travels in, per §9.1 rule 5. */
export interface ToolCallSpanAttributes extends IdentityAttributes {
  toolName: string;
  toolVersion: string;
}

/**
 * Token/cost attributes (RFC-01 §11) — recorded once the wrapped call has
 * actually completed and the numbers are known. Also the payload for one
 * `agent_runs_bi` BigQuery row (Phase 3 of the BI telemetry pipeline) —
 * `runId`/`clientId`/`agentId`/`model`/`durationMs`/`status` exist here
 * specifically so `recordCostAndTokens` can stream-insert without a second
 * call needing to re-supply identity attributes the span already received
 * (span attributes aren't readable back through the OTel API).
 */
export interface CostAndTokenAttributes {
  runId: string;
  /** Maps to `agent_runs_bi.clientId` — same value as `IdentityAttributes.clientSlug`. */
  clientId: string;
  /** Maps to `agent_runs_bi.agentId` — same value as `IdentityAttributes.productId`. */
  agentId: string;
  model: string;
  costUsd: number;
  inputTokensCached: number;
  inputTokensUncached: number;
  /** Cache WRITES, billed at 1.25x base input (SCRUM-361b). Optional so callers that predate the third tier compile unchanged. */
  inputTokensCacheWrite?: number;
  outputTokens: number;
  durationMs: number;
  status: string;
  /**
   * Discriminator columns (2026-08). `runId` above is `WorkflowRuntime.runId`
   * — the WHOLE workflow run's id, shared by every step inside it — so
   * without these, two step rows from the same run are indistinguishable
   * from each other, and from a portal-originated row that happens to reuse
   * the value space differently. `jobId` restates `runId` under the name the
   * portal's own rows use for "the overall run", `stepId` isolates this row
   * to one step within it, and `operation` names what kind of step it was.
   */
  jobId?: string;
  stepId?: string;
  operation?: string;
}

function setIdentityAttributes(span: Span, attrs: IdentityAttributes): void {
  span.setAttribute("run_id", attrs.runId);
  span.setAttribute("client_slug", attrs.clientSlug);
  span.setAttribute("product_id", attrs.productId);
  if (attrs.slotId !== undefined) {
    span.setAttribute("slot_id", attrs.slotId);
  }
}

/**
 * Sets the token/cost attributes on a span from inside a
 * `withWorkflowStepSpan`/`withToolCallSpan` callback, once known, and
 * fire-and-forget stream-inserts the same data into BigQuery's
 * `agent_runs_bi` table (Phase 3). No-ops when `GOOGLE_CLOUD_PROJECT` is
 * unset — see `bigquery-client.ts`'s `biTable()`. Never throws: a failed
 * insert is swallowed after a structured stderr line, since telemetry must
 * never disrupt the run it's describing.
 */
export function recordCostAndTokens(span: Span, attrs: CostAndTokenAttributes): void {
  span.setAttribute("cost_usd", attrs.costUsd);
  span.setAttribute("input_tokens_cached", attrs.inputTokensCached);
  span.setAttribute("input_tokens_uncached", attrs.inputTokensUncached);
  span.setAttribute("input_tokens_cache_write", attrs.inputTokensCacheWrite ?? 0);
  span.setAttribute("output_tokens", attrs.outputTokens);
  void insertAgentRunRow(attrs);
}

async function insertAgentRunRow(attrs: CostAndTokenAttributes): Promise<void> {
  try {
    const table = await biTable("agent_runs_bi");
    if (!table) return; // BigQuery not configured — silent no-op, matches getTracer()'s contract
    await table.insert(
      [
        {
          runId: attrs.runId,
          clientId: attrs.clientId,
          agentId: attrs.agentId,
          model: attrs.model,
          // Kept, and kept meaning what it always meant: TOTAL input tokens.
          // Every dashboard and query written against this column stays
          // correct, which is why the tier columns are added BESIDE it rather
          // than by redefining it.
          inputTokens: attrs.inputTokensCached + attrs.inputTokensUncached + (attrs.inputTokensCacheWrite ?? 0),
          // The three tiers carry three different prices (0.1x / 1x / 1.25x),
          // so the sum above cannot be decomposed after the fact. Not
          // hypothetical: the cache-write mispricing could not be sized from
          // our own telemetry precisely because every sink stored a merged
          // number, and had to be bounded from above instead.
          inputTokensCached: attrs.inputTokensCached,
          inputTokensUncached: attrs.inputTokensUncached,
          inputTokensCacheWrite: attrs.inputTokensCacheWrite ?? 0,
          outputTokens: attrs.outputTokens,
          costUsd: attrs.costUsd,
          durationMs: attrs.durationMs,
          status: attrs.status,
          errorDetails: null,
          timestamp: new Date().toISOString(),
          operation: attrs.operation ?? null,
          jobId: attrs.jobId ?? null,
          stepId: attrs.stepId ?? null,
          // Every row this package writes is engine-originated — the
          // portal's own inserts (src/lib/telemetry/bi-tracker.ts) stamp
          // "portal" themselves.
          source: "agent-engine",
        },
      ],
      // `ignoreUnknownValues: true` is why the SCHEMA must be widened before
      // this code is. It does not merely tolerate drift — it makes drift
      // INVISIBLE: a field this row writes that the table lacks is dropped
      // silently, the insert reports success, and nothing says anything went
      // missing.
      //
      // Not a theoretical risk. `operation`, `jobId`, `stepId` and `source`
      // were added to this row in 2026-08, specifically so two step rows from
      // one run could be told apart, and NONE OF THE FOUR EXISTED IN THE
      // TABLE. Every one had been discarded on every insert since, in silence.
      // They were added to both projects' schemas alongside the tier columns,
      // and they start landing without any change to this file.
      //
      // Kept rather than removed, deliberately: turning it off would make a
      // future mismatch throw into the catch below, which logs a warning and
      // swallows it — trading silent column loss for silent ROW loss, which is
      // worse. The real guard is ordering: schema first, then code.
      { ignoreUnknownValues: true, skipInvalidRows: false },
    );
  } catch (err) {
    console.error(
      JSON.stringify({ severity: "WARNING", message: "agent_runs_bi insert failed", error: describeError(err), runId: attrs.runId }),
    );
  }
}

function runInSpan<T>(name: string, setup: (span: Span) => void, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    setup(span);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: describeError(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Wraps one Layer 1 workflow step (`step.code`/`step.agent`) in a span tagged per RFC-01 §11. */
export function withWorkflowStepSpan<T>(attrs: WorkflowStepSpanAttributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return runInSpan(
    `workflow.step.${attrs.stepKind}`,
    (span) => {
      setIdentityAttributes(span, attrs);
      span.setAttribute("step_id", attrs.stepId);
      span.setAttribute("step_kind", attrs.stepKind);
    },
    fn,
  );
}

/** Wraps one Layer 3 tool execution in a span tagged per RFC-01 §11 (including `tool_version`). */
export function withToolCallSpan<T>(attrs: ToolCallSpanAttributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return runInSpan(
    `tool.call.${attrs.toolName}`,
    (span) => {
      setIdentityAttributes(span, attrs);
      span.setAttribute("tool_name", attrs.toolName);
      span.setAttribute("tool_version", attrs.toolVersion);
    },
    fn,
  );
}

/**
 * Attaches an event to whatever span is currently active, if any (AU61 /
 * SCRUM-360).
 *
 * Exists so callers that need to annotate a trace do not have to take an
 * `@opentelemetry/api` dependency of their own — `packages/core` records model
 * failovers through this rather than importing the OTel API directly.
 *
 * Best-effort by construction: outside a workflow step there is no active
 * span, and instrumentation must never turn the thing it is observing into a
 * failure.
 */
export function addSpanEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
  try {
    trace.getActiveSpan()?.addEvent(name, attributes);
  } catch {
    /* a span that cannot be annotated is not a reason to fail the call */
  }
}
