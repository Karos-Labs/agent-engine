import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentExecutionResult, BaseAgent } from "@agent-engine/core";
import type { WorkflowContext } from "../src/index.js";
import { MemoryDurableStepStore, WorkflowEngine, serializeToDynamicAgentRunReport } from "../src/index.js";
import { DraftOutputSchema, fakeRouterAlwaysFinal, fakeRouterAlwaysThrows, makeSimpleAgent } from "./test-helpers.js";

/**
 * AU68 (SCRUM-366): `step.agent` carries the same completed-on-failure shape
 * AU67 fixed in `step.code`.
 *
 * `runStepAgent` hardcoded `status: "completed"` on the `StepRecord` whenever
 * `agent.run()` returned without throwing — and `BaseAgent` reports
 * `content_fail`/`tooling_error`/`budget_exceeded` as a RETURNED
 * `AgentExecutionResult.status`, never as an exception. So the record said
 * `completed` for a step whose agent had failed, exactly as `step.code` did
 * before SCRUM-365.
 *
 * The `AgentExecutionStatus` was not even unavailable to the recorder: it was
 * already being read two lines above, sent to telemetry and set as a span
 * attribute, then thrown away for the record.
 */

const baseParams = { runId: "run_agent_outcome", clientSlug: "acme", productId: "linkedin", runKind: "recurring" as const };

/**
 * A `BaseAgent`-shaped stub whose `run()` RESOLVES with a chosen terminal
 * status. Deliberately not a throw: the whole defect is that a returned
 * failure was invisible to the recorder, so the test has to return one.
 */
function agentResolvingTo(status: AgentExecutionResult<unknown>["status"], turnError?: string): BaseAgent<unknown> {
  return {
    async run(): Promise<AgentExecutionResult<unknown>> {
      return {
        finalOutput: status === "completed" ? { body: "hello" } : null,
        steps: [
          {
            stepIndex: 0,
            modelUsed: "claude-sonnet-4-6",
            inputTokens: { cached: 10, uncached: 20 },
            outputTokens: 5,
            durationMs: 12,
            costUsd: 0.002,
            status: status === "completed" ? "success" : "tooling_error",
            ...(turnError !== undefined ? { error: turnError } : {}),
          },
        ],
        totalCostUsd: 0.002,
        totalTokens: { input: 30, output: 5 },
        status,
      };
    },
  } as unknown as BaseAgent<unknown>;
}

describe("AU68: a returned step.agent failure is recorded as a failure", () => {
  it("REFUSES to record a forced tooling_error agent step as completed", async () => {
    // Forced through the REAL agent path, not a stub: a router that throws on
    // every turn is what a provider outage looks like, and `BaseAgent` turns it
    // into a RETURNED `tooling_error` rather than propagating the throw.
    const store = new MemoryDurableStepStore();
    const brokenAgent = makeSimpleAgent(DraftOutputSchema, fakeRouterAlwaysThrows("529 overloaded_error from the provider"));
    const workflowFn = async (wf: WorkflowContext) => wf.step.agent("10-draft-post", brokenAgent, {});

    await new WorkflowEngine(store).run(workflowFn, baseParams);

    const [step] = await store.listSteps(baseParams.runId);
    expect(step!.kind).toBe("agent");
    expect(step!.status, "this was hardcoded `completed` before SCRUM-366").toBe("tooling_error");
    expect(step!.error, "a report that can say THAT a step failed but not why is half a report").toMatch(/overloaded_error/);
  });

  it.each([
    ["content_fail", "content_fail"],
    ["tooling_error", "tooling_error"],
    ["budget_exceeded", "budget_exceeded"],
    ["completed", "completed"],
  ])("records an agent that resolved to %s as %s — distinguishable, not flattened", async (agentStatus, expected) => {
    const store = new MemoryDurableStepStore();
    const runId = `run_agent_${agentStatus}`;
    const workflowFn = async (wf: WorkflowContext) =>
      wf.step.agent("draft", agentResolvingTo(agentStatus as AgentExecutionResult<unknown>["status"]), {});

    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });

    const [step] = await store.listSteps(runId);
    // `content_fail` is a revision loop doing its job and `budget_exceeded` is a
    // designed ceiling; `tooling_error` is a fault. Collapsing them into one
    // status would be the same conflation this ticket is about, one level up.
    expect(step!.status).toBe(expected);
  });

  it("leaves resume semantics alone — a failed-outcome agent step is NOT re-run", async () => {
    // The widening must not silently start re-running steps that already ran:
    // re-spending money and repeating side effects would be a worse bug than
    // the one being fixed. `isCheckpointedStepStatus` is what holds this.
    const store = new MemoryDurableStepStore();
    const runId = "run_agent_resume";
    let calls = 0;
    const countingAgent = {
      async run() {
        calls++;
        return agentResolvingTo("tooling_error").run({} as never, {});
      },
    } as unknown as BaseAgent<unknown>;

    const workflowFn = async (wf: WorkflowContext) => wf.step.agent("draft", countingAgent, {});
    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });
    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });

    expect(calls, "a checkpointed outcome is replayable — resume must return it, not re-run the agent").toBe(1);
    expect((await store.listSteps(runId))[0]!.status).toBe("tooling_error");
  });
});

