import { describe, expect, it, vi } from "vitest";
import type { ModelRouter } from "@agent-engine/core";
import type { WorkflowContext } from "../src/index.js";
import {
  GateAlreadyResolvedError,
  MemoryDurableStepStore,
  WorkflowBlockedIntake,
  WorkflowConcurrentRunError,
  WorkflowContentFailure,
  WorkflowEngine,
  WorkflowHeld,
  WorkflowToolingFailure,
} from "../src/index.js";
import { DraftOutputSchema, fakeRouterAlwaysFinal, fakeRouterAlwaysThrows, makeSimpleAgent } from "./test-helpers.js";

const baseParams = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring" as const,
};

describe("1. multi-step workflow: step.code -> step.agent -> step.code", () => {
  it("executes in order and returns the final output as completed", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const loadIntake = vi.fn(async () => ({ topic: "remote work" }));
    const agent = makeSimpleAgent(DraftOutputSchema, fakeRouterAlwaysFinal({ body: "hello world" }));
    const finalize = vi.fn((draft: { body: string }) => ({ ...draft, published: true }));

    const workflowFn = async (wf: WorkflowContext) => {
      const intake = await wf.step.code("load-intake", loadIntake);
      const draftResult = await wf.step.agent("draft", agent, intake);
      return wf.step.code("finalize", () => finalize(draftResult.finalOutput!));
    };

    const result = await engine.run(workflowFn, baseParams);

    expect(result.status).toBe("completed");
    expect(result.status === "completed" ? result.output : null).toEqual({ body: "hello world", published: true });
    expect(loadIntake).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});

describe("2. resume from an interrupted workflow", () => {
  it("does not re-execute step 1 when resuming after step 2 never ran", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const fn1 = vi.fn(async () => ({ topic: "x" }));
    const fn2 = vi.fn(async () => ({ body: "drafted" }));
    const fn3 = vi.fn(async (draft: { body: string }) => ({ ...draft, done: true }));

    const crashAfterStep1 = async (wf: WorkflowContext) => {
      await wf.step.code("step1", fn1);
      throw new Error("simulated crash before step2");
    };
    const first = await engine.run(crashAfterStep1, baseParams);
    expect(first.status).toBe("degraded");
    expect(fn1).toHaveBeenCalledTimes(1);

    const fullWorkflow = async (wf: WorkflowContext) => {
      await wf.step.code("step1", fn1);
      const draft = await wf.step.code("step2", fn2);
      return wf.step.code("step3", () => fn3(draft));
    };
    const second = await engine.run(fullWorkflow, baseParams);

    expect(second.status).toBe("completed");
    expect(second.status === "completed" ? second.output : null).toEqual({ body: "drafted", done: true });
    expect(fn1).toHaveBeenCalledTimes(1); // NOT re-executed
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(fn3).toHaveBeenCalledTimes(1);
  });
});

