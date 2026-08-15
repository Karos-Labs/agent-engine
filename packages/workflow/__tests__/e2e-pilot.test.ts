import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { AgentContext } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import type { WorkflowContext } from "../src/index.js";
import {
  MemoryDurableStepStore,
  WorkflowContentFailure,
  WorkflowEngine,
  WorkflowToolingFailure,
  serializeToDynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
} from "../src/index.js";
import { fakeRouterAlwaysFinal, fakeRouterSequence, makeAgent } from "./test-helpers.js";

/**
 * A full pilot run through all three layers (RFC-01 §14's Definition of
 * Done, "one real end-to-end pilot run... executes through all three
 * layers"): Layer 1 orchestrates, Layer 2 (`BaseAgent`) reasons and
 * self-critiques, Layer 3 (`karos-*` tools, on the real file+git adapter) is
 * the only thing that ever touches storage.
 */

const RESEARCH_OUTPUT_SCHEMA = z.object({ topics: z.array(z.string()) });
const DRAFT_OUTPUT_SCHEMA = z.object({ text: z.string() });

function toAgentContext(wf: WorkflowContext): AgentContext {
  return {
    runId: wf.runId,
    clientSlug: wf.clientSlug,
    productId: wf.productId,
    runKind: wf.runKind,
    ...(wf.slotId !== undefined ? { slotId: wf.slotId } : {}),
    metadata: {},
  };
}

