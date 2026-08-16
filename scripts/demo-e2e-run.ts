/**
 * Live, narrated end-to-end demo of agent-engine's three layers working
 * together in a single run: Layer 1 (`packages/workflow`) orchestrates,
 * Layer 2 (`BaseAgent`, `packages/core`) reasons and self-critiques, and
 * Layer 3 (`packages/tools`, the karos-* MCP servers) is the only thing that
 * ever touches storage. Every tool call below is real — real write-fence
 * enforcement, real `karos-gates` verdicts, real file-backed persistence —
 * only the *model* is faked (a scripted `ModelRouter`), so this runs with no
 * API key and no network call.
 *
 * Run with:
 *   npx tsx scripts/demo-e2e-run.ts
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  InMemoryPromptStore,
  MockAgent,
  type AgentContext,
  type AgentStepConfig,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelRouter,
} from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import {
  MemoryDurableStepStore,
  WorkflowContentFailure,
  WorkflowEngine,
  serializeToDynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
  type WorkflowContext,
} from "@agent-engine/workflow";

// ── tiny console-narration helpers (no dependency added just for a demo script) ──

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

function section(title: string): void {
  console.log();
  console.log(`${BOLD}${CYAN}${"=".repeat(78)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}${"=".repeat(78)}${RESET}`);
}

function sub(title: string): void {
  console.log();
  console.log(`${BOLD}${title}${RESET}`);
  console.log(`${DIM}${"-".repeat(70)}${RESET}`);
}

function info(label: string, value: unknown): void {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`  ${DIM}${label}:${RESET} ${rendered}`);
}

function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${RED}✗${RESET} ${msg}`);
}

function pause(msg: string): void {
  console.log(`  ${YELLOW}⏸${RESET} ${msg}`);
}

function narrate(msg: string): void {
  console.log(`  ${msg}`);
}

function skipped(msg: string): void {
  console.log(`  ${DIM}↻ ${msg} — SKIPPED (checkpoint already exists)${RESET}`);
}

// ── scripted "model" — no network, no API key; every tool call is real ──

function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    async complete() {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouterSequence: exhausted configured turns");
      return next();
    },
    async completeAlias() {
      throw new Error("completeAlias not used in this demo");
    },
  } as unknown as ModelRouter;
}

function finalTurn(output: unknown, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 30,
  });
}

function toolCallTurn(
  tool: string,
  args: unknown,
  opts: { model?: string; inputTokens?: number; outputTokens?: number } = {},
): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "tool_call", tool, args },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 20,
  });
}

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

const RESEARCH_OUTPUT_SCHEMA = z.object({ topics: z.array(z.string()) });
const DRAFT_OUTPUT_SCHEMA = z.object({ text: z.string() });

async function main(): Promise<void> {
  section("AGENT-ENGINE — PHASE 1 LIVE DEMO");
  narrate("One run, three layers: Layer 1 orchestrates, Layer 2 reasons + self-critiques, Layer 3 is the only thing that touches storage.");

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-engine-demo-"));
  const workspaceStore = new WorkspaceStore(rootDir);
  const tools = createAllKarosTools(workspaceStore);
  const durableStore = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(durableStore);

  const params = {
    runId: "demo_run_2026",
    clientSlug: "acme",
    productId: "linkedin-agent",
    runKind: "recurring" as const,
  };

  // ── 1. Run initialization + PromptStore resolution ──
  sub("[1/8] RUN INITIALIZATION + PromptStore resolution");
  info("runId", params.runId);
  info("clientSlug", params.clientSlug);
  info("productId", params.productId);
  info("runKind", params.runKind);

  const promptStore = new InMemoryPromptStore();
  promptStore.setPrompt("linkedin-voice", "1", "Be helpful.");
  promptStore.setPrompt("linkedin-voice", "2", "Always confident, never jargon. Cite a source for any numeric claim.");
  const resolvedPrompt = await promptStore.getPrompt("linkedin-voice", "2");
  narrate(`Resolving skillRef "linkedin-voice@2" via InMemoryPromptStore...`);
  ok(`resolved ${resolvedPrompt.length} chars: "${resolvedPrompt}"`);

  // Seed Layer 3 fixture data — a client that's already been onboarded, and a topic catalog.
  await workspaceStore.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  await workspaceStore.writeJson("acme", ["client", "voice-rules"], { tone: "confident, no jargon" });
  const seedCtx: AgentContext = { ...params, metadata: {} };
  await tools["topics.topUp"]!.execute({ topics: ["remote work", "hybrid teams", "AI adoption"] }, { ctx: seedCtx });
  ok("seeded client.profile, client.voice-rules, and a 3-topic catalog on the real file+git WorkspaceStore");

  function buildWorkflowFn() {
    return async (wf: WorkflowContext) => {
      // ── 2. step.code — assemble context via karos-client ──
      const context = await wf.step.code("assemble-context", async () => {
        narrate(`${MAGENTA}→ RUNNING${RESET} step.code "assemble-context"`);
        const ctx = toAgentContext(wf);
        const profile = await tools["client.getProfile"]!.execute({}, { ctx });
        const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });
        if (profile.status !== "success") throw new Error("client profile not available");
        info("client.getProfile", profile.result);
        info("client.getVoiceRules", voiceRules.status === "success" ? voiceRules.result : voiceRules);
        return { profile: profile.result, voiceRules: voiceRules.status === "success" ? voiceRules.result : {} };
      });

      // ── 3. step.agent — BaseAgent ReAct loop calling karos-topics.reserve ──
      const researchRouter = fakeRouterSequence([
        toolCallTurn("topics.reserve", { reservationKey: "demo_run_2026__reserve", count: 2, excludeTopics: [] }, { inputTokens: 80, outputTokens: 20 }),
        finalTurn({ topics: ["remote work", "hybrid teams"] }, { inputTokens: 120, outputTokens: 15 }),
      ]);
      const researchConfig: AgentStepConfig<{ topics: string[] }> = {
        id: "reserve-topics",
        description: "Reserve topics for this run's batch",
        allowedTools: ["topics.reserve"],
        outputSchema: RESEARCH_OUTPUT_SCHEMA,
        modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
        skillRef: "linkedin-voice@2",
      };
      const researchRuntime: BaseAgentRuntime = { router: researchRouter, tools, promptStore };
      const researchAgent = new MockAgent(researchRuntime, researchConfig);

      const researchResult = await wf.step.agent("reserve-topics", researchAgent, context);
      if (researchResult.status !== "completed") {
        throw new WorkflowContentFailure(`research step resolved to "${researchResult.status}"`);
      }
      const reservedTopics = researchResult.finalOutput!.topics;

      // ── 4. fanout over 2 slots — each a self-critiquing BaseAgent ──
      const platforms = ["linkedin", "twitter"];
      const slotLabels = ["p01", "p02"];
      const slotOutcomes = await wf.fanout("drafts", platforms, async (platform, slotCtx, index) => {
        const label = slotLabels[index];
        narrate(`${MAGENTA}→ RUNNING${RESET} fan-out slot [${label}] — drafting for "${platform}"`);
        const draftText =
          platform === "linkedin"
            ? "We've noticed more teams experimenting with flexible schedules this quarter — worth a look if you haven't already."
            : "Flexible schedules are reshaping how teams work this quarter. Worth a look.";
        const draftRouter = fakeRouterSequence([finalTurn({ text: draftText }, { inputTokens: 90, outputTokens: 25 })]);
        const draftConfig: AgentStepConfig<{ text: string }> = {
          id: "draft",
          description: `Draft a ${platform} post`,
          allowedTools: [],
          outputSchema: DRAFT_OUTPUT_SCHEMA,
          modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
          selfCritique: { gateTool: "gate.brandCompliance", maxRevisions: 1 },
        };
        const draftRuntime: BaseAgentRuntime = { router: draftRouter, tools };
        const draftAgent = new MockAgent(draftRuntime, draftConfig);

        const result = await slotCtx.step.agent("draft", draftAgent, { platform, topic: reservedTopics[index] });
        if (result.status !== "completed") throw new Error(`draft for "${platform}" resolved to "${result.status}"`);
        // Gate-check telemetry rows carry the bare GateVerdict as toolCall.result (RFC-01 §5.6) —
        // not wrapped in an AgentToolOutcome, unlike a regular tool_call row.
        const gateRow = result.steps.find((s) => s.toolCall?.name === "gate.brandCompliance");
        const verdict = gateRow?.toolCall?.result as { verdict: string } | undefined;
        ok(`[${label}] self-critique gate.brandCompliance → ${verdict?.verdict ?? "unknown"}`);
        ok(`[${label}] completed — cost: $${result.totalCostUsd.toFixed(6)}`);
        return result;
      });

      // ── 5. step.gate — pause for human batch review ──
      narrate("Registering gate \"batch-review\" (kind: batch_review, requiredRole: account_manager)...");
      const decision = await wf.step.gate("batch-review", {
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          drafts: slotOutcomes.map((outcome, i) => ({
            platform: platforms[i],
            text: outcome.status === "completed" && outcome.output.status === "completed" ? outcome.output.finalOutput?.text : undefined,
          })),
        },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "escalate" },
      });
      if (decision.decision !== "approve") {
        throw new WorkflowContentFailure(`batch rejected: ${decision.reason ?? "no reason given"}`);
      }

      // ── 6. step.code — persist deliverables via karos-ledger ──
      const persisted = await wf.step.code("persist-deliverables", async () => {
        narrate(`${MAGENTA}→ RUNNING${RESET} step.code "persist-deliverables"`);
        const ctx = toAgentContext(wf);
        const writes: Array<{ platform: string; id: string }> = [];
        for (let i = 0; i < slotOutcomes.length; i++) {
          const outcome = slotOutcomes[i]!;
          const platform = platforms[i]!;
          if (outcome.status !== "completed" || outcome.output.status !== "completed") continue;
          const writeOutcome = await tools["ledger.writeDeliverable"]!.execute(
            { runId: wf.runId, kind: `${platform}-post`, deliverable: { body: outcome.output.finalOutput!.text } },
            { ctx },
          );
          if (writeOutcome.status === "success") {
            const written = writeOutcome.result as { id: string; created: boolean };
            ok(`ledger.writeDeliverable(${platform}-post) → ${JSON.stringify(written)}`);
            writes.push({ platform, id: written.id });
          }
        }
        return writes;
      });

      return { reservedTopics, slotOutcomes, persisted };
    };
  }

  // ── 3b. isolated write-fence rejection demo (adversarial example) ──
  sub("[3b/8] WRITE-FENCE VALIDATION — adversarial example (isolated from the main run)");
  narrate('Simulating a model-supplied tool_call carrying a cross-tenant override: { ..., clientSlug: "attacker-corp" }');
  const adversarialRouter = fakeRouterSequence([
    toolCallTurn("topics.reserve", { reservationKey: "adversarial", count: 1, excludeTopics: [], clientSlug: "attacker-corp" }),
  ]);
  const adversarialConfig: AgentStepConfig<{ topics: string[] }> = {
    id: "adversarial-probe",
    description: "Adversarial probe for the write-fence demo",
    allowedTools: ["topics.reserve"],
    outputSchema: RESEARCH_OUTPUT_SCHEMA,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
  };
  const adversarialAgent = new MockAgent({ router: adversarialRouter, tools }, adversarialConfig);
  const adversarialCtx: AgentContext = { ...params, runId: "demo_adversarial_probe", metadata: {} };
  const adversarialResult = await adversarialAgent.run(adversarialCtx, {});
  const blockedRow = adversarialResult.steps[0];
  if (adversarialResult.status === "tooling_error" && blockedRow?.toolCall?.result) {
    const blocked = blockedRow.toolCall.result as { blocked: boolean; reason: string };
    fail(`write-fence BLOCKED the call: ${blocked.reason}`);
    ok('the tool ("topics.reserve") was never invoked — the fence rejected the call before execution');
  } else {
    fail("expected the write-fence to block this call, but it did not — investigate");
  }

  // ── run the real workflow ──
  section("[2–6/8] EXECUTING THE WORKFLOW (first pass)");
  const workflowFn = buildWorkflowFn();
  const firstRun = await engine.run(workflowFn, params);

  sub("[5/8] RUN PAUSED AT THE HUMAN GATE");
  pause(`status: "${firstRun.status}"`);
  if (firstRun.status === "awaiting_gate") {
    info("pendingGateId", firstRun.pendingGateId);
  }

  // ── 6. simulate human approval ──
  sub("[6/8] SIMULATING HUMAN APPROVAL");
  narrate('engine.resolveGate("demo_run_2026", "batch-review", { decision: "approve", actor: "jane@karoslabs.com" })');
  await engine.resolveGate(params.runId, "batch-review", {
    decision: "approve",
    actor: "jane@karoslabs.com",
    at: new Date(2026, 7, 15).toISOString(),
  });
  ok("gate resolved");

  // ── 7. resume — proving earlier steps are skipped, not re-executed ──
  section("[7/8] RESUMING THE RUN FROM CHECKPOINT");
  narrate("Re-invoking engine.run() with the SAME runId and the SAME workflow function...");
  narrate(`${DIM}(steps below that print nothing were never re-executed — their checkpoint short-circuited them)${RESET}`);
  console.log();
  skipped('step.code "assemble-context"');
  skipped('step.agent "reserve-topics"');
  skipped('fan-out "drafts" — both p01 and p02');
  console.log();
  const resumedRun = await engine.run(workflowFn, params);

  console.log();
  if (resumedRun.status === "completed") {
    ok(`run completed — total cost: $${resumedRun.totalCostUsd.toFixed(6)}`);
  } else {
    fail(`expected "completed", got "${resumedRun.status}"`);
  }

  // ── 8. serialize + print the final DynamicAgentRunReport ──
  section("[8/8] FINAL DynamicAgentRunReport");
  const runRecord = await durableStore.getRun(params.runId);
  const stepRecords = await durableStore.listSteps(params.runId);
  const slotRecords = await durableStore.listSlots(params.runId, "drafts");

  const descriptors: DynamicAgentStepDescriptor[] = [
    { stepId: "assemble-context", label: "Assemble context", type: "code" },
    { stepId: "reserve-topics", label: "Reserve topics", type: "ai" },
    { stepId: "drafts__slot_0", label: "Draft — linkedin (p01)", type: "ai" },
    { stepId: "drafts__slot_1", label: "Draft — twitter (p02)", type: "ai" },
    { stepId: "persist-deliverables", label: "Persist deliverables", type: "code" },
  ];

  const report = serializeToDynamicAgentRunReport({
    specId: "spec_linkedin_pilot_demo",
    specVersion: 1,
    steps: descriptors,
    stepRecords,
    slotRecords,
    ...(runRecord !== undefined ? { runRecord } : {}),
  });

  console.log(JSON.stringify(report, null, 2));

  // ── wrap up ──
  section("DEMO COMPLETE");
  ok(`run status: "${resumedRun.status}"${resumedRun.status === "completed" ? ` (domainOutcome: "${report.domainOutcome}")` : ""}`);
  ok(`total cost: $${resumedRun.status === "completed" ? resumedRun.totalCostUsd.toFixed(6) : "n/a"}`);
  ok(`steps in the final report: ${report.steps.length}, all "${report.steps.every((s) => s.status === "done") ? "done" : "mixed"}"`);

  await fs.rm(rootDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error();
  console.error(`${RED}${BOLD}DEMO FAILED${RESET}`);
  console.error(err);
  process.exitCode = 1;
});
