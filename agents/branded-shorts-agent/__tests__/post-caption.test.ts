import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { ModelRouter } from "@agent-engine/core";
import { createBrandedShortsAgentWorkflow } from "../src/workflow/create-branded-shorts-agent-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodCaption,
  goodGraphicsPlan,
  goodHighlights,
  makePromptStore,
  setupTestEnvironment,
  smartFakeRouter,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * THE VIDEO IS NOT THE POST.
 *
 * Until 2026-09-25 this agent delivered an MP4 and no words. The portal's own
 * materializer documented the consequence rather than fixing it — *"`content`
 * is the empty string by construction: the video IS the post, and this
 * deliverable carries no caption to put under it"* — so a client who approved
 * a branded short still had to write the caption themselves before it could
 * be posted anywhere. Clipping and content design, which share this agent's
 * TikTok account, have delivered a caption since they were migrated.
 *
 * These tests hold the three things that fix has to be true of: the caption
 * reaches every surface that needs it, it is drafted inside the review round
 * so a reviewer's note can change it, and a drafter that returns nothing does
 * not cost the client the whole run.
 */
const params = { runId: "branded_shorts_run_caption", clientSlug: "acme", productId: "branded-shorts-agent", runKind: "setup" as const };

/** A router that answers the caption schema with `content_fail` and everything else normally. */
function captionFailingRouter(): ModelRouter {
  const good = smartFakeRouter([goodHighlights(), goodGraphicsPlan()]);
  return {
    async complete(prompt, schema, policy) {
      // The caption is the only step whose schema accepts this shape, so
      // parsing it is how we recognise the call without depending on prompt
      // text. Returning a malformed output drives `BaseAgent` to content_fail,
      // which is what a real model that will not produce the schema does.
      if (schema.safeParse({ type: "final", output: goodCaption() }).success) {
        return {
          output: { type: "final", output: { caption: "", about: "" } } as never,
          modelUsed: "claude-sonnet-4-6",
          inputTokens: { cached: 0, uncached: 10 },
          outputTokens: 5,
        };
      }
      return good.complete(prompt, schema, policy);
    },
    async completeAlias() {
      throw new Error("captionFailingRouter: completeAlias not used in these tests");
    },
  } as ModelRouter;
}

describe("a branded short is delivered with the words it is posted with", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env?.cleanup();
  });

  it("puts the drafted caption on the result, the deliverable and the reviewer's gate", async () => {
    env = await setupTestEnvironment();
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodHighlights(), goodGraphicsPlan(), goodCaption()]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "branded_shorts_run_caption_gate";
    const gated = await engine.run(workflowFn, { ...params, runId });

    // THE REVIEWER SEES THE POST, NOT ONLY THE VIDEO. Approving a post while
    // looking at a play button and six counts is approving something you were
    // never shown.
    expect(gated.status).toBe("awaiting_gate");
    const gate = await durableStore.getGate(`${runId}__10-delivery-review-r0`);
    expect(gate).toBeDefined();
    // `preview` is the key the portal renders as a full, direction-aware
    // block; an unanticipated `caption` key would reach the screen truncated
    // to one line, which is the same reviewer approving the same thing unseen.
    expect(gate!.payload).toMatchObject({ preview: goodCaption().caption, about: goodCaption().about });

    await engine.resolveGate(runId, `${runId}__10-delivery-review-r0`, {
      decision: "approve",
      actor: "reviewer@acme.test",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...params, runId });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.copy.caption).toBe(goodCaption().caption);
    expect(result.output.copy.about).toBe(goodCaption().about);

    // And on the persisted deliverable, which is what the portal reads to
    // fill the asset body a client actually sees.
    const deliverables = await env.store.listJson(env.clientSlug, ["ledger", "deliverables", runId, "_"]);
    const short = deliverables.find((d) => d.id === "branded-shorts-video");
    expect(short).toBeDefined();
    const persisted = (short!.data as { deliverable: { caption?: string; about?: string } }).deliverable;
    expect(persisted.caption).toBe(goodCaption().caption);
    expect(persisted.about).toBe(goodCaption().about);
  });

  it("re-drafts the caption when a reviewer sends the round back, rather than returning the same words", async () => {
    // The reason the caption is drafted INSIDE the review round. "The caption
    // misses the point" is one of the likeliest notes a reviewer sends, and a
    // caption drafted above the loop would come back byte-identical while the
    // trace claimed the round had been re-run.
    env = await setupTestEnvironment();
    const promptStore = makePromptStore();
    const revised = { caption: "The number went up and the business did not. That gap is the whole story.", about: "Round two." };
    const router = fakeRouterSequence([
      finalTurn(goodHighlights()),
      finalTurn(goodGraphicsPlan()),
      finalTurn(goodCaption()),
      finalTurn(goodHighlights()),
      finalTurn(goodGraphicsPlan()),
      finalTurn(revised),
    ]);
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "branded_shorts_run_caption_revise";

    expect((await engine.run(workflowFn, { ...params, runId })).status).toBe("awaiting_gate");
    await engine.resolveGate(runId, `${runId}__10-delivery-review-r0`, {
      decision: "revise",
      actor: "reviewer@acme.test",
      at: new Date().toISOString(),
      reason: "the caption buries the point",
    });
    expect((await engine.run(workflowFn, { ...params, runId })).status).toBe("awaiting_gate");

    const round1 = await durableStore.getGate(`${runId}__10-delivery-review-r1`);
    expect(round1).toBeDefined();
    expect(round1!.payload).toMatchObject({ preview: revised.caption });

    await engine.resolveGate(runId, `${runId}__10-delivery-review-r1`, {
      decision: "approve",
      actor: "reviewer@acme.test",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...params, runId });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.copy.caption).toBe(revised.caption);
  });

  it("falls back to the client's own stated takeaway when the drafter returns nothing, and says so", async () => {
    // The owner's always-deliver rule (2026-09-17) applied to the newest step
    // in this pipeline. A caption the model could not produce must not cost
    // the client a rendered video — and the substitution must be visible,
    // because a reviewer has to be able to tell a written caption from a
    // fallen-back one.
    env = await setupTestEnvironment();
    const promptStore = makePromptStore();
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore, router: captionFailingRouter(), autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "branded_shorts_run_caption_failed" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // `setupTestEnvironment` writes this takeaway into the intake.
    expect(result.output.copy.caption.length).toBeGreaterThan(0);
    const repair = (result.output.contentRepairs ?? []).find((r) => r.check === "branded-shorts-caption");
    expect(repair).toBeDefined();
    expect(repair!.action).toBe("unresolved");
    expect(repair!.detail).toContain("takeaway");
  });
});