describe("3. fan-out across multiple slots", () => {
  it("runs one checkpointed slot per item and does not re-execute completed slots on resume", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const platforms = ["linkedin", "twitter", "instagram"];
    const draftSlot = vi.fn(async (platform: string) => ({ platform, body: `draft for ${platform}` }));

    const workflowFn = async (wf: WorkflowContext) => wf.fanout("drafts", platforms, (platform) => draftSlot(platform));

    const first = await engine.run(workflowFn, baseParams);
    expect(first.status).toBe("completed");
    expect(first.status === "completed" ? first.output : []).toHaveLength(3);
    expect(draftSlot).toHaveBeenCalledTimes(3);

    const slotRecords = await store.listSlots("run_1", "drafts");
    expect(slotRecords).toHaveLength(3);
    expect(slotRecords.every((s) => s.status === "completed")).toBe(true);

    const second = await engine.run(workflowFn, baseParams);
    expect(second.status).toBe("completed");
    expect(draftSlot).toHaveBeenCalledTimes(3); // still 3 — no slot re-executed on resume
  });

  it("isolates a single slot's failure from its siblings", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const items = ["a", "b", "c"];

    const workflowFn = async (wf: WorkflowContext) =>
      wf.fanout("drafts", items, async (item) => {
        if (item === "b") throw new Error("draft b failed");
        return { item };
      });

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("completed"); // one slot failing doesn't fail the run itself
    const outcomes = result.status === "completed" ? result.output : [];
    expect(outcomes.find((o) => o.slotId === "drafts__slot_0")).toMatchObject({ status: "completed" });
    expect(outcomes.find((o) => o.slotId === "drafts__slot_1")).toMatchObject({ status: "failed", reason: expect.stringContaining("draft b failed") });
    expect(outcomes.find((o) => o.slotId === "drafts__slot_2")).toMatchObject({ status: "completed" });
  });

  it("keeps sibling slots' step.code/step.agent checkpoints isolated even when they share the same local id", async () => {
    // Regression: step.code/step.agent must namespace their checkpoint key by
    // slotId — otherwise two slots both calling step.code("prep", ...) would
    // collide on one shared checkpoint (RFC-01 §5.5's per-slot isolation).
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const prep = vi.fn(async (platform: string) => ({ prepped: platform }));

    const workflowFn = async (wf: WorkflowContext) =>
      wf.fanout("drafts", ["linkedin", "twitter"], async (platform, slotCtx) => {
        return slotCtx.step.code("prep", () => prep(platform));
      });

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("completed");
    expect(prep).toHaveBeenCalledTimes(2); // one real call per slot, not a shared, collided checkpoint
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.map((o) => (o.status === "completed" ? o.output : null))).toEqual([{ prepped: "linkedin" }, { prepped: "twitter" }]);

    const stepRecords = await store.listSteps("run_1");
    const prepStepIds = stepRecords.map((s) => s.stepId).filter((id) => id.endsWith("::prep"));
    expect(prepStepIds.sort()).toEqual(["drafts__slot_0::prep", "drafts__slot_1::prep"]);

    // Resume: neither slot's "prep" should re-execute.
    await engine.run(workflowFn, baseParams);
    expect(prep).toHaveBeenCalledTimes(2);
  });
});

describe("4. gates pause the run and resume completes it", () => {
  it("returns awaiting_gate when a gate has no response yet, then completes once resolved", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const afterGate = vi.fn((approved: boolean) => ({ approved }));

    const workflowFn = async (wf: WorkflowContext) => {
      await wf.step.code("prep", () => "ok");
      const response = await wf.step.gate("batch-review", {
        kind: "batch_review",
        payload: { batchId: "b1" },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "escalate" },
      });
      return afterGate(response.decision === "approve");
    };

    const paused = await engine.run(workflowFn, baseParams);
    expect(paused.status).toBe("awaiting_gate");
    expect(paused.status === "awaiting_gate" ? paused.pendingGateId : null).toBe("run_1__batch-review");
    expect(afterGate).not.toHaveBeenCalled();

    const stillPending = await store.getGate("run_1__batch-review");
    expect(stillPending?.response).toBeUndefined();

    await engine.resolveGate("run_1", "batch-review", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: "2026-08-15T00:00:00Z",
    });

    const resumed = await engine.run(workflowFn, baseParams);
    expect(resumed.status).toBe("completed");
    expect(resumed.status === "completed" ? resumed.output : null).toEqual({ approved: true });
    expect(afterGate).toHaveBeenCalledTimes(1);
  });

  it("propagates a gate encountered inside a fan-out slot to the whole run, not just that slot", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (wf: WorkflowContext) =>
      wf.fanout("drafts", ["a", "b"], async (item, slotCtx) => {
        if (item === "b") {
          await slotCtx.step.gate("needs-approval", {
            kind: "publish_approve",
            payload: { item },
            requiredRole: "account_manager",
            timeout: { duration: "24h", onTimeout: "hold" },
          });
        }
        return { item };
      });

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("awaiting_gate");
  });
});

