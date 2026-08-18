import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { Annotations } from "@agent-engine/tool-karos-reputation";
import { readAnnotationsCache, writeAnnotationToCache } from "../src/workflow/ledgers.js";
import { REPUTATION_CLASSIFIER_MODEL_ID } from "../src/agent/reputation-extraction-agent.js";
import { createReputationPulseWorkflow } from "../src/workflow/create-reputation-pulse-workflow.js";
import {
  extractionOutput,
  makePromptStore,
  makeReview,
  manualExportLeg,
  setupTestEnvironment,
  smartFakeRouter,
  writeClientConfig,
  type TestEnvironment,
} from "./test-helpers.js";

const REVIEW_ID = "manual:loc-1:rev-cached";
const MODEL_A = "claude-haiku-4-5-20251001";
const MODEL_B = "claude-haiku-9-9-20991231";

function annotationsFrom(modelId: string, overrides: Partial<Annotations> = {}): Annotations {
  return {
    classifier_model_id: modelId,
    sentiment: "neg",
    factual_error: false,
    fixable_complaint: true,
    detailed_positive: false,
    service_recovery_opportunity: true,
    ...overrides,
  };
}

/**
 * `review-schema.md`: annotations are "cached forever at CLIENT level, keyed
 * `(review_id, classifier_model_id)`" — a PAIR — and "a recompute requires a
 * new `classifier_model_id` and is a logged config change." Keying on the
 * review id alone makes that sentence unenforceable: swapping the extraction
 * model would silently keep serving the retired model's booleans forever.
 */
describe("the annotations cache is keyed (review_id, classifier_model_id), not review_id alone", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("a lookup under a DIFFERENT classifier model misses, so the swap triggers a fresh classification", async () => {
    await writeAnnotationToCache(env.store, env.clientSlug, REVIEW_ID, annotationsFrom(MODEL_A));

    const hitA = await readAnnotationsCache(env.store, env.clientSlug, [REVIEW_ID], MODEL_A);
    expect(hitA.get(REVIEW_ID)?.classifier_model_id).toBe(MODEL_A);

    // THE regression: this used to return model A's cached booleans.
    const missB = await readAnnotationsCache(env.store, env.clientSlug, [REVIEW_ID], MODEL_B);
    expect(missB.has(REVIEW_ID)).toBe(false);
  });

  it("keeps both models' entries side by side rather than one overwriting the other", async () => {
    await writeAnnotationToCache(env.store, env.clientSlug, REVIEW_ID, annotationsFrom(MODEL_A, { fixable_complaint: true }));
    await writeAnnotationToCache(env.store, env.clientSlug, REVIEW_ID, annotationsFrom(MODEL_B, { fixable_complaint: false }));

    expect((await readAnnotationsCache(env.store, env.clientSlug, [REVIEW_ID], MODEL_A)).get(REVIEW_ID)?.fixable_complaint).toBe(true);
    expect((await readAnnotationsCache(env.store, env.clientSlug, [REVIEW_ID], MODEL_B)).get(REVIEW_ID)?.fixable_complaint).toBe(false);
    expect(await env.store.listJson(env.clientSlug, ["reputation", "cache", "annotations"])).toHaveLength(2);
  });

  it("end to end: a review cached under a retired model is re-extracted, not served stale", async () => {
    // Cached under a model this workflow does NOT use.
    await writeAnnotationToCache(env.store, env.clientSlug, REVIEW_ID, annotationsFrom(MODEL_B, { sentiment: "pos" }));

    const review = makeReview({ review_id: REVIEW_ID, rating: 4, text: "Fine, though the wait was long." });
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [manualExportLeg([review])] });

    const workflowFn = createReputationPulseWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      // Only an extraction output is offered: if the stale entry were served,
      // the extraction fanout would have zero items and this candidate would
      // go unused — which the slot assertion below detects either way.
      router: smartFakeRouter([extractionOutput({ sentiment: "neg" })]),
      store: env.store,
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const runId = "pulse_annotations_cache";
    const result = await new WorkflowEngine(durableStore).run(workflowFn, {
      runId,
      clientSlug: env.clientSlug,
      productId: "reputation-agent",
      runKind: "recurring" as const,
    });
    expect(result.status).toBe("completed");

    // A real extraction pass ran for this review, despite a cache entry existing under its id.
    const slots = await durableStore.listSlots(runId, "04b-extract-new-reviews");
    expect(slots).toHaveLength(1);

    // ...and the fresh result landed under the model this run actually used.
    const fresh = await readAnnotationsCache(env.store, env.clientSlug, [REVIEW_ID], REPUTATION_CLASSIFIER_MODEL_ID);
    expect(fresh.get(REVIEW_ID)?.sentiment).toBe("neg");
    // The retired model's entry is untouched — a cache miss, never a clobber.
    expect((await readAnnotationsCache(env.store, env.clientSlug, [REVIEW_ID], MODEL_B)).get(REVIEW_ID)?.sentiment).toBe("pos");
  });
});
