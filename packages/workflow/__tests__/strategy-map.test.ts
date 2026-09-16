import { describe, expect, it, vi } from "vitest";
import type { AgentToolRegistry, ModelRouter, PromptStore } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine, emptyLearningContext, ensureStrategyMap, strategyRowId, toAgentContext, type WorkflowContext } from "../src/index.js";

/**
 * C1 (SCRUM-464): the strategy-map builder's gates. The build itself is
 * exercised end to end in x-agent's `learning-loop.test.ts`; what is pinned
 * here is WHEN it runs — never on a client with nothing projected (C7 §4.1),
 * never when a map is already in hand — and the row ids the middleware keys on.
 */

const params = { runId: "sm_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

function deps(complete: ReturnType<typeof vi.fn>) {
  const router = { complete, completeAlias: vi.fn() } as unknown as ModelRouter;
  const promptStore = { getPrompt: vi.fn() } as unknown as PromptStore;
  const writes: unknown[] = [];
  const tools: AgentToolRegistry = {
    "ledger.writeStrategyMap": {
      name: "ledger.writeStrategyMap",
      description: "stub",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      execute: (async (args: unknown) => {
        writes.push(args);
        return { status: "success", result: { path: "state/x/strategy-map", rows: 6, created: true } };
      }) as never,
    },
  };
  return { deps: { tools, router, promptStore }, writes };
}

describe("ensureStrategyMap", () => {
  it("ids are stable, zero-padded and platform-scoped", () => {
    expect(strategyRowId("x", 0)).toBe("sm-x-001");
    expect(strategyRowId("linkedin", 11)).toBe("sm-linkedin-012");
  });

  it("with nothing projected, builds nothing and spends no model call (C7 §4.1)", async () => {
    const complete = vi.fn();
    const { deps: d } = deps(complete);
    const workflowFn = async (wf: WorkflowContext) =>
      ensureStrategyMap(wf, d, toAgentContext(wf), {
        platform: "x",
        learning: emptyLearningContext("x"),
        stepId: "01c",
        input: { today: "2026-09-16", clientProfile: { name: "Acme" }, forbiddenTopics: [] },
      });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, params);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output).toEqual({ map: undefined, source: "none" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("with a map in hand, returns it and says whose it is", async () => {
    const complete = vi.fn();
    const { deps: d } = deps(complete);
    const learning = { ...emptyLearningContext("x"), strategyMap: { rows: [{ id: "sm-x-001", stage: "attention", idea: "a" }] }, sources: { "strategy-map": { projectedBy: "engine-run" } }, readiness: { present: ["strategy-map"], absent: [] } };
    const workflowFn = async (wf: WorkflowContext) => ensureStrategyMap(wf, d, toAgentContext(wf), { platform: "x", learning, stepId: "01c", input: { today: "2026-09-16", clientProfile: {}, forbiddenTopics: [] } });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "sm_2" });
    if (result.status !== "completed") throw new Error("unreachable");
    expect((result.output as { source: string }).source).toBe("engine");
    expect(complete).not.toHaveBeenCalled();
  });

  it("with the loop live and no map but no client material either, builds nothing", async () => {
    const complete = vi.fn();
    const { deps: d } = deps(complete);
    const learning = { ...emptyLearningContext("x"), readiness: { present: ["preferences"], absent: [] } };
    const workflowFn = async (wf: WorkflowContext) => ensureStrategyMap(wf, d, toAgentContext(wf), { platform: "x", learning, stepId: "01c", input: { today: "2026-09-16", clientProfile: {}, forbiddenTopics: [] } });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "sm_3" });
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output).toEqual({ map: undefined, source: "none" });
    expect(complete).not.toHaveBeenCalled();
  });
});