describe("AU68: the consumer that already corrects for this shape must not double-correct", () => {
  /**
   * `serializeOneStep` is the in-engine consumer that has been compensating.
   * For an agent record it calls `serializeAgentRecord`, which derives the
   * portal-facing status from `AgentExecutionResult.status` — the SAME fact the
   * record now carries. AU67 also added a `record.status === "tooling_error"`
   * branch AHEAD of it, for `step.code`.
   *
   * Once the producer is honest those two branches collide: the record-status
   * branch wins, and it returns a bare `{status:"failed", error}` with NO model,
   * NO usage, NO cost and NO tokens — silently deleting everything the run
   * report knew about a failed agent step. One failure, reported once, with its
   * evidence intact, is the requirement.
   */
  it("still reports a failed agent step ONCE, with its model/usage/cost intact", async () => {
    const store = new MemoryDurableStepStore();
    const runId = "run_agent_report";
    const workflowFn = async (wf: WorkflowContext) => wf.step.agent("10-draft-post", agentResolvingTo("tooling_error", "529 overloaded_error"), {});
    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });

    const report = serializeToDynamicAgentRunReport({
      specId: "linkedin",
      specVersion: 1,
      steps: [{ stepId: "10-draft-post", type: "ai", label: "Draft post" }],
      stepRecords: await store.listSteps(runId),
      slotRecords: [],
    });

    expect(report.steps).toHaveLength(1);
    const [reported] = report.steps;
    expect(reported!.status, "reported once, as a failure").toBe("failed");
    expect(reported!.error, "the agent's own reason, not the recorder's placeholder").toMatch(/tooling_error/);
    expect(reported!.model, "dropping the model on a failed step is how a failure becomes unattributable").toBe("claude-sonnet-4-6");
    expect(reported!.usage?.numTurns).toBe(1);
    expect(reported!.costUsd).toBeCloseTo(0.002, 6);
    expect(reported!.tokensOut).toBe(5);
    expect(report.failedStepId).toBe("10-draft-post");
  });

  it("does not turn a healthy agent step into a failure", async () => {
    const store = new MemoryDurableStepStore();
    const runId = "run_agent_report_ok";
    const agent = makeSimpleAgent(DraftOutputSchema, fakeRouterAlwaysFinal({ body: "hello world" }));
    const workflowFn = async (wf: WorkflowContext) => wf.step.agent("10-draft-post", agent, {});
    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });

    const report = serializeToDynamicAgentRunReport({
      specId: "linkedin",
      specVersion: 1,
      steps: [{ stepId: "10-draft-post", type: "ai", label: "Draft post" }],
      stepRecords: await store.listSteps(runId),
      slotRecords: [],
    });
    expect(report.steps[0]!.status).toBe("done");
    expect(report.failedStepId).toBeUndefined();
  });
});

