import { describe, expect, it, vi } from "vitest";
import type { AgentContext, AgentExecutionResult, BaseAgent } from "@agent-engine/core";
import { AwaitingGateSignal, MemoryDurableStepStore, WorkflowEngine, WorkflowStepTimeout, type WorkflowContext } from "../src/index.js";
import * as workflowPkg from "../src/index.js";

// The three symbols this ticket ADDS are reached through the namespace rather
// than as named ESM bindings, deliberately. Named imports of a not-yet-existing
// export make the pre-change run die with "does not provide an export named X"
// — a true failure, but one that proves only that a file was edited. Reached
// this way, the pre-change run fails on the BEHAVIOUR each test is about
// (peak simultaneity, a signal that was never handed over), which is the
// evidence worth having.
const DEFAULT_FANOUT_CONCURRENCY: number = (workflowPkg as { DEFAULT_FANOUT_CONCURRENCY?: number }).DEFAULT_FANOUT_CONCURRENCY ?? 8;
const STEP_ABORT_SIGNAL_METADATA_KEY: string =
  (workflowPkg as { STEP_ABORT_SIGNAL_METADATA_KEY?: string }).STEP_ABORT_SIGNAL_METADATA_KEY ?? "abortSignal";
const stepAbortSignal: (ctx: AgentContext) => AbortSignal | undefined =
  (workflowPkg as { stepAbortSignal?: (ctx: AgentContext) => AbortSignal | undefined }).stepAbortSignal ??
  ((ctx) => {
    const candidate = ctx.metadata[STEP_ABORT_SIGNAL_METADATA_KEY];
    return candidate instanceof AbortSignal ? candidate : undefined;
  });

const baseParams = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "test-product",
  runKind: "recurring" as const,
};

/**
 * AU5 / SCRUM-316.
 *
 * Two engine-level gaps the ticket names:
 *   1. `fanout` was an unbounded `Promise.all` — every item started in the
 *      same tick, so "N prompts x 5 engines" hit a rate-limited route all at
 *      once and nothing in the primitive could stop it.
 *   2. a `step.agent` timeout stopped the engine WAITING but propagated no
 *      cancellation to the agent, so the model call kept running and billing.
 *
 * Every assertion below fails on the pre-change code: `DEFAULT_FANOUT_CONCURRENCY`,
 * `stepAbortSignal` and `STEP_ABORT_SIGNAL_METADATA_KEY` do not exist there,
 * and the two behavioural tests measure peak simultaneity and a fired signal
 * that the old code cannot produce.
 */

/** Records the high-water mark of simultaneously in-flight slot bodies. */
function makeInFlightProbe() {
  let inFlight = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async enter<T>(body: () => Promise<T>): Promise<T> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await body();
      } finally {
        inFlight--;
      }
    },
  };
}

