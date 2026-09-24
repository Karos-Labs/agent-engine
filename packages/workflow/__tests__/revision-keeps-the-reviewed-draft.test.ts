import { describe, expect, it } from "vitest";
import type { WorkflowContext } from "../src/index.js";
import { MemoryDurableStepStore, WorkflowEngine, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runReviewCycle } from "../src/index.js";

/**
 * A REVIEWER'S FEEDBACK MUST NOT DESTROY THE THING THEY REVIEWED.
 *
 * `runReviewCycle` let an exception from `attempt` propagate on every round.
 * On round 0 that is right: nothing exists yet, and the caller's own
 * `WorkflowHeld` message says why. On a LATER round it is not. By then a draft
 * has been produced, rendered, packaged and shown to a person, who read it and
 * asked for a change — and if the revision then fails, the run ends with
 * nothing. The reviewer is left with a held run where their carousel used to
 * be, and the only way back is a fresh run that pays for all of it again.
 *
 * It is not hypothetical. `thepitchbydeel`, prep, 2026-09-22: a carousel
 * cleared its gate at 19:04, the reviewer sent it back at 19:52, and the
 * revision round's three copy attempts each hit the 600s step timeout — $0
 * spent, zero tokens, thirty minutes of wall clock. The run held. The
 * carousel was gone.
 *
 * This is the same ruling four other holds were closed under this week
 * (PR #231, #256): a refusal at the end of a run refuses the NEXT step, never
 * the work already done. It lives in the primitive rather than in one agent
 * because every agent sharing this cycle has the same gap.
 */

const params = { runId: "run_rc", clientSlug: "acme", productId: "instagram", runKind: "recurring" as const };

interface Draft {
  text: string;
  round: number;
}

/** A cycle whose round 0 drafts, and whose every later round throws `thrown`. */
function cycleFailingAfterFirstRound(thrown: () => Error, gateId = "09a-batch-review") {
  return async (wf: WorkflowContext) => {
    const review = await runReviewCycle<Draft>(wf, {
      gateId,
      maxRevisions: 2,
      attempt: async (revision) => {
        if (revision > 0) throw thrown();
        return { text: "the carousel the reviewer read", round: revision };
      },
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: { preview: draft.text, revision },
        requiredRole: "account_manager",
        timeout: { duration: "1h", onTimeout: "hold" },
      }),
    });
    return { outcome: review.outcome, detail: review.outcomeDetail, text: review.output.text, revision: review.revision };
  };
}

async function reviseThenRun(workflowFn: (wf: WorkflowContext) => Promise<unknown>, runId: string) {
  const store = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(store);
  const first = await engine.run(workflowFn, { ...params, runId });
  expect(first.status).toBe("awaiting_gate");
  await engine.resolveGate(runId, `${runId}__09a-batch-review-r0`, {
    decision: "revise",
    actor: "reviewer@acme.test",
    at: new Date().toISOString(),
    feedback: "make slide 3 land harder",
  });
  return engine.run(workflowFn, { ...params, runId });
}

describe("a revision that cannot be produced delivers the draft the reviewer saw", () => {
  it("returns the round-0 draft, marked, instead of ending the run with nothing", async () => {
    const result = await reviseThenRun(cycleFailingAfterFirstRound(() => new WorkflowHeld("no drafting attempt produced copy that cleared its own schema")), "run_rc_held");

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const out = result.output as { outcome?: string; detail?: string; text: string; revision: number };

    // The work survives, and it is the exact draft that went through the gate.
    expect(out.text).toBe("the carousel the reviewer read");
    expect(out.revision).toBe(0);

    // MARKED, never passed off as approved. Every agent already branches on
    // `outcome !== "approved"` to annotate the deliverable, so a caller gets
    // this right without knowing the new value exists.
    expect(out.outcome).toBe("revision_undeliverable");
    expect(out.detail).toContain("could not be produced");
    // The caller's own sentence, verbatim — it is the only thing that says why.
    expect(out.detail).toContain("no drafting attempt produced copy that cleared its own schema");
    expect(out.detail).toContain("unrevised");
  });

  it("still ends the run when round 0 itself holds — nothing exists to stand in", async () => {
    // THE BOUNDARY. A first round that cannot draft is the honest hold this
    // whole mechanism must not swallow: there is no earlier draft, nobody has
    // reviewed anything, and a run that quietly "delivered" here would be
    // delivering a draft that does not exist.
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const workflowFn = async (wf: WorkflowContext) =>
      runReviewCycle<Draft>(wf, {
        gateId: "09a-batch-review",
        maxRevisions: 2,
        attempt: async () => {
          throw new WorkflowHeld("no subject available for this run");
        },
        buildGate: () => ({ kind: "batch_review", payload: {}, requiredRole: "account_manager", timeout: { duration: "1h", onTimeout: "hold" } }),
      });

    const result = await engine.run(workflowFn, { ...params, runId: "run_rc_round0" });
    expect(result.status).toBe("held");
    expect(result.status === "held" ? result.reason : "").toContain("no subject available");
  });

  it("does not swallow a tooling failure or a blocked intake, however late they fire", async () => {
    // `WorkflowHeld` means "this attempt has no deliverable", which is exactly
    // the case an earlier draft should cover. A malfunction is not, and a run
    // that should never have started is not. Shipping a stale draft over
    // either would hide a fault behind a delivery.
    const wedged = await reviseThenRun(cycleFailingAfterFirstRound(() => new WorkflowToolingFailure("the renderer never came back")), "run_rc_tooling");
    // `degraded` is what the engine calls a run a tooling failure ended -- the
    // point is that it did NOT complete carrying a stale draft.
    expect(wedged.status).toBe("degraded");

    const blocked = await reviseThenRun(cycleFailingAfterFirstRound(() => new WorkflowBlockedIntake("client config is not available yet")), "run_rc_blocked");
    expect(blocked.status).toBe("blocked_intake");
  });
});
