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
  /**
   * Which hop of the Claude fallback chain served this step, and the adapter
   * that answered (AU61/SCRUM-360 produced them; SCRUM-361 item 3 needs them
   * here). `"secondary"` / `"tertiary"` / an adapter name; absent when every
   * turn was primary-served, which is the common case.
   *
   * THIS IS A PRECONDITION ON THE BILLING RECONCILIATION, not a nicety. A
   * Claude call served by the direct-Anthropic hop is still recorded as
   * `claude-*` and still costs money — but it is billed by ANTHROPIC, not by
   * Google. A query comparing `agent_runs_bi` costs against a Vertex billing
   * export with no way to exclude those rows reports a delta that means
   * nothing. Measured on 2026-08-27 (SCRUM-361 comment 10368): 88% of one
   * production run's spend and 100% of another's was fallback-served.
   *
   * ABSENT MEANS PRIMARY, NOT UNKNOWN. `base-agent.ts` only attaches
   * `servedBy` when `provenance.hop !== "primary"`, so there is no
   * null-unknown state to be careful of — see the NULL handling in the row
   * literal below and the matching filter in `scripts/reconcile-billing.sql`.
   */
  servedByHop?: string;
  servingAdapter?: string;
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
  // Traces get the same discriminator BigQuery does — a trace showing an
  // expensive step is not interpretable without knowing who served it.
  if (attrs.servedByHop !== undefined) {
    span.setAttribute("served_by_hop", attrs.servedByHop);
  }
  if (attrs.servingAdapter !== undefined) {
    span.setAttribute("serving_adapter", attrs.servingAdapter);
  }
  void insertAgentRunRow(attrs);
}

async function insertAgentRunRow(attrs: CostAndTokenAttributes): Promise<void> {
  try {
    const table = await biTable("agent_runs_bi");
    // Not counted as an attempt: BigQuery genuinely unconfigured is a
    // deployment choice, not a failure, and conflating it with a denied insert
    // would put the two indistinguishable states back together again.
    if (!table) return;
    sinkHealth.attempted += 1;
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
          operation: attrs.operation ?? null,
          // `?? null` and not `?? "primary"`: the row must say what the engine
          // observed, and the engine only observes a hop when a chain was
          // involved. The reconciliation query does the "NULL means Vertex"
          // reading explicitly, where it can be read and argued with.
          servedByHop: attrs.servedByHop ?? null,
          servingAdapter: attrs.servingAdapter ?? null,
          jobId: attrs.jobId ?? null,
          stepId: attrs.stepId ?? null,
          // Every row this package writes is engine-originated — the
          // portal's own inserts (src/lib/telemetry/bi-tracker.ts) stamp
          // "portal" themselves.
          source: "agent-engine",
        },
      ],
      { ignoreUnknownValues: true, skipInvalidRows: false },
    );
    sinkHealth.succeeded += 1;
  } catch (err) {
    // AU72 / SCRUM-372. This used to log at WARNING and stop there, and that
    // silence — not the missing IAM role — is the actual defect. PRODUCTION
    // NEVER WROTE A SINGLE TELEMETRY ROW, for its entire life, because
    // `agent-engine-sa@karoscmo` had no grant on the dataset. Every insert was
    // denied, every denial was swallowed, and every deploy reported success.
    // Prep had the grant and 329 rows, so the sink anyone thought to check was
    // the one that worked.
    //
    // Three changes, each closing one way it stayed invisible:
    //   - ERROR, not WARNING. A permission denial is not a warning.
    //   - a stable `event` string, so a log-based metric can alert on a rate:
    //       gcloud logging metrics create telemetry_insert_failed     //         --log-filter='jsonPayload.event="telemetry.insert_failed"'
    //   - counted in `sinkHealth`, which the diagnostics endpoint reports, so
    //     a human looking at "what is switched off" sees a dead sink without
    //     knowing to grep for it.
    //
    // Still non-fatal: telemetry must never take down the run it describes.
    // Loud is the fix, not throwing.
    sinkHealth.failed += 1;
    sinkHealth.lastError = describeError(err);
    console.error(
      JSON.stringify({
        severity: "ERROR",
        event: "telemetry.insert_failed",
        message: "agent_runs_bi insert failed — this run's cost and token telemetry is LOST, not delayed",
        error: sinkHealth.lastError,
        runId: attrs.runId,
        failedSoFar: sinkHealth.failed,
      }),
    );
  }
}

/**
 * Whether the BigQuery telemetry sink is actually writing (AU72 / SCRUM-372).
 *
 * Process-local and deliberately simple: the question it answers is "has this
 * instance ever successfully written a row, and how many has it lost". That is
 * enough to distinguish the three states that previously looked identical from
 * outside — writing fine, never tried, and failing every time.
 */
export interface TelemetrySinkHealth {
  attempted: number;
  succeeded: number;
  failed: number;
  lastError?: string;
}

const sinkHealth: TelemetrySinkHealth = { attempted: 0, succeeded: 0, failed: 0 };

/** A snapshot of the sink's health, for the diagnostics endpoint. */
export function telemetrySinkHealth(): Readonly<TelemetrySinkHealth> {
  return { ...sinkHealth };
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