/** Yields enough microtasks that every sibling slot gets a chance to start before any finishes. */
async function yieldTicks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("AU5 / SCRUM-316 — fanout concurrency cap", () => {
  it("never runs more than `concurrency` slots at once", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const probe = makeInFlightProbe();
    const items = Array.from({ length: 20 }, (_, i) => i);

    const result = await engine.run(
      async (wf: WorkflowContext) =>
        wf.fanout("capture", items, (item) => probe.enter(async () => {
          await yieldTicks();
          return { item };
        }), { concurrency: 3 }),
      baseParams,
    );

    expect(result.status).toBe("completed");
    // The whole point of the ticket: 20 items, never more than 3 in flight.
    expect(probe.peak).toBe(3);
    expect(result.status === "completed" ? result.output : []).toHaveLength(20);
  });

  it("caps at DEFAULT_FANOUT_CONCURRENCY when the call site says nothing — the cap is not opt-in", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const probe = makeInFlightProbe();
    const items = Array.from({ length: DEFAULT_FANOUT_CONCURRENCY + 12 }, (_, i) => i);

    const result = await engine.run(
      async (wf: WorkflowContext) =>
        wf.fanout("capture", items, (item) => probe.enter(async () => {
          await yieldTicks();
          return { item };
        })),
      baseParams,
    );

    expect(result.status).toBe("completed");
    expect(probe.peak).toBe(DEFAULT_FANOUT_CONCURRENCY);
    expect(probe.peak).toBeLessThan(items.length);
  });

  it("returns outcomes in ITEM order even when slots finish out of order", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const items = [0, 1, 2, 3, 4, 5, 6];

    const result = await engine.run(
      async (wf: WorkflowContext) =>
        // Later items resolve sooner, so completion order is the reverse of item order.
        wf.fanout("ordered", items, async (item) => {
          await yieldTicks(items.length - item);
          return item;
        }, { concurrency: 2 }),
      baseParams,
    );

    expect(result.status).toBe("completed");
    const outcomes = result.status === "completed" ? result.output : [];
    expect(outcomes.map((o) => o.slotId)).toEqual(items.map((i) => `ordered__slot_${i}`));
    expect(outcomes.map((o) => (o.status === "completed" ? o.output : null))).toEqual(items);
  });

  it("stops ADMITTING new slots once a slot raises a run-level signal", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const started: number[] = [];
    const items = Array.from({ length: 30 }, (_, i) => i);

    const result = await engine.run(
      async (wf: WorkflowContext) =>
        wf.fanout("gated", items, async (item) => {
          started.push(item);
          await yieldTicks();
          if (item === 0) throw new AwaitingGateSignal("gate_1");
          return item;
        }, { concurrency: 2 }),
      baseParams,
    );

    expect(result.status).toBe("awaiting_gate");
    // Under the old unbounded Promise.all all 30 slot bodies had already been
    // entered before the gate could be seen. With the pool, admission stops.
    expect(started.length).toBeLessThan(items.length);
    expect(started.length).toBeLessThanOrEqual(4);
  });

  it("rejects every concurrency value that would disable the cap — the guard can fail", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    for (const bad of [0, -1, 2.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const result = await engine.run(
        async (wf: WorkflowContext) =>
          wf.fanout("bad", [1, 2], async (i) => i, { concurrency: bad as number }),
        { ...baseParams, runId: `run_bad_${String(bad)}` },
      );
      expect(result.status, `concurrency ${String(bad)} should not be accepted`).toBe("degraded");
      expect(result.status === "degraded" ? result.failureReason : "").toContain("concurrency must be an integer >= 1");
    }
  });

  it("accepts an explicit items.length as the way to say 'all at once'", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const probe = makeInFlightProbe();
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

    const result = await engine.run(
      async (wf: WorkflowContext) =>
        wf.fanout("all", items, (item) => probe.enter(async () => {
          await yieldTicks();
          return item;
        }), { concurrency: items.length }),
      baseParams,
    );

    expect(result.status).toBe("completed");
    expect(probe.peak).toBe(items.length);
  });

  it("handles an empty item list without spawning a worker", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const fn = vi.fn(async () => 1);

    const result = await engine.run(
      async (wf: WorkflowContext) => wf.fanout("empty", [] as number[], fn),
      baseParams,
    );

    expect(result.status).toBe("completed");
    expect(result.status === "completed" ? result.output : null).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

/** A stand-in agent that never settles, and reports what it was handed. */
class NeverSettlingAgent implements Pick<BaseAgent<unknown>, "run"> {
  seenSignal: AbortSignal | undefined;
  abortReason: unknown;

  async run(ctx: AgentContext): Promise<AgentExecutionResult<unknown>> {
    this.seenSignal = stepAbortSignal(ctx);
    this.seenSignal?.addEventListener("abort", () => {
      this.abortReason = this.seenSignal?.reason;
    });
    return new Promise<AgentExecutionResult<unknown>>(() => {
      /* never settles — stands in for a wedged provider call */
    });
  }
}

describe("AU5 / SCRUM-316 — step-timeout abort propagation", () => {
  it("hands the agent an AbortSignal and fires it with WorkflowStepTimeout when the step times out", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const agent = new NeverSettlingAgent();

    const result = await engine.run(
      async (wf: WorkflowContext) => wf.step.agent("wedged", agent as unknown as BaseAgent<unknown>, {}),
      { ...baseParams, agentStepTimeoutMs: 20 },
    );

    // The pre-existing half: the run gives up instead of sitting at "running".
    expect(result.status).toBe("degraded");

    // The half this ticket adds: the agent was actually handed a live signal,
    // and that signal FIRED, carrying the timeout as its reason.
    expect(agent.seenSignal, "step.agent handed the agent no abort signal at all").toBeInstanceOf(AbortSignal);
    expect(agent.seenSignal?.aborted, "the signal exists but never fired — a cancellation that cannot cancel").toBe(true);
    expect(agent.abortReason).toBeInstanceOf(WorkflowStepTimeout);
    expect((agent.abortReason as WorkflowStepTimeout).message).toContain("wedged");
  });

  it("does NOT fire the signal when the agent returns in time", async () => {
    // The inverse of the guard: if the signal fired on every step it would be
    // useless as a cancellation flag.
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    let seen: AbortSignal | undefined;

    const quickAgent = {
      async run(ctx: AgentContext): Promise<AgentExecutionResult<unknown>> {
        seen = stepAbortSignal(ctx);
        return {
          status: "completed",
          output: { body: "done" },
          steps: [],
          totalCostUsd: 0,
          totalTokens: { input: 0, output: 0 },
        } as unknown as AgentExecutionResult<unknown>;
      },
    };

    const result = await engine.run(
      async (wf: WorkflowContext) => wf.step.agent("quick", quickAgent as unknown as BaseAgent<unknown>, {}),
      { ...baseParams, agentStepTimeoutMs: 5_000 },
    );

    expect(result.status).toBe("completed");
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it("exposes the signal under the documented metadata key, so a Layer 3 tool holding ctx can read it too", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    let raw: unknown;

    const peekAgent = {
      async run(ctx: AgentContext): Promise<AgentExecutionResult<unknown>> {
        raw = ctx.metadata[STEP_ABORT_SIGNAL_METADATA_KEY];
        return {
          status: "completed",
          output: {},
          steps: [],
          totalCostUsd: 0,
          totalTokens: { input: 0, output: 0 },
        } as unknown as AgentExecutionResult<unknown>;
      },
    };

    await engine.run(
      async (wf: WorkflowContext) => wf.step.agent("peek", peekAgent as unknown as BaseAgent<unknown>, {}),
      baseParams,
    );

    expect(raw).toBeInstanceOf(AbortSignal);
  });

  it("stepAbortSignal returns undefined outside a step.agent, rather than a signal that can never fire", () => {
    const bare: AgentContext = {
      runId: "run_1",
      clientSlug: "acme",
      productId: "p",
      runKind: "recurring",
      metadata: {},
    };
    expect(stepAbortSignal(bare)).toBeUndefined();
    expect(stepAbortSignal({ ...bare, metadata: { [STEP_ABORT_SIGNAL_METADATA_KEY]: "not-a-signal" } })).toBeUndefined();
  });
});
