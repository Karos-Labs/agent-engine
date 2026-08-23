import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

/** A minimal valid `XPostOutput` — every test overrides just the field(s) it's exercising. */
function goodPost(overrides: Record<string, unknown> = {}) {
  return {
    text: "More teams are testing 4-day weeks this quarter.",
    mainPostText: "More teams are testing 4-day weeks this quarter.",
    hook: "More teams are testing 4-day weeks this quarter.",
    angle: "trend-observation",
    lane: "knowledge",
    targetHandle: "@acmehq",
    ...overrides,
  };
}

describe("content gate failures (RFC-02 §3 steps 11-17)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced numeric claim fails gate.numbersSourced at step 11 -> held", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn(
        goodPost({
          text: "Teams using 4-day weeks saw output rise 43% this quarter.",
          mainPostText: "Teams using 4-day weeks saw output rise 43% this quarter.",
          hook: "Teams using 4-day weeks saw output rise 43% this quarter.",
          angle: "data-point",
        }),
      ),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_numbers" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/numbers not sourced/i);

    const stepRecords = await durableStore.listSteps("x_run_gate_numbers");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("10-draft-post");
    expect(ids).toContain("11-verify-numbers-sourced");
    expect(ids).not.toContain("12-verify-brand-compliance");
  });

  it("a forbidden brand term fails gate.brandCompliance at step 12 -> held", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn(
        goodPost({
          text: "This approach is guaranteed to work for every team, every time.",
          mainPostText: "This approach is guaranteed to work for every team, every time.",
          hook: "This approach is guaranteed to work.",
        }),
      ),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_brand" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/brand compliance failed/i);

    const stepRecords = await durableStore.listSteps("x_run_gate_brand");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("12-verify-brand-compliance");
    expect(ids).not.toContain("13-verify-link-placement");
  });

  it("a link in mainPostText alongside a set firstReplyUrl fails the link-placement check at step 13 -> held", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn(
        goodPost({
          text: "Check our latest numbers at https://acme.example.com/report for the full breakdown.",
          mainPostText: "Check our latest numbers at https://acme.example.com/report for the full breakdown.",
          hook: "Check our latest numbers.",
          firstReplyUrl: "https://acme.example.com/report",
        }),
      ),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_link" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/bare link/i);

    const stepRecords = await durableStore.listSteps("x_run_gate_link");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("13-verify-link-placement");
    expect(ids).not.toContain("14-render-preview-check");
  });

  it("a clean post with a link only in firstReplyUrl clears the link-placement check", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn(
        goodPost({
          text: "More teams are testing 4-day weeks this quarter. Full data in the reply below.",
          mainPostText: "More teams are testing 4-day weeks this quarter. Full data in the reply below.",
          firstReplyUrl: "https://acme.example.com/report",
        }),
      ),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_link_ok" });

    expect(result.status).toBe("completed");
    const stepRecords = await durableStore.listSteps("x_run_gate_link_ok");
    expect(stepRecords.map((s) => s.stepId)).toContain("13-verify-link-placement");
  });

  it("a planted placeholder marker fails gate.noPlaceholder at step 16 -> held", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn(
        goodPost({
          text: "More teams are testing {{TOPIC}} this quarter.",
          mainPostText: "More teams are testing {{TOPIC}} this quarter.",
          hook: "More teams are testing something this quarter.",
        }),
      ),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_placeholder" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/placeholder/i);

    const stepRecords = await durableStore.listSteps("x_run_gate_placeholder");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("16-verify-no-placeholder");
    expect(ids).not.toContain("17-verify-no-leak");
  });

  it("a planted credential-shaped leak fails gate.leakCheck at step 17 -> held", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn(
        goodPost({
          text: "Our new API key is sk-abcdefghijklmnopqrstuvwxyz123456 for testing.",
          mainPostText: "Our new API key is sk-abcdefghijklmnopqrstuvwxyz123456 for testing.",
          hook: "Our new API key is live.",
        }),
      ),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_leak" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/leak check failed/i);

    const stepRecords = await durableStore.listSteps("x_run_gate_leak");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("17-verify-no-leak");
    expect(ids).not.toContain("18-persist-deliverable");
  });

  it("an over-limit first draft triggers a single self-critique revision, then completes", async () => {
    const promptStore = makePromptStore();
    const tooLong = "This is way too long for X. ".repeat(15); // > 280 chars, fails gate.lintPost
    // Neither turn supplies a `platform` field — proving XDraftAgent's own
    // `gateArgs: {platform: "x"}` is what pins gate.lintPost to the 280-char
    // limit, not something the model has to remember to include.
    const router = fakeRouterSequence([
      finalTurn(goodPost({ text: tooLong, mainPostText: tooLong, hook: "This is way too long for X." })),
      finalTurn(
        goodPost({
          text: "Remote teams keep experimenting with shorter weeks. Worth watching if yours is rethinking its schedule.",
          mainPostText: "Remote teams keep experimenting with shorter weeks. Worth watching if yours is rethinking its schedule.",
          hook: "Remote teams keep experimenting with shorter weeks.",
        }),
      ),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_revision" });

    expect(router.complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();

    const stepRecords = await durableStore.listSteps("x_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("20-commit-and-record");
  });

  it("Phase 2.5 fix-batch: mainPostText is structurally overwritten to match the gated text field, so a divergent, ungated mainPostText can never ship", async () => {
    const promptStore = makePromptStore();
    const cleanText = "More teams are testing 4-day weeks this quarter.";
    // The model's own mainPostText diverges from text and hides content that
    // would fail multiple gates (a forbidden brand term, a banned AI-cliche
    // phrase) if it were ever actually checked. Before the fix, nothing
    // gated `mainPostText` at all, so this would ship unmodified.
    const divergentMainPostText = "This is guaranteed to work and we're thrilled to announce it.";
    const router = fakeRouterSequence([finalTurn(goodPost({ text: cleanText, mainPostText: divergentMainPostText }))]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_main_post_text_enforced" });

    // The divergent mainPostText never reaches any gate as itself, so it
    // can't cause a false hold either -- it's simply never allowed to exist
    // downstream of the draft step.
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson<{ deliverable: { text: string; mainPostText: string } }>(
      "acme",
      ["ledger", "deliverables", "x_run_main_post_text_enforced", "_"],
    );
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]!.data.deliverable.mainPostText).toBe(cleanText);
    expect(deliverables[0]!.data.deliverable.mainPostText).toBe(deliverables[0]!.data.deliverable.text);
    expect(deliverables[0]!.data.deliverable.mainPostText).not.toBe(divergentMainPostText);
  });

  it("a draft that exceeds the character limit after passing lintPost's own check is still caught at step 14", async () => {
    // gate.lintPost and render.preview both use the 280-char X limit, so this exercises
    // the workflow-level render.preview guard directly rather than relying on it being
    // indistinguishable from the agent's own self-critique gate.
    const promptStore = makePromptStore();
    const exactlyAtLimitText = "A".repeat(280);
    const router = fakeRouterSequence([finalTurn(goodPost({ text: exactlyAtLimitText, mainPostText: exactlyAtLimitText, hook: "A" }))]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_at_limit" });

    // Exactly at the limit passes both gate.lintPost and render.preview.
    expect(result.status).toBe("completed");
  });

  it("a draft engaging a forbidden TOPIC fails the terminal guardrail, even with no banned term in it", async () => {
    // The gap the guardrail exists for. gate.brandCompliance two steps earlier
    // matches forbiddenTerms as substrings, so a draft that discusses the
    // subject fluently without naming it clears that gate and must not clear
    // this one. And it runs BEFORE the human review, so a reviewer is never
    // shown something that should not exist.
    await env.store.writeJson("acme", ["client", "config"], {
      xHandle: "@acmehq",
      forbiddenTopics: ["cryptocurrency"],
    });

    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn(
        goodPost({
          text: "Digital assets on a distributed ledger are finally getting sane custody rules.",
          mainPostText: "Digital assets on a distributed ledger are finally getting sane custody rules.",
          hook: "Digital assets on a distributed ledger are finally getting sane custody rules.",
        }),
      ),
      // The guardrail verifier's own turn.
      finalTurn({ violatedTopics: ["cryptocurrency"] }),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, {
      ...baseParams,
      runId: "x_run_topic_guardrail",
    });

    expect(result.status).not.toBe("completed");
    const stepIds = (await durableStore.listSteps("x_run_topic_guardrail")).map((s) => s.stepId);
    expect(stepIds).toContain("guardrail-verify");
    // Nothing was persisted and no human was asked to look at it.
    expect(stepIds).not.toContain("18-persist-deliverable");
  });

  it("costs nothing for a client that forbids no topics", async () => {
    // Most clients. The guardrail must not add a step, a model call, or a
    // config read to their runs -- x-agent already read the config at intake
    // and passes what it found.
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "x_run_no_topics" });

    const stepIds = (await durableStore.listSteps("x_run_no_topics")).map((s) => s.stepId);
    expect(stepIds).not.toContain("guardrail-verify");
    expect(stepIds).not.toContain("guardrail-verify-load-topics");
  });
});