describe("5. step-level telemetry aggregates cleanly to the run summary", () => {
  it("sums every step.agent call's cost into the run's totalCostUsd", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const agent1 = makeSimpleAgent(DraftOutputSchema, fakeRouterAlwaysFinal({ body: "a" }, { inputTokens: 100, outputTokens: 50 }));
    const agent2 = makeSimpleAgent(DraftOutputSchema, fakeRouterAlwaysFinal({ body: "b" }, { inputTokens: 200, outputTokens: 80 }));

    const workflowFn = async (wf: WorkflowContext) => {
      const r1 = await wf.step.agent("draft1", agent1, {});
      const r2 = await wf.step.agent("draft2", agent2, {});
      return { r1, r2 };
    };

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    const expectedTotal = result.output.r1.totalCostUsd + result.output.r2.totalCostUsd;
    expect(expectedTotal).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeCloseTo(expectedTotal, 6);

    const runRecord = await store.getRun("run_1");
    expect(runRecord?.totalCostUsd).toBeCloseTo(expectedTotal, 6);

    const stepRecords = await store.listSteps("run_1");
    const stepCostSum = stepRecords.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    expect(stepCostSum).toBeCloseTo(expectedTotal, 6);
  });
});

/** Waits a few microtask ticks — enough for `markStepRunning`'s own (real-I/O-free, `MemoryDurableStepStore`-backed) await chain to land, without waiting for `releaseSlowWork` to have been called. */
async function letInFlightWritesLand(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("6. real-time in-progress checkpoints", () => {
  it("checkpoints a step.code call as 'running' before its own function resolves, and points the run's currentStepId at it", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    let releaseSlowWork!: () => void;
    const slowWork = new Promise<void>((resolve) => {
      releaseSlowWork = resolve;
    });

    const workflowFn = async (wf: WorkflowContext) =>
      wf.step.code("slow-step", async () => {
        await slowWork;
        return "done";
      });

    const runPromise = engine.run(workflowFn, baseParams);
    await letInFlightWritesLand();

    const stepWhileRunning = await store.getStep("run_1", "slow-step");
    expect(stepWhileRunning?.status).toBe("running");
    expect(stepWhileRunning?.completedAt).toBeUndefined();

    const runWhileRunning = await store.getRun("run_1");
    expect(runWhileRunning?.currentStepId).toBe("slow-step");

    releaseSlowWork();
    const result = await runPromise;
    expect(result.status).toBe("completed");

    const stepAfterCompletion = await store.getStep("run_1", "slow-step");
    expect(stepAfterCompletion?.status).toBe("completed");
    expect(stepAfterCompletion?.completedAt).toBeDefined();
  });

  it("checkpoints a step.agent call as 'running' before the model call resolves", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    let resolveModelCall!: () => void;
    const modelCallGate = new Promise<void>((resolve) => {
      resolveModelCall = resolve;
    });
    const slowRouter: ModelRouter = {
      complete: vi.fn(async () => {
        await modelCallGate;
        return { output: { type: "final", output: { body: "x" } }, modelUsed: "claude-sonnet-4-6", inputTokens: { cached: 0, uncached: 10 }, outputTokens: 5 };
      }),
      completeAlias: vi.fn(async () => {
        throw new Error("not used in this test");
      }),
    } as unknown as ModelRouter;
    const slowAgent = makeSimpleAgent(DraftOutputSchema, slowRouter);

    const workflowFn = async (wf: WorkflowContext) => wf.step.agent("slow-draft", slowAgent, {});

    const runPromise = engine.run(workflowFn, baseParams);
    await letInFlightWritesLand();

    const stepWhileRunning = await store.getStep("run_1", "slow-draft");
    expect(stepWhileRunning?.status).toBe("running");

    resolveModelCall();
    const result = await runPromise;
    expect(result.status).toBe("completed");

    const stepAfterCompletion = await store.getStep("run_1", "slow-draft");
    expect(stepAfterCompletion?.status).toBe("completed");
  });
});

