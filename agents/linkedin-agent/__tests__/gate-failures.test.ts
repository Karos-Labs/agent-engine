import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { allProse, deliveredPost, fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

function baseFields() {
  return {
    headline: "A headline",
    hashtags: ["HybridWork"],
    callToAction: "Think about it.",
    takeaway: "Predictability, not enforcement, is what made the schedule stick.",
    targetAudience: "Operations leaders",
    archetype: "teardown-framework" as const,
  };
}

describe("content gate failures are REPAIRED, never held (RFC-02 §5 steps 09-14r)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("an unsourced numeric claim is removed from the post, which still ships", async () => {
    const promptStore = makePromptStore();
    const text = "Teams using anchor days saw scheduling conflicts fall 43% this quarter.";
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: text, body: text, text }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_numbers" });

    // The old contract was `held`: the run ended and the client got an error
    // message instead of the post. The gate keeps its authority over what may
    // be PUBLISHED, asserted below; it lost the authority to end the run.
    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "linkedin_run_gate_numbers");
    expect(allProse(post)).not.toContain("43%");
    expect(post["contentRepairs"]).toBeDefined();

    const ids = (await durableStore.listSteps("linkedin_run_gate_numbers")).map((s) => s.stepId);
    expect(ids).toContain("10-verify-numbers-sourced");
    expect(ids).toContain("11-verify-brand-compliance");
    expect(ids).toContain("14r-repair-post");
  });

  it("a forbidden brand term is removed from the post, which still ships", async () => {
    const promptStore = makePromptStore();
    const text = "This approach is guaranteed to work for every team, every time.";
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: text, body: text, text }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_brand" });

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "linkedin_run_gate_brand");
    expect(allProse(post)).not.toContain("guaranteed");

    const ids = (await durableStore.listSteps("linkedin_run_gate_brand")).map((s) => s.stepId);
    expect(ids).toContain("11-verify-brand-compliance");
    expect(ids).toContain("12-render-preview-check");
  });

  it("a draft dated to the day it was written is REPAIRED by the model, not shipped as written", async () => {
    // A LinkedIn post is drafted now and published after review — often days
    // later. "yesterday" is true only on the day it was typed, so by the time
    // anyone reads it the sentence is simply wrong. The check names the
    // phrase; the redraft is asked to date the claim and does.
    const promptStore = makePromptStore();
    const dated = "We moved the whole team onto anchor days yesterday, and the calendar already looks different.";
    const fixed = "We moved the whole team onto anchor days on September 15, and the calendar already looks different.";
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: dated, body: dated, text: dated }),
      finalTurn({ ...baseFields(), hook: fixed, body: fixed, text: fixed }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_dated_redraft" });

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "linkedin_run_dated_redraft");
    expect(allProse(post)).not.toContain("yesterday");
    // The good case: the model dates the claim itself, so the post keeps the
    // timing rather than losing it to a deletion.
    expect(allProse(post)).toContain("on September 15");

    const ids = (await durableStore.listSteps("linkedin_run_dated_redraft")).map((s) => s.stepId);
    expect(ids).toContain("14r-repair-post");
  });

  it("a redraft that keeps the relative day loses the phrase to the floor, across every field, and the post still ships", async () => {
    // The floor that makes the rule unconditional. The model is asked once and
    // hands back a draft still anchored to "yesterday", so the phrase is
    // DELETED rather than replaced — nothing here knows what date the writer
    // meant, and inventing one is the failure the rule exists to prevent.
    const promptStore = makePromptStore();
    const dated = "Our new onboarding flow went live yesterday.";
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: dated, body: dated, text: dated }),
      finalTurn({ ...baseFields(), hook: dated, body: dated, text: dated }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_dated_floor" });

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "linkedin_run_dated_floor");
    // Every field, not just the published `text`: a phrase deleted from one
    // and left in the `body` beside it reads as the rule not working.
    expect(allProse(post)).not.toContain("yesterday");
    // Deleted, not replaced — the rest of the sentence is untouched.
    expect(post["text"]).toContain("Our new onboarding flow went live");
    expect(post["body"]).toContain("Our new onboarding flow went live");

    const repairs = post["contentRepairs"] as Array<{ check: string; action: string }>;
    expect(repairs).toContainEqual(expect.objectContaining({ check: "linkedin-dated-language", action: "redacted" }));
  });

  it("an over-limit first draft triggers a single self-critique revision, then completes", async () => {
    const promptStore = makePromptStore();
    const tooLong = "This paragraph is way too long for LinkedIn. ".repeat(100); // > 3000 chars, fails gate.lintPost
    // No `platform` field on either turn's output — LinkedInDraftAgent's own
    // `gateArgs: {platform: "linkedin"}` is what pins gate.lintPost to the
    // 3000-char limit here, not something the model has to remember to include.
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: "This paragraph is way too long for LinkedIn.", body: tooLong, text: tooLong }),
      finalTurn({
        ...baseFields(),
        hook: "Remote teams keep experimenting with anchor days.",
        body: "Worth watching if yours is rethinking its hybrid schedule.",
        text: "Remote teams keep experimenting with anchor days.\n\nWorth watching if yours is rethinking its hybrid schedule.\n\n#HybridWork",
      }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_revision" });

    expect(router.complete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();

    const stepRecords = await durableStore.listSteps("linkedin_run_gate_revision");
    expect(stepRecords.map((s) => s.stepId)).toContain("18-commit-and-record");
  });

  it("a draft exactly at the character limit passes both gate.lintPost and render.preview at step 12", async () => {
    const promptStore = makePromptStore();
    const exactlyAtLimitText = "A".repeat(3000);
    const router = fakeRouterSequence([
      finalTurn({ ...baseFields(), hook: "A", body: exactlyAtLimitText, text: exactlyAtLimitText }),
    ]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_at_limit" });

    expect(result.status).toBe("completed");
  });

  it("brand.requiredDisclaimer is passed to gate.brandCompliance, and a post omitting it has it APPENDED", async () => {
    await env.store.writeJson("acme", ["client", "brand"], {
      forbiddenTerms: ["guaranteed", "the best", "#1"],
      requiredDisclaimer: "Results may vary by team.",
    });
    const promptStore = makePromptStore();
    const text = "We tried a new onboarding flow this month and tracked how a small group of customers responded.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), hook: text, body: text, text })]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_disclaimer_missing" });

    // A missing disclaimer is the one brand failure fixed by ADDING rather
    // than deleting, and it is fixable exactly: the client configured the
    // sentence verbatim, so the repair appends that sentence and nothing else.
    // No legal copy is invented on the client's behalf.
    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "linkedin_run_gate_disclaimer_missing");
    expect(post["text"]).toContain("Results may vary by team.");
    // ...and the original sentence survived the repair intact.
    expect(post["text"]).toContain("We tried a new onboarding flow this month");

    const repairs = post["contentRepairs"] as Array<{ action: string }>;
    expect(repairs).toContainEqual(expect.objectContaining({ action: "rewritten" }));
    expect(repairs).not.toContainEqual(expect.objectContaining({ action: "unresolved" }));
  });

  it("a draft that includes the client's required disclaimer verbatim clears gate.brandCompliance", async () => {
    await env.store.writeJson("acme", ["client", "brand"], {
      forbiddenTerms: ["guaranteed", "the best", "#1"],
      requiredDisclaimer: "Results may vary by team.",
    });
    const promptStore = makePromptStore();
    const text =
      "We tried a new onboarding flow this month and tracked how a small group of customers responded.\n\nResults may vary by team.";
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), hook: text, body: text, text })]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_disclaimer_present" });

    expect(result.status).toBe("completed");
  });

  it("an unresolved placeholder marker is removed, and the leak check still runs after it", async () => {
    const promptStore = makePromptStore();
    const hook = "We tried something new with our onboarding flow this month.";
    const body = "We rolled out {{FEATURE_NAME}} to a small group of customers and tracked how they responded.";
    const callToAction = "Let us know if a similar approach might help your team.";
    const text = `${hook}\n\n${body}\n\n${callToAction}\n\n#HybridWork`;
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), hook, body, callToAction, text })]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_placeholder" });

    expect(result.status).toBe("completed");

    const post = await deliveredPost(env, "linkedin_run_gate_placeholder");
    expect(allProse(post)).not.toContain("{{FEATURE_NAME}}");

    const ids = (await durableStore.listSteps("linkedin_run_gate_placeholder")).map((s) => s.stepId);
    expect(ids).toContain("13-verify-no-placeholder");
    expect(ids).toContain("14-verify-no-leak");
  });

  it("a leaked local file path is removed from every field before the post reaches a human", async () => {
    const promptStore = makePromptStore();
    const hook = "We tried something new with our onboarding flow this month.";
    const body = "Full rollout notes live at C:\\Users\\jane\\rollout-notes.txt if you want the detailed breakdown.";
    const callToAction = "Happy to share more context if useful.";
    const text = `${hook}\n\n${body}\n\n${callToAction}\n\n#HybridWork`;
    const router = fakeRouterSequence([finalTurn({ ...baseFields(), hook, body, callToAction, text })]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_gate_leak" });

    expect(result.status).toBe("completed");

    // Gone from `body` too, not just the gated `text` — the deliverable ships
    // every field, so this is the assertion that catches a half-repair.
    const post = await deliveredPost(env, "linkedin_run_gate_leak");
    expect(allProse(post)).not.toContain("rollout-notes.txt");

    const ids = (await durableStore.listSteps("linkedin_run_gate_leak")).map((s) => s.stepId);
    expect(ids).toContain("14-verify-no-leak");
    expect(ids).toContain("15-batch-review-r0");
  });
});
