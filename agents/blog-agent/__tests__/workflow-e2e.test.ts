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

const ALL_16_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  "08-determine-angle",
  "09-draft-post",
  "10-verify-numbers-sourced",
  "11-verify-brand-compliance",
  "12-render-preview-check",
  "13-persist-deliverable",
  "14-persist-manifest",
  "15-commit-and-record",
];

function goodDraft() {
  const title = "How We Cut Onboarding Time in Half With a Structured 4-Day Rollout";
  const bodyMarkdown =
    "## The problem with our old onboarding\n\nNew engineers took nearly a month before they shipped anything meaningful.\n\n" +
    "## What we actually changed\n\nWe restructured the first week into four fixed days.\n\n" +
    "## The results after one quarter\n\nMedian time to first merged pull request dropped 47% [1], from 19 days to about 10.";
  return {
    title,
    slug: "structured-four-day-onboarding-rollout",
    excerpt: "A breakdown of the onboarding changes that actually moved the needle for our engineering team.",
    bodyMarkdown,
    headersList: ["The problem with our old onboarding", "What we actually changed", "The results after one quarter"],
    metaDescription: "How a structured 4-day onboarding rollout cut new-hire ramp time in half.",
    estimatedReadMinutes: 3,
    text: `${title}\n\n${bodyMarkdown}`,
  };
}

describe("end-to-end: the 16-step Blog agent workflow", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes all 16 steps and resolves to completed / domainOutcome: delivered", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });

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
    expect(executedIds).toEqual([...ALL_16_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["blog-post"]);

    // The reserved topic was actually committed (consumed) at step 15, not left dangling.
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.some((t) => t.status === "committed")).toBe(true);

    const descriptors: DynamicAgentStepDescriptor[] = ALL_16_STEP_IDS.map((stepId) => ({
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
});
