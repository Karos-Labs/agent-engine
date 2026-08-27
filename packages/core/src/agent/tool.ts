import type { ZodSchema } from "../types/agent-step.js";
import type { AgentContext } from "../types/agent-context.js";

/**
 * One billable thing a tool consumed that is NOT measured in tokens
 * (SCRUM-361 / AU66).
 *
 * ## Why this exists
 *
 * A measured Instagram run reported $0.565829. Two `gemini-2.5-flash-image`
 * invocations in that run's window were confirmed against Vertex's own
 * publisher metrics, at $0.039 each. The run's own record for the steps that
 * made them read $0.000000 — and not because a cost was looked up and missed.
 * There was no cost path from a tool AT ALL: `AgentToolOutcome` had nowhere to
 * put one, and `runStepCode` wrote the literal constant `0`.
 *
 * That is a ~14% understatement today, which on its own would not justify
 * urgency. The reason it does is that it is a TOTAL BLIND SPOT rather than a
 * bad number, and per-second video billing is heading straight for it: a
 * structural gap tells you a number is wrong, never how wrong.
 *
 * ## The rule
 *
 * Report what you CONSUMED, not what you think it cost. `unit` and `quantity`
 * are observations; the price lives in `UNIT_PRICING` (`telemetry/pricing.ts`)
 * next to `MODEL_PRICING`, so a rate change is one edit in one table rather
 * than a hunt through tools. A tool that computes dollars is a tool that will
 * be wrong quietly the day a rate moves.
 */
export interface ToolUnitUsage {
  /** The billable SKU that priced it — `gemini-2.5-flash-image`, a video model id. Looked up in `UNIT_PRICING`. */
  readonly model: string;
  /** What is counted: `image`, `second`. Asserted against the pricing row's own unit, so a seconds count can never be billed at an image rate. */
  readonly unit: string;
  /** How many. Must be what was actually produced/consumed, not what was requested. */
  readonly quantity: number;
}

/**
 * The three typed outcomes every tool call resolves to, everywhere in the
 * system (RFC-01 §6): `content_fail` is real signal about wrong/non-compliant
 * data; `tooling_error` means something broke and must never be mistaken for
 * a content judgment; `not_available` means the requested data legitimately
 * doesn't exist yet.
 *
 * `usage` (SCRUM-361) rides on `success` only. A tool that failed produced no
 * billable units by definition of the outcomes above — `content_fail` and
 * `not_available` never reach a metered API, and `tooling_error` means the
 * call did not complete. A partial success that DID consume units reports
 * `success` with the units it actually got, which is what `image.generate`
 * does when it fills three of four slots.
 */
export type AgentToolOutcome<TResult> =
  | { status: "success"; result: TResult; usage?: readonly ToolUnitUsage[] }
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
