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

  // SCRUM-242 (T-A10) superseded this case's old title and assertions
  // ("builds normally ... never blocking") — that was T-A9's own,
  // explicitly temporary behavior, called out in Batch 5's own doc: "a run
  // with every context doc absent still completes (T-A10 is what changes
  // that, not this ticket)." landing-builder-agent's row in the shared
  // CONTEXT_DOC_POLICY table is BLOCK, so a run with product-information
  // absent now resolves to `blocked_intake` before ever drafting — see
  // `context-doc-policy-fixture.test.ts` for the required cross-agent
  // assertion of this same behavior.
  it("BLOCKs (blocked_intake) when no product-information doc has been projected for this client (SCRUM-242/T-A10)", async () => {
    // `beforeEach`'s env carries the default (present) fixture `setupTestEnvironment()`
    // writes for every OTHER test in this repo — replace it with the true-absence
    // variant so client.getContextDoc genuinely reports not_available.
    await env.cleanup();
    env = await setupTestEnvironment("forge", { withContextDocs: false });
    const router = spyRouter([goodCopy(), goodCompose(), goodCraftVerdict()]);
    const workflowFn = createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId: "run_forge_pi_absent" });

    expect(result.status).toBe("blocked_intake");
    expect(result.status === "blocked_intake" ? result.reason : undefined).toContain("missing required context doc(s) [product-information]");

    const step = await durableStore.getStep("run_forge_pi_absent", "01b-load-product-information");
    expect(step?.output).toBeNull();

    // Blocked before ever drafting — the model is never called, so no cost is
    // spent building a page nobody should have gotten.
    expect(router.complete).not.toHaveBeenCalled();
  });
});
