import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { CompletionResult, ModelRouter } from "@agent-engine/core";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import type { SeoGeoReport } from "../src/workflow/types.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

/**
 * SCRUM-303 / AU19: seo-geo-agent adopts the shared `runReviewCycle` primitive
 * (`@agent-engine/workflow`), the same pattern every migrated content agent
 * uses for its own final human-review gate. Before this, the pipeline had two
 * human gates (`03-prompt-set-review`, `12-fix-generation-review`) but neither
 * ever showed a human the report's ACTUAL drafted content — `12` approves
 * generating fixes at all, before the fixes or narrative exist.
 *
 * This agent deliberately does NOT adopt `runTopicGuardrail`, unlike
 * tiktok-agent (the other agent in this ticket): `apps/agent-server/__tests__/guardrail-coverage.test.ts`
 * documents, as an enforced repo-wide invariant, that seo-geo-agent's
 * deliverable is internal (an SEO/GEO audit read by the client's own team,
 * never published) and must never run the terminal topic guardrail — that
 * check asks "does this text engage a subject the client's PUBLIC voice
 * avoids", which does not apply to an internal audit. Adding the call here
 * would fail that coverage test outright.
 */

const baseParams = { clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/** Serves each router call from a strict, order-based queue — the two bounded agents (fix-draft, narrative) always call in that order, once per revision round, when no forbidden topics are configured (so the guardrail never touches the router). */
function sequentialFakeRouter(candidates: readonly unknown[]): ModelRouter {
  const queue = [...candidates];
  return {
    async complete(_prompt, _schema, policy) {
      const next = queue.shift();
      if (next === undefined) throw new Error("sequentialFakeRouter: exhausted configured turns");
      return {
        output: { type: "final", output: next },
        modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
        inputTokens: { cached: 0, uncached: 100 },
        outputTokens: 30,
      } as CompletionResult<unknown>;
    },
    async completeAlias() {
      throw new Error("completeAlias is not used here");
    },
  } as ModelRouter;
}

/** Drives a fresh run through both early gates (auto-resolved as "approve"), leaving it paused at the new `16-batch-review` gate. */
async function runToFinalReviewGate(
  engine: WorkflowEngine,
  workflowFn: ReturnType<typeof createSeoGeoAgentWorkflow>,
  runId: string,
): Promise<Awaited<ReturnType<WorkflowEngine["run"]>>> {
  await engine.run(workflowFn, { ...baseParams, runId });
  await engine.resolveGate(runId, "03-prompt-set-review", { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });
  await engine.run(workflowFn, { ...baseParams, runId });
  await engine.resolveGate(runId, "12-fix-generation-review", { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });
  return engine.run(workflowFn, { ...baseParams, runId });
}

describe("seo-geo-agent review cycle (runReviewCycle)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("re-drafts the fixes and narrative with the reviewer's feedback, then delivers on approval", async () => {
    const revisedFixDrafts = { fixes: [{ recId: "SEO-02", title: "Revised fix", description: "Rewritten per reviewer feedback, still grounded in the same recommendation data." }] };
    const revisedNarrative = { summary: "Revised per reviewer note: leads with the SEO gap first, not the GEO one." };
    const router = sequentialFakeRouter([goodFixDrafts(), goodNarrative(), revisedFixDrafts, revisedNarrative]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "seo_geo_rev_1";

    const r0 = await runToFinalReviewGate(engine, workflowFn, runId);
    expect(r0.status).toBe("awaiting_gate");
    if (r0.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r0.pendingGateId).toContain("16-batch-review-r0");

    await engine.resolveGate(runId, "16-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Lead with the SEO gap, not the GEO one, and tighten the fix description.",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflowFn, { ...baseParams, runId });
    expect(r1.status).toBe("awaiting_gate");
    if (r1.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r1.pendingGateId).toContain("16-batch-review-r1");

    await engine.resolveGate(runId, "16-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...baseParams, runId });
    expect(final.status).toBe("completed");

    const ids = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    // Round 1's drafting steps are revision-scoped, so they genuinely re-ran.
    expect(ids).toContain("13-draft-fixes");
    expect(ids).toContain("13-draft-fixes-r1");
    expect(ids).toContain("14-draft-narrative-r1");
    expect(ids).toContain("15-verify-narrative-numbers-r1");
    // Everything upstream of the draft loop (scoring, recommendations, the
    // connector overlay) kept its id and ran exactly once.
    expect(ids.filter((i) => i === "09-compute-scores")).toHaveLength(1);
    expect(ids).not.toContain("09-compute-scores-r1");
    expect(ids.filter((i) => i === "11-fire-recommendations")).toHaveLength(1);

    const stored = await env.store.readJson<{ deliverable: SeoGeoReport }>("acme", ["ledger", "deliverables", runId, "_", "seo-geo-report"]);
    expect(stored?.deliverable.narrative).toBe(revisedNarrative.summary);
    expect(stored?.deliverable.fixDrafts[0]?.title).toBe("Revised fix");
  }, 30000);

  it("saves the reviewer's words to client memory, on a revision and on an approval alike", async () => {
    const router = sequentialFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "seo_geo_rev_memory";

    await runToFinalReviewGate(engine, workflowFn, runId);
    await engine.resolveGate(runId, "16-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      feedback: "The SEO-first framing is landing well, keep doing that.",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...baseParams, runId });
    expect(final.status).toBe("completed");

    const remembered = await env.store.listJson<{ note: string; decision: string; productId: string }>("acme", ["memory", "feedback"]);
    expect(remembered.map((r) => r.data.note)).toContain("The SEO-first framing is landing well, keep doing that.");
    expect(remembered.map((r) => r.data.decision)).toContain("approve");
    expect(remembered.map((r) => r.data.productId)).toContain("seo-geo-agent");
  }, 30000);

  it("still holds on an outright rejection, and nothing is persisted", async () => {
    const router = sequentialFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "seo_geo_rev_reject";

    await runToFinalReviewGate(engine, workflowFn, runId);
    await engine.resolveGate(runId, "16-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "narrative reads too negative for this client",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...baseParams, runId });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/review rejected/i);
    expect(result.reason).toMatch(/narrative reads too negative for this client/);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect(deliverables).toHaveLength(0);
  }, 30000);
});

describe("seo-geo-agent deliberately has no terminal topic guardrail", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("never runs the guardrail even when the client has forbidden topics configured, and a report discussing one still ships", async () => {
    // Internal deliverable, never published — see this file's own header
    // comment and `guardrail-coverage.test.ts`. An audit that surfaces a
    // topic this client will not POST about is exactly the honest finding
    // this product exists to produce.
    await env.store.writeJson("acme", ["client", "config"], { forbiddenTopics: ["cryptocurrency"] });

    const narrativeWithForbiddenTopic = {
      summary: "This audit found the strongest growth opportunity is accepting digital assets on a distributed ledger for enterprise invoicing.",
    };
    const router = smartFakeRouter([goodFixDrafts(), narrativeWithForbiddenTopic]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "seo_geo_no_guardrail" });

    expect(result.status).toBe("completed");
    const stepIds = (await durableStore.listSteps("seo_geo_no_guardrail")).map((s) => s.stepId);
    expect(stepIds).not.toContain("guardrail-verify");
    expect(stepIds).not.toContain("guardrail-verify-load-topics");
  }, 30000);
});
