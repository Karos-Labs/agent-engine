import type { AgentContext, AgentToolRegistry, GateVerdict } from "@agent-engine/core";
import { WorkflowToolingFailure } from "./signals.js";

/**
 * Unwraps a gate tool's outcome into its `GateVerdict`, treating a broken
 * gate call as a tooling failure — never a content verdict (RFC-01 §5.6/§6).
 *
 * Lifted out of the per-agent workflow files that each defined this
 * (seo-geo-agent's own comment on its copy: "Copied verbatim from
 * `linkedin-agent`'s `create-linkedin-agent-workflow.ts`") — AU16 / SCRUM-300.
 * Of the nine local copies this ticket's audit found, seven were byte-for-byte
 * identical to this. The other two had already diverged on their own —
 * tiktok-agent's wraps a broader local `callTool` helper it also uses for
 * non-gate tool calls, and branded-shorts-agent's includes the failed gate's
 * own `reason` in the thrown message — and are left as deliberate local
 * variants rather than forced onto this shape.
 */
export async function runGate(tools: AgentToolRegistry, gateName: string, args: unknown, ctx: AgentContext): Promise<GateVerdict> {
  const tool = tools[gateName];
  if (!tool) {
    throw new WorkflowToolingFailure(`no gate registered as "${gateName}"`);
  }
  const outcome = await tool.execute(args, { ctx });
  if (outcome.status !== "success") {
    throw new WorkflowToolingFailure(`gate "${gateName}" call failed: ${outcome.status}`);
  }
  return outcome.result as GateVerdict;
}
