import type { AgentContext } from "@agent-engine/core";

export function testCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    runId: "run_test",
    clientSlug: "forge",
    productId: "s6",
    runKind: "setup",
    metadata: {},
    ...overrides,
  };
}