describe("end-to-end pilot: all 3 layers, one run", () => {
  let rootDir: string;
  let workspaceStore: WorkspaceStore;
  let tools: ReturnType<typeof createAllKarosTools>;
  let durableStore: MemoryDurableStepStore;
  let engine: WorkflowEngine;

  const params = {
    runId: "run_pilot_1",
    clientSlug: "acme",
    productId: "linkedin-agent",
    runKind: "recurring" as const,
  };

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-pilot-"));
    workspaceStore = new WorkspaceStore(rootDir);
    tools = createAllKarosTools(workspaceStore);
    durableStore = new MemoryDurableStepStore();
    engine = new WorkflowEngine(durableStore);

    // Seed Layer 3 fixture data — a client that's already been onboarded.
    await workspaceStore.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
    await workspaceStore.writeJson("acme", ["client", "voice-rules"], { tone: "confident, no jargon" });

    // Catalog order is deterministic (RFC-01 §9.2) — reserve(count:2) will take
    // exactly these first two, which is what the research agent's fake final
    // turn below is scripted to echo back.
    const seedCtx: AgentContext = { ...params, metadata: {} };
    await tools["topics.topUp"]!.execute({ topics: ["remote work", "hybrid teams", "AI adoption"] }, { ctx: seedCtx });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function buildWorkflowFn() {
    return async (wf: WorkflowContext) => {
      // --- Layer 1 step.code: context assembly, calling karos-client directly (no model judgment needed) ---
      const context = await wf.step.code("assemble-context", async () => {
        const ctx = toAgentContext(wf);
        const profile = await tools["client.getProfile"]!.execute({}, { ctx });
        const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });
        if (profile.status !== "success") {
          throw new Error("client profile not available");
        }
        return { profile: profile.result, voiceRules: voiceRules.status === "success" ? voiceRules.result : {} };
      });

      // --- Layer 1 step.agent -> Layer 2 BaseAgent -> Layer 3 karos-topics.reserve (real tool, real write-fence) ---
      const researchRouter = fakeRouterSequence([
        () => ({
          output: { type: "tool_call", tool: "topics.reserve", args: { reservationKey: "run_pilot_1__reserve", count: 2, excludeTopics: [] } },
          modelUsed: "claude-sonnet-4-6",
          inputTokens: { cached: 0, uncached: 80 },
          outputTokens: 20,
        }),
        () => ({
          output: { type: "final", output: { topics: ["remote work", "hybrid teams"] } },
          modelUsed: "claude-sonnet-4-6",
          inputTokens: { cached: 0, uncached: 120 },
          outputTokens: 15,
        }),
      ]);
      const researchAgent = makeAgent(RESEARCH_OUTPUT_SCHEMA, researchRouter, { tools }, { allowedTools: ["topics.reserve"] });
      const researchResult = await wf.step.agent("reserve-topics", researchAgent, context);
      if (researchResult.status !== "completed") {
        throw new WorkflowToolingFailure(`research step resolved to "${researchResult.status}"`);
      }
      const reservedTopics = researchResult.finalOutput!.topics;

      // --- fanout over 2 slots: one draft BaseAgent per platform, each self-critiquing via the REAL gate.brandCompliance ---
      const platforms = ["linkedin", "twitter"];
      const slotOutcomes = await wf.fanout("drafts", platforms, async (platform, slotCtx, index) => {
        const draftText =
          platform === "linkedin"
            ? "We've noticed more teams experimenting with flexible schedules this quarter — worth a look if you haven't already."
            : "Flexible schedules are reshaping how teams work this quarter. Worth a look.";
        const draftRouter = fakeRouterAlwaysFinal({ text: draftText }, { inputTokens: 90, outputTokens: 25 });
        const draftAgent = makeAgent(
          DRAFT_OUTPUT_SCHEMA,
          draftRouter,
          { tools },
          { allowedTools: [], selfCritique: { gateTool: "gate.brandCompliance", maxRevisions: 1 } },
        );
        // Each slot returns its BaseAgent's own AgentExecutionResult unchanged — the
        // slot checkpoint IS the agent result, which is what makes it directly
        // serializable as one "ai" step later (RFC-01 §7.2). Platform association
        // for later steps comes from `platforms[index]`, not from reshaping this.
        return slotCtx.step.agent("draft", draftAgent, { platform, topic: reservedTopics[index] });
      });

      // --- Layer 1 step.gate: await human batch review ---
      const decision = await wf.step.gate("batch-review", {
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          drafts: slotOutcomes.map((outcome, i) => ({
            platform: platforms[i],
            status: outcome.status,
            text: outcome.status === "completed" && outcome.output.status === "completed" ? outcome.output.finalOutput?.text : undefined,
          })),
        },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "escalate" },
      });
      if (decision.decision !== "approve") {
        throw new WorkflowContentFailure(`batch rejected: ${decision.reason ?? "no reason given"}`);
      }

      // --- Layer 1 step.code: persist deliverables via the REAL karos-ledger write tool ---
      const persisted = await wf.step.code("persist-deliverables", async () => {
        const ctx = toAgentContext(wf);
        const writes = [];
        for (let i = 0; i < slotOutcomes.length; i++) {
          const outcome = slotOutcomes[i]!;
          const platform = platforms[i]!;
          if (outcome.status !== "completed" || outcome.output.status !== "completed") continue;
          const writeOutcome = await tools["ledger.writeDeliverable"]!.execute(
            { runId: wf.runId, kind: `${platform}-post`, deliverable: { body: outcome.output.finalOutput!.text } },
            { ctx },
          );
          writes.push({ platform, writeOutcome });
        }
        return writes;
      });

      return { reservedTopics, slotOutcomes, persisted };
    };
  }

  it("pauses at the human gate, then completes after approval — persisting real deliverables through Layer 3", async () => {
    const workflowFn = buildWorkflowFn();

    const paused = await engine.run(workflowFn, params);
    expect(paused.status).toBe("awaiting_gate");
    expect(paused.status === "awaiting_gate" ? paused.pendingGateId : null).toBe("run_pilot_1__batch-review");

    // Nothing was persisted yet — the gate genuinely blocked the run.
    const beforeApproval = await workspaceStore.listJson("acme", ["ledger", "deliverables", "run_pilot_1", "_"]);
    expect(beforeApproval).toHaveLength(0);

    await engine.resolveGate("run_pilot_1", "batch-review", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: "2026-08-15T00:00:00Z",
    });

    const completed = await engine.run(workflowFn, params);
    expect(completed.status).toBe("completed");
    if (completed.status !== "completed") throw new Error("unreachable");

    expect(completed.output.reservedTopics).toEqual(["remote work", "hybrid teams"]);
    expect(completed.output.slotOutcomes.every((s) => s.status === "completed")).toBe(true);
    expect(completed.totalCostUsd).toBeGreaterThan(0);

    // The deliverables genuinely landed on disk via karos-ledger, tenant-scoped under "acme".
    const deliverables = await workspaceStore.listJson("acme", ["ledger", "deliverables", "run_pilot_1", "_"]);
    expect(deliverables.map((d) => d.id).sort()).toEqual(["linkedin-post", "twitter-post"]);
  });

  it("produces a valid DynamicAgentRunReport for the completed run (RFC-01 §7)", async () => {
    const workflowFn = buildWorkflowFn();
    await engine.run(workflowFn, params);
    await engine.resolveGate("run_pilot_1", "batch-review", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: "2026-08-15T00:00:00Z",
    });
    await engine.run(workflowFn, params);

    const stepRecords = await durableStore.listSteps("run_pilot_1");
    const slotRecords = await durableStore.listSlots("run_pilot_1", "drafts");

    const descriptors: DynamicAgentStepDescriptor[] = [
      { stepId: "assemble-context", label: "Assemble context", type: "code" },
      { stepId: "reserve-topics", label: "Reserve topics", type: "ai" },
      { stepId: "drafts__slot_0", label: "Draft — linkedin", type: "ai" },
      { stepId: "drafts__slot_1", label: "Draft — twitter", type: "ai" },
      { stepId: "persist-deliverables", label: "Persist deliverables", type: "code" },
    ];

    const report = serializeToDynamicAgentRunReport({
      specId: "spec_linkedin_pilot",
      specVersion: 1,
      steps: descriptors,
      stepRecords,
      slotRecords,
    });

    expect(report.specId).toBe("spec_linkedin_pilot");
    expect(report.steps).toHaveLength(5);
    expect(report.steps.every((s) => s.status === "done")).toBe(true);
    expect(report.failedStepId).toBeUndefined();
    expect(report.hasPartialOutput).toBeUndefined();

    const researchStep = report.steps.find((s) => s.stepId === "reserve-topics")!;
    expect(researchStep.type).toBe("ai");
    expect(researchStep.model).toBe("claude-sonnet-4-6");
    expect(researchStep.costUsd).toBeGreaterThan(0);
    expect(researchStep.tokensOut).toBeGreaterThan(0);
    expect(researchStep.usage?.numTurns).toBe(2); // tool_call turn + final turn

    const draftStep = report.steps.find((s) => s.stepId === "drafts__slot_0")!;
    expect(draftStep.usage?.numTurns).toBeGreaterThanOrEqual(1); // final turn (+ a gate-check row, zero-cost)

    const codeStep = report.steps.find((s) => s.stepId === "assemble-context")!;
    expect(codeStep.usage).toBeUndefined();
    expect(codeStep.costUsd).toBeUndefined();
  });

  it("rejects the batch at the gate and resolves the run to failed, persisting nothing", async () => {
    const workflowFn = buildWorkflowFn();
    await engine.run(workflowFn, params);

    await engine.resolveGate("run_pilot_1", "batch-review", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "voice doesn't match this quarter's campaign",
      at: "2026-08-15T00:00:00Z",
    });

    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.failureReason : "").toMatch(/voice doesn't match/);

    const deliverables = await workspaceStore.listJson("acme", ["ledger", "deliverables", "run_pilot_1", "_"]);
    expect(deliverables).toHaveLength(0);
  });
});
