import type { AgentContext } from "../types/agent-context.js";
import type { AgentStepConfig } from "../types/agent-step.js";
import { BaseAgent } from "./base-agent.js";
import type { BaseAgentRuntime } from "./types.js";

/**
 * A `BaseAgent` whose config AND system prompt both come from stored data
 * at construction time, rather than being hand-written into a concrete
 * subclass — the execution half of Task 2's data-driven "dynamic agent"
 * (see `../agent-definitions/types.js`'s `AgentDefinitionStage`, and
 * `apps/agent-server/src/wiring/dynamic-workflows.ts`, which builds one of
 * these per stage). Structurally almost identical to `MockAgent` (which
 * exists for the same "config-only subclass" reason, test-only) — the one
 * real difference is `loadSystemPrompt`: a dynamic agent's prompt is
 * authored directly on its stage, not resolved through `skillRef`/
 * `PromptStore` — that mechanism is for the versioned craft-policy prompts
 * the 12 hand-written agents share (RFC-01 §16.1), a different concern
 * from one Studio-authored stage's own single prompt.
 */
export class DynamicAgent<TOutput> extends BaseAgent<TOutput> {
  protected readonly config: AgentStepConfig<TOutput>;
  private readonly systemPromptText: string | undefined;

  constructor(runtime: BaseAgentRuntime, config: AgentStepConfig<TOutput>, systemPrompt?: string) {
    super(runtime);
    this.config = config;
    this.systemPromptText = systemPrompt;
  }

  protected override async loadSystemPrompt(_ctx: AgentContext): Promise<string | undefined> {
    return this.systemPromptText;
  }
}
