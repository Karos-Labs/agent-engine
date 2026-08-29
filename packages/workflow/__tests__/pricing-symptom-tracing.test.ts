import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { applyStageModelOverride, type AgentContext, type AgentExecutionResult, type BaseAgent } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine, type WorkflowContext } from "../src/index.js";

/**
 * AU42/SCRUM-326's explicit ask: "verify from the traces that [AU36's pricing
 * fallback fix] now fails loudly."
 *
 * `assertModelPriced`/`applyStageModelOverride`
 * (`packages/core/src/telemetry/pricing.ts`) already throw for an unpriced
 * model id — confirmed directly below, real code, not a stub. That guard
 * existing is necessary but not sufficient for THIS ticket: `BaseAgent`'s own
 * ReAct loop (`runOneTurn`) catches exactly that throw and returns a
 * `tooling_error` turn rather than letting it propagate (see
 * `base-agent.ts`'s own doc comments on `runOneTurn`) — which is correct per
 * RFC-01 §6 (a tool/step reports failure by RETURNING a verdict), but it
 * means the exception never reaches `runStepAgent`'s span as a THROW. Before
 * AU42, that span had no other way to learn about it, so it read `OK`.
 *
 * This test builds a minimal `BaseAgent`-shaped stub that reproduces exactly
 * that translation (real `applyStageModelOverride` call, caught the same way
 * `runOneTurn` catches it, returned as the same `tooling_error`
 * `AgentExecutionResult` shape) — not to bypass `BaseAgent`, but so this test
 * doesn't have to also stand up a full `ModelRouter`/adapter chain to reach a
 * code path whose SHAPE is what's being tested here, not its ReAct-loop
 * plumbing.
 */
describe("AU42/SCRUM-326 — the AU36 pricing-fallback fix fails loudly in the step's span, not just in logs", () => {
  it("assertModelPriced (AU36 / SCRUM-314, packages/core/src/telemetry/pricing.ts) throws for an unpriced model — confirms the guard this test's scenario depends on is really in the code, not assumed", () => {
    expect(() => applyStageModelOverride("draft", { policy: "portable", model: "claude-sonnet-4-6" }, { draft: "totally-unpriced-mystery-model-xyz" })).toThrow(
      /has no pricing row/,
    );
  });

  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    provider.register({ contextManager });
  });

  afterEach(async () => {
    contextManager.disable();
    trace.disable();
    await provider.shutdown();
  });

  it("marks the workflow.step.agent span ERROR for a step whose model turn hit the unpriced-model guard, instead of the OK a thrown-but-swallowed error used to leave behind", async () => {
    const stepId = "draft";
    const stageModels = { [stepId]: "totally-unpriced-mystery-model-xyz" };

    // Reproduces `BaseAgent.runOneTurn`'s real catch-and-translate for this
    // exact failure (see this file's own doc comment above) — the guard
    // itself (`applyStageModelOverride`) is the real, unmodified AU36 code.
    const fakeAgent = {
      async run(ctx: AgentContext): Promise<AgentExecutionResult<unknown>> {
        try {
          applyStageModelOverride(stepId, { policy: "portable", model: "claude-sonnet-4-6" }, ctx.stageModels);
          throw new Error("test setup error: expected applyStageModelOverride to throw for an unpriced model");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            finalOutput: null,
            steps: [
              {
                stepIndex: 0,
                modelUsed: "claude-sonnet-4-6",
                inputTokens: { cached: 0, uncached: 0 },
                outputTokens: 0,
                durationMs: 1,
                costUsd: 0,
                status: "tooling_error",
                error: `model call failed: ${message}`,
              },
            ],
            totalCostUsd: 0,
            totalTokens: { input: 0, output: 0 },
            status: "tooling_error",
          };
        }
      },
    } as unknown as BaseAgent<unknown>;

    const store = new MemoryDurableStepStore();
    const workflowFn = async (wf: WorkflowContext) => wf.step.agent(stepId, fakeAgent, {});

    await new WorkflowEngine(store).run(workflowFn, {
      runId: "run_pricing_symptom",
      clientSlug: "acme",
      productId: "linkedin",
      runKind: "recurring",
      stageModels,
    });

    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    const stepSpan = spans.find((s) => s.name === "workflow.step.agent");
    expect(stepSpan, "expected a workflow.step.agent span to have been recorded").toBeDefined();
    expect(stepSpan!.attributes.agent_status).toBe("tooling_error");
    expect(
      stepSpan!.status.code,
      "a step whose model turn was refused for having no pricing row must show ERROR in its trace, not the OK a same-shaped RETURNED failure used to read",
    ).toBe(SpanStatusCode.ERROR);
    expect(stepSpan!.status.message).toMatch(/has no pricing row|model call failed/);
  });
});
