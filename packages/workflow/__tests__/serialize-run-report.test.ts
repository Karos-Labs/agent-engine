import { describe, expect, it } from "vitest";
import type { AgentExecutionResult } from "@agent-engine/core";
import type { RunRecord, SlotRecord, StepRecord } from "../src/adapters/types.js";
import { serializeToDynamicAgentRunReport } from "../src/serializers/serialize-run-report.js";

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run_1",
    clientSlug: "acme",
    productId: "linkedin",
    runKind: "recurring",
    status: "completed",
    createdAt: 1000,
    updatedAt: 1500,
    ...overrides,
  };
}

function makeCodeStep(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    stepId: "assemble-context",
    kind: "code",
    status: "completed",
    output: { topic: "remote work" },
    costUsd: 0,
    durationMs: 5,
    startedAt: 1000,
    completedAt: 1005,
    ...overrides,
  };
}

function makeAgentResult(overrides: Partial<AgentExecutionResult<unknown>> = {}): AgentExecutionResult<unknown> {
  return {
    finalOutput: { body: "hello world" },
    steps: [
      {
        stepIndex: 0,
        modelUsed: "claude-sonnet-4-6",
        inputTokens: { cached: 100, uncached: 50 },
        outputTokens: 30,
        durationMs: 500,
        costUsd: 0.001,
        status: "success",
      },
    ],
    totalCostUsd: 0.001,
    totalTokens: { input: 150, output: 30 },
    status: "completed",
    ...overrides,
  };
}

function makeAgentStep(overrides: Partial<StepRecord> = {}, resultOverrides: Partial<AgentExecutionResult<unknown>> = {}): StepRecord {
  return {
    stepId: "draft",
    kind: "agent",
    status: "completed",
    output: makeAgentResult(resultOverrides),
    costUsd: 0.001,
    durationMs: 500,
    startedAt: 1000,
    completedAt: 1500,
    ...overrides,
  };
}

describe("serializeToDynamicAgentRunReport", () => {
  it("serializes a completed code step as done, with no usage", () => {
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_1",
      specVersion: 1,
      steps: [{ stepId: "assemble-context", label: "Assemble context", type: "code" }],
      stepRecords: [makeCodeStep()],
      slotRecords: [],
    });

    expect(report).toEqual({
      specId: "spec_1",
      specVersion: 1,
      steps: [{ stepId: "assemble-context", type: "code", label: "Assemble context", status: "done", durationMs: 5 }],
    });
  });

  it("serializes a failed code step as failed, carrying the error", () => {
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_1",
      specVersion: 1,
      steps: [{ stepId: "boom", label: "Boom", type: "code" }],
      stepRecords: [makeCodeStep({ stepId: "boom", status: "failed", output: null, error: "unexpected bug" })],
      slotRecords: [],
    });

    expect(report.steps[0]).toMatchObject({ status: "failed", error: "unexpected bug" });
    expect(report.failedStepId).toBe("boom");
    expect(report.failedStepIndex).toBe(0);
    expect(report.hasPartialOutput).toBe(false);
  });

  it("serializes a completed agent step as done, with usage/model/cost/tokens populated", () => {
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_1",
      specVersion: 1,
      steps: [{ stepId: "draft", label: "Draft the post", type: "ai" }],
      stepRecords: [makeAgentStep()],
      slotRecords: [],
    });

    const step = report.steps[0]!;
    expect(step.status).toBe("done");
    expect(step.model).toBe("claude-sonnet-4-6");
    expect(step.costUsd).toBeCloseTo(0.001, 6);
    expect(step.tokensIn).toEqual({ cached: 100, uncached: 50 });
    expect(step.tokensOut).toBe(30);
    expect(step.usage).toEqual({
      totalCostUsd: 0.001,
      numTurns: 1,
      models: {
        "claude-sonnet-4-6": { inputTokens: 150, outputTokens: 30, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, costUsd: 0.001 },
      },
    });
  });

  it("collapses a content_fail agent result to the portal's binary 'failed' status (RFC-01 §7.2)", () => {
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_1",
      specVersion: 1,
      steps: [{ stepId: "draft", label: "Draft the post", type: "ai" }],
      stepRecords: [makeAgentStep({}, { status: "content_fail", finalOutput: null })],
      slotRecords: [],
    });

    const step = report.steps[0]!;
    expect(step.status).toBe("failed");
    expect(step.error).toMatch(/content_fail/);
    // still carries usage/cost — Layer 1 doesn't discard telemetry just because the content failed.
    expect(step.costUsd).toBeCloseTo(0.001, 6);
  });

  it("marks a step that never ran (no checkpoint at all) as failed, never silently omitted", () => {
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_1",
      specVersion: 1,
      steps: [
        { stepId: "assemble-context", label: "Assemble context", type: "code" },
        { stepId: "batch-review", label: "Batch review", type: "code" },
      ],
      stepRecords: [makeCodeStep()],
      slotRecords: [],
    });

    expect(report.steps).toHaveLength(2);
    expect(report.steps[1]).toMatchObject({ stepId: "batch-review", status: "failed", error: "step did not run" });
    expect(report.failedStepId).toBe("batch-review");
    expect(report.failedStepIndex).toBe(1);
    expect(report.hasPartialOutput).toBe(true); // step 0 (assemble-context) did produce usable output
  });

  it("serializes a fan-out slot the same way as a top-level agent step", () => {
    const slot: SlotRecord = {
      slotId: "drafts__slot_0",
      fanoutId: "drafts",
      status: "completed",
      output: makeAgentResult(),
      durationMs: 500,
      startedAt: 1000,
      completedAt: 1500,
    };

    const report = serializeToDynamicAgentRunReport({
      specId: "spec_1",
      specVersion: 1,
      steps: [{ stepId: "drafts__slot_0", label: "Draft — linkedin", type: "ai" }],
      stepRecords: [],
      slotRecords: [slot],
    });

    expect(report.steps[0]).toMatchObject({ stepId: "drafts__slot_0", status: "done", model: "claude-sonnet-4-6" });
  });

  it("reports no failure fields when every step succeeded", () => {
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_1",
      specVersion: 1,
      steps: [{ stepId: "assemble-context", label: "Assemble context", type: "code" }],
      stepRecords: [makeCodeStep()],
      slotRecords: [],
    });

    expect(report.failedStepId).toBeUndefined();
    expect(report.failedStepIndex).toBeUndefined();
    expect(report.hasPartialOutput).toBeUndefined();
  });
});

