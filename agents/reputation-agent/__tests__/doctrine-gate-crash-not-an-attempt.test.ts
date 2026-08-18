import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createReputationPulseWorkflow } from "../src/workflow/create-reputation-pulse-workflow.js";
import {
  doctrineOutput,
  draftOutput,
  flakyStepRouter,
  makePromptStore,
  makeReview,
  manualExportLeg,
  setupTestEnvironment,
  voicePassOutput,
  writeClientConfig,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "pulse_crash_attempt_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };

const RESPOND_ID = "manual:loc-1:rev-crashy";
const DRAFT_TEXT = "Thank you for the detailed feedback. We would like to look into this and follow up with you directly.";

function makeRespondReview() {
  // fixable_complaint(20) + service_recovery_opportunity(15) + platform google(10) = 45 >= 40 -> RESPOND, draft_attached.
  return makeReview({
    review_id: RESPOND_ID,
    rating: 3,
    text: "The order took a while but the team tried to fix it on the spot.",
    annotations: {
      classifier_model_id: "fixture",
      sentiment: "neg",
      factual_error: false,
      fixable_complaint: true,
      detailed_positive: false,
      service_recovery_opportunity: true,
    },
  });
}

/** The doctrine gate's model verdict always disagrees — a real, observed content failure. */
const ALWAYS_FAILS_DOCTRINE = doctrineOutput({
  no_blame: { verdict: "fail", quote: "you must have misunderstood the policy", rationale: "reads as blaming the reviewer" },
});

async function countDraftCycles(store: MemoryDurableStepStore, runId: string): Promise<number> {
  let cycles = 0;
  for (let c = 1; c <= 12; c++) {
    if ((await store.listSlots(runId, `06-draft-cycle-${c}`)).length === 0) break;
    cycles = c;
  }
  return cycles;
}

/**
 * run-protocol.md §4: "A crash never writes a `RETURN` file, so **a crash
 * cannot consume a gate attempt**." The port used to increment the per-item
 * attempt counter on ANY non-completed turn, so two transient model API
 * failures burned the whole 2-retry budget before the model ever got a real
 * chance — and the third, genuine, content failure then dropped a perfectly
 * draftable review to FLAG on infrastructure grounds.
 */
describe("steps 06-09: an execution/tooling failure never spends a doctrine-gate retry attempt", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [manualExportLeg([makeRespondReview()])] });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("a thrown model call on the doctrine turn buys another cycle without costing an attempt — the item still gets all 3 content tries", async () => {
    // The first doctrine-gate turn throws (a transient router/API failure);
    // every later one completes and returns a genuine `fail` verdict.
    const router = flakyStepRouter([draftOutput(DRAFT_TEXT), voicePassOutput([RESPOND_ID]), ALWAYS_FAILS_DOCTRINE], {
      stepId: "reputation-doctrine-gate",
      failFirstN: 1,
    });
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, store: env.store, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // 4 cycles: 1 crash (free) + 3 real content attempts (the initial try plus
    // the 2-retry cap). Under the old accounting this stopped at 3 cycles,
    // having only ever seen TWO real doctrine verdicts.
    expect(await countDraftCycles(durableStore, params.runId)).toBe(4);

    // The final drop is attributed to the CONTENT failure, not the crash.
    const row = result.output.draftManifest[0]!;
    expect(row.outcome).toBe("dropped");
    expect(row.reason).toMatch(/exceeded 2 retries to steps 06-09/);
    expect(row.reason).toMatch(/doctrine gate failed/);
    expect(row.reason).not.toMatch(/simulated transient model API failure/);
  });

  it("still enforces the cap at exactly 3 content attempts when nothing crashes (the unchanged baseline)", async () => {
    const router = flakyStepRouter([draftOutput(DRAFT_TEXT), voicePassOutput([RESPOND_ID]), ALWAYS_FAILS_DOCTRINE], {
      stepId: "reputation-doctrine-gate",
      failFirstN: 0,
    });
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, store: env.store, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const runId = "pulse_crash_attempt_baseline";
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId });
    if (result.status !== "completed") throw new Error("unreachable");

    expect(await countDraftCycles(durableStore, runId)).toBe(3);
    expect(result.output.draftManifest[0]!.reason).toMatch(/exceeded 2 retries/);
  });

  it("a tooling fault that never clears halts the run as degraded, rather than quietly degrading the item to FLAG", async () => {
    const router = flakyStepRouter([draftOutput(DRAFT_TEXT), voicePassOutput([RESPOND_ID]), doctrineOutput()], {
      stepId: "reputation-doctrine-gate",
      failFirstN: Number.POSITIVE_INFINITY,
    });
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, store: env.store, autoApprove: true });

    const runId = "pulse_crash_attempt_persistent";
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId });

    // `WorkflowToolingFailure` -> `degraded`: an infrastructure fault for a
    // human to fix and resume (run-protocol.md §9's HALT), never recorded as a
    // content verdict about the draft (RFC-01 §6).
    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("unreachable");
    expect(result.failureReason).toMatch(/tooling-retry budget/);
    expect(result.failureReason).toContain(RESPOND_ID);

    // Nothing was persisted and nothing was silently flagged.
    expect(await env.store.listJson(env.clientSlug, ["ledger", "deliverables", runId, "_"])).toHaveLength(0);
    expect(await env.store.listJson(env.clientSlug, ["reputation", "ledger", "responded"])).toHaveLength(0);
  });
});
