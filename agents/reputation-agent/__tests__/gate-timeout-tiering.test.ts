import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine, CLEAN_GATE_TIMEOUT, FLAGGED_GATE_TIMEOUT } from "@agent-engine/workflow";
import { createReputationPulseWorkflow } from "../src/workflow/create-reputation-pulse-workflow.js";
import {
  doctrineOutput,
  draftOutput,
  makePromptStore,
  makeReview,
  manualExportLeg,
  setupTestEnvironment,
  smartFakeRouter,
  tagOutput,
  voicePassOutput,
  writeClientConfig,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * A GATE THAT APPROVES ON TIMEOUT IS A DELAY, NOT A GATE.
 *
 * `10-reputation-approve-all` carried a flat `1h / auto_approve`, so a pulse
 * carrying a CRISIS trigger — a review the run itself escalated — got exactly
 * the hour a quiet pulse got. The platform's three-tier policy
 * (`packages/workflow/src/primitives/gate-timeout.ts`) gives that batch six
 * hours and then still releases it: a flag buys a reviewer TIME, not a veto,
 * because a pulse nobody came back to is a pulse thrown away.
 *
 * Both halves are asserted. A test that only proves the flagged case passes
 * just as well if EVERY pulse waits six hours, which would be a different bug
 * with the same shape.
 */

const params = { runId: "pulse_gate_clock", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };
const RESPOND_ID = "manual:loc-1:rev-respond";
const CRISIS_ID = "manual:loc-1:rev-scam";
const DRAFT_TEXT =
  "Thank you for sharing this feedback. We would like to learn more about what happened; please reach out to us directly so we can follow up.";

/** One review that earns a drafted reply, and nothing that escalates. */
function quietReview() {
  return makeReview({
    review_id: RESPOND_ID,
    rating: 3,
    text: "The wait was long but the staff tried to help sort it out.",
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

/** The crisis keyword the triage config escalates on. */
function crisisReview() {
  return makeReview({
    review_id: CRISIS_ID,
    rating: 1,
    text: "This is a scam, avoid this place.",
    annotations: {
      classifier_model_id: "fixture",
      sentiment: "neg",
      factual_error: false,
      fixable_complaint: false,
      detailed_positive: false,
      service_recovery_opportunity: false,
    },
  });
}

function router() {
  return smartFakeRouter([tagOutput([{ reviewId: CRISIS_ID, tag: "Fraud" }]), draftOutput(DRAFT_TEXT), voicePassOutput([RESPOND_ID]), doctrineOutput()]);
}

async function pauseAtGate(env: TestEnvironment, reviews: ReturnType<typeof makeReview>[]) {
  await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [manualExportLeg(reviews)] });
  const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: router(), store: env.store });
  const durableStore = new MemoryDurableStepStore();
  const paused = await new WorkflowEngine(durableStore).run(workflowFn, params);
  if (paused.status !== "awaiting_gate") throw new Error(`expected the approve-all gate, got ${paused.status}`);
  const gate = await durableStore.getGate(paused.pendingGateId);
  return { gate, payload: (gate?.payload ?? {}) as Record<string, unknown> };
}

describe("what the clock on the approve-all gate is worth", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a quiet pulse keeps the hour it always had", async () => {
    const { gate, payload } = await pauseAtGate(env, [quietReview()]);
    expect(payload["crisisFired"]).toBe(false);
    expect(gate?.timeout?.duration).toBe(CLEAN_GATE_TIMEOUT);
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["gateFlags"]).toBeUndefined();
  });

  it("a pulse with a crisis trigger waits six hours — and then still releases", async () => {
    const { gate, payload } = await pauseAtGate(env, [quietReview(), crisisReview()]);
    expect(payload["crisisFired"]).toBe(true);
    expect(gate?.timeout?.duration).toBe(FLAGGED_GATE_TIMEOUT);
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["gateFlags"]).toEqual([expect.stringMatching(/crisis trigger fired/)]);
    expect(payload["gateWaitReason"]).toMatch(/waits for a person/i);
  });
});
