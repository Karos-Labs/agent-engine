import { SpanStatusCode, type Span } from "@opentelemetry/api";
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
  outputTokens: number;
  durationMs: number;
  status: string;
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
          inputTokens: attrs.inputTokensCached + attrs.inputTokensUncached,
          outputTokens: attrs.outputTokens,
          costUsd: attrs.costUsd,
          durationMs: attrs.durationMs,
          status: attrs.status,
          errorDetails: null,
          timestamp: new Date().toISOString(),
        },
      ],
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
