import type { AgentToolOutcome, ToolUnitUsage } from "@agent-engine/core";

/**
 * Typed-outcome constructors matching RFC-01 §6/§9.1 rule 3: every tool
 * result is one of these four shapes, everywhere, so a caller never has to
 * guess which field means what.
 *
 * `usage` (the per-unit cost work — shipped without a Jira ticket) reports non-token units this call consumed — images
 * generated, seconds rendered — priced by `UNIT_PRICING` rather than here. A
 * tool that computes its own dollars is a tool that goes quietly wrong the day
 * a rate moves. Omit it for the overwhelming majority of tools, which consume
 * nothing billable beyond the model tokens their caller already counts.
 */
export function success<TResult>(result: TResult, usage?: readonly ToolUnitUsage[]): AgentToolOutcome<TResult> {
  return { status: "success", result, ...(usage && usage.length > 0 ? { usage } : {}) };
}

export function contentFail<TResult = never>(reason: string): AgentToolOutcome<TResult> {
  return { status: "content_fail", reason };
}

export function toolingError<TResult = never>(reason: string): AgentToolOutcome<TResult> {
  return { status: "tooling_error", reason };
}

export function notAvailable<TResult = never>(reason: string): AgentToolOutcome<TResult> {
  return { status: "not_available", reason };
}