describe("run-level outcome classification (RFC-01 §6)", () => {
  it("resolves to 'failed' when the run's own budget ceiling is exceeded before a step runs", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const expensiveAgent = makeSimpleAgent(
      DraftOutputSchema,
      fakeRouterAlwaysFinal({ body: "x" }, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );

    const workflowFn = async (wf: WorkflowContext) => {
      await wf.step.agent("draft1", expensiveAgent, {});
      await wf.step.agent("draft2", expensiveAgent, {});
      return "done";
    };

    const result = await engine.run(workflowFn, { ...baseParams, budget: { maxTotalCostUsd: 0.001 } });
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.failureReason : "").toMatch(/budget ceiling exceeded/);
  });

  it("resolves to 'failed' when workflow code explicitly throws WorkflowContentFailure off a content_fail result", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    // The mock's "final" output ({body: 123}) fails DraftOutputSchema's {body: string} — BaseAgent returns content_fail.
    const badAgent = makeSimpleAgent(DraftOutputSchema, fakeRouterAlwaysFinal({ body: 123 }));

    const workflowFn = async (wf: WorkflowContext) => {
      const result = await wf.step.agent("draft", badAgent, {});
      if (result.status === "content_fail") {
        throw new WorkflowContentFailure("draft step failed content review");
      }
      return result.finalOutput;
    };

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.failureReason : "").toMatch(/content review/);
  });

  it("resolves to 'degraded' when workflow code explicitly throws WorkflowToolingFailure off a tooling_error result", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const brokenAgent = makeSimpleAgent(DraftOutputSchema, fakeRouterAlwaysThrows("network down"));

    const workflowFn = async (wf: WorkflowContext) => {
      const result = await wf.step.agent("draft", brokenAgent, {});
      if (result.status === "tooling_error") {
        throw new WorkflowToolingFailure("draft step could not be verified");
      }
      return result.finalOutput;
    };

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("degraded");
    expect(result.status === "degraded" ? result.failureReason : "").toMatch(/could not be verified/);
  });

  it("resolves to 'degraded' for any other uncaught error (never conflated with a content judgment)", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (wf: WorkflowContext) => {
      return wf.step.code("boom", () => {
        throw new Error("unexpected bug");
      });
    };

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("degraded");
    expect(result.status === "degraded" ? result.failureReason : "").toMatch(/unexpected bug/);
  });
});

describe("domain outcomes: held and blocked_intake (RFC-01 §16.2 / RFC-02 §3)", () => {
  it("resolves to 'held' — a legitimate empty result, never conflated with 'failed'", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (wf: WorkflowContext) => {
      await wf.step.code("draft-attempt", () => "no draft cleared brand review");
      throw new WorkflowHeld("no draft cleared brand review after 1 revision");
    };

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("held");
    expect(result.status === "held" ? result.reason : "").toBe("no draft cleared brand review after 1 revision");
    expect(result.status === "held" ? result.output : "not null").toBeNull();

    const runRecord = await store.getRun("run_1");
    expect(runRecord?.status).toBe("held");
    expect(runRecord?.reason).toBe("no draft cleared brand review after 1 revision");
    // Never recorded under the "failure" field — held is not a failure (RFC-01 §16.2).
    // Explicitly null, not merely absent: every transition writes a complete snapshot of
    // the three optional fields so a later transition can't inherit a stale one (see
    // WorkflowEngine.run()'s terminalRunFields).
    expect(runRecord?.failureReason).toBeNull();
  });

  it("resolves to 'blocked_intake' — a client-side gap, never conflated with 'failed'/'degraded'", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (_wf: WorkflowContext) => {
      throw new WorkflowBlockedIntake("client has not supplied a company handle yet");
    };

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("blocked_intake");
    expect(result.status === "blocked_intake" ? result.reason : "").toBe("client has not supplied a company handle yet");

    const runRecord = await store.getRun("run_1");
    expect(runRecord?.status).toBe("blocked_intake");
  });

  it("propagates WorkflowHeld thrown inside a fan-out slot to the whole run, not just that slot", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (wf: WorkflowContext) =>
      wf.fanout("drafts", ["a", "b"], async (item) => {
        if (item === "b") throw new WorkflowHeld("nothing cleared review for this slot's batch");
        return { item };
      });

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("held");
  });

  it("re-evaluates the intake guard on the next call — the check itself is a plain condition, never checkpointed", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    let intakeReady = false;

    // The guard is deliberately plain code, not step.code — intake readiness must
    // reflect the CURRENT state on every call, never a stale checkpointed value.
    const workflowFn = async (wf: WorkflowContext) => {
      if (!intakeReady) {
        throw new WorkflowBlockedIntake("company handle missing");
      }
      return wf.step.code("proceed", () => "proceeded");
    };

    const first = await engine.run(workflowFn, baseParams);
    expect(first.status).toBe("blocked_intake");

    intakeReady = true;
    const second = await engine.run(workflowFn, baseParams);
    expect(second.status).toBe("completed");
    expect(second.status === "completed" ? second.output : null).toBe("proceeded");
  });
});

