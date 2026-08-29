import { getMeter } from "./tracer.js";

/**
 * OTel metrics (AU42/SCRUM-326) — the counterpart to the four span sites this
 * package already had. Traces answer "what happened on THIS run/step/call";
 * these answer "what is the overall rate/shape across all of them", which a
 * trace explorer cannot show without stepping through spans one at a time.
 *
 * Every function here is safe to call unconditionally, with or without
 * `initTelemetry()` having run: `getMeter()` returns the OTel API's own no-op
 * `Meter` until a real `MeterProvider` is registered (see `tracer.ts`), so
 * every `add()`/`record()` below is a cheap no-op in that state — the same
 * "zero-overhead when unconfigured" guarantee `span-helpers.ts` relies on.
 *
 * Each instrument is fetched fresh (`getMeter().createCounter(...)`) rather
 * than cached in a module-level `const` — a `Meter` obtained before
 * `initTelemetry()` runs would stay bound to the no-op implementation for the
 * rest of the process if cached, since the OTel metrics API (unlike the trace
 * API's `ProxyTracer`) does not re-resolve a previously-vended `Meter` against
 * a later-registered provider. `createCounter`/`createHistogram` are cheap,
 * idempotent-by-name lookups against the meter's own instrument registry, so
 * calling them on every record is the correct trade here, not a wasteful one.
 */

/** One `step.code`/`step.agent` completion, by kind and outcome status. */
export function recordWorkflowStepMetric(attrs: { stepKind: string; status: string }): void {
  getMeter()
    .createCounter("agent_engine.workflow.steps", { description: "Workflow steps completed, by step kind and outcome status" })
    .add(1, { step_kind: attrs.stepKind, status: attrs.status });
}

/** One `WorkflowEngine.run()` invocation (an initial run or a resume), by run kind and terminal outcome. */
export function recordWorkflowRunMetric(attrs: { runKind: string; status: string }): void {
  getMeter()
    .createCounter("agent_engine.workflow.runs", { description: "WorkflowEngine.run() invocations completed, by run kind and outcome status" })
    .add(1, { run_kind: attrs.runKind, status: attrs.status });
}

/** One resolved `step.gate`, by decision. */
export function recordGateMetric(attrs: { decision: string }): void {
  getMeter()
    .createCounter("agent_engine.workflow.gates", { description: "Resolved workflow gates, by decision" })
    .add(1, { decision: attrs.decision });
}

/** One Layer 3 tool call, by tool name and outcome status. */
export function recordToolCallMetric(attrs: { toolName: string; status: string }): void {
  getMeter()
    .createCounter("agent_engine.tool.calls", { description: "Tool calls completed, by tool name and outcome status" })
    .add(1, { tool_name: attrs.toolName, status: attrs.status });
}

/** One model-adapter `complete()` attempt (one per fallback hop), by vendor/model and outcome. */
export function recordModelCallMetric(attrs: { vendor: string; model: string; status: string; durationMs: number }): void {
  const meter = getMeter();
  meter
    .createCounter("agent_engine.model.calls", { description: "Model adapter call attempts, by vendor, model, and outcome status" })
    .add(1, { vendor: attrs.vendor, model: attrs.model, status: attrs.status });
  meter
    .createHistogram("agent_engine.model.call.duration_ms", { description: "Model adapter call duration", unit: "ms" })
    .record(attrs.durationMs, { vendor: attrs.vendor, model: attrs.model, status: attrs.status });
}

/** One completed HTTP request, by method/route/status — the top of the request → run → step → tool → model call trace this ticket exists to complete. */
export function recordHttpRequestMetric(attrs: { method: string; route: string; statusCode: number }): void {
  getMeter()
    .createCounter("agent_engine.http.requests", { description: "HTTP requests handled, by method, route, and status code" })
    .add(1, { method: attrs.method, route: attrs.route, status_code: attrs.statusCode });
}
