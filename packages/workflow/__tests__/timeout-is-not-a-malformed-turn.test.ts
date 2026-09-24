import { describe, expect, it } from "vitest";
import type { ModelRouter } from "@agent-engine/core";
import type { WorkflowContext } from "../src/index.js";
import { MemoryDurableStepStore, WorkflowEngine, describeToolingFailure } from "../src/index.js";
import { DraftOutputSchema, fakeRouterAlwaysThrows, makeSimpleAgent } from "./test-helpers.js";

/**
 * TWO DIFFERENT EVENTS WORE ONE STATUS, AND AGENTS TOLD CLIENTS THE WRONG ONE.
 *
 * `step.agent` hands the workflow `status: "tooling_error"` both when the model
 * answered unreadably and when it never answered at all — an absorbed
 * `WorkflowStepTimeout` is converted into exactly that result (AU72). The
 * status is right in both cases; it is the vocabulary a workflow branches on.
 * What was missing was any way to tell them apart afterwards, so every agent
 * that printed a sentence for `tooling_error` guessed, and they all guessed
 * the same way: "a malformed model turn".
 *
 * IT WAS WRONG ON A REAL RUN. `thepitchbydeel`'s carousel of 2026-09-22 was
 * drafted, rendered, packaged and reviewed; the reviewer sent it back; the
 * revision round's three copy attempts each hit the 600s step timeout — $0
 * spent, zero tokens, thirty minutes of wall clock — and the run held saying
 * the model had produced "a malformed model turn" on all three. A reader
 * would have gone to the copy prompt and the output schema. Nothing was
 * malformed. Nothing arrived.
 *
 * `timedOutAfterMs` is the fact that was being thrown away, and
 * `describeToolingFailure` is the one place the sentence is chosen.
 */

const baseParams = { runId: "run_1", clientSlug: "acme", productId: "instagram", runKind: "recurring" as const };

/** A router whose `complete()` never settles — what a wedged provider call looks like from here. */
function neverSettlingRouter(): ModelRouter {
  return {
    complete: () => new Promise(() => {}),
    completeAlias: () => new Promise(() => {}),
  } as unknown as ModelRouter;
}

describe("a step that ran out of time says so", () => {
  it("marks the absorbed timeout on the result the WORKFLOW reads, not only on the step record", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const wedged = makeSimpleAgent(DraftOutputSchema, neverSettlingRouter());

    const workflowFn = async (wf: WorkflowContext) => {
      const result = await wf.step.agent("write-copy", wedged, {});
      // Exactly what an agent does with it: branch on status, then describe.
      return { status: result.status, sentence: describeToolingFailure(result) };
    };

    const run = await engine.run(workflowFn, { ...baseParams, agentStepTimeoutMs: 25 });
    expect(run.status).toBe("completed");
    if (run.status !== "completed") throw new Error("unreachable");

    // The status is unchanged — every `status !== "completed"` check in the
    // fleet still reads this correctly, which is why the fix is additive.
    expect(run.output.status).toBe("tooling_error");
    // And the sentence is now the true one.
    expect(run.output.sentence).toBe("ran out of time after 0s without answering");
    expect(run.output.sentence).not.toContain("malformed");
  });

  it("still calls a genuinely unreadable turn a malformed turn", async () => {
    // THE OTHER HALF, and the reason this is not a blanket rewording: a
    // provider that answers with something unparseable IS a malformed turn,
    // and a change that renamed every `tooling_error` a timeout would be the
    // same defect pointing the other way.
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const broken = makeSimpleAgent(DraftOutputSchema, fakeRouterAlwaysThrows());

    const workflowFn = async (wf: WorkflowContext) => {
      const result = await wf.step.agent("write-copy", broken, {});
      return { status: result.status, timedOut: result.timedOutAfterMs, sentence: describeToolingFailure(result) };
    };

    const run = await engine.run(workflowFn, { ...baseParams, runId: "run_2" });
    expect(run.status).toBe("completed");
    if (run.status !== "completed") throw new Error("unreachable");
    expect(run.output.status).toBe("tooling_error");
    expect(run.output.timedOut).toBeUndefined();
    expect(run.output.sentence).toContain("a malformed model turn");
  });

  it("reports the real wait, so 'ran out of time' is a measurement rather than a label", async () => {
    // A sentence that said "ran out of time" with no number would be true and
    // useless: ten minutes and ten seconds are different problems, and the
    // first is the one that cost that run half an hour.
    expect(describeToolingFailure({ timedOutAfterMs: 600_000 })).toBe("ran out of time after 600s without answering");
    expect(describeToolingFailure({ timedOutAfterMs: 30_000 })).toBe("ran out of time after 30s without answering");
  });
});
