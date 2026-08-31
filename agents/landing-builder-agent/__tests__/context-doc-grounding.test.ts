import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";
import type { ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLandingBuilderAgentWorkflow } from "../src/workflow/create-landing-builder-agent-workflow.js";
import { setupTestEnvironment, smartFakeRouter, makePromptStore, goodCopy, goodCompose, goodCraftVerdict, type TestEnvironment } from "./test-helpers.js";

/**
 * SCRUM-241 (T-A9). landing-builder-agent is the second of the two agents
 * this ticket describes as reading nothing from `client.getContextDoc` — in
 * fact it never called `client.getBrand` either; its only client input was
 * the one-time onboarding bundle (`landing.readBundle`'s `brand`/
 * `intakeMarkdown`). This asserts the whole path — fixture doc ->
 * `client.getContextDoc` -> 01b's checkpointed read -> the COPY step's
 * actual generated prompt — the same way the instagram-agent grounding test
 * does, and for the same reason: a test that only asserts the field was
 * fetched proves nothing about whether it reaches the model.
 */

/** Wraps `smartFakeRouter` in a `vi.fn` so calls are recorded, while keeping its schema-matching behavior (this workflow's three bounded steps use three different output schemas, so a strict call-order queue isn't reliable here). */
function spyRouter(candidates: readonly unknown[]): ModelRouter {
  const inner = smartFakeRouter(candidates);
  return { complete: vi.fn(inner.complete), completeAlias: inner.completeAlias } as unknown as ModelRouter;
}

describe("landing-builder-agent grounding: product-information (SCRUM-241/T-A9)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment("forge");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const baseParams = { clientSlug: "forge", productId: "s6", runKind: "setup" as const };

  it("reads the client's projected product-information doc and the copy step's actual prompt changes when its content varies", async () => {
    await env.store.writeJson("forge", ["context", "product-information"], {
      markdown: "FORGE's core differentiator is real-time load autoregulation via barbell velocity sensors, not just a workout log.",
    });

    const routerA = spyRouter([goodCopy(), goodCompose(), goodCraftVerdict()]);
    const workflowFnA = createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: routerA, autoApprove: true });
    const durableStoreA = new MemoryDurableStepStore();
    const resultA = await new WorkflowEngine(durableStoreA).run(workflowFnA, { ...baseParams, runId: "run_forge_pi_a" });
    expect(resultA.status).toBe("completed");

    const stepA = await durableStoreA.getStep("run_forge_pi_a", "01b-load-product-information");
    expect(stepA?.output).toBe("FORGE's core differentiator is real-time load autoregulation via barbell velocity sensors, not just a workout log.");

    // `landing-copy` is the schema every candidate in `[goodCopy(), goodCompose(), goodCraftVerdict()]`
    // is checked against first, so the FIRST `router.complete` call is the copy step's — find it by
    // its own stepId rather than assuming index, since `smartFakeRouter` doesn't guarantee call order.
    const callsA = (routerA.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const copyPromptA = callsA.map((c) => c[0] as string).find((p) => JSON.parse(p).stepId === "landing-copy")!;
    expect(copyPromptA).toContain("barbell velocity sensors");

    // A second, fresh run — a DIFFERENT client (a second build target
    // cannot reuse "forge"'s already-written site tree) with DIFFERENT
    // product information — proving the prompt tracks the document's
    // content, not a hardcoded string that merely happens to match run A.
    await env.cleanup();
    env = await setupTestEnvironment("forge2");
    await env.store.writeJson("forge2", ["context", "product-information"], {
      markdown: "FORGE's real differentiator is its 24/7 human coaching chat, available inside the app on every plan.",
    });
    const routerB = spyRouter([goodCopy(), goodCompose(), goodCraftVerdict()]);
    const workflowFnB = createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: routerB, autoApprove: true });
    const durableStoreB = new MemoryDurableStepStore();
    const resultB = await new WorkflowEngine(durableStoreB).run(workflowFnB, { ...baseParams, clientSlug: "forge2", runId: "run_forge_pi_b" });
    expect(resultB.status).toBe("completed");

    const callsB = (routerB.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const copyPromptB = callsB.map((c) => c[0] as string).find((p) => JSON.parse(p).stepId === "landing-copy")!;
    expect(copyPromptB).toContain("24/7 human coaching chat");
    expect(copyPromptB).not.toContain("barbell velocity sensors");
    expect(copyPromptA).not.toContain("24/7 human coaching chat");
  });

  it("builds normally when no product-information doc has been projected for this client (not_available, never blocking)", async () => {
    // No fixture written — client.getContextDoc reports not_available.
    const router = spyRouter([goodCopy(), goodCompose(), goodCraftVerdict()]);
    const workflowFn = createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "run_forge_pi_absent" });

    expect(result.status).toBe("completed");
    const step = await durableStore.getStep("run_forge_pi_absent", "01b-load-product-information");
    expect(step?.output).toBeNull();

    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const copyPrompt = calls.map((c) => c[0] as string).find((p) => JSON.parse(p).stepId === "landing-copy")!;
    expect(copyPrompt).not.toContain("productInformation");
  });
});
