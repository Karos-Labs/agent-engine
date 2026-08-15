import type { AgentExecutionResult } from "@agent-engine/core";
import type { RunRecord, SlotRecord, StepRecord } from "../adapters/types.js";
import type {
  DynamicAgentDomainOutcome,
  DynamicAgentRunReport,
  DynamicAgentRunStep,
  DynamicAgentRunStepUsage,
  DynamicAgentStepDescriptor,
} from "./types.js";

export interface SerializeToDynamicAgentRunReportParams {
  specId: string;
  specVersion: number;
  /** In execution order — the order `failedStepId`/`failedStepIndex` are derived from. */
  steps: readonly DynamicAgentStepDescriptor[];
  stepRecords: readonly StepRecord[];
  slotRecords: readonly SlotRecord[];
  /** Optional — when provided, derives `domainOutcome`/`domainOutcomeReason` (RFC-01 §16.2) from the run's own status. */
  runRecord?: RunRecord;
}

function isAgentExecutionResult(output: unknown): output is AgentExecutionResult<unknown> {
  return (
    typeof output === "object" &&
    output !== null &&
    "status" in output &&
    "steps" in output &&
    "totalCostUsd" in output &&
    "totalTokens" in output &&
    Array.isArray((output as { steps: unknown }).steps)
  );
}

function usageFromAgentResult(result: AgentExecutionResult<unknown>): DynamicAgentRunStepUsage {
  const models: Record<string, DynamicAgentRunStepUsage["models"][string]> = {};
  for (const step of result.steps) {
    const bucket = (models[step.modelUsed] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    });
    bucket.inputTokens += step.inputTokens.cached + step.inputTokens.uncached;
    bucket.outputTokens += step.outputTokens;
    bucket.cacheReadInputTokens += step.inputTokens.cached;
    bucket.costUsd = (bucket.costUsd ?? 0) + step.costUsd;
  }
  return { totalCostUsd: result.totalCostUsd, numTurns: result.steps.length, models };
}

function serializeAgentRecord(
  descriptor: DynamicAgentStepDescriptor,
  durationMs: number,
  result: AgentExecutionResult<unknown>,
): DynamicAgentRunStep {
  const usage = usageFromAgentResult(result);
  const primaryModel = result.steps[0]?.modelUsed;
  const inputTokensCached = result.steps.reduce((sum, s) => sum + s.inputTokens.cached, 0);
  const inputTokensUncached = result.steps.reduce((sum, s) => sum + s.inputTokens.uncached, 0);

  return {
    stepId: descriptor.stepId,
    type: descriptor.type,
    label: descriptor.label,
    // RFC-01 §7.2: agent-engine's richer taxonomy collapses to the portal's binary status here.
    status: result.status === "completed" ? "done" : "failed",
    durationMs,
    ...(primaryModel !== undefined ? { model: primaryModel } : {}),
    ...(result.status !== "completed" ? { error: `agent step resolved to "${result.status}"` } : {}),
    usage,
    costUsd: result.totalCostUsd,
    tokensIn: { cached: inputTokensCached, uncached: inputTokensUncached },
    tokensOut: result.totalTokens.output,
  };
}

function serializeOneStep(
  descriptor: DynamicAgentStepDescriptor,
  record: StepRecord | SlotRecord | undefined,
): DynamicAgentRunStep {
  if (!record) {
    // Never reached — the run stopped or paused before this step (e.g. behind an unresolved gate).
    return { stepId: descriptor.stepId, type: descriptor.type, label: descriptor.label, status: "failed", durationMs: 0, error: "step did not run" };
  }

  if (record.status === "failed") {
    return {
      stepId: descriptor.stepId,
      type: descriptor.type,
      label: descriptor.label,
      status: "failed",
      durationMs: record.durationMs,
      error: record.error ?? "step failed",
    };
  }

  if (isAgentExecutionResult(record.output)) {
    return serializeAgentRecord(descriptor, record.durationMs, record.output);
  }

  // A plain "code" step (or a fan-out slot whose inner logic wasn't an agent call) — no model/usage to report.
  return { stepId: descriptor.stepId, type: descriptor.type, label: descriptor.label, status: "done", durationMs: record.durationMs };
}

/**
 * Derives `domainOutcome`/`domainOutcomeReason` (RFC-01 §16.2) from the run's
 * own status — `held`/`blocked_intake` are never reported as `failedStepId`-
 * style failures; a `completed` run is labeled `delivered`, the domain name
 * for "produced a real, gate-passed deliverable". Any other run status
 * (`failed`/`degraded`/`awaiting_gate`/`running`) has no domain outcome yet.
 */
function domainOutcomeFromRun(runRecord: RunRecord | undefined): { domainOutcome?: DynamicAgentDomainOutcome; domainOutcomeReason?: string } {
  if (!runRecord) {
    return {};
  }
  if (runRecord.status === "completed") {
    return { domainOutcome: "delivered" };
  }
  if (runRecord.status === "held" || runRecord.status === "blocked_intake") {
    return { domainOutcome: runRecord.status, ...(runRecord.reason !== undefined ? { domainOutcomeReason: runRecord.reason } : {}) };
  }
  return {};
}

/**
 * Transforms the engine's internal state into the portal-compatible
 * `DynamicAgentRunReport` (RFC-01 §7.2) — `specId`/`specVersion` and each
 * step's `label`/`type` have no home in Layer 1's own records (they're
 * authoring metadata, not execution state), so they're supplied by the
 * caller rather than invented here.
 */
export function serializeToDynamicAgentRunReport(params: SerializeToDynamicAgentRunReportParams): DynamicAgentRunReport {
  const stepsById = new Map(params.stepRecords.map((s) => [s.stepId, s] as const));
  const slotsById = new Map(params.slotRecords.map((s) => [s.slotId, s] as const));

  const steps = params.steps.map((descriptor) => serializeOneStep(descriptor, stepsById.get(descriptor.stepId) ?? slotsById.get(descriptor.stepId)));

  const failedIndex = steps.findIndex((step) => step.status === "failed");

  return {
    specId: params.specId,
    specVersion: params.specVersion,
    steps,
    ...(failedIndex !== -1
      ? {
          failedStepId: steps[failedIndex]!.stepId,
          failedStepIndex: failedIndex,
          hasPartialOutput: failedIndex > 0,
        }
      : {}),
    ...domainOutcomeFromRun(params.runRecord),
  };
}
