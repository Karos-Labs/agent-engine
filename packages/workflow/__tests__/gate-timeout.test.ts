import { describe, expect, it } from "vitest";
import type { WorkflowContext } from "../src/index.js";
import { GateAlreadyResolvedError, MemoryDurableStepStore, WorkflowEngine } from "../src/index.js";

const baseParams = {
  runId: "run_timeout",
  clientSlug: "acme",
  productId: "seo-geo-agent",
  runKind: "recurring" as const,
};

/**
 * `runStepGate`'s `onTimeout: "auto_approve"` handling (SCRUM-273/T-A20):
 * once `duration` has elapsed with no human response, the NEXT call into the
 * run synthesizes an `approve` itself rather than throwing
 * `AwaitingGateSignal` again — proven here with a controllable `now()`
 * (the engine's own injectable clock), never a real sleep or fake timers.
 */
describe("gate timeout: auto_approve", () => {
  it("stays awaiting_gate before the window elapses, then auto-approves and completes once it has", async () => {
    const store = new MemoryDurableStepStore();
    let clock = Date.parse("2026-08-30T00:00:00Z");
    const engine = new WorkflowEngine(store, () => clock);

    const workflowFn = async (wf: WorkflowContext) => {
      const response = await wf.step.gate("review", {
        kind: "batch_review",
        payload: { batchId: "b1" },
        requiredRole: "account_manager",
        timeout: { duration: "1h", onTimeout: "auto_approve" },
      });
      return { decision: response.decision, actor: response.actor };
    };

    const first = await engine.run(workflowFn, baseParams);
    expect(first.status).toBe("awaiting_gate");

    // 30 minutes later — still inside the 1h window, still no human response.
    clock += 30 * 60 * 1000;
    const stillWaiting = await engine.run(workflowFn, baseParams);
    expect(stillWaiting.status).toBe("awaiting_gate");

    // 31 more minutes later — 61 minutes total, past the 1h window.
    clock += 31 * 60 * 1000;
    const resumed = await engine.run(workflowFn, baseParams);
    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") throw new Error("unreachable");
    expect(resumed.output).toEqual({ decision: "approve", actor: "system:gate-timeout" });

    const gate = await store.getGate("run_timeout__review");
    expect(gate?.response?.decision).toBe("approve");
    expect(gate?.response?.actor).toBe("system:gate-timeout");

    // A genuine human decision arriving late must not silently overwrite the
    // timeout's own response — same "never replace a resolved gate's audit
    // trail" rule a real human-vs-human race already gets.
    await expect(
      engine.resolveGate("run_timeout", "review", { decision: "approve", actor: "jane@karoslabs.com", at: new Date(clock).toISOString() }),
    ).rejects.toThrow(GateAlreadyResolvedError);
  });

  it("never auto-approves a hold gate, however long it waits", async () => {
    const store = new MemoryDurableStepStore();
    let clock = Date.parse("2026-08-30T00:00:00Z");
    const engine = new WorkflowEngine(store, () => clock);

    const workflowFn = async (wf: WorkflowContext) => {
      const response = await wf.step.gate("review", {
        kind: "batch_review",
        payload: { batchId: "b1" },
        requiredRole: "account_manager",
        timeout: { duration: "1h", onTimeout: "hold" },
      });
      return { decision: response.decision };
    };

    await engine.run(workflowFn, baseParams);
    clock += 10 * 60 * 60 * 1000; // 10 hours — far past any "1h" window
    const stillWaiting = await engine.run(workflowFn, baseParams);
    expect(stillWaiting.status).toBe("awaiting_gate");
  });
});
