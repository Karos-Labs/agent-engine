import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  MemoryDurableStepStore,
  WorkflowEngine,
  serializeToDynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
} from "@agent-engine/workflow";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import {
  DEFAULT_TARGET_THREAD_TITLE,
  DEFAULT_TARGET_THREAD_URL,
  fakeRouterSequence,
  finalTurn,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "reddit_run_1", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

const ALL_22_STEP_IDS = [
  "00-channel-setup",
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  // The read side of the feedback flywheel: what this client asked for on
  // previous runs, injected into the drafting prompt.
  "04e-read-past-feedback",
  // The shipped-output window (dedup) and the client intel report, read
  // once each — see history-dedup.ts in packages/workflow.
  "read-output-history",
  "read-intel-context",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  "08-select-target-thread",
  "09-check-thread-not-answered",
  "10-verify-subreddit-eligibility",
  "11-determine-angle",
  "12-draft-reply",
  "13-verify-numbers-sourced",
  "14-verify-brand-compliance",
  "15-verify-no-placeholder",
  "16-verify-leak-check",
  "17-render-preview-check",
  // Revision-scoped: `-r0` is the first review round. A `revise` decision
  // registers `-r1` after re-drafting.
  "18-batch-review-r0",
  "19-persist-deliverable",
  "20-persist-manifest",
  "21-commit-and-record",
];

function goodDraft() {
  const replyBody =
    "We run a small B2B SaaS shop and moved most of engineering to a 4-day week last quarter as a trial.\n\n" +
    "Sick days dropped noticeably across the team, and shipped feature count stayed roughly flat.\n\n" +
    "Has anyone else run a trial like this? Curious what broke for you that didn't show up in the first month.";
  return {
    targetThreadUrl: DEFAULT_TARGET_THREAD_URL,
    targetThreadTitle: DEFAULT_TARGET_THREAD_TITLE,
    replyBody,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
    text: replyBody,
  };
}

function goodDraftRouter() {
  return fakeRouterSequence([finalTurn(goodDraft())]);
}

describe("end-to-end: the 23-step Reddit agent reply-only workflow", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes all 23 steps and resolves to completed / domainOutcome: delivered (auto-approved gate)", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();
    expect(result.output.targetThreadUrl).toBe(DEFAULT_TARGET_THREAD_URL);
    expect(result.output.targetSubreddit).toBe("smallbusiness");
    expect(result.totalCostUsd).toBeGreaterThan(0);

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId).sort();
    expect(executedIds).toEqual([...ALL_22_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["reddit-reply"]);

    // The reserved topic was actually committed (consumed) at the final step, not left dangling.
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.some((t) => t.status === "committed")).toBe(true);

    // The target thread URL is recorded so a future run's step 09 dedup check can find it.
    const decisions = await env.store.listJson("acme", ["memory", "products", params.productId, "decisions"]);
    expect(decisions.some((d) => (d.data as { summary: string }).summary.includes(DEFAULT_TARGET_THREAD_URL))).toBe(true);

    const descriptors: DynamicAgentStepDescriptor[] = ALL_22_STEP_IDS.map((stepId) => ({
      stepId,
      label: stepId,
      type: stepId === "12-draft-reply" ? "ai" : "code",
    }));
    const runRecord = await durableStore.getRun(params.runId);
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_reddit_agent",
      specVersion: 1,
      steps: descriptors,
      stepRecords,
      slotRecords: [],
      ...(runRecord !== undefined ? { runRecord } : {}),
    });

    expect(report.domainOutcome).toBe("delivered");
    expect(report.steps.every((s) => s.status === "done")).toBe(true);
    const draftStep = report.steps.find((s) => s.stepId === "12-draft-reply")!;
    expect(draftStep.costUsd).toBeGreaterThan(0);
    expect(draftStep.model).toBe("claude-sonnet-4-6");
  });

  it("pauses at the human batch-review gate by default, then resumes to completed on approval (RFC-01 §8.3)", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("18-batch-review-r0");

    const deliverablesBeforeApproval = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverablesBeforeApproval).toHaveLength(0);

    await engine.resolveGate(params.runId, "18-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(1);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["reddit-reply"]);

    // THE GATE IS A STEP RECORD TOO, now that `wf.step.gate` checkpoints
    // itself (`kind: "gate"`) — so the full id list appears here, gate
    // included, and this suite's own "N-step workflow" name is finally
    // literally true. This assertion used to filter "18-batch-review" OUT,
    // under a comment explaining that a gate never reaches `listSteps()`;
    // that absence is exactly what made a real run's step sequence read
    // straight past its human review step in the portal.
    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual([...ALL_22_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
    // And the checkpoint carries the DECISION, which is the only place the
    // run records that a human approved this and who they were.
    const gateStep = stepRecords.find((s) => s.kind === "gate");
    expect(gateStep?.stepId).toBe("18-batch-review-r0");
    expect(gateStep?.output).toMatchObject({ decision: "approve", actor: "jane@karoslabs.com" });
  });

  it("rejects the batch review with a reason -> held, and the deliverable never ships", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    await engine.run(workflowFn, params);
    await engine.resolveGate(params.runId, "18-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "not on brand this week",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    // `runReviewCycle` is generic across agents, so the wording is
    // "review rejected" rather than anything channel-specific.
    expect(result.reason).toMatch(/review rejected/i);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  });

  it("holds the run when the client has no target thread candidate — a submission-only fallback is never fabricated", async () => {
    const noThreadEnv = await setupTestEnvironment({ withTargetThread: false });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ tools: noThreadEnv.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...params, runId: "reddit_run_no_thread" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/no target thread available/i);
    expect(router.complete).not.toHaveBeenCalled();

    await noThreadEnv.cleanup();
  });

  it("holds the run when requestedThreadUrl isn't a real reddit.com thread URL", async () => {
    await env.store.writeJson("acme", ["client", "config"], {
      targetSubreddits: ["smallbusiness"],
      requestedThreadUrl: "https://example.com/not-reddit",
      requestedThreadTitle: "Not a real thread",
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...params, runId: "reddit_run_bad_thread_url" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/doesn't look like a real reddit\.com thread URL/i);
    expect(router.complete).not.toHaveBeenCalled();
  });
});
