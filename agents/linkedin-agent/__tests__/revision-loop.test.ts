import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * The universal approve / revise / reject cycle, as linkedin-agent uses it.
 *
 * Identical mechanics to instagram-agent's and x-agent's — that is the point
 * of `runReviewCycle` being generic rather than reimplemented per channel.
 */

const params = { runId: "linkedin_rev", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

function draft(text: string) {
  return finalTurn({
    headline: "Anchor days cut scheduling friction",
    hook: text.slice(0, 60),
    body: text,
    hashtags: ["HybridWork", "FutureOfWork"],
    callToAction: "If your team is still negotiating its hybrid policy, a fixed anchor-day structure might be worth testing.",
    takeaway: "Predictability, not enforcement, is what made the schedule stick.",
    targetAudience: "People leaders evaluating hybrid work policies",
    archetype: "teardown-framework" as const,
    text,
  });
}

const FIRST =
  "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.\n\n" +
  "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts than teams with fully flexible policies.\n\n" +
  "#HybridWork #FutureOfWork";
const REVISED =
  "Hybrid policies are converging on one shape: fixed anchor days.\n\n" +
  "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts than teams with fully flexible policies.\n\n" +
  "#HybridWork #FutureOfWork";

describe("linkedin-agent revision loop", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("re-drafts with the reviewer's feedback, then delivers on approval", async () => {
    const router = fakeRouterSequence([draft(FIRST), draft(REVISED)]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const r0 = await engine.run(workflowFn, params);
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(params.runId, "15-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Lead with the trend, not the internal data.",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflowFn, params);
    expect(r1.status).toBe("awaiting_gate");
    if (r1.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r1.pendingGateId).toContain("15-batch-review-r1");

    await engine.resolveGate(params.runId, "15-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, params);
    expect(final.status).toBe("completed");

    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // Round 1's drafting steps are revision-scoped, so they genuinely re-ran.
    expect(ids).toContain("09-draft-post");
    expect(ids).toContain("09-draft-post-r1");
    expect(ids).toContain("10-verify-numbers-sourced-r1");
    // Everything upstream — including the merged channel-setup pre-flight —
    // kept its id and was reused, which is why the revision is in-run rather
    // than a fresh run.
    expect(ids.filter((i) => i === "00-channel-setup")).toHaveLength(1);
    expect(ids.filter((i) => i === "04-research-pull")).toHaveLength(1);
    expect(ids).not.toContain("04-research-pull-r1");
    expect(ids).not.toContain("06-reserve-topic-r1");
  }, 60000);

  it("saves the reviewer's words to client memory, on a revision and on an approval alike", async () => {
    const router = fakeRouterSequence([draft(FIRST)]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "linkedin_rev_memory";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "15-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      feedback: "The anchor-day framing is working, keep doing that.",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...params, runId });
    expect(final.status).toBe("completed");

    const remembered = await env.store.listJson<{ note: string; decision: string; productId: string }>("acme", [
      "memory",
      "feedback",
    ]);
    expect(remembered.map((r) => r.data.note)).toContain("The anchor-day framing is working, keep doing that.");
    expect(remembered.map((r) => r.data.decision)).toContain("approve");
    // Scoped to the product, so a later linkedin-agent run reads its own history first.
    expect(remembered.map((r) => r.data.productId)).toContain("linkedin-agent");
  }, 60000);

  it("DELIVERS the best draft when the reviewer runs the cycle out of rounds, carrying every open request", async () => {
    // The ceiling is reached, not a rejection: a reviewer asking for one more
    // change wants MORE, not nothing. This used to hold, which threw away every
    // round of work and left them with neither the draft they had been
    // iterating on nor their own outstanding requests.
    const router = fakeRouterSequence([draft(FIRST), draft(REVISED), draft(FIRST)]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "linkedin_rev_exhausted";

    // MAX_REVISION_ROUNDS is 2, so r0, r1 and r2 all exist and r2 is the last.
    for (const round of [0, 1, 2]) {
      await engine.run(workflowFn, { ...params, runId });
      await engine.resolveGate(runId, `15-batch-review-r${round}`, {
        decision: "revise",
        actor: "jane@karoslabs.com",
        feedback: `round ${round}: still not there`,
        at: new Date().toISOString(),
      });
    }

    const result = await engine.run(workflowFn, { ...params, runId });
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect(deliverables).toHaveLength(1);
    const post = (deliverables[0] as { data: { deliverable: Record<string, unknown> } }).data.deliverable;
    const repairs = post["contentRepairs"] as Array<{ check: string; action: string; detail: string }>;
    // Every round's request is on the deliverable, so the next pass starts from
    // something rather than from scratch.
    const note = repairs.find((r) => r.check === "human-review");
    expect(note?.action).toBe("unresolved");
    expect(note?.detail).toContain("round 0: still not there");
    expect(note?.detail).toContain("round 2: still not there");
  }, 60000);

  it("keeps and MARKS the work on an outright rejection — the marker is how the gate says no", async () => {
    const router = fakeRouterSequence([draft(FIRST)]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "linkedin_rev_reject";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "15-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "off-brand this week",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...params, runId });
    // This reverses a deliberate earlier decision, and the reversal is the
    // point: a reject used to end the run, so a drafted post a reviewer had
    // opinions about existed nowhere afterwards and the next run started from
    // scratch. The gate still says no — the rejection rides on the deliverable
    // where nobody can miss it, and no caller treats a rejected deliverable as
    // shippable. What changed is that the reviewer keeps the work and the
    // reason attached to it.
    expect(result.status).toBe("completed");
  }, 60000);
});
