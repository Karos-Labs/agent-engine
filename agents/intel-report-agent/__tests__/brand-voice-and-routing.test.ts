import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { ModelPolicy } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createIntelReportAgentWorkflow } from "../src/workflow/create-intel-report-agent-workflow.js";
import { INTEL_REPORT_DRAFT_MODEL_POLICY } from "../src/agent/intel-report-draft-agent.js";
import { fakeRouterSequence, finalTurn, goodIntelReport, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * SCRUM-380 (D1-v2). Two acceptance items, one file, because both are
 * properties of the same step (`02-generate-report`) and both are only real
 * if they hold on the SECOND drafting attempt — the revision round — which
 * is exactly where a checkpoint would otherwise serve a stale answer.
 *
 *   1. Model routing for the context-document generation step, driven by a
 *      complexity signal.
 *   2. Brand Voice as a first-class, always-latest input — proven by a
 *      stale-cache test, not by inspection.
 */

const params = { runId: "intel_bv", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };

/** The serialized turn prompt each `router.complete` call actually received — the agent's input is inside it. */
function promptAt(router: ReturnType<typeof fakeRouterSequence>, index: number): string {
  const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[index]![0] as string;
}

/** The `ModelPolicy` each `router.complete` call was made with (`BaseAgent.runOneTurn`'s 3rd argument). */
function policyAt(router: ReturnType<typeof fakeRouterSequence>, index: number): ModelPolicy {
  const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[index]![2] as ModelPolicy;
}

describe("SCRUM-380: Brand Voice is always-latest, never served from the run's own checkpoint", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a Brand Voice edited in the portal WHILE the run waits at the review gate reaches the revision draft", async () => {
    // The failure this is about, concretely: the run pauses at a 24-hour
    // human gate. A reviewer reads the draft, decides the voice is off, fixes
    // Brand Voice in the portal, and clicks "revise". Before this ticket, the
    // re-draft used the brand kit `00-load-client-context` checkpointed
    // yesterday — so the reviewer's own edit was invisible to the draft it
    // was made to fix, and nothing reported that.
    const router = fakeRouterSequence([finalTurn(goodIntelReport()), finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");

    // Round 0 drafted against the voice the brand kit held at dispatch.
    expect(promptAt(router, 0)).toContain("confident, no jargon");

    // The portal edit, mid-gate. `client/brand.json` is the same file
    // `client.getBrand` reads and the portal's brand-kit editor writes.
    await env.store.writeJson("acme", ["client", "brand"], {
      voice: "wry and plainspoken, Hebrew-first, never superlatives",
      forbiddenTerms: ["guaranteed", "the best", "#1"],
    });

    await engine.resolveGate(params.runId, "04-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "The tone is not ours. I have updated the Brand Voice in the portal — redraft against it.",
      at: new Date().toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("awaiting_gate");

    // THE ASSERTION. The revision draft's prompt carries the NEW voice, and
    // no longer carries the old one.
    const revisionPrompt = promptAt(router, 1);
    expect(revisionPrompt).toContain("wry and plainspoken, Hebrew-first, never superlatives");
    expect(revisionPrompt).not.toContain("confident, no jargon");

    // ...and it is first-class, a named input rather than something the model
    // has to dig out of a brand-kit blob.
    expect(revisionPrompt).toContain('"brandVoice":"wry and plainspoken, Hebrew-first, never superlatives"');

    // Freshness does NOT come from re-running the checkpointed load step —
    // that would break resume semantics and every other agent's shape. Step
    // 00 still ran exactly once, and no new checkpointed step id appeared.
    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(ids.filter((i) => i === "00-load-client-context")).toHaveLength(1);
    expect(ids).toContain("02-generate-report-r1");
  }, 30000);

  it("falls back to the loaded brand kit rather than failing the run when the live read is unavailable", async () => {
    // Freshness is best-effort by construction: a client whose brand kit has
    // never been written still drafts, exactly as it did before.
    const noBrand = await setupTestEnvironment();
    try {
      await noBrand.store.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
      // Overwrite the brand kit with an empty object: `client.getBrand`
      // returns success with nothing usable in it.
      await noBrand.store.writeJson("acme", ["client", "brand"], {});

      const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
      const workflowFn = createIntelReportAgentWorkflow({
        tools: noBrand.tools,
        promptStore: makePromptStore(),
        router,
        autoApprove: true,
      });
      const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "intel_bv_nobrand" });
      expect(result.status).toBe("completed");
      expect(promptAt(router, 0)).not.toContain('"brandVoice"');
    } finally {
      await noBrand.cleanup();
    }
  }, 30000);
});

describe("SCRUM-380: the context-document generation step routes on document complexity", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a routine instance stays on the step's compiled policy", async () => {
    // One competitor, a small offline research payload, no steers — nothing
    // about this instance is hard, and nothing about its routing changes.
    const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "intel_route_standard" });

    expect(result.status).toBe("completed");
    expect(policyAt(router, 0)).toEqual(INTEL_REPORT_DRAFT_MODEL_POLICY);
    expect(policyAt(router, 0).model).toBe("claude-sonnet-4-6");
  }, 30000);

  it("a Wide-Scan-sized competitor field routes the same step to Opus", async () => {
    // 9 tracked competitors: past the craft prompt's own Wide Scan target of
    // 8 rows, which the scorer weighs as the largest single driver of how
    // hard this document is to produce.
    await env.store.writeJson(
      "acme",
      ["client", "competitors"],
      Array.from({ length: 9 }, (_, i) => ({ name: `Rival ${i}`, website: `https://rival${i}.example.com` })),
    );

    const router = fakeRouterSequence([finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "intel_route_high" });

    expect(result.status).toBe("completed");
    const policy = policyAt(router, 0);
    expect(policy.model).toBe("claude-opus-4-8");
    // Still pinned, still Anthropic: this is a pre-call SELECTION, not a
    // fallback, and it never moves vendor without the catalog saying so.
    expect(policy.policy).toBe("pinned");
    expect(policy.vendor ?? "anthropic").toBe("anthropic");
  }, 30000);

  it("routes the revision round on its own signals, not the first pass's", async () => {
    // A revision carries the reviewer's directive and a higher round number
    // on top of everything the first pass had. With 7 competitors the first
    // pass scores ~4.0 (standard); round 1 adds 1.0 for the round and 0.5 for
    // the reviewer's directive, clearing the threshold at ~5.5 — the same
    // document, re-scored because the instance genuinely changed.
    await env.store.writeJson(
      "acme",
      ["client", "competitors"],
      Array.from({ length: 7 }, (_, i) => ({ name: `Rival ${i}`, website: `https://rival${i}.example.com` })),
    );

    const router = fakeRouterSequence([finalTurn(goodIntelReport()), finalTurn(goodIntelReport())]);
    const workflowFn = createIntelReportAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "intel_route_revision";

    await engine.run(workflowFn, { ...params, runId });
    expect(policyAt(router, 0).model).toBe("claude-sonnet-4-6");

    await engine.resolveGate(runId, "04-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Rank the client honestly against Rival 2 and Rival 4 — the current placement is generous.",
      at: new Date().toISOString(),
    });
    const second = await engine.run(workflowFn, { ...params, runId });
    expect(second.status).toBe("awaiting_gate");
    expect(policyAt(router, 1).model).toBe("claude-opus-4-8");
  }, 30000);
});
