import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "instagram_run_countcheck", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

describe("09b-deliver-and-log: rendered PNG count must exactly match slide count (RFC-03 §3 step 09)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("refuses to log a deliverable when the render tool reports fewer rendered PNGs than slides -- a real, checked invariant", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);

    // A deliberately broken stand-in for publish.renderCarousel: reports
    // "success" but with fewer rendered entries than slides were requested --
    // simulating a hypothetical bug in the render tool itself, which step
    // 09b must catch as a real invariant, not just trust the tool's own
    // "success" verdict at face value.
    const writeDeliverableSpy = vi.spyOn(env.tools["ledger.writeDeliverable"]!, "execute");
    const brokenRenderTool: AgentToolRegistry[string] = {
      ...env.tools["publish.renderCarousel"]!,
      execute: vi.fn(async () => ({ status: "success" as const, result: { rendered: [{ n: 1, path: "fake/slide-1.png" }] } })),
    };
    const tools: AgentToolRegistry = { ...env.tools, "publish.renderCarousel": brokenRenderTool };

    const workflowFn = createInstagramAgentWorkflow({
      tools,
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("unreachable");
    expect(result.failureReason).toMatch(/rendered PNG count \(1\) does not match slide count \(6\)/i);

    // The mismatch was caught BEFORE any deliverable was ever written or the
    // topic claim committed -- never a partial/inconsistent delivery.
    expect(writeDeliverableSpy).not.toHaveBeenCalled();
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.some((t) => t.status === "committed")).toBe(false);
  }, 30000);
});