describe("AU68: fanout is a producer too — SlotRecord.status widened", () => {
  const toolOutcome = (status: string, reason: string) => ({ status, reason, result: {} });

  it("records a slot whose body returned a tooling_error as tooling_error, not completed", async () => {
    const store = new MemoryDurableStepStore();
    const runId = "run_slot_outcome";
    const workflowFn = async (wf: WorkflowContext) => wf.fanout("slots", [1], async () => toolOutcome("tooling_error", "browser launch timed out"));

    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });

    const slots = await store.listSlots(runId, "slots");
    expect(slots).toHaveLength(1);
    expect(slots[0]!.status, "this was `completed` before SCRUM-366 — the AU67 defect one primitive over").toBe("tooling_error");
    expect(slots[0]!.error).toMatch(/browser launch timed out/);
  });

  it("hands the workflow author the same verdict it wrote down", async () => {
    // Producer/consumer split INSIDE one function is the same defect family:
    // a record saying tooling_error while the returned SlotOutcome says
    // completed would just move the lie rather than remove it.
    const store = new MemoryDurableStepStore();
    const runId = "run_slot_outcome_value";
    let seen: string | undefined;
    const workflowFn = async (wf: WorkflowContext) => {
      const outcomes = await wf.fanout("slots", [1], async () => toolOutcome("not_available", "no renderer configured"));
      seen = outcomes[0]!.status;
      return outcomes;
    };

    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });

    expect(seen).toBe("not_available");
    expect((await store.listSlots(runId, "slots"))[0]!.status).toBe("not_available");
  });

  it("still records an ordinary slot as completed, and a thrown slot as failed", async () => {
    const store = new MemoryDurableStepStore();
    const runId = "run_slot_plain";
    const workflowFn = async (wf: WorkflowContext) =>
      wf.fanout("slots", [1, 2], async (item) => {
        if (item === 2) throw new Error("slot blew up");
        return { deliverableId: "d1" };
      });

    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });

    const slots = (await store.listSlots(runId, "slots")).sort((a, b) => a.slotId.localeCompare(b.slotId));
    expect(slots.map((s) => s.status)).toEqual(["completed", "failed"]);
  });

  it("resumes a failed-outcome slot from its checkpoint rather than re-running it", async () => {
    const store = new MemoryDurableStepStore();
    const runId = "run_slot_resume";
    let calls = 0;
    const workflowFn = async (wf: WorkflowContext) =>
      wf.fanout("slots", [1], async () => {
        calls++;
        return toolOutcome("tooling_error", "browser launch timed out");
      });

    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });
    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });

    expect(calls).toBe(1);
    expect((await store.listSlots(runId, "slots"))[0]!.status).toBe("tooling_error");
  });
});

describe("AU68: step.gate remains structurally incapable of this defect", () => {
  it("records a REJECTED gate as completed — the gate did its job, which was to capture a no", async () => {
    // Acceptance #4, the half that stays as it is. `runStepGate` constructs its
    // own output from a `GateResponse`; there is no `status` field arriving
    // from a tool that could disagree with the one it writes. A rejection is a
    // human decision, surfaced at run level as `held`.
    const store = new MemoryDurableStepStore();
    const runId = "run_gate_reject";
    const engine = new WorkflowEngine(store);
    const workflowFn = async (wf: WorkflowContext) => wf.step.gate("13-review", { kind: "campaign_review", payload: {}, requiredRole: "staff", timeout: { duration: "24h", onTimeout: "escalate" } });

    const first = await engine.run(workflowFn, { ...baseParams, runId });
    expect(first.status).toBe("awaiting_gate");
    await engine.resolveGate(runId, "13-review", { decision: "reject", actor: "tomer@karoslabs.com", at: "2026-08-28T00:00:00Z", reason: "off-brand" });
    await engine.run(workflowFn, { ...baseParams, runId });

    const gateStep = (await store.listSteps(runId)).find((s) => s.kind === "gate");
    expect(gateStep!.status).toBe("completed");
  });
});
