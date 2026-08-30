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

const ALL_20_STEP_IDS = [
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
  "06-reserve-topics",
  "07-select-candidates",
  "08-determine-edition-theme",
  "09-draft-post",
  // AU20: the VERIFIED half of de-duplication. `recentPosts` in the drafting
  // prompt only asks the model not to repeat itself; 09a scores the finished
  // draft against the same excerpt window, inside the drafting pass, so the
  // reviewer is never shown a draft that was not measured.
  "09a-verify-not-duplicate",
  "10-verify-brand-compliance",
  "11-verify-numbers-sourced",
  "12-verify-compliance-footer",
  "13-verify-no-placeholder",
  "14-verify-no-leak",
  "15-render-preview-check",
  // Revision-scoped: `-r0` is the first review round. A `revise` decision
  // registers `-r1` after re-drafting.
  "16-batch-review-r0",
  "17-persist-deliverable",
  "18-persist-manifest",
  "19-commit-and-record",
];

function goodDraft() {
  const intro = "This week we're looking at what's actually working for engineering teams right now.";
  // No numeric claims: sources is always [] in production today (research.pull
  // is a Phase-1 stand-in), and gate.numbersSourced now cross-checks the exact
  // figure against source content rather than accepting a bare citation marker.
  const sections = [
    { heading: "Structured onboarding cuts ramp time", body: "New-hire ramp time dropped sharply after a fixed four-day onboarding rollout." },
    { heading: "Async standups are gaining ground", body: "A few teams have replaced daily standups with async written updates." },
  ];
  const callToAction = { text: "Read the full breakdown", url: "https://example.com/full" };
  const signoff = "The Acme Weekly Team";
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

function goodDraftRouter() {
  return fakeRouterSequence([finalTurn(goodDraft())]);
}

describe("end-to-end: the 20-step Newsletter agent workflow", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes all 20 steps and resolves to completed / domainOutcome: delivered (auto-approved gate)", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

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
    expect(executedIds).toEqual([...ALL_20_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["newsletter-edition"]);

    // The reserved topics were actually committed (consumed) at step 16, not left dangling.
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.some((t) => t.status === "committed")).toBe(true);

    // A multi-topic reservation (main + secondary) really committed more than one topic.
    const committedCount = catalog?.filter((t) => t.status === "committed").length ?? 0;
    expect(committedCount).toBeGreaterThan(1);

    const descriptors: DynamicAgentStepDescriptor[] = ALL_20_STEP_IDS.map((stepId) => ({
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

  it("pauses at the human batch-review gate by default, then resumes to completed on approval (RFC-01 §8.3)", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("16-batch-review-r0");

    const deliverablesBeforeApproval = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverablesBeforeApproval).toHaveLength(0);

    await engine.resolveGate(params.runId, "16-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(1);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["newsletter-edition"]);

    // THE GATE IS A STEP RECORD TOO, now that `wf.step.gate` checkpoints
    // itself (`kind: "gate"`) — so the full id list appears here, gate
    // included, and this suite's own "N-step workflow" name is finally
    // literally true. This assertion used to filter "16-batch-review" OUT,
    // under a comment explaining that a gate never reaches `listSteps()`;
    // that absence is exactly what made a real run's step sequence read
    // straight past its human review step in the portal.
    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual([...ALL_20_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
    // And the checkpoint carries the DECISION, which is the only place the
    // run records that a human approved this and who they were.
    const gateStep = stepRecords.find((s) => s.kind === "gate");
    expect(gateStep?.stepId).toBe("16-batch-review-r0");
    expect(gateStep?.output).toMatchObject({ decision: "approve", actor: "jane@karoslabs.com" });
  });

  it("rejects the batch review with a reason -> held, and the deliverable never ships", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    await engine.run(workflowFn, params);
    await engine.resolveGate(params.runId, "16-batch-review-r0", {
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
