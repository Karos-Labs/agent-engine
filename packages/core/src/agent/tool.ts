import type { ZodSchema } from "../types/agent-step.js";
import type { AgentContext } from "../types/agent-context.js";

/**
 * The three typed outcomes every tool call resolves to, everywhere in the
 * system (RFC-01 §6): `content_fail` is real signal about wrong/non-compliant
 * data; `tooling_error` means something broke and must never be mistaken for
 * a content judgment; `not_available` means the requested data legitimately
 * doesn't exist yet.
 */
export type AgentToolOutcome<TResult> =
  | { status: "success"; result: TResult }
  | { status: "content_fail"; reason: string }
  | { status: "tooling_error"; reason: string }
  | { status: "not_available"; reason: string };

export interface AgentToolCallContext {
  ctx: AgentContext;
}

/**
 * A single Layer 3 tool, as seen from Layer 2. `BaseAgent` never touches the
 * filesystem, an external API, or a database directly (RFC-01 §4's
 * invariant) — every external effect goes through something shaped like
 * this. Real MCP-backed implementations live in `packages/tools/`; this is
 * only the contract Layer 2 depends on.
 */
export interface AgentTool<TArgs = unknown, TResult = unknown> {
  name: string;
  /** Travels into every telemetry record — RFC-01 §9.1 rule 5. */
  version: string;
  inputSchema: ZodSchema<TArgs>;
  execute(args: TArgs, context: AgentToolCallContext): Promise<AgentToolOutcome<TResult>>;
}

/** A heterogeneous tool registry, keyed by the name used in `AgentStepConfig.allowedTools`. */
export type AgentToolRegistry = Record<string, AgentTool<unknown, unknown>>;
