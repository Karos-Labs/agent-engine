import { describe, expect, it } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  goodImageCandidatePool,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

/**
 * REGRESSION — prep run `pubsub-21839432908803804`, 2026-09-14.
 *
 * ## The incident
 *
 * `Cannot read properties of null (reading 'series')`. The run drafted,
 * rendered and spent **$1.199**, and the client received nothing.
 *
 * ## The mechanism, and it is a trap this repo already documented
 *
 * `wf.step.code`'s checkpoint is persisted through `sanitizeForFirestore`
 * (`packages/workflow/src/adapters/firestore/firestore-store.ts`), which
 * recursively replaces **every** `undefined` with `null` — because real
 * Firestore's `set()` throws on `undefined` anywhere in the document tree.
 *
 * So a step that returns `undefined` is read back as `null`. On the first pass
 * the in-memory value is `undefined` and every guard behaves; on a RESUME or a
 * redelivery the same step hands back `null`, `seriesChoice !== undefined` is
 * TRUE, and the next line dereferences it.
 *
 * ## Why every existing test was green
 *
 * `MemoryDurableStepStore` performs no such coercion — it stores the JS value.
 * So `series-wiring.test.ts`'s own fail-open case asserted the step output was
 * `undefined` and passed, while production was storing `null` for the same
 * run. **A guard that cannot see the production encoding cannot fail on it.**
 * That is the fourth time this codebase has recorded a guard that could not
 * fail, and the first where the cost was a live run.
 *
 * ## What this test does differently
 *
 * It reproduces the COERCION rather than the code path: run once so the
 * checkpoint exists, rewrite `04i2-select-series`'s output to `null` exactly
 * as the Firestore adapter would, then resume the same `runId`. The workflow
 * has to treat that `null` as "no series" and deliver.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

async function build(env: TestEnvironment, tools: AgentToolRegistry, router: ReturnType<typeof fakeRouterSequence>) {
  return createInstagramAgentWorkflow({
    tools,
    promptStore: makePromptStore(),
    router,
    repoRoot: env.repoRoot,
    imageCandidatePool: goodImageCandidatePool(),
    autoApprove: true,
  });
}

describe("a checkpointed `null` series is read as NO series, not as an object", () => {
  it("resumes and delivers when 04i2's checkpoint came back null, the way Firestore stores it", async () => {
    const env = await setupTestEnvironment();
    const tools = { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
    const runId = "instagram_run_series_null_checkpoint";
    const store = new MemoryDurableStepStore();

    // Pass one, on the fail-open path so the step genuinely has nothing to
    // record: every proposal rests on a claim this run never fetched, which is
    // what `selectAngle` refuses.
    const ungrounded = {
      angles: goodAngleProposal().angles.map((angle) => ({ ...angle, restsOn: ["a claim no card in this run carries"] })),
      notes: "every proposal rests on a card this run never fetched",
    };
    const first = await new WorkflowEngine(store).run(await build(env, tools, fakeRouterSequence(happyTurns({ angle: ungrounded }))), {
      runId,
      ...base,
    });
    expect(first.status, JSON.stringify(first)).toBe("completed");

    // ── THE COERCION IS ALREADY THERE, AND THAT IS THE FINDING. ──
    //
    // This case was written expecting to have to APPLY the `undefined -> null`
    // rewrite by hand, the way `sanitizeForFirestore` does at the Firestore
    // boundary. It does not: the recorded output is ALREADY `null` in
    // `MemoryDurableStepStore`, so the coercion happens when the engine records
    // a step, not only when Firestore persists one.
    //
    // Which means a plain resume reproduces the incident with no help, and it
    // also explains why `series-wiring.test.ts` missed it: that assertion reads
    // `record?.output ?? undefined`, and `null ?? undefined` is `undefined`.
    // The `??` written for convenience is the thing that hid the encoding.
    const checkpoint = await store.getStep(runId, "04i2-select-series");
    expect(checkpoint, "04i2-select-series did not checkpoint, so this test is not reproducing anything").toBeDefined();
    expect(checkpoint!.output, "the fail-open path recorded a series, or the engine stopped coercing — either way this no longer reproduces").toBeNull();

    // ── AND THE RESUME, WHICH IS WHAT PRODUCTION DOES ON A REDELIVERY. ──
    const resumed = await new WorkflowEngine(store).run(await build(env, tools, fakeRouterSequence(happyTurns({ angle: ungrounded }))), {
      runId,
      ...base,
    });
    expect(
      resumed.status,
      `the resumed run did not complete — a null checkpoint was dereferenced: ${JSON.stringify(resumed)}`,
    ).toBe("completed");

    // ASSERT THE PREMISE. The rewrite has to have survived, or the resume
    // proved nothing: a store that quietly dropped the `null` back to
    // `undefined` would make this case green for the wrong reason.
    expect((await store.getStep(runId, "04i2-select-series"))?.output, "the null checkpoint did not survive the resume").toBeNull();
    // And the shape of the bug, stated where the next reader will look: `null`
    // is not `undefined`, so `x !== undefined` is TRUE for it. Every guard on a
    // checkpointed optional has to be `== null` or normalised at the boundary.
    expect(null !== undefined).toBe(true);
  }, 180_000);
});
