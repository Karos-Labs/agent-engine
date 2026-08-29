import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  recordGateMetric,
  recordHttpRequestMetric,
  recordModelCallMetric,
  recordToolCallMetric,
  recordWorkflowRunMetric,
  recordWorkflowStepMetric,
} from "../src/index.js";

/**
 * Registers a REAL `MeterProvider` with an in-memory exporter (AU42/SCRUM-326)
 * — the metrics counterpart of `test-tracer.ts`. `reader.collect()` forces an
 * immediate collection rather than waiting for `PeriodicExportingMetricReader`'s
 * export timer, so a test can assert on data points synchronously.
 */
function setupTestMetrics() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  return {
    async collect() {
      const result = await reader.collect();
      return result.resourceMetrics.scopeMetrics.flatMap((sm) => sm.metrics);
    },
    async shutdown() {
      metrics.disable();
      await provider.shutdown();
    },
  };
}

describe("OTel metrics (AU42/SCRUM-326) — real MeterProvider, not just no-op safety", () => {
  let tracking: ReturnType<typeof setupTestMetrics>;

  beforeEach(() => {
    tracking = setupTestMetrics();
  });

  afterEach(async () => {
    await tracking.shutdown();
  });

  it("recordWorkflowStepMetric aggregates by step kind and status", async () => {
    recordWorkflowStepMetric({ stepKind: "agent", status: "completed" });
    recordWorkflowStepMetric({ stepKind: "agent", status: "completed" });
    recordWorkflowStepMetric({ stepKind: "agent", status: "tooling_error" });

    const collected = await tracking.collect();
    const metric = collected.find((m) => m.descriptor.name === "agent_engine.workflow.steps");
    expect(metric).toBeDefined();
    const points = metric!.dataPoints.map((dp) => ({ attrs: dp.attributes, value: dp.value }));
    expect(points).toEqual(
      expect.arrayContaining([
        { attrs: { step_kind: "agent", status: "completed" }, value: 2 },
        { attrs: { step_kind: "agent", status: "tooling_error" }, value: 1 },
      ]),
    );
  });

  it("recordWorkflowRunMetric, recordGateMetric, recordToolCallMetric each record under their own name", async () => {
    recordWorkflowRunMetric({ runKind: "recurring", status: "completed" });
    recordGateMetric({ decision: "approve" });
    recordToolCallMetric({ toolName: "gate.lintPost", status: "success" });

    const collected = await tracking.collect();
    const names = new Set(collected.map((m) => m.descriptor.name));
    expect(names).toEqual(new Set(["agent_engine.workflow.runs", "agent_engine.workflow.gates", "agent_engine.tool.calls"]));
  });

  it("recordModelCallMetric records both a call counter and a duration histogram", async () => {
    recordModelCallMetric({ vendor: "anthropic", model: "claude-sonnet-4-6", status: "ok", durationMs: 842 });

    const collected = await tracking.collect();
    const counter = collected.find((m) => m.descriptor.name === "agent_engine.model.calls");
    const histogram = collected.find((m) => m.descriptor.name === "agent_engine.model.call.duration_ms");
    expect(counter?.dataPoints[0]?.value).toBe(1);
    expect(counter?.dataPoints[0]?.attributes).toEqual({ vendor: "anthropic", model: "claude-sonnet-4-6", status: "ok" });
    const histogramValue = histogram?.dataPoints[0]?.value as { count: number; sum?: number } | undefined;
    expect(histogramValue?.count).toBe(1);
    expect(histogramValue?.sum).toBe(842);
  });

  it("recordHttpRequestMetric records method/route/status_code", async () => {
    recordHttpRequestMetric({ method: "POST", route: "/api/v1/runs/start", statusCode: 200 });

    const collected = await tracking.collect();
    const metric = collected.find((m) => m.descriptor.name === "agent_engine.http.requests");
    expect(metric?.dataPoints[0]?.attributes).toEqual({ method: "POST", route: "/api/v1/runs/start", status_code: 200 });
  });
});

describe("metrics functions stay safe with no MeterProvider registered (no-op default)", () => {
  it("never throws when called before any provider is registered", () => {
    expect(() => {
      recordWorkflowStepMetric({ stepKind: "code", status: "completed" });
      recordWorkflowRunMetric({ runKind: "recurring", status: "completed" });
      recordGateMetric({ decision: "reject" });
      recordToolCallMetric({ toolName: "x", status: "success" });
      recordModelCallMetric({ vendor: "gemini", model: "gemini-2.5-pro", status: "ok", durationMs: 1 });
      recordHttpRequestMetric({ method: "GET", route: "/healthz", statusCode: 200 });
    }).not.toThrow();
  });
});
