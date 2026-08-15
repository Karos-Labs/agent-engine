import type { AgentToolOutcome } from "@agent-engine/core";

/**
 * Typed-outcome constructors matching RFC-01 §6/§9.1 rule 3: every tool
 * result is one of these four shapes, everywhere, so a caller never has to
 * guess which field means what.
 */
export function success<TResult>(result: TResult): AgentToolOutcome<TResult> {
  return { status: "success", result };
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
