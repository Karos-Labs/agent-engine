import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createBrandedShortsAgentWorkflow } from "../src/workflow/create-branded-shorts-agent-workflow.js";
import { fakeRouterSequence, finalTurn, goodGraphicsPlan, goodHighlights, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * SCRUM-241 (T-A9). branded-shorts-agent is one of the two agents this
 * ticket describes as reading nothing from `client.getContextDoc` — it also
 * never called `client.getBrand`; its only "brand" input was the
 * video-render-specific `brand-profile.json` (colors/fonts for the FFmpeg
 * pipeline, not the portal's BrandKit). This asserts the whole path —
 * fixture doc -> `client.getContextDoc` -> 02b's checkpointed read -> the
 * graphics-planning step's actual generated prompt — the same way the
 * instagram-agent and landing-builder-agent grounding tests do.
 */
const params = { runId: "branded_shorts_run_ground", clientSlug: "acme", productId: "branded-shorts-agent", runKind: "setup" as const };

/** `fakeRouterSequence` (call-order queue): highlights (06), then graphics (08a) — the fixed order this happy path always takes. */
function orderedRouter() {
  return fakeRouterSequence([finalTurn(goodHighlights()), finalTurn(goodGraphicsPlan())]);
}

describe("branded-shorts-agent grounding: branding-guidelines (SCRUM-241/T-A9)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("reads the client's projected branding-guidelines doc and the graphics-planning step's actual prompt changes when its content varies", async () => {
    env = await setupTestEnvironment();
    await env.store.writeJson(env.clientSlug, ["context", "branding-guidelines"], {
      markdown: "Cutaway stills must never show a competitor's product or an identifiable person's face.",
    });

    const routerA = orderedRouter();
    const workflowFnA = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: routerA, autoApprove: true });
    const durableStoreA = new MemoryDurableStepStore();
    const resultA = await new WorkflowEngine(durableStoreA).run(workflowFnA, params);
    expect(resultA.status).toBe("completed");

    const stepA = await durableStoreA.getStep(params.runId, "02b-load-branding-guidelines");
    expect(stepA?.output).toBe("Cutaway stills must never show a competitor's product or an identifiable person's face.");

    // Turn 0 is highlights (06), turn 1 is graphics (08a-plan-graphics-attempt-1).
    const promptA = (routerA.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]![0] as string;
    expect(promptA).toContain("never show a competitor's product");

    // A second, fresh run with DIFFERENT branding guidelines — proving the
    // prompt tracks the document's content, not a hardcoded string.
    await env.cleanup();
    env = await setupTestEnvironment();
    await env.store.writeJson(env.clientSlug, ["context", "branding-guidelines"], {
      markdown: "Every cutaway must be framed in strict 1:1 center-crop, matching the client's grid-locked visual system.",
    });
    const routerB = orderedRouter();
    const workflowFnB = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: routerB, autoApprove: true });
    const durableStoreB = new MemoryDurableStepStore();
    const resultB = await new WorkflowEngine(durableStoreB).run(workflowFnB, params);
    expect(resultB.status).toBe("completed");

    const promptB = (routerB.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]![0] as string;
    expect(promptB).toContain("grid-locked visual system");
    expect(promptB).not.toContain("never show a competitor's product");
    expect(promptA).not.toContain("grid-locked visual system");
  });

  it("builds normally when no branding-guidelines doc has been projected for this client (not_available, never blocking)", async () => {
    env = await setupTestEnvironment();
    // No fixture written — client.getContextDoc reports not_available.
    const router = orderedRouter();
    const workflowFn = createBrandedShortsAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);

    expect(result.status).toBe("completed");
    const step = await durableStore.getStep(params.runId, "02b-load-branding-guidelines");
    expect(step?.output).toBeNull();

    const prompt = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]![0] as string;
    expect(prompt).not.toContain("brandingGuidelines");
  });
});
