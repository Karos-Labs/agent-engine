import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
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

/**
 * SCRUM-241 (T-A9). instagram-agent is one of the two agents this ticket
 * describes as reading nothing from `client.getContextDoc` — before this
 * ticket, no fixed-workflow agent in this repo ever called that tool at
 * all. This asserts the whole path, the same way `workflow-e2e.test.ts`'s
 * own "reads the client's profile description..." test asserts
 * `clientVoiceContext`'s path: fixture doc -> `client.getContextDoc` ->
 * 02e's checkpointed read -> the copy step's ACTUAL prompt (the exact
 * argument the model router received, not merely a step record).
 *
 * The ticket's own decisive invariant: "a document that is read must
 * actually influence the prompt, not merely enter an object and sit
 * unused." A test that only asserts one fixed markdown value appears
 * cannot distinguish real plumbing from a hardcoded string sitting next to
 * an unused tool call — so this drafts twice, with two DIFFERENT
 * branding-guidelines bodies, and asserts each run's copy-step prompt
 * contains ONLY its own run's content and not the other's.
 */
const params = { runId: "instagram_run_grounding", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

function happyRouter() {
  return fakeRouterSequence([
    finalTurn(goodResearchOutput()),
    finalTurn(goodCopyOutput()),
    finalTurn(goodImageVettingOutput()),
    finalTurn(goodVisualQaOutput()),
  ]);
}

async function runWithBrandingGuidelines(env: TestEnvironment, markdown: string) {
  await env.store.writeJson("acme", ["context", "branding-guidelines"], { markdown });

  const router = happyRouter();
  const workflowFn = createInstagramAgentWorkflow({
    tools: testTools(env),
    promptStore: makePromptStore(),
    router,
    repoRoot: env.repoRoot,
    imageCandidatePool: goodImageCandidatePool(),
    autoApprove: true,
  });
  const durableStore = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(durableStore);
  const result = await engine.run(workflowFn, params);
  return { result, router, durableStore };
}

describe("instagram-agent grounding: branding-guidelines (SCRUM-241/T-A9)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("reads the client's projected branding-guidelines doc and the copy step's actual prompt changes when its content varies", async () => {
    const runA = await runWithBrandingGuidelines(env, "Never show identifiable human faces in photography — product and interface only.");
    expect(runA.result.status).toBe("completed");

    const stepA = await runA.durableStore.getStep(params.runId, "02e-load-branding-guidelines");
    expect(stepA?.output).toBe("Never show identifiable human faces in photography — product and interface only.");

    // The copy-writing model call is the second turn (research, then copy).
    // `copyCall[0]` is `BaseAgent.buildTurnPrompt`'s own return value — the
    // literal per-turn prompt string sent to the model, not the (separately
    // cached) system/craft-policy text, which would contain the word
    // "brandingGuidelines" regardless of whether any client had one
    // projected, since that's where §11's field DOCUMENTATION lives.
    const promptA = (runA.router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]![0] as string;
    expect(promptA).toContain("Never show identifiable human faces");

    // A second, fresh run for the SAME client with DIFFERENT branding
    // guidelines — proving the prompt tracks the document's content, not a
    // hardcoded string that merely happens to match run A.
    await env.cleanup();
    env = await setupTestEnvironment();
    const runB = await runWithBrandingGuidelines(env, "Lead every slide with the client's signature deep-teal palette; never use warm tones.");
    expect(runB.result.status).toBe("completed");

    const promptB = (runB.router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]![0] as string;
    expect(promptB).toContain("signature deep-teal palette");
    expect(promptB).not.toContain("Never show identifiable human faces");
    expect(promptA).not.toContain("signature deep-teal palette");
  }, 60000);

  it("completes normally when no branding-guidelines doc has been projected for this client (not_available, never blocking)", async () => {
    // No fixture written at all — client.getContextDoc reports not_available.
    const router = happyRouter();
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    const step = await durableStore.getStep(params.runId, "02e-load-branding-guidelines");
    expect(step?.output).toBeNull();

    const prompt = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]![0] as string;
    expect(prompt).not.toContain("brandingGuidelines");
  }, 60000);
});
