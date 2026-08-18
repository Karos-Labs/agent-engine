import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createReputationPulseWorkflow } from "../src/workflow/create-reputation-pulse-workflow.js";
import {
  doctrineOutput,
  draftOutput,
  makePromptStore,
  makeReview,
  manualExportLeg,
  parseTurnPrompt,
  recordingSmartFakeRouter,
  setupTestEnvironment,
  voicePassOutput,
  writeClientConfig,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "pulse_separation_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };

const RESPOND_ID = "manual:loc-1:rev-separation";
const DRAFT_TEXT = "Thank you for the feedback. We would like to understand what happened and make it right.";

function makeRespondReview() {
  return makeReview({
    review_id: RESPOND_ID,
    rating: 3,
    text: "Order was late but staff apologized and tried to help.",
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

/**
 * RFC-08 §5/§9's core design for step 09: "the model that wrote a sentence is
 * the worst judge of whether it conceded fault." This proves that structural
 * separation with real evidence from the actual turns sent to the router —
 * not just by reading the doc comments on `ReputationDoctrineGateAgent` —
 * by capturing every `router.complete()` call's own prompt and asserting the
 * doctrine-gate turn is a fresh, opaque handoff that never carries the draft
 * agent's own input fields, reasoning, or transcript.
 */
describe("the doctrine-gate agent's model turn is structurally separate from the draft agent's turn (RFC-08 step 09)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [manualExportLeg([makeRespondReview()])] });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("sends the draft and doctrine-gate agents two distinct turns, with distinct step ids, distinct input shapes, and no shared transcript", async () => {
    const promptStore = makePromptStore();
    const { router, calls } = recordingSmartFakeRouter([draftOutput(DRAFT_TEXT), voicePassOutput([RESPOND_ID]), doctrineOutput()]);
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore, router, store: env.store, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.approvedDraftCount).toBe(1);

    const parsedCalls = calls.map((c) => parseTurnPrompt(c.prompt));
    const draftCall = parsedCalls.find((c) => c.stepId === "reputation-draft");
    const doctrineCall = parsedCalls.find((c) => c.stepId === "reputation-doctrine-gate");
    const voiceCall = parsedCalls.find((c) => c.stepId === "reputation-voice");

    expect(draftCall).toBeTruthy();
    expect(doctrineCall).toBeTruthy();
    expect(voiceCall).toBeTruthy();
    // Three genuinely separate model calls occurred, not one call reused across steps.
    expect(parsedCalls.length).toBe(3);

    // The draft agent's own input carries drafting-specific fields the doctrine-gate agent must never see.
    expect(Object.keys(draftCall!.input).sort()).toEqual(
      ["reviewId", "platform", "rating", "text", "route", "factsBase", "brandVoice", "priorFailureReason"].sort(),
    );

    // The doctrine-gate agent's own input is the narrow, opaque contract RFC-08 describes:
    // the finished draft text plus the facts base and the original review text — nothing
    // about how the draft was produced, and none of the draft agent's own input fields.
    expect(Object.keys(doctrineCall!.input).sort()).toEqual(["reviewId", "draftText", "factsBase", "reviewText"].sort());
    expect(doctrineCall!.input["draftText"]).toBe(DRAFT_TEXT);
    expect(doctrineCall!.input).not.toHaveProperty("platform");
    expect(doctrineCall!.input).not.toHaveProperty("rating");
    expect(doctrineCall!.input).not.toHaveProperty("route");
    expect(doctrineCall!.input).not.toHaveProperty("brandVoice");
    expect(doctrineCall!.input).not.toHaveProperty("priorFailureReason");

    // Each call's transcript is freshly seeded from its own input alone (BaseAgent.run()'s
    // own construction: `[{role: "input", content: input}]`) — never the draft agent's
    // own transcript/thought carried forward into the doctrine-gate call.
    expect(draftCall!.transcript).toHaveLength(1);
    expect(doctrineCall!.transcript).toHaveLength(1);
    expect(doctrineCall!.transcript).not.toEqual(draftCall!.transcript);
  });
});
