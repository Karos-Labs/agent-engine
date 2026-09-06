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

/**
 * Every step a REQUESTED-thread run executes (a caller named the thread, so
 * no scan and no scout). The scanned path adds `06-scout-thread` and, when a
 * charter was auto-derived, `04a-plan-channel`/`04b-record-auto-charter`; see
 * thread-discovery.test.ts and blocked-intake.test.ts for those.
 */
const REQUESTED_PATH_STEP_IDS = [
  "00-channel-setup",
  "00a-load-client-config",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-read-intel-context",
  "04c-intake-check",
  "04d-read-past-feedback",
  "04e-read-output-history",
  "05-discover-threads",
  "07-select-target-thread",
  // The thread itself — the poster's text and the existing replies — read
  // live. Every version before this drafted from the title alone.
  "08-fetch-thread",
  "09-check-thread-not-answered",
  "10-verify-subreddit-eligibility",
  // Research runs FOR the chosen thread, after it is known, not before.
  "11-research-pull",
  "11a-determine-angle",
  "12-draft-reply",
  "12a-verify-not-duplicate",
  "13-verify-numbers-sourced",
  "14-verify-brand-compliance",
  "15-verify-no-placeholder",
  "16-verify-leak-check",
  "17-render-preview-check",
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

describe("end-to-end: the Reddit agent reply-only workflow, requested-thread path", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes every step and resolves to completed / domainOutcome: delivered (auto-approved gate)", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBe(DEFAULT_TARGET_THREAD_TITLE);
    // The caller's URL, verbatim — it is their bookmark.
    expect(result.output.targetThreadUrl).toBe(DEFAULT_TARGET_THREAD_URL);
    expect(result.output.targetSubreddit).toBe("smallbusiness");
    expect(result.totalCostUsd).toBeGreaterThan(0);

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId).sort();
    expect(executedIds).toEqual([...REQUESTED_PATH_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // No scan ran: the caller named the thread. Only the thread itself was read.
    expect(env.redditRequests.filter((u) => u.includes("/new.rss"))).toEqual([]);
    expect(env.redditRequests.some((u) => u.includes("/comments/abc123/.rss"))).toBe(true);

    // The draft was handed the thread's own text and existing replies.
    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const draftPrompt = String(calls[0]![0]);
    expect(draftPrompt).toContain("client response times slipped on Fridays");
    expect(draftPrompt).toContain("meetings compress into the four days");

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson<{ deliverable: { charterSource: string; threadSource: string } }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["reddit-reply"]);
    expect(deliverables[0]!.data.deliverable.charterSource).toBe("client-config");
    expect(deliverables[0]!.data.deliverable.threadSource).toBe("reddit-feed");

    // The target thread URL is recorded so a future run's dedup checks can find it.
    const decisions = await env.store.listJson("acme", ["memory", "products", params.productId, "decisions"]);
    expect(decisions.some((d) => (d.data as { summary: string }).summary.includes(DEFAULT_TARGET_THREAD_URL))).toBe(true);

    const descriptors: DynamicAgentStepDescriptor[] = REQUESTED_PATH_STEP_IDS.map((stepId) => ({
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
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router });

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

    // The gate is a step record too (`kind: "gate"`), so the full id list
    // appears here, gate included, and it carries the DECISION — the only
    // place the run records that a human approved this and who they were.
    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual([...REQUESTED_PATH_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
    const gateStep = stepRecords.find((s) => s.kind === "gate");
    expect(gateStep?.stepId).toBe("18-batch-review-r0");
    expect(gateStep?.output).toMatchObject({ decision: "approve", actor: "jane@karoslabs.com" });
  });

  it("rejects the batch review with a reason -> held, and the deliverable never ships", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router });

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
    expect(result.reason).toMatch(/review rejected/i);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  });

  it("still drafts when the thread itself cannot be read: title only, and the draft is told so", async () => {
    // The scan and everything else work; only this one thread's feed is refused.
    const brokenEnv = await setupTestEnvironment({ reddit: { statusFor: (url) => (url.includes("/comments/abc123/.rss") ? 403 : undefined) } });
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createRedditAgentWorkflow({ ...brokenEnv.workflowOptions, tools: brokenEnv.tools, promptStore, router, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "reddit_run_unreadable_thread" });

    expect(result.status).toBe("completed");
    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const draftPrompt = String(calls[0]![0]);
    expect(draftPrompt).toContain("only its title is known");
    expect(draftPrompt).toContain('"source":"unavailable"');
    await brokenEnv.cleanup();
  });

  it("holds the run when requestedThreadUrl isn't a real reddit.com thread URL", async () => {
    await env.store.writeJson("acme", ["client", "config"], {
      targetSubreddits: ["smallbusiness"],
      requestedThreadUrl: "https://example.com/not-reddit",
      requestedThreadTitle: "Not a real thread",
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...params, runId: "reddit_run_bad_thread_url" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/doesn't look like a real reddit\.com thread URL/i);
    expect(router.complete).not.toHaveBeenCalled();
  });

  it("a thread URL typed into the run's own input outranks the one in client config", async () => {
    const promptStore = makePromptStore();
    const other = "https://www.reddit.com/r/smallbusiness/comments/def456/late_paying_clients/";
    const router = fakeRouterSequence([finalTurn({ ...goodDraft(), targetThreadUrl: other, targetThreadTitle: "How do you handle late-paying clients without souring the relationship?" })]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore, router, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "reddit_run_input_thread", input: { requestedThreadUrl: other } });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.targetThreadUrl).toBe(other);
    // No title was supplied, so the thread's own title was read from Reddit.
    expect(result.output.topic).toBe("How do you handle late-paying clients without souring the relationship?");
  });
});
