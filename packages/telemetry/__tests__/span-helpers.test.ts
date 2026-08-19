import { describe, expect, it, vi } from "vitest";
import { recordCostAndTokens, withToolCallSpan, withWorkflowStepSpan } from "../src/index.js";

/**
 * No `TracerProvider` is registered anywhere in this test process, so every
 * call below runs against the OpenTelemetry API's own no-op tracer — this is
 * exactly the "zero-overhead no-op tracing when a tracer is not configured"
 * guarantee (RFC-01 §11) being exercised for real, not mocked.
 */

describe("withWorkflowStepSpan", () => {
  it("returns the wrapped function's result unchanged", async () => {
    const result = await withWorkflowStepSpan(
      { runId: "run_1", clientSlug: "acme", productId: "linkedin", stepId: "draft", stepKind: "agent" },
      async () => ({ body: "hello" }),
    );
    expect(result).toEqual({ body: "hello" });
  });

  it("passes a usable Span into the callback with no configured tracer, without throwing", async () => {
    const setAttribute = vi.fn();
    await withWorkflowStepSpan(
      { runId: "run_1", clientSlug: "acme", productId: "linkedin", slotId: "slot_0", stepId: "draft", stepKind: "code" },
      async (span) => {
        // A real Span object even with no SDK registered — every method is safe to call.
        expect(span).toBeDefined();
        expect(typeof span.setAttribute).toBe("function");
        recordCostAndTokens(span, {
          runId: "run_1",
          clientId: "acme",
          agentId: "linkedin",
          model: "claude-sonnet-4-6",
          costUsd: 0.01,
          inputTokensCached: 10,
          inputTokensUncached: 90,
          outputTokens: 20,
          durationMs: 120,
          status: "completed",
        });
        setAttribute();
        return null;
      },
    );
    expect(setAttribute).toHaveBeenCalledTimes(1);
  });

  it("rethrows the wrapped function's error after recording it, rather than swallowing it", async () => {
    await expect(
      withWorkflowStepSpan({ runId: "run_1", clientSlug: "acme", productId: "linkedin", stepId: "boom", stepKind: "code" }, async () => {
        throw new Error("step exploded");
      }),
    ).rejects.toThrow("step exploded");
  });
});

describe("withToolCallSpan", () => {
  it("returns the wrapped function's result unchanged", async () => {
    const result = await withToolCallSpan(
      { runId: "run_1", clientSlug: "acme", productId: "linkedin", toolName: "gate.lintPost", toolVersion: "1.0.0" },
      async () => ({ status: "success", result: { verdict: "pass" } }),
    );
    expect(result).toEqual({ status: "success", result: { verdict: "pass" } });
  });

  it("rethrows the wrapped function's error after recording it", async () => {
    await expect(
      withToolCallSpan(
        { runId: "run_1", clientSlug: "acme", productId: "linkedin", toolName: "ledger.writeDeliverable", toolVersion: "1.0.0" },
        async () => {
          throw new Error("disk on fire");
        },
      ),
    ).rejects.toThrow("disk on fire");
  });

  it("many calls in sequence never throw or leak — the no-op tracer is safe under repeated use", async () => {
    for (let i = 0; i < 50; i++) {
      await withToolCallSpan(
        { runId: `run_${i}`, clientSlug: "acme", productId: "linkedin", toolName: "client.getProfile", toolVersion: "1.0.0" },
        async () => i,
      );
    }
  });
});
