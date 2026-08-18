import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createReputationPulseWorkflow } from "../src/workflow/create-reputation-pulse-workflow.js";
import {
  doctrineOutput,
  draftOutput,
  makePromptStore,
  makeReview,
  manualExportLeg,
  setupTestEnvironment,
  smartFakeRouter,
  voicePassOutput,
  writeClientConfig,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "pulse_doctrine_retry_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };

const RESPOND_ID = "manual:loc-1:rev-stubborn";
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

describe("steps 06-09: the doctrine-gate retry loop is capped at 2 retries (run-protocol.md §4: 'two is the cap')", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [manualExportLeg([makeRespondReview()])] });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("retries a persistently doctrine-failing draft exactly twice, then drops it to FLAG with a manifest reason naming the cap", async () => {
    const promptStore = makePromptStore();
    // The draft/voice/mechanical checks pass every cycle; only the doctrine gate's
    // own model verdict keeps failing (a genuine content disagreement, not a
    // mechanical backstop override) — every one of the 3 allowed attempts should
    // still go all the way through drafting before failing at the gate.
    const router = smartFakeRouter([
      draftOutput(DRAFT_TEXT),
      voicePassOutput([RESPOND_ID]),
      doctrineOutput({ no_blame: { verdict: "fail", quote: "you must have misunderstood the policy", rationale: "reads as blaming the reviewer" } }),
    ]);
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore, router, store: env.store, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    expect(result.output.counts.respond).toBe(1); // triage's own route never changes because drafting failed downstream.
    expect(result.output.approvedDraftCount).toBe(0);
    expect(result.output.draftManifest).toHaveLength(1);
    const row = result.output.draftManifest[0]!;
    expect(row.reviewId).toBe(RESPOND_ID);
    expect(row.outcome).toBe("dropped");
    expect(row.reason).toMatch(/exceeded 2 retries to steps 06-09/);
    expect(row.reason).toMatch(/doctrine gate failed/);

    // Exactly 3 draft attempts (the initial try plus the 2-retry cap), one full
    // cycle each through draft -> lock -> voice -> mechanical -> doctrine.
    for (const cycle of [1, 2, 3]) {
      const draftSlots = await durableStore.listSlots(params.runId, `06-draft-cycle-${cycle}`);
      expect(draftSlots).toHaveLength(1);
      expect(draftSlots[0]!.status).toBe("completed");

      const doctrineSlots = await durableStore.listSlots(params.runId, `09-doctrine-gate-cycle-${cycle}`);
      expect(doctrineSlots).toHaveLength(1);
      expect(doctrineSlots[0]!.status).toBe("completed"); // the agent call succeeded; the doctrine *verdict* was a fail, not an agent crash.

      const lockStep = await durableStore.getStep(params.runId, `07-client-lock-cycle-${cycle}`);
      expect(lockStep?.status).toBe("completed");

      const voiceStep = await durableStore.getStep(params.runId, `08a-voice-batch-cycle-${cycle}`);
      expect(voiceStep?.status).toBe("completed");
    }

    // There must be no 4th cycle — the cap actually stopped the loop.
    const cycle4 = await durableStore.listSlots(params.runId, "06-draft-cycle-4");
    expect(cycle4).toHaveLength(0);
  });
});
