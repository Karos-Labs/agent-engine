import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { CaptureLegRequest } from "@agent-engine/tool-karos-reputation";
import { createReputationPulseWorkflow } from "../src/workflow/create-reputation-pulse-workflow.js";
import {
  makePromptStore,
  makeReview,
  manualExportLeg,
  setupTestEnvironment,
  smartFakeRouter,
  writeClientConfig,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "pulse_tombstone_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };

const LIVE_ID = "manual:loc-1:rev-live";

/** A real leg with no credential — `captureGbp` returns UNAVAILABLE before it ever touches the network. */
const deadGbpLeg: CaptureLegRequest = {
  leg: "gbp",
  listingId: "loc-main",
  listingLabel: "Main St",
  inRoster: true,
  account: "acc-1",
  location: "loc-1",
} as CaptureLegRequest;

function makeLiveReview() {
  // detailed_positive(10) + platform google(10) = 20 < 40 -> NO_ACTION, no drafting, no model calls at all.
  return makeReview({
    review_id: LIVE_ID,
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
  });
}

/**
 * ADAPTERS.md rule 1 / run-protocol.md §7: "A dead leg writes an UNAVAILABLE
 * tombstone into the envelope, never zero reviews — the two are opposite
 * facts and a zero is read downstream as 'nothing to answer'."
 *
 * `triage.py` has always had the branch that handles an `UNAVAILABLE`-tier
 * row (NO_ACTION, `signals: ["capture_unavailable"]`, `summary.unavailable++`)
 * and this port faithfully copied it — but nothing in the port ever PRODUCED
 * such a row, so the branch was unreachable and a dead Google leg looked
 * exactly like a Google listing with no reviews.
 */
describe("a dead capture leg reaches triage as an UNAVAILABLE tombstone, and is visible in the pulse", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    // Guarantee the credential really is absent regardless of the developer's shell.
    vi.stubEnv("GOOGLE_BUSINESS_TOKEN", "");
    await writeClientConfig(env.store, env.clientSlug, {
      reputationRoster: [deadGbpLeg, manualExportLeg([makeLiveReview()])],
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await env.cleanup();
  });

  it("counts the dead leg in summary.unavailable and names it in the result and the deliverable", async () => {
    const promptStore = makePromptStore();
    // No candidates at all: this scenario must not call a model even once, so
    // any stray agent call fails loudly instead of passing silently.
    const router = smartFakeRouter([]);
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore, router, store: env.store, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, params);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // THE regression: this was 0 before the fix, because the dead leg returned
    // `reviews: []` and the tombstone branch in triage() could never fire.
    expect(result.output.counts.unavailable).toBe(1);
    // The tombstone's row IS routed NO_ACTION, but triage.py's tombstone branch
    // counts it only under `unavailable` and `continue`s — a broken integration
    // must never inflate "we decided not to reply to this many reviews".
    expect(result.output.counts.noAction).toBe(1);

    // The leg-level fact, surfaced first-class rather than buried in a review row.
    expect(result.output.unavailableLegs).toEqual([
      { leg: "gbp", status: "UNAVAILABLE", reviewCount: 0, reason: "missing env GOOGLE_BUSINESS_TOKEN" },
    ]);
    expect(result.output.captureLegs).toEqual([
      { leg: "gbp", status: "UNAVAILABLE", reviewCount: 0, reason: "missing env GOOGLE_BUSINESS_TOKEN" },
      { leg: "manual_export", status: "ok", reviewCount: 1 },
    ]);

    const deliverables = await env.store.listJson(env.clientSlug, ["ledger", "deliverables", params.runId, "_"]);
    const payload = deliverables[0]!.data as {
      deliverable: { summary: { unavailable: number }; unavailableLegs: Array<{ leg: string; reason?: string }> };
    };
    expect(payload.deliverable.summary.unavailable).toBe(1);
    expect(payload.deliverable.unavailableLegs[0]!.leg).toBe("gbp");
    expect(payload.deliverable.unavailableLegs[0]!.reason).toContain("GOOGLE_BUSINESS_TOKEN");

    // A tombstone is a run-record fact, not a review anyone has "seen" — the
    // seen ledger must stay clean so a later real capture of that listing is
    // still new evidence for crisis purposes.
    const seen = await env.store.listJson(env.clientSlug, ["reputation", "ledger", "seen"]);
    expect(seen.map((s) => (s.data as { reviewId: string }).reviewId)).toEqual([LIVE_ID]);
  });

  it("a fully healthy pulse reports no unavailable legs, so the signal above is not noise", async () => {
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [manualExportLeg([makeLiveReview()])] });
    const workflowFn = createReputationPulseWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([]),
      store: env.store,
      autoApprove: true,
    });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "pulse_tombstone_clean" });
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.counts.unavailable).toBe(0);
    expect(result.output.unavailableLegs).toEqual([]);
  });
});
