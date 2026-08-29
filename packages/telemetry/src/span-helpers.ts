import { context, SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { getTracer } from "./tracer.js";
import { describeError } from "./errors.js";
import { biTable } from "./bigquery-client.js";
import { recordHttpRequestMetric } from "./metrics.js";

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

/**
 * Lets a wrapped callback declare "this call came back without throwing, but
 * it is still a failure" (AU42/SCRUM-326) — a `tooling_error`/`content_fail`
 * step outcome, an `error` tool outcome — none of which raise an exception,
 * so `runInSpan`'s own catch block never sees them. Before this, every span
 * below ended `OK` unless its wrapped call literally threw, which is exactly
 * the "structurally incapable of failing" shape: a step or tool call that
 * fails BY RETURNING a failure verdict (the normal path for both, per
 * RFC-01 §6) produced a trace indistinguishable from success. Call with
 * `true` (and, ideally, a message) once the outcome is known; leave unset and
 * the span defaults to `OK`, same as before.
 */
type MarkSpanOutcome = (isError: boolean, message?: string) => void;

function runInSpan<T>(name: string, setup: (span: Span) => void, fn: (span: Span, markOutcome: MarkSpanOutcome) => Promise<T>): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    setup(span);
    let outcomeSet = false;
    const markOutcome: MarkSpanOutcome = (isError, message) => {
      outcomeSet = true;
      span.setStatus(isError ? { code: SpanStatusCode.ERROR, ...(message !== undefined ? { message } : {}) } : { code: SpanStatusCode.OK });
    };
    try {
      const result = await fn(span, markOutcome);
      if (!outcomeSet) {
        span.setStatus({ code: SpanStatusCode.OK });
      }
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
export function withWorkflowStepSpan<T>(attrs: WorkflowStepSpanAttributes, fn: (span: Span, markOutcome: MarkSpanOutcome) => Promise<T>): Promise<T> {
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
export function withToolCallSpan<T>(attrs: ToolCallSpanAttributes, fn: (span: Span, markOutcome: MarkSpanOutcome) => Promise<T>): Promise<T> {
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

/** Attributes for one workflow-run span (AU42/SCRUM-326) — the parent every step/tool/model-call span in a run nests under. */
export interface WorkflowRunSpanAttributes {
  runId: string;
  clientSlug: string;
  productId: string;
  runKind: string;
}

/**
 * Wraps one `WorkflowEngine.run()` invocation — an initial run or a resume —
 * in a span (AU42/SCRUM-326). This is the top of the "HTTP request → run →
 * steps → tool calls → model calls" trace the ticket asks for: every
 * `step.code`/`step.agent`/`step.gate` call made from inside `workflowFn`
 * nests under this span, since `startActiveSpan` makes it the ambient
 * context for the whole `await workflowFn(wf)` call.
 *
 * `run()` never lets an unhandled exception escape past its own outcome
 * switch — every branch, including `failed`/`degraded`, is a RETURNED
 * `WorkflowRunResult`, not a throw — so exactly like the step/tool spans
 * above, the caller must call `markOutcome(true, reason)` itself for the
 * outcomes that are actually failures; see `WorkflowEngine.run()`.
 */
export function withWorkflowRunSpan<T>(attrs: WorkflowRunSpanAttributes, fn: (span: Span, markOutcome: MarkSpanOutcome) => Promise<T>): Promise<T> {
  return runInSpan(
    "workflow.run",
    (span) => {
      span.setAttribute("run_id", attrs.runId);
      span.setAttribute("client_slug", attrs.clientSlug);
      span.setAttribute("product_id", attrs.productId);
      span.setAttribute("run_kind", attrs.runKind);
    },
    fn,
  );
}

/** Attributes for one model-adapter call span (AU42/SCRUM-326). */
export interface ModelCallSpanAttributes {
  vendor: string;
  model: string;
  /** `ModelPolicy.policy` — "pinned" | "portable" | "commodity" (RFC-01 §5.4). */
  tier: string;
}

/**
 * Wraps one attempt at a model-adapter `complete()` call (AU42/SCRUM-326) —
 * one span per hop, so a `portable`/`commodity` step's primary attempt and
 * its fallback attempt (see `DefaultModelRouter.complete`) are two distinct,
 * separately-timed child spans under the same workflow-step span, not one
 * span silently covering both.
 *
 * Unlike the step/tool spans above, a `ModelAdapter.complete()` failure is
 * always a thrown exception (never a returned "soft" failure shape — every
 * adapter in `packages/core/src/router/adapters` either resolves or throws),
 * so this reuses `runInSpan`'s automatic catch-and-record for the failure
 * case; the wrapped callback only needs to set success attributes.
 */
export function withModelCallSpan<T>(attrs: ModelCallSpanAttributes, fn: (span: Span, markOutcome: MarkSpanOutcome) => Promise<T>): Promise<T> {
  return runInSpan(
    `model.call.${attrs.vendor}`,
    (span) => {
      span.setAttribute("vendor", attrs.vendor);
      span.setAttribute("model", attrs.model);
      span.setAttribute("tier", attrs.tier);
    },
    fn,
  );
}

/** Attributes for one resolved gate span (AU42/SCRUM-326). */
export interface GateSpanAttributes {
  runId: string;
  clientSlug: string;
  productId: string;
  stepId: string;
  gateId: string;
  decision: string;
  actor?: string;
}

/**
 * Records one resolved `step.gate` as a span with EXPLICIT start/end times
 * (AU42/SCRUM-326) — deliberately NOT `startActiveSpan`/`runInSpan` like
 * every span above. `runStepGate` (packages/workflow) is re-entered once per
 * resume attempt while a gate is still pending, throwing `AwaitingGateSignal`
 * every time until a response exists; wrapping that in a live span would
 * report a run of sub-millisecond "failures" instead of the one real —
 * possibly multi-hour or multi-day — human wait. The caller
 * (`recordResolvedGateStep`) already computes the true `startedAt`
 * (first time this gate's step became current) and `completedAt` (when the
 * response landed) for its own checkpoint record; this just opens a span
 * backdated to the former and ends it at the latter, exactly once, only on
 * the replay pass that actually sees the resolution.
 *
 * Always `OK`, regardless of `decision`: a rejected gate is a resolved human
 * decision, not a malfunction (see `runStepGate`'s own doc comment) — the
 * decision is carried as an attribute, not a failure status.
 */
export function recordGateSpan(attrs: GateSpanAttributes, startedAt: number, completedAt: number): void {
  const span = getTracer().startSpan("workflow.gate", { startTime: startedAt });
  span.setAttribute("run_id", attrs.runId);
  span.setAttribute("client_slug", attrs.clientSlug);
  span.setAttribute("product_id", attrs.productId);
  span.setAttribute("step_id", attrs.stepId);
  span.setAttribute("gate_id", attrs.gateId);
  span.setAttribute("gate_decision", attrs.decision);
  if (attrs.actor !== undefined) {
    span.setAttribute("gate_actor", attrs.actor);
  }
  span.setStatus({ code: SpanStatusCode.OK });
  span.end(completedAt);
}

/**
 * Minimal, Express-agnostic shape this module needs from an HTTP
 * request/response (AU42/SCRUM-326) — structural typing so this package
 * never takes an `express` dependency of its own; `apps/agent-server`'s
 * middleware wrapper supplies real `Request`/`Response` objects, which
 * satisfy this shape without a cast.
 */
export interface HttpSpanRequest {
  method: string;
  path: string;
  route?: { path: string };
  baseUrl?: string;
}
export interface HttpSpanResponseLike {
  statusCode: number;
  on(event: "finish", listener: () => void): void;
}

/**
 * Opens the top-of-trace HTTP request span (AU42/SCRUM-326) — the "HTTP
 * request" half of "a full trace from HTTP request → run → steps → tool
 * calls → model calls". Makes the span the ACTIVE context for the rest of
 * the middleware/route chain (`next()` runs inside `context.with(...)`), so
 * every `workflow.run`/`workflow.step.*`/`tool.call.*`/`model.call.*` span
 * created while handling this request nests underneath it — the same
 * mechanism `runInSpan`'s `startActiveSpan` relies on, one level up.
 *
 * Ends on the response's `finish` event rather than synchronously after
 * `next()` returns: Express middleware calls `next()` and returns
 * immediately, long before the request is actually done (every downstream
 * handler is async) — ending here would close the span before the run it is
 * supposed to contain even starts.
 */
export function withHttpRequestSpan(req: HttpSpanRequest, res: HttpSpanResponseLike, next: () => void): void {
  const span = getTracer().startSpan(`HTTP ${req.method}`, { kind: SpanKind.SERVER });
  span.setAttribute("http.method", req.method);
  span.setAttribute("http.target", req.path);

  context.with(trace.setSpan(context.active(), span), () => {
    res.on("finish", () => {
      const route = req.route !== undefined ? `${req.baseUrl ?? ""}${req.route.path}` : req.path;
      span.setAttribute("http.route", route);
      span.setAttribute("http.status_code", res.statusCode);
      span.setStatus({ code: res.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      recordHttpRequestMetric({ method: req.method, route, statusCode: res.statusCode });
      span.end();
    });
    next();
  });
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
