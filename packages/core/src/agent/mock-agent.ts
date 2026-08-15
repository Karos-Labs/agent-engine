import type { AgentStepConfig } from "../types/agent-step.js";
import { BaseAgent } from "./base-agent.js";
import type { BaseAgentRuntime } from "./types.js";

/**
 * A concrete `BaseAgent` with no behavior of its own beyond what the base
 * class already implements — used to unit-test the ReAct loop, the
 * write-fence, and the self-critique flow against an injected fake
 * `ModelRouter` and fake tools, without a real subclass's prompt/schema.
 */
export class MockAgent<TOutput> extends BaseAgent<TOutput> {
  protected readonly config: AgentStepConfig<TOutput>;

  constructor(runtime: BaseAgentRuntime, config: AgentStepConfig<TOutput>) {
    super(runtime);
    this.config = config;
  }
}
