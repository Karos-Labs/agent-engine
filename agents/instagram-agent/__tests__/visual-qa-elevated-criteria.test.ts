import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodBrandTokens,
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
 * SCRUM-324 (AU40) — the required evidence: a deterministic pre-check
 * failure short-circuits `instagram-visual-qa` WITHOUT a model call, and the
 * elevated criteria actually sent to the model shrink to match what code has
 * already verified. Without a test like this one, per the ticket, the
 * "ordering makes it cheap" claim is unproven — "a longer prompt," not a
 * real cost/reliability improvement.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function fakeLogoFetch(): typeof fetch {
  return (async () => ({
    ok: true,
    headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
  })) as unknown as typeof fetch;
}

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/** The qa turn's own input, pulled back out of `router.complete`'s recorded prompt argument. */
function qaTurnInput(router: ReturnType<typeof fakeRouterSequence>, callIndex: number): Record<string, unknown> {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  const promptArg = complete.mock.calls[callIndex]?.[0];
  if (typeof promptArg !== "string") throw new Error(`expected call ${callIndex} to have a string prompt argument`);
  const parsed = JSON.parse(promptArg) as { input?: Record<string, unknown> };
  if (!parsed.input) throw new Error(`call ${callIndex}'s prompt carried no "input" field: ${promptArg}`);
  return parsed.input;
}

describe("08a2-visual-qa-pre-checks: an off-kit accent color short-circuits the model entirely", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    // A client whose portal-authored brand.json accent ("#ABCDEF", the sole
    // member of the kit ring built by AU39's buildAccentRing) genuinely
    // disagrees with the instagramStyleConfig accentColor ("#123456") the
    // render actually paints every slide with — a real, realistic config
    // drift between two brand sources of truth, not a synthetic hook.
    env = await setupTestEnvironment({ brandTokens: goodBrandTokens({ accentColor: "#123456" }) });
    await env.store.writeJson("acme", ["client", "brand"], { accent: "#ABCDEF" });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("never calls the model for visual QA, on any of the 3 attempts, and holds the run with the deterministic reason", async () => {
    // Deliberately NO visual-qa turn anywhere in this queue. If the
    // pre-check ever failed to short-circuit, `qaAgent`'s `wf.step.agent`
    // call would pop from this exhausted queue and THROW
    // "fakeRouterSequence: exhausted configured turns" — the run would fail
    // outright, not merely hold. Completing as `held` with every attempt's
    // budget consumed by copy+vetting alone is the proof the model was never
    // asked to grade anything this ticket's pre-checks can answer in code.
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
    ]);
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
    const result = await engine.run(workflowFn, { runId: "instagram_offkit_palette", ...base });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/deterministic pre-check failed/);
    expect(result.reason).toMatch(/#123456/);
    expect(result.reason).toMatch(/#abcdef/i);
    // Exactly 1 research + 3 × (copy + vetting) = 7 — the model was NEVER
    // invoked for `08b-visual-qa`, on any attempt.
    expect(router.complete).toHaveBeenCalledTimes(7);

    const stepIds = (await durableStore.listSteps("instagram_offkit_palette")).map((s) => s.stepId);
    expect(stepIds).toContain("08a2-visual-qa-pre-checks-attempt-1");
    expect(stepIds).toContain("08a2-visual-qa-pre-checks-attempt-3");
    expect(stepIds).not.toContain("08b-visual-qa-attempt-1");
    expect(stepIds).not.toContain("08b-visual-qa-attempt-2");
    expect(stepIds).not.toContain("08b-visual-qa-attempt-3");

    const preCheck1 = (await durableStore.getStep("instagram_offkit_palette", "08a2-visual-qa-pre-checks-attempt-1")) as {
      output: { paletteGate: { ok: boolean; reason: string } };
    };
    expect(preCheck1.output.paletteGate.ok).toBe(false);
    expect(preCheck1.output.paletteGate.reason).toContain("#123456");
  }, 60000);
});

describe("08b-visual-qa: the elevated criteria sent to the model shrink to match what code already verified", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("a brandless client is asked to grade composition/font-hierarchy only — never brand-asset-integration or colour-harmony", async () => {
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { runId: "instagram_no_brand", ...base });
    expect(result.status).toBe("completed");

    const qaInput = qaTurnInput(router, 3);
    const ruleIds = (qaInput["renderRules"] as Array<{ id: string }>).map((r) => r.id);
    expect(ruleIds).toContain("composition-richness");
    expect(ruleIds).toContain("font-hierarchy");
    expect(ruleIds).not.toContain("brand-asset-integration");
    expect(ruleIds).not.toContain("colour-harmony");
    expect(qaInput["brandAssetContext"]).toBeUndefined();
    expect(qaInput["brandPalette"]).toBeUndefined();
  }, 60000);

  it("a brand kit with a palette but no logo adds colour-harmony but not brand-asset-integration", async () => {
    await env.store.writeJson("acme", ["client", "brand"], { accent: "#A5E82B" });
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { runId: "instagram_palette_no_logo", ...base });
    expect(result.status).toBe("completed");

    const qaInput = qaTurnInput(router, 3);
    const ruleIds = (qaInput["renderRules"] as Array<{ id: string }>).map((r) => r.id);
    expect(ruleIds).toContain("colour-harmony");
    expect(ruleIds).not.toContain("brand-asset-integration");
    expect(qaInput["brandPalette"]).toEqual(["#A5E82B"]);
    expect(qaInput["brandAssetContext"]).toBeUndefined();
  }, 60000);

  it("a present, legible logo adds brand-asset-integration with the deterministic corner/scrim facts, never asking the model whether the logo exists", async () => {
    await env.store.writeJson("acme", ["client", "brand"], { accent: "#A5E82B", logoUrl: "https://logos.example/acme.png" });
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
      fetchImpl: fakeLogoFetch(),
    });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { runId: "instagram_logo_present", ...base });
    expect(result.status).toBe("completed");

    const qaInput = qaTurnInput(router, 3);
    const ruleIds = (qaInput["renderRules"] as Array<{ id: string }>).map((r) => r.id);
    expect(ruleIds).toContain("brand-asset-integration");
    expect(qaInput["brandAssetContext"]).toMatchObject({ corner: expect.any(String), scrimmed: expect.any(Boolean) });
  }, 60000);

  it("a configured but unreachable (gs://) logo never asks the model to grade brand-asset-integration, and never holds the run over it", async () => {
    await env.store.writeJson("acme", ["client", "brand"], { accent: "#A5E82B", logoUrl: "gs://karos-brand-assets/acme/logo.svg" });
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { runId: "instagram_gs_logo", ...base });

    // The gs:// dead end degrades the same way a missing logo always has —
    // never a hold, per the invariant `brand-logo.ts`/`brandFragments`
    // state repeatedly ("brand furniture must never be able to hold a run").
    expect(result.status).toBe("completed");

    const qaInput = qaTurnInput(router, 3);
    const ruleIds = (qaInput["renderRules"] as Array<{ id: string }>).map((r) => r.id);
    expect(ruleIds).not.toContain("brand-asset-integration");

    const preCheck1 = (await durableStore.getStep("instagram_gs_logo", "08a2-visual-qa-pre-checks-attempt-1")) as {
      output: { brandAsset: { present: boolean; reason?: string } };
    };
    expect(preCheck1.output.brandAsset.present).toBe(false);
    expect(preCheck1.output.brandAsset.reason).toContain("gs://karos-brand-assets/acme/logo.svg");
    expect(preCheck1.output.brandAsset.reason).toMatch(/silently refuses/);
  }, 60000);
});
