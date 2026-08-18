import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createBrandedShortsStyleExplorationWorkflow } from "../src/workflow/create-branded-shorts-style-exploration-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodStyleCandidates,
  makePromptStore,
  offPaletteStyleCandidates,
  setupTestEnvironment,
  smartFakeRouter,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "style_exploration_run", clientSlug: "acme", productId: "branded-shorts-agent", runKind: "setup" as const };

describe("createBrandedShortsStyleExplorationWorkflow (RFC-06 onboarding)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    await env.store.writeJson(env.clientSlug, ["client", "brand"], { palette: { accent: "#FF6B2C" }, fonts: ["Spectral"] });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("proposes three candidates and locks the auto-approved one (candidate zero) when autoApprove is set", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodStyleCandidates()]);
    const workflowFn = createBrandedShortsStyleExplorationWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.candidates).toHaveLength(3);
    expect(result.output.lockedCandidateName).toBe(goodStyleCandidates().candidates[0]!.name);

    const beliefs = await env.store.readJson(env.clientSlug, ["memory", "beliefs"]);
    expect((beliefs as { brandedShortsLockedStyle?: { name: string } })?.brandedShortsLockedStyle?.name).toBe(goodStyleCandidates().candidates[0]!.name);
  });

  it("without autoApprove, pauses at the style_exploration_lock gate", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodStyleCandidates()]);
    const workflowFn = createBrandedShortsStyleExplorationWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "style_exploration_run_gated" });

    expect(result.status).toBe("awaiting_gate");
  });

  it("resolves to failed (tooling failure) when the human names a candidate that was never proposed", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodStyleCandidates()]);
    const workflowFn = createBrandedShortsStyleExplorationWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "style_exploration_run_bad_lock";
    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "02-style-lock", { decision: "approve", actor: "human", reason: "Some Candidate That Was Never Proposed", at: new Date().toISOString() });
    const result = await engine.run(workflowFn, { ...params, runId });

    expect(result.status).toBe("degraded");
  });

  it("rejects candidates citing an off-brand hex, then revises to a clean set and locks it (P1#6 token fidelity gate)", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(offPaletteStyleCandidates()), finalTurn(goodStyleCandidates())]);
    const workflowFn = createBrandedShortsStyleExplorationWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "style_exploration_run_off_palette" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // The revised (clean) set is what actually gets locked — never the off-palette draft.
    expect(result.output.candidates[0]!.paletteTokensUsed).toEqual(["#FF6B2C"]);
    expect(result.output.lockedCandidateName).toBe(goodStyleCandidates().candidates[0]!.name);
  });

  it("resolves to held (never a silent lock) when every revision still cites an off-brand hex (maxRevisions exhausted)", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(offPaletteStyleCandidates()), finalTurn(offPaletteStyleCandidates())]);
    const workflowFn = createBrandedShortsStyleExplorationWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "style_exploration_run_always_off_palette" });

    expect(result.status).toBe("held");
  });

  it("resolves to held when the human rejects every candidate", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodStyleCandidates()]);
    const workflowFn = createBrandedShortsStyleExplorationWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "style_exploration_run_rejected";
    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "02-style-lock", { decision: "reject", actor: "human", reason: "none of these fit the brand", at: new Date().toISOString() });
    const result = await engine.run(workflowFn, { ...params, runId });

    expect(result.status).toBe("held");
  });
});