describe("network/logging hygiene: err.cause preservation (RFC-01 §16.4)", () => {
  it("preserves err.cause in a 'degraded' outcome from a plain uncaught error inside step.code", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (wf: WorkflowContext) =>
      wf.step.code("fetch-remote", () => {
        const networkError = new Error("ECONNRESET");
        throw new Error("fetch failed", { cause: networkError });
      });

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("degraded");
    expect(result.status === "degraded" ? result.failureReason : "").toBe("fetch failed (cause: ECONNRESET)");
  });

  it("preserves err.cause when workflow code explicitly throws WorkflowToolingFailure with one attached", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (_wf: WorkflowContext) => {
      const rootCause = new Error("socket hang up");
      throw new WorkflowToolingFailure("draft step could not be verified", { cause: rootCause });
    };

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("degraded");
    expect(result.status === "degraded" ? result.failureReason : "").toBe("draft step could not be verified (cause: socket hang up)");
  });

  it("preserves err.cause when a fan-out slot's plain error is recorded as that slot's failure", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (wf: WorkflowContext) =>
      wf.fanout("drafts", ["a"], async () => {
        throw new Error("draft failed", { cause: new Error("upstream 503") });
      });

    const result = await engine.run(workflowFn, baseParams);
    expect(result.status).toBe("completed");
    const outcomes = result.status === "completed" ? result.output : [];
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "draft failed (cause: upstream 503)" });
  });
});

describe("optimistic concurrency (a reliability audit finding)", () => {
  it("rejects a second run() call while the first is genuinely mid-flight (status still 'running')", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    // Get a run into "running" and leave it there, standing in for a still-in-flight
    // execution (or one that crashed without ever reaching a terminal status).
    await store.createRunIfNotExists({
      runId: "run_1",
      clientSlug: "acme",
      productId: "linkedin",
      runKind: "recurring",
      status: "running",
      createdAt: 0,
      updatedAt: 0,
    });

    const workflowFn = async (wf: WorkflowContext) => wf.step.code("noop", () => "done");
    await expect(engine.run(workflowFn, baseParams)).rejects.toThrow(WorkflowConcurrentRunError);
  });

  it("lets a second call proceed once the first genuinely finishes (claimed sequentially, not blocked forever)", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (wf: WorkflowContext) => {
      const response = await wf.step.gate("review", {
        kind: "batch_review",
        payload: {},
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "escalate" },
      });
      return response.decision;
    };

    const paused = await engine.run(workflowFn, baseParams);
    expect(paused.status).toBe("awaiting_gate");

    await engine.resolveGate("run_1", "review", { decision: "approve", actor: "jane@karoslabs.com", at: "2026-08-15T00:00:00Z" });

    // Two "resumes" back to back — the first claims and completes; a genuinely concurrent
    // second one arriving after the first already finished must succeed too (completed is
    // claimable — see RESUMABLE_FROM_STATUSES), never treated as a lost race.
    const first = await engine.run(workflowFn, baseParams);
    expect(first.status).toBe("completed");
    const second = await engine.run(workflowFn, baseParams);
    expect(second.status).toBe("completed");
  });

  it("preserves the originally-set budget ceiling across a resume that supplies no budget of its own", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const expensiveAgent = makeSimpleAgent(
      DraftOutputSchema,
      fakeRouterAlwaysFinal({ body: "x" }, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );

    const workflowFn = async (wf: WorkflowContext) => {
      const response = await wf.step.gate("review", {
        kind: "batch_review",
        payload: {},
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "escalate" },
      });
      // Two expensive calls AFTER the gate — if the budget ceiling set at start doesn't
      // carry over into the resumed call, these silently exceed it uncounted.
      await wf.step.agent("draft1", expensiveAgent, {});
      await wf.step.agent("draft2", expensiveAgent, {});
      return response.decision;
    };

    const paused = await engine.run(workflowFn, { ...baseParams, budget: { maxTotalCostUsd: 0.001 } });
    expect(paused.status).toBe("awaiting_gate");

    await engine.resolveGate("run_1", "review", { decision: "approve", actor: "jane@karoslabs.com", at: "2026-08-15T00:00:00Z" });

    // Deliberately omits `budget` here — params.budget ?? existingRun?.budget must recover it.
    const resumed = await engine.run(workflowFn, baseParams);
    expect(resumed.status).toBe("failed");
    expect(resumed.status === "failed" ? resumed.failureReason : "").toMatch(/budget ceiling exceeded/);
  });
});

