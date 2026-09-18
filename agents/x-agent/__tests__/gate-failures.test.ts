import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import {
  allProse,
  deliveredPost, fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

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

describe("content gate failures are REPAIRED, never held (RFC-02 §3 steps 11-14r)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced numeric claim is removed from the post, which still ships", async () => {
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
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_numbers" });

    // The old contract was `held`. The gate keeps its authority over what may
    // be PUBLISHED, asserted below; it lost the authority to end the run.
    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "x_run_gate_numbers");
    expect(allProse(post)).not.toContain("43%");

    const ids = (await durableStore.listSteps("x_run_gate_numbers")).map((s) => s.stepId);
    expect(ids).toContain("11-verify-numbers-sourced");
    expect(ids).toContain("12-verify-brand-compliance");
    expect(ids).toContain("14r-repair-post");
  });

  it("a forbidden brand term is removed from the post, which still ships", async () => {
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
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_brand" });

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "x_run_gate_brand");
    expect(allProse(post)).not.toContain("guaranteed");

    // Every later check still runs, on the repaired post — the brand gate no
    // longer short-circuits the ones after it.
    const ids = (await durableStore.listSteps("x_run_gate_brand")).map((s) => s.stepId);
    expect(ids).toContain("12-verify-brand-compliance");
    expect(ids).toContain("13-verify-link-placement");
    expect(ids).toContain("14r-repair-post");
  });

  it("a link in mainPostText alongside a set firstReplyUrl is REMOVED from the body, not held", async () => {
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
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_gate_link" });

    expect(result.status).toBe("completed");

    // The URL is gone from the body and the thread. Nothing is lost: it is
    // already in `firstReplyUrl`, which is exactly where the rule wants it.
    const post = await deliveredPost(env, "x_run_gate_link");
    expect(allProse(post)).not.toContain("https://acme.example.com/report");
    expect(post["firstReplyUrl"]).toBe("https://acme.example.com/report");

    const ids = (await durableStore.listSteps("x_run_gate_link")).map((s) => s.stepId);
    expect(ids).toContain("13-verify-link-placement");
    expect(ids).toContain("14-render-preview-check");
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

  it("a planted placeholder marker is removed before the post reaches the human gate", async () => {
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

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "x_run_gate_placeholder");
    expect(allProse(post)).not.toContain("{{TOPIC}}");

    // AU13's invariant still holds, and is now stronger: the finding is
    // surfaced AND repaired before the human gate, so the reviewer sees a
    // clean post rather than approving one that would then be killed with no
    // revision path.
    const ids = (await durableStore.listSteps("x_run_gate_placeholder")).map((s) => s.stepId);
    expect(ids).toContain("14c-verify-no-placeholder");
    expect(ids).toContain("14r-repair-post");
    expect(ids.indexOf("14r-repair-post")).toBeLessThan(ids.indexOf("15-batch-review-r0"));
  });

  it("a planted credential-shaped leak is removed before the post reaches the human gate", async () => {
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

    expect(result.status).toBe("completed");

    // The credential is gone from `text` AND `mainPostText` — the two are kept
    // in lockstep precisely so a repair cannot clean one and ship the other.
    const post = await deliveredPost(env, "x_run_gate_leak");
    expect(allProse(post)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");

    const ids = (await durableStore.listSteps("x_run_gate_leak")).map((s) => s.stepId);
    expect(ids).toContain("14d-verify-no-leak");
    expect(ids).toContain("18-persist-deliverable");
    expect(ids.indexOf("14r-repair-post")).toBeLessThan(ids.indexOf("15-batch-review-r0"));
  });

  it("a draft dated to the day it was written is REPAIRED by the model, not shipped as written", async () => {
    // "yesterday" is true only on the day the model writes it. The post is
    // reviewed and published later, so by the time anyone reads it the
    // sentence is simply wrong. The check names the phrase; the redraft is
    // asked to date the claim properly and does.
    const promptStore = makePromptStore();
    const dated = "We shipped our new scheduling view yesterday and teams are already moving meetings.";
    const fixed = "We shipped our new scheduling view on September 15 and teams are already moving meetings.";
    const router = fakeRouterSequence([
      finalTurn(goodPost({ text: dated, mainPostText: dated, hook: "We shipped our new scheduling view." })),
      finalTurn(goodPost({ text: fixed, mainPostText: fixed, hook: "We shipped our new scheduling view." })),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_dated_redraft" });

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "x_run_dated_redraft");
    expect(allProse(post)).not.toContain("yesterday");
    // The redraft is kept whole, dateline and all -- this is the good case,
    // where the model fixes the sentence rather than the floor deleting a word.
    expect(allProse(post)).toContain("on September 15");

    const ids = (await durableStore.listSteps("x_run_dated_redraft")).map((s) => s.stepId);
    expect(ids).toContain("14r-repair-post");
  });

  it("a redraft that keeps the relative day loses the phrase to the floor, and the post still ships", async () => {
    // The floor that makes the rule unconditional. The model is asked once and
    // hands back a draft still anchored to "yesterday", so nothing is gained by
    // asking again: the phrase is DELETED. "went live yesterday" becomes "went
    // live" -- less specific, never false. Substituting a date would mean
    // inventing one, which is the failure the rule exists to prevent.
    const promptStore = makePromptStore();
    const dated = "Our redesigned pricing page went live yesterday.";
    const router = fakeRouterSequence([
      finalTurn(goodPost({ text: dated, mainPostText: dated, hook: "Our redesigned pricing page is live." })),
      finalTurn(goodPost({ text: dated, mainPostText: dated, hook: "Our redesigned pricing page is live." })),
    ]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_dated_floor" });

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "x_run_dated_floor");
    expect(allProse(post)).not.toContain("yesterday");
    // Deleted, not replaced: the rest of the sentence is untouched.
    expect(post["text"]).toContain("Our redesigned pricing page went live");
    expect(post["mainPostText"]).toBe(post["text"]);

    const repairs = post["contentRepairs"] as Array<{ check: string; action: string }>;
    expect(repairs).toContainEqual(expect.objectContaining({ check: "x-post-shape", action: "redacted" }));
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
          // Under the 70-character hook ceiling Craft 01 §5 now enforces: this
          // fixture is about the TOPIC guardrail, and a hook that trips the
          // length rule first would never reach it.
          hook: "Distributed-ledger assets are getting sane custody rules.",
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
