import { describe, expect, it, vi } from "vitest";
import type { WorkflowContext } from "../src/index.js";
import { MemoryDurableStepStore, WorkflowEngine, sumRunCost } from "../src/index.js";
import { DraftOutputSchema, fakeRouterAlwaysFinal, makeSimpleAgent } from "./test-helpers.js";

/**
 * The run cost ledger (2026-09-22).
 *
 * `sumRunCost` calls `store.listSteps(runId)`, which fetches every step
 * DOCUMENT of the run — and a step document carries that step's whole
 * `output`, for `step.agent` an entire `AgentExecutionResult` with every
 * turn's transcript. Calling it once per step therefore re-downloads the run's
 * whole history on every step: quadratic in bytes, not merely in reads. It was
 * called from the budget pre-check in both `step.code` and `step.agent`, and
 * `wf.costSoFarUsd()` called it again — which tiktok-agent does from
 * inside its per-beat loops, several times per beat, on the one product that
 * actually carries a `RUN_BUDGET_USD_DEFAULTS` entry.
 *
 * These tests pin both halves of the fix: that it reads the store far less,
 * and that it still reports the same number the store would.
 */

const baseParams = {
  runId: "run_ledger",
  clientSlug: "acme",
  productId: "tiktok",
  runKind: "recurring" as const,
};

/** A store that counts how many times the whole step history was fetched. */
function countingStore(): { store: MemoryDurableStepStore; listSteps: ReturnType<typeof vi.fn> } {
  const store = new MemoryDurableStepStore();
  const listSteps = vi.fn(store.listSteps.bind(store));
  store.listSteps = listSteps as unknown as MemoryDurableStepStore["listSteps"];
  return { store, listSteps };
}

const cheapAgent = () => makeSimpleAgent(DraftOutputSchema, fakeRouterAlwaysFinal({ body: "x" }, { inputTokens: 1_000, outputTokens: 500 }));

describe("run cost ledger", () => {
  it("reports the same total the store would, having read the step history once", async () => {
    const { store, listSteps } = countingStore();
    const engine = new WorkflowEngine(store);
    const agent = cheapAgent();
    let reported = -1;

    const workflowFn = async (wf: WorkflowContext) => {
      for (let i = 0; i < 6; i += 1) {
        await wf.step.agent(`draft-${i}`, agent, {});
        await wf.step.code(`polish-${i}`, () => ({ i }));
        // The shape tiktok-agent uses: the running total read from inside the
        // loop, not once at the end.
        reported = await wf.costSoFarUsd();
      }
      return "done";
    };

    // A ceiling well above what this run spends, so the pre-check runs on
    // every step without ever refusing one.
    const result = await engine.run(workflowFn, { ...baseParams, budget: { maxTotalCostUsd: 100 } });
    expect(result.status).toBe("completed");

    const fromStore = await sumRunCost(store, baseParams.runId);
    expect(fromStore).toBeGreaterThan(0);
    // The ledger and the store agree — the property the budget check
    // depends on, since a ledger that drifts low would let a run overspend.
    expect(reported).toBeCloseTo(fromStore, 12);
    expect(result.status === "completed" ? result.totalCostUsd : -1).toBeCloseTo(fromStore, 12);

    // 12 steps, each with a pre-check, plus 18 in-loop `costSoFarUsd()` reads
    // and the engine's own final total. Before the ledger that was 31 full
    // history fetches; now it is the one seed plus the engine's authoritative
    // closing read. The assertion is deliberately a bound and not an exact
    // count: the point is that it no longer scales with the step count.
    expect(listSteps.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("seeds from the store, so a resumed run counts what a previous process already spent", async () => {
    // The whole reason the ledger starts at null rather than 0. This store
    // already holds a completed, paid-for step that THIS process never ran.
    const store = new MemoryDurableStepStore();
    await store.saveStep(baseParams.runId, {
      stepId: "05-footage",
      kind: "code",
      status: "completed",
      output: { bought: true },
      costUsd: 0.9,
      durationMs: 10,
      startedAt: 1,
      completedAt: 11,
    });
    const engine = new WorkflowEngine(store);
    const ran = vi.fn(() => ({ ok: true }));

    const result = await engine.run(async (wf: WorkflowContext) => wf.step.code("06-render", ran), {
      ...baseParams,
      budget: { maxTotalCostUsd: 0.5 },
    });

    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.failureReason : "").toMatch(/budget ceiling exceeded/);
    // A ledger initialised to 0 would have let this step run and spend past a
    // ceiling the run had already blown through.
    expect(ran).not.toHaveBeenCalled();
  });

  it("carries a fan-out slot's spend back to the parent, because the ledger is shared by reference", async () => {
    // `fanout` hands each slot `{ ...runtime, slotId }`. A ledger held as a
    // NUMBER would be copied into that spread, so the slot's spend would land
    // on the slot's own copy and the parent would go on reading a stale total
    // for the rest of the run — under-counting, in the direction that
    // lets a run overspend. `absorbedStepTimeouts` is a mutable box for
    // exactly this reason; so is the ledger.
    const { store, listSteps } = countingStore();
    const engine = new WorkflowEngine(store);
    const agent = cheapAgent();
    let beforeFanout = -1;
    let afterFanout = -1;

    const result = await engine.run(
      async (wf: WorkflowContext) => {
        await wf.step.agent("plan", agent, {});
        beforeFanout = await wf.costSoFarUsd();
        await wf.fanout("beats", [1, 2], async (_item, slot) => slot.step.agent("draft", agent, {}), { concurrency: 1 });
        afterFanout = await wf.costSoFarUsd();
        return "done";
      },
      { ...baseParams, budget: { maxTotalCostUsd: 100 } },
    );

    expect(result.status).toBe("completed");
    const fromStore = await sumRunCost(store, baseParams.runId);
    expect(afterFanout).toBeGreaterThan(beforeFanout);
    expect(afterFanout).toBeCloseTo(fromStore, 12);
    expect(listSteps.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("still answers from the store when a runtime carries no ledger", async () => {
    // `costLedger` is optional on `WorkflowRuntime`, so any caller that builds
    // a runtime by hand (several tests, and any future embedder) keeps working
    // — slowly, but correctly.
    const store = new MemoryDurableStepStore();
    await store.saveStep("run_bare", {
      stepId: "01",
      kind: "agent",
      status: "completed",
      output: null,
      costUsd: 0.25,
      durationMs: 1,
      startedAt: 1,
      completedAt: 2,
    });
    expect(await sumRunCost(store, "run_bare")).toBe(0.25);
  });
});
