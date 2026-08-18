import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { claimReview, releaseReviewClaim, sanitizeReputationKey, type ReputationClaimRecord } from "../src/workflow/claims.js";
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

const RESPOND_ID = "manual:loc-1:rev-claimed";
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

function goodRouter() {
  return smartFakeRouter([draftOutput(DRAFT_TEXT), voicePassOutput([RESPOND_ID]), doctrineOutput()]);
}

function claimSegments(reviewId: string): string[] {
  return ["reputation", "claims", "reviews", sanitizeReputationKey(reviewId)];
}

/**
 * run-protocol.md §5 + §9. A review claim exists for exactly one purpose:
 * stopping two pulses drafting the same review AT THE SAME TIME. It is not
 * the record that a review was answered — that is the response ledger (§6).
 * So closing a run "releases every claim", always, whatever the outcome.
 */
describe("review claims: taken to prevent double-drafting, and handed back when the run closes", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [manualExportLeg([makeRespondReview()])] });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe("the claim primitive itself", () => {
    it("lets one run win and the other lose, and lets the winner re-take its own claim on a replay", async () => {
      expect(await claimReview(env.store, env.clientSlug, "run-a", RESPOND_ID)).toEqual({ won: true, claimedBy: "run-a" });
      expect(await claimReview(env.store, env.clientSlug, "run-b", RESPOND_ID)).toEqual({ won: false, claimedBy: "run-a" });
      // An idempotent replay of the SAME run still holds it (run-protocol.md §11).
      expect(await claimReview(env.store, env.clientSlug, "run-a", RESPOND_ID)).toEqual({ won: true, claimedBy: "run-a" });
    });

    it("releases only for the holding run, is idempotent, and frees the key for the next pulse", async () => {
      await claimReview(env.store, env.clientSlug, "run-a", RESPOND_ID);

      // A run that does not hold the claim can never release it out from under the holder.
      expect(await releaseReviewClaim(env.store, env.clientSlug, "run-b", RESPOND_ID)).toBe(false);
      expect(await claimReview(env.store, env.clientSlug, "run-b", RESPOND_ID)).toEqual({ won: false, claimedBy: "run-a" });

      expect(await releaseReviewClaim(env.store, env.clientSlug, "run-a", RESPOND_ID)).toBe(true);
      expect(await releaseReviewClaim(env.store, env.clientSlug, "run-a", RESPOND_ID)).toBe(false); // replay-safe

      expect(await claimReview(env.store, env.clientSlug, "run-b", RESPOND_ID)).toEqual({ won: true, claimedBy: "run-b" });
    });
  });

  it("a REJECTED approve-all gate releases every claim, so the next pulse can draft those reviews again", async () => {
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: goodRouter(), store: env.store });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const rejected = { runId: "pulse_claim_rejected", clientSlug: env.clientSlug, productId: "reputation-agent", runKind: "recurring" as const };

    await engine.run(workflowFn, rejected);
    // Mid-run, before the human decides, the claim is genuinely held.
    const midRun = await env.store.readJson<ReputationClaimRecord>(env.clientSlug, claimSegments(RESPOND_ID));
    expect(midRun?.runId).toBe(rejected.runId);
    expect(midRun?.releasedAt).toBeUndefined();

    await engine.resolveGate(rejected.runId, "10-reputation-approve-all", {
      decision: "reject",
      actor: "account_manager@karoslabs.com",
      reason: "batch needs a second look",
      at: new Date().toISOString(),
    });
    const held = await engine.run(workflowFn, rejected);
    expect(held.status).toBe("held");

    // The claim came back — one human "no" must not strand the review forever.
    const afterHold = await env.store.readJson<ReputationClaimRecord>(env.clientSlug, claimSegments(RESPOND_ID));
    expect(afterHold?.releasedAt).toBeTruthy();

    // Nothing was recorded as responded, so the review is still genuinely draftable.
    expect(await env.store.listJson(env.clientSlug, ["reputation", "ledger", "responded"])).toHaveLength(0);

    // A SECOND pulse now drafts and approves it, rather than silently dropping
    // it as "lost the review claim race" to a run that closed days ago.
    const secondEngine = new WorkflowEngine(new MemoryDurableStepStore());
    const secondFn = createReputationPulseWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: goodRouter(),
      store: env.store,
      autoApprove: true,
    });
    const second = await secondEngine.run(secondFn, { ...rejected, runId: "pulse_claim_second" });

    expect(second.status).toBe("completed");
    if (second.status !== "completed") throw new Error("unreachable");
    expect(second.output.approvedDraftCount).toBe(1);
    expect(second.output.draftManifest).toEqual([{ reviewId: RESPOND_ID, outcome: "written" }]);
  });

  it("a claim for a review DROPPED by the client lock is released at the closing step, not held forever", async () => {
    await writeClientConfig(env.store, env.clientSlug, {
      reputationRoster: [manualExportLeg([makeRespondReview()])],
      reputationLocks: { neverSay: ["follow up with you directly"], requiredFramingAnyOf: [] },
    });
    const workflowFn = createReputationPulseWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([draftOutput(DRAFT_TEXT)]),
      store: env.store,
      autoApprove: true,
    });
    const dropped = { runId: "pulse_claim_locked", clientSlug: env.clientSlug, productId: "reputation-agent", runKind: "recurring" as const };

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, dropped);
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.draftManifest[0]!.outcome).toBe("dropped");

    const record = await env.store.readJson<ReputationClaimRecord>(env.clientSlug, claimSegments(RESPOND_ID));
    expect(record?.releasedAt).toBeTruthy();
    expect(await claimReview(env.store, env.clientSlug, "some-future-pulse", RESPOND_ID)).toEqual({ won: true, claimedBy: "some-future-pulse" });
  });

  it("a claim for a review that WAS successfully persisted stays held — the run really did answer it", async () => {
    const workflowFn = createReputationPulseWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: goodRouter(),
      store: env.store,
      autoApprove: true,
    });
    const ok = { runId: "pulse_claim_written", clientSlug: env.clientSlug, productId: "reputation-agent", runKind: "recurring" as const };

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, ok);
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.approvedDraftCount).toBe(1);

    const record = await env.store.readJson<ReputationClaimRecord>(env.clientSlug, claimSegments(RESPOND_ID));
    expect(record?.runId).toBe(ok.runId);
    expect(record?.releasedAt).toBeUndefined();
  });
});
