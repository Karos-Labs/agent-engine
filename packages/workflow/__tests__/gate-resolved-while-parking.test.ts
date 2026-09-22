import { describe, expect, it } from "vitest";
import { MemoryDurableStepStore } from "../src/adapters/memory-store.js";
import type { GateRecord, StepRecord } from "../src/adapters/types.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import type { WorkflowContext } from "../src/primitives/context.js";
import { GATE_TIMEOUT_ACTOR } from "../src/primitives/step-gate.js";
import { GateAlreadyResolvedError } from "../src/primitives/signals.js";

const BASE = { clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

/**
 * THE WEDGE (prep run pubsub-21936957999643915, 2026-09-22).
 *
 * `runStepGate` reads the gate, sees no response, and throws
 * `AwaitingGateSignal`. If a decision lands on that gate between the read and
 * this execution writing `awaiting_gate`, the run is parked at a gate that is
 * already decided — and before this fix nothing would ever move it again: the
 * next `/resume` 409'd (already resolved) and the sweep skipped it (has a
 * response). `runUntilParkedOrDone` re-reads the gate before parking.
 */
describe("WorkflowEngine.run — a gate resolved while the run was parking at it", () => {
  it("continues with the decision instead of parking on a gate that already has one", async () => {
    const store = new MemoryDurableStepStore();
    // The narrowest possible interception: `markStepRunning` is the last
    // store write `runStepGate` makes before it throws. A decision written
    // at that instant is the race.
    const raced = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "saveStep") {
          return async (runId: string, step: StepRecord) => {
            await target.saveStep(runId, step);
            if (step.kind === "gate" && step.status === "running") {
              const gate = (await target.getGate(`${runId}__approve`)) as GateRecord;
              await target.saveGate({ ...gate, response: { decision: "approve", actor: "jane@karoslabs.com", at: "2026-09-22T19:50:00Z" } as never });
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const engine = new WorkflowEngine(raced);
    let afterGate = 0;

    const workflow = async (wf: WorkflowContext) => {
      await wf.step.gate("approve", { kind: "human", prompt: "ok?" } as never);
      afterGate += 1;
      return "done";
    };

    const result = await engine.run(workflow, { ...BASE, runId: "run_raced" });
    expect(result.status).toBe("completed");
    expect(afterGate).toBe(1);
    // Jane's decision, applied as-is.
    const gate = await store.getGate("run_raced__approve");
    expect(gate?.response?.actor).toBe("jane@karoslabs.com");
    const step = await store.getStep("run_raced", "approve");
    expect(step?.status).toBe("completed");
  });

  it("still parks normally when nobody decided", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const workflow = async (wf: WorkflowContext) => {
      await wf.step.gate("approve", { kind: "human", prompt: "ok?" } as never);
      return "done";
    };
    const result = await engine.run(workflow, { ...BASE, runId: "run_plain" });
    expect(result.status).toBe("awaiting_gate");
  });
});

describe("WorkflowEngine.resolveGate — superseding a timeout approval", () => {
  async function parkedRun(store: MemoryDurableStepStore, engine: WorkflowEngine, runId: string) {
    const workflow = async (wf: WorkflowContext) => {
      await wf.step.gate("approve", { kind: "human", prompt: "ok?" } as never);
      return "done";
    };
    const first = await engine.run(workflow, { ...BASE, runId });
    expect(first.status).toBe("awaiting_gate");
    return workflow;
  }

  it("lets a human replace the timeout's own approval while the run is still parked, when asked to", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    await parkedRun(store, engine, "run_t1");
    const gate = (await store.getGate("run_t1__approve"))!;
    await store.saveGate({ ...gate, response: { decision: "approve", actor: GATE_TIMEOUT_ACTOR, at: "2026-09-22T20:05:00Z" } as never });

    await engine.resolveGate("run_t1", "approve", { decision: "reject", actor: "jane@karoslabs.com", at: "2026-09-22T22:50:00Z", reason: "no" } as never, {
      supersedeTimeoutApproval: true,
    });
    expect((await store.getGate("run_t1__approve"))?.response?.actor).toBe("jane@karoslabs.com");
  });

  it("never replaces a decision a human recorded, whatever the option says", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    await parkedRun(store, engine, "run_t2");
    await engine.resolveGate("run_t2", "approve", { decision: "approve", actor: "mallory@example.com", at: "2026-09-22T20:05:00Z" } as never);

    await expect(
      engine.resolveGate("run_t2", "approve", { decision: "reject", actor: "jane@karoslabs.com", at: "2026-09-22T22:50:00Z", reason: "no" } as never, {
        supersedeTimeoutApproval: true,
      }),
    ).rejects.toBeInstanceOf(GateAlreadyResolvedError);
    expect((await store.getGate("run_t2__approve"))?.response?.actor).toBe("mallory@example.com");
  });

  it("keeps refusing by default, timeout approval or not", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    await parkedRun(store, engine, "run_t3");
    const gate = (await store.getGate("run_t3__approve"))!;
    await store.saveGate({ ...gate, response: { decision: "approve", actor: GATE_TIMEOUT_ACTOR, at: "2026-09-22T20:05:00Z" } as never });

    await expect(
      engine.resolveGate("run_t3", "approve", { decision: "reject", actor: "jane@karoslabs.com", at: "2026-09-22T22:50:00Z", reason: "no" } as never),
    ).rejects.toBeInstanceOf(GateAlreadyResolvedError);
  });
});
