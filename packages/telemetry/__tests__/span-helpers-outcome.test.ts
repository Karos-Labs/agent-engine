import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  recordGateSpan,
  withHttpRequestSpan,
  withModelCallSpan,
  withToolCallSpan,
  withWorkflowRunSpan,
  withWorkflowStepSpan,
} from "../src/index.js";
import { findSpan, isChildOf, setupTestTracing, type TestTracing } from "./test-tracer.js";

/**
 * These tests register a REAL `TracerProvider` (see `test-tracer.ts`) — every
 * assertion below reads back what a span actually recorded, unlike
 * `span-helpers.test.ts`'s no-op-tracer tests.
 */
describe("span status reflects the DOMAIN outcome, not just whether something threw (AU42/SCRUM-326)", () => {
  let tracing: TestTracing;
  beforeEach(() => {
    tracing = setupTestTracing();
  });
  afterEach(async () => {
    await tracing.shutdown();
  });

  it("BEFORE this fix's shape: a step span defaults OK even when the wrapped call returns a failure verdict without throwing", async () => {
    // Exercises `withWorkflowStepSpan` exactly as it behaved before AU42: no
    // call to `markOutcome`, a normally-returned "failure". This is the
    // reproduction of the defect — it must still pass, proving the OLD shape
    // really did read OK.
    await withWorkflowStepSpan({ runId: "run_1", clientSlug: "acme", productId: "linkedin", stepId: "old-shape", stepKind: "code" }, async () => {
      return { status: "tooling_error", reason: "boom" };
    });
    const span = findSpan(tracing.finishedSpans(), "workflow.step.code");
    expect(span).toBeDefined();
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("AFTER this fix: calling markOutcome(true, ...) marks the span ERROR even though nothing threw", async () => {
    await withWorkflowStepSpan({ runId: "run_1", clientSlug: "acme", productId: "linkedin", stepId: "new-shape", stepKind: "code" }, async (_span, markOutcome) => {
      const output = { status: "tooling_error", reason: "no pricing row for model" };
      markOutcome(true, output.reason);
      return output;
    });
    const span = findSpan(tracing.finishedSpans(), "workflow.step.code");
    expect(span).toBeDefined();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe("no pricing row for model");
  });

  it("a content_fail (a content judgment, not a malfunction) stays OK even with markOutcome available", async () => {
    await withWorkflowStepSpan({ runId: "run_1", clientSlug: "acme", productId: "linkedin", stepId: "content-fail", stepKind: "agent" }, async (_span, markOutcome) => {
      const output = { status: "content_fail" as const };
      if ((output.status as string) === "tooling_error") markOutcome(true, "n/a");
      return output;
    });
    const span = findSpan(tracing.finishedSpans(), "workflow.step.agent");
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("a thrown error still marks ERROR automatically (unchanged behavior)", async () => {
    await expect(
      withWorkflowStepSpan({ runId: "run_1", clientSlug: "acme", productId: "linkedin", stepId: "throws", stepKind: "code" }, async () => {
        throw new Error("real crash");
      }),
    ).rejects.toThrow("real crash");
    const span = findSpan(tracing.finishedSpans(), "workflow.step.code");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("withToolCallSpan: a tooling_error outcome marks ERROR via markOutcome", async () => {
    await withToolCallSpan({ runId: "run_1", clientSlug: "acme", productId: "linkedin", toolName: "some.tool", toolVersion: "1.0.0" }, async (_span, markOutcome) => {
      markOutcome(true, "tool broke");
      return { status: "tooling_error" as const, reason: "tool broke" };
    });
    const span = findSpan(tracing.finishedSpans(), "tool.call.some.tool");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe("withWorkflowRunSpan (AU42/SCRUM-326)", () => {
  let tracing: TestTracing;
  beforeEach(() => {
    tracing = setupTestTracing();
  });
  afterEach(async () => {
    await tracing.shutdown();
  });

  it("records run identity attributes and defaults OK", async () => {
    await withWorkflowRunSpan({ runId: "run_42", clientSlug: "acme", productId: "linkedin", runKind: "content" }, async () => "done");
    const span = findSpan(tracing.finishedSpans(), "workflow.run");
    expect(span).toBeDefined();
    expect(span?.attributes.run_id).toBe("run_42");
    expect(span?.attributes.client_slug).toBe("acme");
    expect(span?.attributes.product_id).toBe("linkedin");
    expect(span?.attributes.run_kind).toBe("content");
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("markOutcome(true, ...) marks a run's span ERROR for a failed/degraded outcome that is RETURNED, not thrown", async () => {
    await withWorkflowRunSpan({ runId: "run_43", clientSlug: "acme", productId: "linkedin", runKind: "content" }, async (span, markOutcome) => {
      span.setAttribute("run_status", "degraded");
      markOutcome(true, "workflow tooling failure");
      return { status: "degraded" };
    });
    const span = findSpan(tracing.finishedSpans(), "workflow.run");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes.run_status).toBe("degraded");
  });

  it("a workflow.step span nested inside a workflow.run span is recorded as its child", async () => {
    await withWorkflowRunSpan({ runId: "run_44", clientSlug: "acme", productId: "linkedin", runKind: "content" }, async () => {
      await withWorkflowStepSpan({ runId: "run_44", clientSlug: "acme", productId: "linkedin", stepId: "draft", stepKind: "code" }, async () => "step output");
      return "run output";
    });
    const spans = tracing.finishedSpans();
    const runSpan = findSpan(spans, "workflow.run");
    const stepSpan = findSpan(spans, "workflow.step.code");
    expect(runSpan).toBeDefined();
    expect(stepSpan).toBeDefined();
    expect(isChildOf(stepSpan!, runSpan!)).toBe(true);
  });
});

describe("withModelCallSpan (AU42/SCRUM-326)", () => {
  let tracing: TestTracing;
  beforeEach(() => {
    tracing = setupTestTracing();
  });
  afterEach(async () => {
    await tracing.shutdown();
  });

  it("records vendor/model/tier and defaults OK on success", async () => {
    await withModelCallSpan({ vendor: "anthropic", model: "claude-sonnet-4-6", tier: "portable" }, async (span) => {
      span.setAttribute("model_used", "claude-sonnet-4-6");
      return "ok";
    });
    const span = findSpan(tracing.finishedSpans(), "model.call.anthropic");
    expect(span).toBeDefined();
    expect(span?.attributes.vendor).toBe("anthropic");
    expect(span?.attributes.model).toBe("claude-sonnet-4-6");
    expect(span?.attributes.tier).toBe("portable");
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("a thrown adapter failure marks the span ERROR and records the exception (no markOutcome needed — adapters only ever resolve or throw)", async () => {
    await expect(
      withModelCallSpan({ vendor: "gemini", model: "gemini-2.5-pro", tier: "commodity" }, async () => {
        throw new Error("no pricing row for model \"mystery-model\"");
      }),
    ).rejects.toThrow(/no pricing row/);
    const span = findSpan(tracing.finishedSpans(), "model.call.gemini");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });
});

describe("recordGateSpan (AU42/SCRUM-326)", () => {
  let tracing: TestTracing;
  beforeEach(() => {
    tracing = setupTestTracing();
  });
  afterEach(async () => {
    await tracing.shutdown();
  });

  it("records an explicitly-timed span spanning the real wait, not the call duration", () => {
    const startedAt = Date.parse("2026-08-01T00:00:00.000Z");
    const completedAt = Date.parse("2026-08-02T12:00:00.000Z"); // 36h later — a human review wait
    recordGateSpan(
      { runId: "run_1", clientSlug: "acme", productId: "linkedin", stepId: "review", gateId: "run_1__review", decision: "approve", actor: "alex@acme.com" },
      startedAt,
      completedAt,
    );
    const span = findSpan(tracing.finishedSpans(), "workflow.gate");
    expect(span).toBeDefined();
    expect(span?.status.code).toBe(SpanStatusCode.OK);
    expect(span?.attributes.gate_decision).toBe("approve");
    expect(span?.attributes.gate_actor).toBe("alex@acme.com");
    const durationMs = (span!.duration[0] * 1000 + span!.duration[1] / 1e6);
    expect(durationMs).toBeCloseTo(completedAt - startedAt, -2);
  });

  it("a rejected gate still records OK status — a resolved human decision, not a malfunction", () => {
    recordGateSpan(
      { runId: "run_1", clientSlug: "acme", productId: "linkedin", stepId: "review", gateId: "run_1__review", decision: "reject", actor: "alex@acme.com" },
      Date.now() - 1000,
      Date.now(),
    );
    const span = findSpan(tracing.finishedSpans(), "workflow.gate");
    expect(span?.status.code).toBe(SpanStatusCode.OK);
    expect(span?.attributes.gate_decision).toBe("reject");
  });
});

describe("withHttpRequestSpan (AU42/SCRUM-326)", () => {
  let tracing: TestTracing;
  beforeEach(() => {
    tracing = setupTestTracing();
  });
  afterEach(async () => {
    await tracing.shutdown();
  });

  function fakeResponse(statusCode: number) {
    let finishListener: (() => void) | undefined;
    return {
      res: {
        statusCode,
        on(event: "finish", listener: () => void) {
          if (event === "finish") finishListener = listener;
        },
      },
      finish: () => finishListener?.(),
    };
  }

  it("records method/route/status and OK for a 2xx response", () => {
    const { res, finish } = fakeResponse(200);
    let ran = false;
    withHttpRequestSpan({ method: "GET", path: "/healthz" }, res, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    finish();
    const span = findSpan(tracing.finishedSpans(), "HTTP GET");
    expect(span).toBeDefined();
    expect(span?.attributes["http.method"]).toBe("GET");
    expect(span?.attributes["http.status_code"]).toBe(200);
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("marks ERROR for a 5xx response", () => {
    const { res, finish } = fakeResponse(500);
    withHttpRequestSpan({ method: "POST", path: "/api/v1/runs/start" }, res, () => undefined);
    finish();
    const span = findSpan(tracing.finishedSpans(), "HTTP POST");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("a workflow.run span opened synchronously inside next() nests under the HTTP span", async () => {
    const { res, finish } = fakeResponse(200);
    let runPromise: Promise<unknown> = Promise.resolve();
    withHttpRequestSpan({ method: "POST", path: "/api/v1/runs/start" }, res, () => {
      runPromise = withWorkflowRunSpan({ runId: "run_99", clientSlug: "acme", productId: "linkedin", runKind: "content" }, async () => "done");
    });
    await runPromise;
    finish();
    const spans = tracing.finishedSpans();
    const httpSpan = findSpan(spans, "HTTP POST");
    const runSpan = findSpan(spans, "workflow.run");
    expect(httpSpan).toBeDefined();
    expect(runSpan).toBeDefined();
    expect(isChildOf(runSpan!, httpSpan!)).toBe(true);
  });
});
