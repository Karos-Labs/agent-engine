import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { CompletionResult } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * Prep job viPcZ66rMVWk6HmiQImc (run pubsub-21699953559354996, 2026-09-06):
 * `10-draft-post` spent all eight turns calling `gate.lintPost` on
 * near-identical text — seven passes — and never returned the post, because
 * every Thought planned "run the gates, then output" and a turn carries one
 * tool call. The step ended `budget_exceeded`, the workflow threw a
 * `WorkflowToolingFailure`, and the portal showed a FAILED job over a draft
 * that had passed lint seven times.
 *
 * Three things changed, each tested here through the real workflow:
 *   1. the engine adds one commit turn after an exhausted loop (core);
 *   2. a draft that still exhausts is re-attempted once, told what it did;
 *   3. a second exhaustion HOLDS the run with that account as the reason.
 */

const baseParams = { clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };
/** `XDraftAgent` takes `BaseAgent`'s default working budget. */
const DRAFT_MAX_STEPS = 8;

function goodPost() {
  return {
    text: "More teams are testing 4-day weeks this quarter.",
    mainPostText: "More teams are testing 4-day weeks this quarter.",
    hook: "More teams are testing 4-day weeks this quarter.",
    angle: "trend-observation",
    lane: "knowledge",
    targetHandle: "@acmehq",
  };
}

/** The observed turn shape: lint the same passing text, again. */
function lintAgainTurn(): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "tool_call", tool: "gate.lintPost", args: { text: goodPost().text, platform: "x" } },
    modelUsed: "claude-sonnet-4-6",
    inputTokens: { cached: 6222, uncached: 23000 },
    outputTokens: 2200,
  });
}

/** Eight working turns of re-linting, then a commit turn that ALSO calls a tool — refused, so the step is `budget_exceeded`. */
function anExhaustedDraft(): Array<() => CompletionResult<unknown>> {
  return Array.from({ length: DRAFT_MAX_STEPS + 1 }, () => lintAgainTurn());
}

describe("the draft step's turn budget (x-agent 10-draft-post)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("a draft that re-lints through its whole budget is rescued by the commit turn inside the step", async () => {
    const router = fakeRouterSequence([...Array.from({ length: DRAFT_MAX_STEPS }, () => lintAgainTurn()), finalTurn(goodPost())]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "x_run_commit_turn" });

    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps("x_run_commit_turn");
    const draft = steps.find((s) => s.stepId === "10-draft-post")!;
    expect(draft.status).toBe("completed");
    // Eight working turns, the commit turn's final, the self-critique gate.
    expect((draft.output as { steps: unknown[] }).steps).toHaveLength(DRAFT_MAX_STEPS + 2);
    expect(steps.map((s) => s.stepId)).not.toContain("10-draft-post-attempt-2");
  });

  it("a draft that exhausts even its commit turn is re-attempted once, told what it did instead of finishing", async () => {
    const router = fakeRouterSequence([...anExhaustedDraft(), finalTurn(goodPost())]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "x_run_redraft" });

    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps("x_run_redraft");
    const first = steps.find((s) => s.stepId === "10-draft-post")!;
    const second = steps.find((s) => s.stepId === "10-draft-post-attempt-2")!;
    // The first attempt stays on the record as what it was — not a failure.
    expect(first.status).toBe("budget_exceeded");
    expect(first.error).toMatch(/called "gate\.lintPost" instead — refused, not executed/);
    expect(second.status).toBe("completed");

    // The redraft's prompt carries its predecessor's account.
    const redraftPrompt = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[DRAFT_MAX_STEPS + 1]![0] as string;
    expect(redraftPrompt).toContain('"commitDirective":"Your previous drafting attempt ran out of turns');
    expect(redraftPrompt).toContain("gate.lintPost ×9 (8 pass)");
    expect(redraftPrompt).toContain("AT MOST once");
  });

  it("a second exhaustion holds the run — never fails it — with the step's own account as the reason", async () => {
    const router = fakeRouterSequence([...anExhaustedDraft(), ...anExhaustedDraft()]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();

    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "x_run_held" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/^draft ran out of turns without returning a post: budget_exceeded after 9 turn\(s\), \$\d+\.\d\d; tool calls: gate\.lintPost ×9 \(8 pass\); /);
    expect(result.reason).toMatch(/refused, not executed$/);

    const ids = (await durableStore.listSteps("x_run_held")).map((s) => s.stepId);
    expect(ids).toContain("10-draft-post");
    expect(ids).toContain("10-draft-post-attempt-2");
    // One redraft, not a loop: the third attempt slot is never spent on this.
    expect(ids).not.toContain("10-draft-post-attempt-3");
    expect(ids).not.toContain("11-verify-numbers-sourced");
  });
});
