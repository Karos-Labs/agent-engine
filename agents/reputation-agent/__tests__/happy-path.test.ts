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
  tagOutput,
  voicePassOutput,
  writeClientConfig,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "pulse_happy_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };

const RESPOND_ID = "manual:loc-1:rev-respond";
const NO_ACTION_ID = "manual:loc-1:rev-happy";
const FLAG_ID = "manual:loc-1:rev-scam";

const DRAFT_TEXT =
  "Thank you for sharing this feedback. We would like to learn more about what happened; please reach out to us directly so we can follow up.";

function makeReviews() {
  return [
    // fixable_complaint(20) + service_recovery_opportunity(15) + platform google(10) = 45 >= 40 -> RESPOND, draft_attached.
    makeReview({
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
    }),
    // detailed_positive(10) + platform google(10) = 20 < 40 -> NO_ACTION.
    makeReview({
      review_id: NO_ACTION_ID,
      rating: 5,
      text: "Great coffee and friendly staff.",
      annotations: {
        classifier_model_id: "fixture",
        sentiment: "pos",
        factual_error: false,
        fixable_complaint: false,
        detailed_positive: true,
        service_recovery_opportunity: false,
      },
    }),
    // rating_1(35) + crisis_keyword "scam"(40) = 75 >= 50 -> FLAG. value = platform(10) only, < 40 -> no draft attached.
    makeReview({
      review_id: FLAG_ID,
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
    }),
  ];
}

async function seedClient(env: TestEnvironment) {
  await writeClientConfig(env.store, env.clientSlug, {
    reputationRoster: [manualExportLeg(makeReviews())],
  });
}

function goodRouter() {
  return smartFakeRouter([
    tagOutput([{ reviewId: FLAG_ID, tag: "Fraud" }]),
    draftOutput(DRAFT_TEXT),
    voicePassOutput([RESPOND_ID]),
    doctrineOutput(),
  ]);
}

describe("end-to-end: the reputation pulse workflow happy path (RFC-08 §5)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    await seedClient(env);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("routes RESPOND/FLAG/NO_ACTION correctly, drafts+approves the RESPOND lane, tags the FLAG lane, and persists everything (autoApprove)", async () => {
    const promptStore = makePromptStore();
    const router = goodRouter();
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore, router, store: env.store, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    expect(result.output.counts).toEqual({ respond: 1, flag: 1, noAction: 1, unavailable: 0 });
    expect(result.output.crisisFired).toBe(true);
    expect(result.output.crisisTriggerCount).toBe(1);
    expect(result.output.approvedDraftCount).toBe(1);
    expect(result.output.flaggedCount).toBe(1);
    expect(result.output.deliverableId).toBeTruthy();
    expect(result.totalCostUsd).toBeGreaterThan(0);

    expect(result.output.draftManifest).toEqual([{ reviewId: RESPOND_ID, outcome: "written" }]);

    // reputation.publish / publish-gbp-reply is never called anywhere in this workflow — the
    // only "publish" surface reached past the human gate is `ledger.writeDeliverable`.
    const deliverables = await env.store.listJson(env.clientSlug, ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["reputation-pulse"]);
    const deliverablePayload = deliverables[0]!.data as { deliverable: { approvedDrafts: unknown[]; flagged: Array<{ departmentTag?: string }> } };
    expect(deliverablePayload.deliverable.approvedDrafts).toEqual([{ reviewId: RESPOND_ID, draftText: DRAFT_TEXT }]);
    expect(deliverablePayload.deliverable.flagged[0]!.departmentTag).toBe("Fraud");

    // ledgers really landed on the workspace store.
    const responded = await env.store.listJson(env.clientSlug, ["reputation", "ledger", "responded"]);
    expect(responded.map((r) => (r.data as { reviewId: string }).reviewId)).toEqual([RESPOND_ID]);

    const seen = await env.store.listJson(env.clientSlug, ["reputation", "ledger", "seen"]);
    expect(seen.map((r) => (r.data as { reviewId: string }).reviewId).sort()).toEqual([FLAG_ID, NO_ACTION_ID, RESPOND_ID].sort());

    const crisisSignatures = await env.store.listJson(env.clientSlug, ["reputation", "ledger", "crisis-signatures"]);
    expect(crisisSignatures).toHaveLength(1);

    const learningLog = await env.store.listJson(env.clientSlug, ["reputation", "learning-log"]);
    expect(learningLog).toHaveLength(1);

    const decisions = await env.store.listJson(env.clientSlug, ["memory", "decisions"]);
    expect(decisions.some((d) => (d.data as { decisionId: string }).decisionId === `${params.runId}__no_action__${NO_ACTION_ID.replace(/[:/\\]/g, "__")}`)).toBe(
      true,
    );

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId).sort();
    expect(executedIds).toEqual(
      [
        "01-open-pulse",
        "02-freeze-inputs",
        "03-capture",
        "04a-read-annotations-cache",
        "04c-cache-new-annotations",
        "04d-triage",
        "04e-tag-flagged-reviews",
        "tag",
        "05-no-action-log",
        "04f-claim-draftable-reviews",
        "07-client-lock-cycle-1",
        "06-draft-cycle-1__slot_0::draft",
        "08a-voice-batch-cycle-1",
        "08b-mechanical-antislop-cycle-1",
        "09-doctrine-gate-cycle-1__slot_0::doctrine-verdicts",
        "10-reputation-approve-all",
        "11-assemble-and-persist",
      ].sort(),
    );
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // 04b's fanout has zero items (every review already carried pre-set annotations) -> no slots.
    const extractionSlots = await durableStore.listSlots(params.runId, "04b-extract-new-reviews");
    expect(extractionSlots).toHaveLength(0);
  });

  it("without autoApprove, pauses at the reputation_approve_all gate rather than running through completion, then resumes on approval", async () => {
    const promptStore = makePromptStore();
    const router = goodRouter();
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore, router, store: env.store });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const gatedParams = { ...params, runId: "pulse_happy_gated" };

    const first = await engine.run(workflowFn, gatedParams);
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("10-reputation-approve-all");

    // nothing was persisted yet — the gate sits strictly before step 11.
    const beforeApproval = await env.store.listJson(env.clientSlug, ["ledger", "deliverables", gatedParams.runId, "_"]);
    expect(beforeApproval).toHaveLength(0);

    await engine.resolveGate(gatedParams.runId, "10-reputation-approve-all", {
      decision: "approve",
      actor: "account_manager@karoslabs.com",
      at: new Date().toISOString(),
    });

    const second = await engine.run(workflowFn, gatedParams);
    expect(second.status).toBe("completed");

    const afterApproval = await env.store.listJson(env.clientSlug, ["ledger", "deliverables", gatedParams.runId, "_"]);
    expect(afterApproval).toHaveLength(1);
  });

  it("held when a human rejects the reputation_approve_all gate — nothing persisted, never mistaken for a crash", async () => {
    const promptStore = makePromptStore();
    const router = goodRouter();
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore, router, store: env.store });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const rejectedParams = { ...params, runId: "pulse_happy_rejected" };

    await engine.run(workflowFn, rejectedParams);
    await engine.resolveGate(rejectedParams.runId, "10-reputation-approve-all", {
      decision: "reject",
      actor: "account_manager@karoslabs.com",
      reason: "batch needs a second look before it goes out",
      at: new Date().toISOString(),
    });

    const result = await engine.run(workflowFn, rejectedParams);
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/reputation_approve_all gate rejected/i);

    const deliverables = await env.store.listJson(env.clientSlug, ["ledger", "deliverables", rejectedParams.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  });
});
