import type { StepRecordStatus } from "../adapters/types.js";

/**
 * The translation between RFC-01 §6's four-outcome tool contract and the status
 * a checkpoint records (AU67 / SCRUM-365, extended to slots by AU68 /
 * SCRUM-366).
 *
 * This is the missing translation the whole defect family is about. Tools
 * report failure as a RETURNED VALUE; the recorders only ever listened for
 * exceptions. A correctly-reported failure therefore arrived as a successful
 * return and was written down as `completed`.
 *
 * It lives in its own module because there are now TWO recorders that take
 * arbitrary caller code and have to read its return value — `step.code`'s body
 * and `fanout`'s slot function. Two copies of a translation are two chances for
 * them to drift, and a drift here is invisible: both copies would still
 * compile, still pass their own tests, and disagree only about a failure
 * nobody is watching.
 */

/**
 * Shape-driven, like the rest of the recorders' inspection of `output`, and for
 * the same reason: an opt-in would only catch the call sites someone
 * remembered, leaving the default wrong — which is the failure being fixed. A
 * body returning something that is not a tool outcome (most of them) is
 * `completed`, and that is now a measurement rather than an assumption.
 *
 * Deliberately NOT collapsed to `failed`: `not_available` is a designed,
 * expected state and `content_fail` is a real content judgment a revision loop
 * asks for. Flattening them into "failed" would be the same conflation this
 * function exists to remove, one level up.
 */
export function statusFromOutcome(output: unknown): Extract<StepRecordStatus, "completed" | "content_fail" | "not_available" | "tooling_error"> {
  if (typeof output !== "object" || output === null) return "completed";
  const status = (output as { status?: unknown }).status;
  if (status === "content_fail" || status === "not_available" || status === "tooling_error") return status;
  return "completed";
}

/**
 * The tool's own `reason`, promoted onto the record.
 *
 * Without it a non-success step records a status and nothing else, so the run
 * report can say THAT a step failed but not why. Same argument as
 * `AgentStepTelemetry.error`, which exists for exactly this.
 */
export function describeOutcomeReason(output: unknown): { error?: string } {
  if (typeof output !== "object" || output === null) return {};
  const { status, reason } = output as { status?: unknown; reason?: unknown };
  if (status === "success" || typeof reason !== "string") return {};
  return { error: reason };
}
