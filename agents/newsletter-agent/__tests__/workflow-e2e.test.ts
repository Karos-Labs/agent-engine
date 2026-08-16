import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  MemoryDurableStepStore,
  WorkflowEngine,
  serializeToDynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
} from "@agent-engine/workflow";
import { createNewsletterAgentWorkflow } from "../src/workflow/create-newsletter-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "newsletter_run_1", clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring" as const };

const ALL_16_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topics",
  "07-select-candidates",
  "08-determine-edition-theme",
  "09-draft-post",
  "10-verify-numbers-sourced",
  "11-verify-brand-compliance",
  "12-render-preview-check",
  "13-persist-deliverable",
  "14-persist-manifest",
  "15-commit-and-record",
];

function goodDraft() {
  const intro = "This week we're looking at what's actually working for engineering teams right now.";
  const sections = [
    { heading: "Structured onboarding cuts ramp time", body: "New-hire ramp time dropped 47% [1] after a fixed four-day onboarding rollout." },
    { heading: "Async standups are gaining ground", body: "A few teams have replaced daily standups with async written updates." },
  ];
  const callToAction = { text: "Read the full breakdown", url: "https://example.com/full" };
  const signoff = "— The Acme Weekly Team";
  const text =
    `${intro}\n\n` +
    sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n") +
    `\n\n${callToAction.text}\n\n${signoff}`;
  return {
    subjectLine: "3 teams cut onboarding time in half",
    previewText: "Plus: async standups are quietly replacing daily syncs.",
    intro,
    sections,
    callToAction,
    signoff,
    text,
  };
}

describe("end-to-end: the 16-step Newsletter agent workflow", () => {
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
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.mainStory).toBeTruthy();
    expect(result.output.targetAudience).toBe("engineering leaders at mid-size B2B SaaS companies");
    expect(result.totalCostUsd).toBeGreaterThan(0);

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId).sort();
    expect(executedIds).toEqual([...ALL_16_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["newsletter-edition"]);

    // The reserved topics were actually committed (consumed) at step 15, not left dangling.
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.some((t) => t.status === "committed")).toBe(true);

    // A multi-topic reservation (main + secondary) really committed more than one topic.
    const committedCount = catalog?.filter((t) => t.status === "committed").length ?? 0;
    expect(committedCount).toBeGreaterThan(1);

    const descriptors: DynamicAgentStepDescriptor[] = ALL_16_STEP_IDS.map((stepId) => ({
      stepId,
      label: stepId,
      type: stepId === "09-draft-post" ? "ai" : "code",
    }));
    const runRecord = await durableStore.getRun(params.runId);
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_newsletter_agent",
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