describe("domainOutcome derivation (RFC-01 §16.2 / RFC-02 §3)", () => {
  const baseArgs = {
    specId: "spec_1",
    specVersion: 1,
    steps: [{ stepId: "assemble-context", label: "Assemble context", type: "code" as const }],
    stepRecords: [makeCodeStep()],
    slotRecords: [],
  };

  it("labels a completed run 'delivered'", () => {
    const report = serializeToDynamicAgentRunReport({ ...baseArgs, runRecord: makeRunRecord({ status: "completed" }) });
    expect(report.domainOutcome).toBe("delivered");
    expect(report.domainOutcomeReason).toBeUndefined();
  });

  it("labels a held run 'held', carrying its reason", () => {
    const report = serializeToDynamicAgentRunReport({
      ...baseArgs,
      runRecord: makeRunRecord({ status: "held", reason: "no draft cleared brand review" }),
    });
    expect(report.domainOutcome).toBe("held");
    expect(report.domainOutcomeReason).toBe("no draft cleared brand review");
  });

  it("labels a blocked_intake run 'blocked_intake', carrying its reason", () => {
    const report = serializeToDynamicAgentRunReport({
      ...baseArgs,
      runRecord: makeRunRecord({ status: "blocked_intake", reason: "company handle missing" }),
    });
    expect(report.domainOutcome).toBe("blocked_intake");
    expect(report.domainOutcomeReason).toBe("company handle missing");
  });

  it("omits domainOutcome for a failed/degraded/awaiting_gate run", () => {
    for (const status of ["failed", "degraded", "awaiting_gate", "running"] as const) {
      const report = serializeToDynamicAgentRunReport({ ...baseArgs, runRecord: makeRunRecord({ status }) });
      expect(report.domainOutcome).toBeUndefined();
    }
  });

  it("omits domainOutcome entirely when no runRecord is supplied (backward compatible)", () => {
    const report = serializeToDynamicAgentRunReport(baseArgs);
    expect(report.domainOutcome).toBeUndefined();
    expect(report.domainOutcomeReason).toBeUndefined();
    expect("domainOutcome" in report).toBe(false);
  });
});
