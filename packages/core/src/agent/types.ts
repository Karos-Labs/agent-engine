import type { ModelRouter } from "../router/model-router.js";
import type { AgentToolOutcome, AgentToolRegistry } from "./tool.js";
import type { PromptStore } from "./prompt-store.js";

/**
 * One ReAct turn (RFC-01 §5.3): the model either takes an Action (calls
 * exactly one tool from `allowedTools`) or produces its terminal output.
 */
export type ReActTurn<TOutput> =
  | { type: "tool_call"; thought?: string | undefined; tool: string; args: unknown }
  | { type: "final"; thought?: string | undefined; output: TOutput };

/** The running record of a step's Thought → Action → Observation turns, fed back into the next prompt. */
export type TranscriptEntry =
  | { role: "input"; content: unknown }
  | { role: "tool_call"; tool: string; args: unknown }
  | { role: "observation"; tool: string; outcome: AgentToolOutcome<unknown> }
  | { role: "write_fence_block"; tool: string; reason: string }
  | { role: "gate_feedback"; gateTool: string; reason: string; evidence: string[] };

/**
 * The platform-provided dependencies a `BaseAgent` step runs against.
 * Subclasses never construct a `ModelRouter` or a tool registry themselves —
 * these are injected so a step is testable without a network call and
 * without importing `packages/tools/`.
 */
export interface BaseAgentRuntime {
  router: ModelRouter;
  tools: AgentToolRegistry;
  /** Resolves `config.skillRef` (`promptId@version`) into system-prompt content (RFC-01 §5.2 step 2, §16.1). Optional — a step with no `skillRef` never needs one. */
  promptStore?: PromptStore;
  /** Injectable clock, for deterministic `durationMs` telemetry in tests. Defaults to `Date.now`. */
  now?(): number;
}