describe("gate lifecycle: id symmetry and overwrite protection (a gate-lifecycle audit finding)", () => {
  it("resolveGate accepts the fully qualified gate id, not just the workflow-local one", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const afterGate = vi.fn((approved: boolean) => ({ approved }));

    const workflowFn = async (wf: WorkflowContext) => {
      const response = await wf.step.gate("batch-review", {
        kind: "batch_review",
        payload: {},
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "escalate" },
      });
      return afterGate(response.decision === "approve");
    };

    const paused = await engine.run(workflowFn, baseParams);
    expect(paused.status === "awaiting_gate" ? paused.pendingGateId : null).toBe("run_1__batch-review");

    // Round-trips the exact qualified id the engine itself handed back — this used to
    // double-qualify to "run_1__run_1__batch-review" and 404.
    await engine.resolveGate("run_1", "run_1__batch-review", { decision: "approve", actor: "jane@karoslabs.com", at: "2026-08-15T00:00:00Z" });

    const resumed = await engine.run(workflowFn, baseParams);
    expect(resumed.status).toBe("completed");
  });

  it("rejects resolving an already-resolved gate rather than overwriting the audit trail", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (wf: WorkflowContext) =>
      wf.step.gate("batch-review", {
        kind: "batch_review",
        payload: {},
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "escalate" },
      });

    await engine.run(workflowFn, baseParams);
    await engine.resolveGate("run_1", "batch-review", { decision: "approve", actor: "jane@karoslabs.com", at: "2026-08-15T00:00:00Z" });

    await expect(
      engine.resolveGate("run_1", "batch-review", { decision: "reject", actor: "mallory@example.com", at: "2026-08-15T01:00:00Z" }),
    ).rejects.toThrow(GateAlreadyResolvedError);

    // The original, legitimate decision must survive untouched.
    const gate = await store.getGate("run_1__batch-review");
    expect(gate?.response?.decision).toBe("approve");
    expect(gate?.response?.actor).toBe("jane@karoslabs.com");
  });
});

describe("terminal-transition field hygiene (a reliability audit finding)", () => {
  it("clears a stale failureReason once a previously-failed run is retried to completion", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    let shouldFail = true;

    const workflowFn = async (wf: WorkflowContext) => {
      if (shouldFail) {
        throw new WorkflowContentFailure("first attempt failed content review");
      }
      return wf.step.code("proceed", () => "ok");
    };

    const first = await engine.run(workflowFn, baseParams);
    expect(first.status).toBe("failed");
    expect((await store.getRun("run_1"))?.failureReason).toBe("first attempt failed content review");

    shouldFail = false;
    const second = await engine.run(workflowFn, baseParams);
    expect(second.status).toBe("completed");

    const runRecord = await store.getRun("run_1");
    expect(runRecord?.status).toBe("completed");
    // The old failure must not survive into the now-completed record.
    expect(runRecord?.failureReason).toBeNull();
  });

  it("clears a stale pendingGateId once a resumed run completes", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    const workflowFn = async (wf: WorkflowContext) =>
      wf.step.gate("batch-review", {
        kind: "batch_review",
        payload: {},
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "escalate" },
      });

    await engine.run(workflowFn, baseParams);
    expect((await store.getRun("run_1"))?.pendingGateId).toBe("run_1__batch-review");

    await engine.resolveGate("run_1", "batch-review", { decision: "approve", actor: "jane@karoslabs.com", at: "2026-08-15T00:00:00Z" });
    await engine.run(workflowFn, baseParams);

    const runRecord = await store.getRun("run_1");
    expect(runRecord?.status).toBe("completed");
    expect(runRecord?.pendingGateId).toBeNull();
  });
});
