import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { checkSlidesData } from "../src/workflow/slides-data.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodStyleConfig,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };
const params = { runId: "instagram_run_brand_gate", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/** `goodCopyOutput()` with one slide's body replaced -- everything else stays valid, so a failure traces to exactly one condition. */
function copyWith(overrideBody: string, slideIndex = 0): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return {
    ...copy,
    slides: copy.slides.map((s, i) => (i === slideIndex ? { ...s, body: overrideBody } : s)),
  };
}

/**
 * SCRUM-301 / AU17: step 07's `checkSlidesData` used to re-implement its own
 * case-insensitive substring scan for `banned_words`/`banned_chars`/
 * `compliance.never_say`/`compliance.required_framing`, duplicating the exact
 * algorithm the shared `gate.brandCompliance` tool
 * (`packages/tools/karos-gates/src/brand-compliance.ts`) already implements
 * and every other migrated content agent already calls for its own client's
 * "forbidden terms"/"required disclaimer" check. These tests exercise the
 * REAL `gate.brandCompliance` tool (via `env.tools`, exactly as
 * `craft-hygiene.test.ts` already does for `gate.lintPost`) both directly
 * through `checkSlidesData` and through the real workflow's step 07, not a
 * mock or a reimplementation.
 */
describe("SCRUM-301/AU17: step 07's banned-word/char + compliance checks now call the real gate.brandCompliance tool", () => {
  describe("checkSlidesData (unit, via the real gate.brandCompliance tool)", () => {
    let env: TestEnvironment;

    beforeEach(async () => {
      env = await setupTestEnvironment();
    });

    afterEach(async () => {
      await env.cleanup();
    });

    it("passes clean copy against a client with real banned_words/banned_chars configured", async () => {
      const result = await checkSlidesData(
        env.tools,
        ctx,
        goodCopyOutput(),
        goodImageVettingOutput().selections,
        goodResearchOutput(),
        goodStyleConfig(),
      );
      expect(result.ok).toBe(true);
    });

    it("fails a slide that uses a client's configured banned_words (parity with the old inlined check)", async () => {
      const copy = copyWith(`${goodCopyOutput().slides[0]!.body} This is guaranteed to work.`);
      const result = await checkSlidesData(env.tools, ctx, copy, goodImageVettingOutput().selections, goodResearchOutput(), goodStyleConfig());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/slide 1/);
      expect(result.reason).toMatch(/guaranteed/i);
    });

    it("fails a slide that uses a client's configured banned_chars (parity with the old inlined check)", async () => {
      const styleConfig = goodStyleConfig({ banned_chars: ["🚀"] });
      const copy = copyWith(`${goodCopyOutput().slides[0]!.body} Growth incoming 🚀`);
      const result = await checkSlidesData(env.tools, ctx, copy, goodImageVettingOutput().selections, goodResearchOutput(), styleConfig);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/slide 1/);
    });

    /**
     * This is the load-bearing proof that `checkSlidesData` is calling the
     * REAL shared tool and not a local stand-in: `DEFAULT_BANNED_PROMISE_PHRASES`
     * is hard-coded inside `gate.brandCompliance` itself and was never part of
     * the old inlined check (a client with empty `banned_words`/`banned_chars`
     * got no protection at all before this fix). A mock or a reimplementation
     * of the old logic would not know about this phrase.
     */
    it("fails a slide on gate.brandCompliance's own always-on promise/hype-language floor, even with an unconfigured client", async () => {
      const styleConfig = goodStyleConfig({ banned_words: [], banned_chars: [] });
      const copy = copyWith(`${goodCopyOutput().slides[0]!.body} We offer guaranteed returns on every plan.`);
      const result = await checkSlidesData(env.tools, ctx, copy, goodImageVettingOutput().selections, goodResearchOutput(), styleConfig);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/guaranteed returns/i);
    });

    it("enforces a regulated client's compliance.required_framing phrase across the whole post", async () => {
      const styleConfig = goodStyleConfig({
        compliance: { regulated: true, required_framing: ["results are not guaranteed"], never_say: [] },
      });
      const result = await checkSlidesData(env.tools, ctx, goodCopyOutput(), goodImageVettingOutput().selections, goodResearchOutput(), styleConfig);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/required framing phrase is missing/i);
      expect(result.reason).toMatch(/results are not guaranteed/i);
    });

    it("passes a regulated client's compliance.required_framing check once the phrase is actually present", async () => {
      const styleConfig = goodStyleConfig({
        banned_words: [],
        compliance: { regulated: true, required_framing: ["results are not guaranteed"], never_say: [] },
      });
      const copy = copyWith(`${goodCopyOutput().slides[0]!.body} Results are not guaranteed for every team.`);
      const result = await checkSlidesData(env.tools, ctx, copy, goodImageVettingOutput().selections, goodResearchOutput(), styleConfig);
      expect(result.ok).toBe(true);
    });

    it("enforces a regulated client's compliance.never_say phrase across the whole post", async () => {
      const styleConfig = goodStyleConfig({
        compliance: { regulated: true, required_framing: [], never_say: ["can't lose"] },
      });
      const copy = copyWith(`${goodCopyOutput().slides[0]!.body} With this approach you can't lose.`);
      const result = await checkSlidesData(env.tools, ctx, copy, goodImageVettingOutput().selections, goodResearchOutput(), styleConfig);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/never say/i);
    });

    it("does not enforce compliance.required_framing/never_say at all for a non-regulated client", async () => {
      // regulated: false with a never_say phrase actually present in the copy --
      // must still pass, since the compliance block is opt-in per RFC-03.
      const styleConfig = goodStyleConfig({
        banned_words: [],
        compliance: { regulated: false, required_framing: ["never appears anywhere"], never_say: ["guaranteed"] },
      });
      const copy = copyWith(`${goodCopyOutput().slides[0]!.body} This plan is guaranteed to help.`);
      const result = await checkSlidesData(env.tools, ctx, copy, goodImageVettingOutput().selections, goodResearchOutput(), styleConfig);
      expect(result.ok).toBe(true);
    });
  });

  describe("wired into the real workflow's step 07 (integration, real entry point)", () => {
    let env: TestEnvironment;

    afterEach(async () => {
      await env?.cleanup();
    });

    it("blocks a draft with a client-configured banned_char on attempt 1, then succeeds on attempt 2 with a clean revision", async () => {
      env = await setupTestEnvironment({ styleConfig: goodStyleConfig({ banned_chars: ["🚀"] }) });
      const promptStore = makePromptStore();
      const rocketCopy = copyWith(`${goodCopyOutput().slides[0]!.body} Growth incoming 🚀`);
      const cleanCopy = goodCopyOutput();
      const router = fakeRouterSequence([
        finalTurn(goodResearchOutput()),
        finalTurn(rocketCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(cleanCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(goodVisualQaOutput()),
      ]);
      const workflowFn = createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore,
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      const result = await engine.run(workflowFn, params);

      expect(result.status).toBe("completed");
      const selfCheck1 = (await durableStore.getStep(params.runId, "07-self-check-attempt-1")) as { output: { ok: boolean; reason?: string } };
      expect(selfCheck1.output.ok).toBe(false);
      const selfCheck2 = (await durableStore.getStep(params.runId, "07-self-check-attempt-2")) as { output: { ok: boolean } };
      expect(selfCheck2.output.ok).toBe(true);
    }, 60000);

    it("holds a regulated client's post that never satisfies its required_framing phrase", async () => {
      env = await setupTestEnvironment({
        styleConfig: goodStyleConfig({
          compliance: { regulated: true, required_framing: ["results are not guaranteed"], never_say: [] },
        }),
      });
      const promptStore = makePromptStore();
      const badCopy = goodCopyOutput();
      const router = fakeRouterSequence([
        finalTurn(goodResearchOutput()),
        finalTurn(badCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(badCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(badCopy),
        finalTurn(goodImageVettingOutput()),
      ]);
      const workflowFn = createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore,
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_brand_gate_regulated" });

      expect(result.status).toBe("held");
      if (result.status !== "held") throw new Error("unreachable");
      expect(result.reason).toMatch(/self-check never passed after 3 attempt/i);

      const selfCheck1 = (await durableStore.getStep("instagram_run_brand_gate_regulated", "07-self-check-attempt-1")) as {
        output: { ok: boolean; reason?: string };
      };
      expect(selfCheck1.output.ok).toBe(false);
      expect(selfCheck1.output.reason).toMatch(/required framing phrase is missing/i);
    }, 60000);
  });
});
