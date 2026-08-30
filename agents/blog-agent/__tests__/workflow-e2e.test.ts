import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  MemoryDurableStepStore,
  WorkflowEngine,
  serializeToDynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
} from "@agent-engine/workflow";
import { createBlogAgentWorkflow } from "../src/workflow/create-blog-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "blog_run_1", clientSlug: "acme", productId: "blog-agent", runKind: "recurring" as const };

const ALL_19_STEP_IDS = [
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
  "08-determine-angle",
  "09-draft-post",
  // AU20: the VERIFIED half of de-duplication. `recentPosts` in the drafting
  // prompt only asks the model not to repeat itself; 09a scores the finished
  // draft against the same excerpt window, inside the drafting pass, so the
  // reviewer is never shown a draft that was not measured.
  "09a-verify-not-duplicate",
  "10-verify-numbers-sourced",
  "11-verify-brand-compliance",
  "12-render-preview-check",
  "13-verify-no-placeholder",
  "14-verify-no-leak",
  // Revision-scoped: `-r0` is the first review round. A `revise` decision
  // registers `-r1` after re-drafting.
  "15-batch-review-r0",
  "16-persist-deliverable",
  "17-persist-manifest",
  "18-commit-and-record",
];

function goodDraft() {
  const title = "How We Cut Onboarding Time in Half With a Structured 4-Day Rollout";
  const bodyMarkdown =
    "## The problem with our old onboarding\n\n" +
    "New engineers took nearly a month before they shipped anything meaningful, and that gap was not caused by a lack of ability. " +
    "Most new hires spent the bulk of their first three weeks trying to figure out who to ask about a given system, which service " +
    "actually owned a piece of logic, and where the current version of a runbook lived. The technical material itself was rarely the " +
    "blocker. A new engineer could read the codebase just fine; what slowed everyone down was the absence of a predictable path through " +
    "that first week. Every cohort effectively reinvented onboarding from scratch, asking the same scattered questions in Slack channels " +
    "that had already answered them for someone else three months earlier. Managers noticed the pattern in retrospectives long before " +
    "anyone treated it as a process problem worth fixing directly, and for a while the informal fix was simply to assign a buddy and hope " +
    "the pairing worked out. Some pairings worked well. Many did not, and there was no consistent floor under the experience regardless " +
    "of which engineer happened to be free that week.\n\n" +
    "## What we actually changed\n\n" +
    "We restructured the first week into four fixed days, each with a specific and narrow goal instead of a loose list of things a new " +
    "hire should eventually get around to. Day one was environment setup end to end: local build, test suite, and a single deploy to a " +
    "sandbox environment, so that by the end of day one every new engineer had proof their machine actually worked. Day two paired the " +
    "new hire with an engineer who walked through the two or three systems most relevant to their team, focusing on how pieces connect " +
    "rather than reading every file line by line. Day three handed the new hire a small, genuinely scoped ticket, chosen in advance by " +
    "their manager so nobody spent the morning hunting for something appropriate to work on. Day four closed the week with a short " +
    "review session involving the whole team, where the new hire walked through what they built and asked the questions that had piled " +
    "up over the previous three days. Nothing about the underlying technical content changed; the structure around it was the entire " +
    "intervention, and that distinction mattered enormously once we started measuring results.\n\n" +
    "## The results after one quarter\n\n" +
    "Across the twelve engineers who went through the new process, median time to first merged pull request dropped sharply [1], falling " +
    "from nineteen days down to about ten. Just as important, the variance between individual engineers narrowed sharply: under the old " +
    "approach some new hires needed six weeks before their first real contribution while others needed nine days, and that spread alone " +
    "made it hard to plan work around new team members with any confidence. Retention at the ninety-day mark also held steady across the " +
    "cohort, which mattered to us as much as raw speed did, since a faster ramp that came at the cost of early attrition would not have " +
    "been a real win. Manager-reported confidence in new hires by the end of week one rose noticeably too, even though that metric is " +
    "harder to quantify cleanly than a pull request timestamp.\n\n" +
    "## What we would do differently\n\n" +
    "The biggest gap in our first run was documentation for the paired-engineer session on day two: two different pairs ran that session " +
    "in noticeably different ways, and new hires noticed the inconsistency immediately when they compared notes with each other. If your " +
    "team decides to try something similar, write the walkthrough script down before your first cohort goes through it, not after you " +
    "have already seen where it went sideways. We also underestimated how much day three depended on managers actually preparing a " +
    "ticket in advance; the one cohort where a manager scrambled to find a ticket the morning of day three was the one week where the " +
    "whole schedule slipped.\n\n" +
    "If your team is rethinking its own onboarding process, a structured first week is worth testing before you assume the underlying " +
    "problem is your documentation, your codebase, or your new hires themselves. The structure was the fix in our case, and it is worth " +
    "ruling out before reaching for a heavier one.";
  return {
    title,
    slug: "structured-four-day-onboarding-rollout",
    excerpt: "A breakdown of the onboarding changes that actually moved the needle for our engineering team.",
    bodyMarkdown,
    headersList: [
      "The problem with our old onboarding",
      "What we actually changed",
      "The results after one quarter",
      "What we would do differently",
    ],
    metaDescription: "How a structured 4-day onboarding rollout cut new-hire ramp time in half.",
    estimatedReadMinutes: 5,
    text: `${title}\n\n${bodyMarkdown}`,
    faqItems: [],
  };
}

