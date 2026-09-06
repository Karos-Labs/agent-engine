import type { AgentExecutionResult, AgentStepTelemetry } from "@agent-engine/core";

/**
 * What a `step.agent` result that ended without output actually did, in one
 * line a person can act on — the step's own account of itself.
 *
 * Written for two readers. The reviewer who sees a `held` run in the portal
 * gets "budget_exceeded after 9 turn(s), $0.91; tool calls: render.preview ×2,
 * gate.lintPost ×7 (7 pass); … called "gate.lintPost" instead — refused" and
 * knows at once that a finished draft was verified seven times and never
 * returned, rather than the bare `draft step resolved to "budget_exceeded"`
 * prep run pubsub-21699953559354996 recorded. And the redraft attempt that
 * follows (`commitDirectiveAfterExhaustion`) is handed the same account, so
 * it is told what its predecessor did wrong instead of being asked the same
 * question the same way.
 *
 * A gate verdict is read from the tool outcome's `result.verdict`, the shape
 * every `gate.*` tool returns; any other tool's result is just counted.
 */
export function describeAgentExhaustion(result: AgentExecutionResult<unknown>): string {
  const byTool = new Map<string, { calls: number; passes: number }>();
  for (const step of result.steps) {
    if (step.toolCall === undefined) continue;
    const entry = byTool.get(step.toolCall.name) ?? { calls: 0, passes: 0 };
    entry.calls++;
    if (gateVerdict(step) === "pass") entry.passes++;
    byTool.set(step.toolCall.name, entry);
  }
  const tools = [...byTool.entries()].map(([name, { calls, passes }]) => `${name} ×${calls}${passes > 0 ? ` (${passes} pass)` : ""}`).join(", ");
  // The LAST turn carrying an error is the one that ended the loop — the same
  // rule `step.agent` itself applies when it promotes a reason onto the record.
  const lastError = [...result.steps].reverse().find((step) => step.error !== undefined)?.error;

  return [
    `${result.status} after ${result.steps.length} turn(s), $${result.totalCostUsd.toFixed(2)}`,
    tools.length > 0 ? `tool calls: ${tools}` : "no tool calls",
    lastError ?? "no final output was returned",
  ].join("; ");
}

function gateVerdict(step: AgentStepTelemetry): string | undefined {
  const outcome = step.toolCall?.result as { result?: { verdict?: unknown } } | null | undefined;
  const verdict = outcome?.result?.verdict;
  return typeof verdict === "string" ? verdict : undefined;
}

/**
 * The steer a workflow hands its ONE redraft after a drafting step ran out of
 * turns. Names what the previous attempt did (the diagnosis above), then
 * states the shape of a turn-frugal attempt: write, check at most once,
 * return. The lane-and-mode sentence is there because the observed failure
 * spent its turns re-deliberating a lane it had been told not to choose.
 */
export function commitDirectiveAfterExhaustion(diagnosis: string): string {
  return (
    `Your previous drafting attempt ran out of turns without returning a final output (${diagnosis}). ` +
    'This attempt: write the post, check it with a gate tool AT MOST once, then return {"type":"final"} on the very next turn. ' +
    "Do not re-check text that has already passed, and do not draft alternates. " +
    "The lane and content mode you were given are settled: write the most honest post that fits them rather than deliberating about the fit."
  );
}
