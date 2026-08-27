import { describe, expect, it, vi } from "vitest";
import type { WorkflowContext } from "../src/index.js";
import { MemoryDurableStepStore, WorkflowEngine, serializeToDynamicAgentRunReport } from "../src/index.js";

const baseParams = { runId: "run_outcome_1", clientSlug: "acme", productId: "linkedin", runKind: "recurring" as const };

/**
 * AU67 (SCRUM-365): the step recorder now speaks the four-outcome contract.
 *
 * Two correct designs produced a wrong result. RFC-01 §6 says a tool reports
 * failure as an OUTCOME — a returned value. `runStepCode` listened for
 * EXCEPTIONS. Nothing translated, so a correctly-reported failure arrived at
 * the recorder as a successful return and was written down as `completed`.
 *
 * Observed live before the fix, prep run
 * `2303f93f-0d11-4805-b0e8-ab661442712f`:
 *
 *   08-render-carousel-attempt-1    completed    $0.000000
 *
 * while `publish.renderCarousel` had reported `tooling_error` and the RUN was
 * `degraded`.
 *
 * THE ACCEPTANCE PROPERTY, and the reason every workflow below is written this
 * way: none of them inspects an outcome. Both real call sites in
 * instagram-agent DO inspect theirs, which is exactly why the defect stayed
 * invisible — a workflow that does not was the case being silently
 * misreported, and it must now report honestly with NO per-workflow code.
 */
const toolOutcome = (status: string, reason?: string) => ({ status, ...(reason !== undefined ? { reason } : {}), result: {} });

describe("AU67: a tool failure inside step.code is recorded as a failure", () => {
  it("REFUSES to record a tooling_error step as completed", async () => {
    const store = new MemoryDurableStepStore();
    const workflowFn = async (wf: WorkflowContext) =>
      wf.step.code("render", async () => toolOutcome("tooling_error", "browserType.launch: Timeout 180000ms exceeded"));

    await new WorkflowEngine(store).run(workflowFn, baseParams);

    const [step] = await store.listSteps(baseParams.runId);
    expect(step!.status, "this was `completed` before SCRUM-365").toBe("tooling_error");
    expect(step!.error, "the tool's own reason must survive, or a report can say THAT a step failed but not why").toMatch(/Timeout 180000ms/);
  });

  it.each([["content_fail"], ["not_available"]])("records %s as itself, not flattened into a generic failure", async (outcome) => {
    const store = new MemoryDurableStepStore();
    const runId = `run_${outcome}`;
    const workflowFn = async (wf: WorkflowContext) => wf.step.code("s", async () => toolOutcome(outcome, "because"));
    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });

    const [step] = await store.listSteps(runId);
    // `not_available` is a DESIGNED state and `content_fail` is a real content
    // judgment a revision loop asks for. Collapsing either into "failed" would
    // be the same conflation this ticket is about, one level up.
    expect(step!.status).toBe(outcome);
  });

  it("still records completed for a body returning something that is not an outcome", async () => {
    // Most step.code bodies are ordinary computation. The translation must not
    // start reading `status` off arbitrary objects.
    const store = new MemoryDurableStepStore();
    const workflowFn = async (wf: WorkflowContext) => wf.step.code("s", async () => ({ topics: ["a"], status: "anything-else" }));
    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "run_plain" });

    expect((await store.listSteps("run_plain"))[0]!.status).toBe("completed");
  });

  it("still records failed when the body THROWS — which is what failed always meant here", async () => {
    const store = new MemoryDurableStepStore();
    const workflowFn = async (wf: WorkflowContext) =>
      wf.step.code("s", async () => {
        throw new Error("boom");
      });
    await new WorkflowEngine(store)
      .run(workflowFn, { ...baseParams, runId: "run_throw" })
      .catch(() => undefined);

    expect((await store.listSteps("run_throw"))[0]!.status).toBe("failed");
  });
});

describe("AU67: resume semantics are unchanged", () => {
  it("does NOT re-run a step whose tool reported a failure", async () => {
    // The enumeration's load-bearing finding. Four sites skip a step on resume
    // and they asked `status === "completed"` — which happened to be the right
    // set only because a tool failure was MISRECORDED as completed. Widening
    // the vocabulary without `isCheckpointedStepStatus` would have made every
    // such step re-run on resume, re-spending money and repeating side effects
    // that had already happened.
    const store = new MemoryDurableStepStore();
    const body = vi.fn(async () => toolOutcome("tooling_error", "transient"));
    const workflowFn = async (wf: WorkflowContext) => wf.step.code("render", body);

    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "run_resume" });
    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "run_resume" });

    expect(body, "the checkpoint must still be honoured").toHaveBeenCalledTimes(1);
  });

  it("DOES re-run a step that threw, exactly as before", async () => {
    const store = new MemoryDurableStepStore();
    let attempts = 0;
    const workflowFn = async (wf: WorkflowContext) =>
      wf.step.code("s", async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return { ok: true };
      });

    await new WorkflowEngine(store)
      .run(workflowFn, { ...baseParams, runId: "run_retry" })
      .catch(() => undefined);
    await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "run_retry" });

    expect(attempts).toBe(2);
  });
});

describe("AU67: the run report tells the truth without per-workflow code", () => {
  const rec = (stepId: string, status: string, error?: string) =>
    ({ stepId, kind: "code", status, output: {}, durationMs: 1, startedAt: 1, completedAt: 2, ...(error ? { error } : {}) }) as never;

  const report = (records: never[], runStatus?: string) =>
    serializeToDynamicAgentRunReport({
      specId: "spec_x",
      specVersion: 1,
      steps: records.map((r: { stepId: string }) => ({ stepId: r.stepId, type: "code" as const, label: r.stepId })),
      stepRecords: records,
      slotRecords: [],
      ...(runStatus
        ? {
            runRecord: {
              runId: "r",
              clientSlug: "acme",
              productId: "linkedin",
              runKind: "recurring",
              status: runStatus,
              createdAt: 1,
              updatedAt: 2,
            } as never,
          }
        : {}),
    });

  it("renders a tooling_error step as failed, carrying its reason", () => {
    const [step] = report([rec("render", "tooling_error", "browserType.launch: Timeout 180000ms exceeded")]).steps;
    expect(step!.status, "this rendered as `done` before SCRUM-365").toBe("failed");
    expect(step!.error).toMatch(/Timeout 180000ms/);
  });

  it("does NOT render content_fail or not_available as failed steps", () => {
    // A revision loop asks for content_fail and retries. Marking every one a
    // failed step would make healthy loops read as broken.
    const steps = report([rec("a", "content_fail", "too long"), rec("b", "not_available", "no key")]).steps;
    expect(steps.map((s) => s.status)).toEqual(["done", "done"]);
  });

  it("does not set failedStepId on a run that COMPLETED", () => {
    // What failedStepId DRIVES, from the enumeration: the portal renders every
    // step after it as "skipped" and shows a partial-output banner
    // (dynamic-agent-step-progress.tsx). A recovered attempt-1 inside a
    // successful run must not mislabel the rest of a healthy run.
    const records = [rec("render-attempt-1", "tooling_error", "transient"), rec("render-attempt-2", "completed")];
    expect(report(records, "completed").failedStepId).toBeUndefined();
    expect(report(records, "degraded").failedStepId, "an unrecovered run must still point at it").toBe("render-attempt-1");
  });
});