function goodDraftRouter() {
  return fakeRouterSequence([finalTurn(goodDraft())]);
}

describe("end-to-end: the 19-step Blog agent workflow", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes all 19 steps and resolves to completed / domainOutcome: delivered (auto-approved gate)", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();
    expect(result.output.targetKeyword).toBe("engineering onboarding");
    expect(result.totalCostUsd).toBeGreaterThan(0);

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId).sort();
    expect(executedIds).toEqual([...ALL_19_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["blog-post"]);

    // The reserved topic was actually committed (consumed) at step 16, not left dangling.
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.some((t) => t.status === "committed")).toBe(true);

    const descriptors: DynamicAgentStepDescriptor[] = ALL_19_STEP_IDS.map((stepId) => ({
      stepId,
      label: stepId,
      type: stepId === "09-draft-post" ? "ai" : "code",
    }));
    const runRecord = await durableStore.getRun(params.runId);
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_blog_agent",
      specVersion: 1,
      steps: descriptors,
      stepRecords,
      slotRecords: [],
      ...(runRecord !== undefined ? { runRecord } : {}),
    });

    expect(report.domainOutcome).toBe("delivered");
    expect(report.steps.every((s) => s.status === "done")).toBe(true);
    const draftStep = report.steps.find((s) => s.stepId === "09-draft-post")!;
    expect(draftStep.costUsd).toBeGreaterThan(0);
    expect(draftStep.model).toBe("claude-sonnet-4-6");
  });

  it("pauses at the human batch-review gate by default, then resumes to completed on approval (RFC-01 §8.3)", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("15-batch-review-r0");

    const deliverablesBeforeApproval = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverablesBeforeApproval).toHaveLength(0);

    await engine.resolveGate(params.runId, "15-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(1);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["blog-post"]);

    // THE GATE IS A STEP RECORD TOO, now that `wf.step.gate` checkpoints
    // itself (`kind: "gate"`) — so the full id list appears here, gate
    // included, and this suite's own "N-step workflow" name is finally
    // literally true. This assertion used to filter "15-batch-review" OUT,
    // under a comment explaining that a gate never reaches `listSteps()`;
    // that absence is exactly what made a real run's step sequence read
    // straight past its human review step in the portal.
    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual([...ALL_19_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
    // And the checkpoint carries the DECISION, which is the only place the
    // run records that a human approved this and who they were.
    const gateStep = stepRecords.find((s) => s.kind === "gate");
    expect(gateStep?.stepId).toBe("15-batch-review-r0");
    expect(gateStep?.output).toMatchObject({ decision: "approve", actor: "jane@karoslabs.com" });
  });

  it("rejects the batch review with a reason -> held, and the deliverable never ships", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    await engine.run(workflowFn, params);
    await engine.resolveGate(params.runId, "15-batch-review-r0", {
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
});
