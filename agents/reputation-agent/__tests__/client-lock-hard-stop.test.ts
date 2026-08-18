import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createReputationPulseWorkflow } from "../src/workflow/create-reputation-pulse-workflow.js";
import {
  draftOutput,
  makePromptStore,
  makeReview,
  manualExportLeg,
  setupTestEnvironment,
  smartFakeRouter,
  writeClientConfig,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "pulse_client_lock_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };

const RESPOND_ID = "manual:loc-1:rev-lock";
// Deliberately contains the client's configured never-say phrase.
const LOCKED_DRAFT_TEXT = "We cannot help with that today, but we appreciate you taking the time to share this.";

function makeRespondReview() {
  // fixable_complaint(20) + service_recovery_opportunity(15) + platform google(10) = 45 >= 40 -> RESPOND, draft_attached.
  return makeReview({
    review_id: RESPOND_ID,
    rating: 3,
    text: "Had to ask twice before someone helped, but they did eventually sort it out.",
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

describe("step 07: the client-lock gate is a hard stop, never edit-and-continue (RFC-08 task spec)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    await writeClientConfig(env.store, env.clientSlug, {
      reputationRoster: [manualExportLeg([makeRespondReview()])],
      reputationLocks: { neverSay: ["we cannot help"], requiredFramingAnyOf: [] },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("drops a locked draft to FLAG on its very first attempt, without ever calling the voice or doctrine-gate agents", async () => {
    const promptStore = makePromptStore();
    // Only a draft-output candidate is registered — if the workflow (incorrectly)
    // tried to call the voice or doctrine-gate agent after a lock violation, the
    // router would throw "no candidate matches" and this test would fail loudly.
    const router = smartFakeRouter([draftOutput(LOCKED_DRAFT_TEXT)]);
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore, router, store: env.store, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    expect(result.output.approvedDraftCount).toBe(0);
    expect(result.output.draftManifest).toHaveLength(1);
    const row = result.output.draftManifest[0]!;
    expect(row.reviewId).toBe(RESPOND_ID);
    expect(row.outcome).toBe("dropped");
    expect(row.reason).toMatch(/client lock violation \(step 07, no retry\)/);
    expect(row.reason).toMatch(/we cannot help/i);

    // Exactly one draft attempt — no retry loop for a lock violation.
    const cycle1DraftSlots = await durableStore.listSlots(params.runId, "06-draft-cycle-1");
    expect(cycle1DraftSlots).toHaveLength(1);
    const cycle2DraftSlots = await durableStore.listSlots(params.runId, "06-draft-cycle-2");
    expect(cycle2DraftSlots).toHaveLength(0);

    // Steps 08/09 never ran at all for this item.
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("08a-voice-batch-cycle-1");
    expect(stepIds.some((id) => id.includes("doctrine-verdicts"))).toBe(false);
    const doctrineSlots = await durableStore.listSlots(params.runId, "09-doctrine-gate-cycle-1");
    expect(doctrineSlots).toHaveLength(0);
  });
});
