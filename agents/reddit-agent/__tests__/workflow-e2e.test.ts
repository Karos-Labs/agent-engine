import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  MemoryDurableStepStore,
  WorkflowEngine,
  serializeToDynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
} from "@agent-engine/workflow";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "reddit_run_1", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

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
  const title = "Our team switched to a 4-day week 3 months ago — sharing what actually changed";
  const body =
    "We run a small B2B SaaS shop and moved most of engineering to a 4-day week last quarter as a trial.\n\n" +
    "Internal tracking showed an 18% [1] drop in reported sick days across the team.\n\n" +
    "Has anyone else run a trial like this?";
  return {
    title,
    body,
    targetSubreddit: "smallbusiness",
    flair: "",
    hook: "We run a small B2B SaaS shop and moved most of engineering to a 4-day week last quarter as a trial.",
    text: `${title}\n\n${body}`,
  };
}

describe("end-to-end: the 16-step Reddit agent workflow", () => {
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
    const workflowFn = createRedditAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();
    expect(result.output.targetSubreddit).toBe("smallbusiness");
    expect(result.totalCostUsd).toBeGreaterThan(0);

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId).sort();
    expect(executedIds).toEqual([...ALL_16_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["reddit-post"]);

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
      specId: "spec_reddit_agent",
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
