import { afterEach, describe, expect, it } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine, CLEAN_GATE_TIMEOUT, FLAGGED_GATE_TIMEOUT } from "@agent-engine/workflow";
import type { RunKind } from "@agent-engine/core";
import type { PageParts } from "@agent-engine/tool-karos-landing";
import { createLandingBuilderAgentWorkflow } from "../src/workflow/create-landing-builder-agent-workflow.js";
import { landingFakeRouter, makePromptStore, sampleParts, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * A GATE THAT APPROVES ON TIMEOUT IS A DELAY, NOT A GATE.
 *
 * This gate carried a flat `1h / auto_approve`, which gave a page whose own
 * deterministic checks FAILED exactly the hour a clean page got: an hour of
 * nobody looking, and a page the engine had already said was not ready went
 * LIVE on a client's domain. The platform's three-tier policy
 * (`packages/workflow/src/primitives/gate-timeout.ts`) is what this run should
 * have been reading all along.
 *
 * Both halves are asserted, because asserting only the first is how a policy
 * like this quietly becomes a rubber stamp again:
 *
 *   * a clean build is UNTOUCHED — an hour, then it ships, exactly as before;
 *   * a build that failed its own checks waits six hours and then still ships,
 *     because a flag buys a reviewer TIME, not a veto.
 */

const params: { runId: string; clientSlug: string; productId: string; runKind: RunKind } = {
  runId: "landing_run_gate_clock",
  clientSlug: "northwind",
  productId: "landing-builder-agent",
  runKind: "setup",
};

async function pauseAtGate(env: TestEnvironment, router: ReturnType<typeof landingFakeRouter>["router"]) {
  const workflowFn = createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
  const durableStore = new MemoryDurableStepStore();
  const paused = await new WorkflowEngine(durableStore).run(workflowFn, params);
  if (paused.status !== "awaiting_gate") throw new Error(`expected the craft gate, got ${paused.status}`);
  const gate = await durableStore.getGate(paused.pendingGateId);
  return { gate, payload: (gate?.payload ?? {}) as Record<string, unknown> };
}

describe("what the clock on the landing craft gate is worth", () => {
  let env: TestEnvironment;
  afterEach(() => env.cleanup());

  it("a clean build keeps the hour it always had, and says so", async () => {
    env = await setupTestEnvironment();
    const { gate, payload } = await pauseAtGate(env, landingFakeRouter().router);

    expect(gate?.timeout?.duration).toBe(CLEAN_GATE_TIMEOUT);
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["gateWaitReason"]).toMatch(/nothing is flagged/i);
    // No flags list at all on a clean build: an empty section a reviewer has to
    // read past is how a notice becomes furniture.
    expect(payload["gateFlags"]).toBeUndefined();
  });

  it("a build that failed its own checks waits six hours — and still ships, rather than going in the bin", async () => {
    env = await setupTestEnvironment();
    // The same unsourced figure the e2e suite uses to fail the deterministic
    // floor; the fix pass returns it unchanged, so the page reaches the gate
    // still failing.
    const broken: PageParts = sampleParts();
    broken.sections[1]!.html = broken.sections[1]!.html.replace("Twelve agents run in production today.", "Trusted by 400+ teams.");
    const { gate, payload } = await pauseAtGate(env, landingFakeRouter({ parts: broken, fixedParts: broken }).router);

    expect(gate?.timeout?.duration).toBe(FLAGGED_GATE_TIMEOUT);
    // Six hours, then it SHIPS. A hold does not protect a page, it discards one.
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["status"]).toBe("needs_human");
    expect(payload["gateFlags"]).toEqual([expect.stringMatching(/did not pass its own deterministic checks/)]);
    expect(payload["gateWaitReason"]).toMatch(/waits for a person/i);
  });
});
