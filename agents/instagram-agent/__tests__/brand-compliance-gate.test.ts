import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { checkSlidesData } from "../src/workflow/slides-data.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  goodRelevanceVerdict,
  goodTrendScoutOutput,
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
import { DEFAULT_PACKAGE_TURN, VALUE_TURN_NO_FINDINGS } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

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
        finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
        finalTurn(rocketCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(cleanCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
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

    /**
     * ── RFC-19 §5.5: this case used to end `held`, and nobody ever saw the post ──
     *
     * It asserted `/self-check never passed after 3 attempt/`. Three drafts
     * were paid for, a regulated client's required-framing phrase was missing
     * from all three, and the run died with nothing delivered and nobody
     * informed — the single worst outcome available, because a compliance
     * problem is exactly the thing a human needs to SEE.
     *
     * **The gate is not weakened.** `07-self-check-attempt-3` still refuses,
     * with `kind: "compliance"`, and this test asserts it did (the premise,
     * RFC-19 §8.2 — without it, this case passes just as happily when the gate
     * silently stopped running). What changed is what happens after: the
     * carousel ships, the finding rides `selfCheck.checks` with
     * `severity: "blocking"`, and the reviewer gets the rendered post plus the
     * gate's own sentence.
     *
     * **The turn count is ENUMERATED, not observed**: 3 pre-loop + 2 per
     * refused attempt × 3 + the 3 the delivering attempt now reaches
     * (relevance, value, visual QA) + 1 packager = 13. Zero added model cost is
     * enforced here, not asserted in a comment.
     */
    it("delivers a regulated client's post that never satisfied its required_framing phrase, with a BLOCKING finding, rather than holding", async () => {
      env = await setupTestEnvironment({
        styleConfig: goodStyleConfig({
          compliance: { regulated: true, required_framing: ["results are not guaranteed"], never_say: [] },
        }),
      });
      const promptStore = makePromptStore();
      const badCopy = goodCopyOutput();
      const router = fakeRouterSequence([
        finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
        finalTurn(badCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(badCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(badCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
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
      const runId = "instagram_run_brand_gate_regulated";
      const result = await engine.run(workflowFn, { ...params, runId });

      expect(result.status).toBe("completed");

      // THE PREMISE, on the attempt that SHIPPED — not just on attempt 1.
      const selfCheck3 = (await durableStore.getStep(runId, "07-self-check-attempt-3")) as {
        output: { ok: boolean; kind?: string; reason?: string };
      };
      expect(selfCheck3.output.ok).toBe(false);
      expect(selfCheck3.output.kind).toBe("compliance");
      expect(selfCheck3.output.reason).toMatch(/required framing phrase is missing/i);

      const deliverables = await env.store.listJson<{
        deliverable?: { selfCheck?: { status: string; reason: string; checks: Array<Record<string, unknown>> } };
      }>("acme", ["ledger", "deliverables", runId, "_"]);
      expect(deliverables).toHaveLength(1);
      const selfCheck = deliverables[0]!.data.deliverable?.selfCheck;
      expect(selfCheck?.status).toBe("degraded");
      // RFC-19 §5.5 item 2: the regulated finding rides the TOP of the list —
      // a reviewer reading one line must read that half of it first.
      expect(selfCheck?.checks[0]?.["severity"]).toBe("blocking");
      expect(selfCheck?.checks[0]?.["gate"]).toBe("slides");
      expect(selfCheck?.checks[0]?.["kind"]).toBe("compliance");
      // The gate's OWN sentence, verbatim — never re-worded on the way out.
      expect(selfCheck?.checks[0]?.["detail"]).toBe(selfCheck3.output.reason);

      expect(router.complete).toHaveBeenCalledTimes(13);
    }, 60000);

    /**
     * The other half of §5.5, and the half that makes delivering honest rather
     * than reckless: `09a`'s normal timeout is
     * `{ duration: "1h", onTimeout: "auto_approve" }`, and per the prep
     * environment the sweep that would fire it is not wired there at all. For a
     * REGULATED client that would make DELIVERY indistinguishable from
     * PUBLICATION — which is precisely the argument that was offered for
     * keeping a narrow compliance hold. §5.5 concedes the argument and refuses
     * the hold: a whole day, and a HOLD at the end of it.
     *
     * Run WITHOUT `autoApprove`, because `runReviewCycle` never calls
     * `buildGate` when it is on — an auto-approved run cannot observe a
     * timeout, so a test asserting one under `autoApprove: true` would be
     * asserting nothing.
     */
    it("reconfigures 09a to 24h/hold for that run, so nothing regulated auto-approves into publication unread", async () => {
      env = await setupTestEnvironment({
        styleConfig: goodStyleConfig({
          compliance: { regulated: true, required_framing: ["results are not guaranteed"], never_say: [] },
        }),
      });
      const promptStore = makePromptStore();
      const badCopy = goodCopyOutput();
      const router = fakeRouterSequence([
        finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
        finalTurn(badCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(badCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(badCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
      ]);
      const workflowFn = createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore,
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: false,
      });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      const runId = "instagram_run_brand_gate_regulated_gate";
      const result = await engine.run(workflowFn, { ...params, runId });

      // Not held, and not completed either: a human is holding it, with the
      // rendered carousel in front of them.
      expect(result.status).toBe("awaiting_gate");

      const gate = await durableStore.getGate(`${runId}__09a-batch-review-r0`);
      expect(gate).toBeDefined();
      expect(gate!.timeout).toEqual({ duration: "24h", onTimeout: "hold" });

      const payload = gate!.payload as { selfCheck?: { checks: Array<Record<string, unknown>> } };
      expect(payload.selfCheck?.checks[0]?.["severity"]).toBe("blocking");
    }, 60000);

    /**
     * The control, and the assertion that stops the case above from being a
     * test that cannot fail: a NON-regulated client whose draft also refuses
     * still gets `{ duration: "1h", onTimeout: "auto_approve" }`. `24h`/`hold`
     * is a property of the BLOCKING finding, not of "something went wrong".
     */
    it("leaves 09a at 1h/auto_approve for a NON-regulated client, blocking is not a synonym for degraded", async () => {
      env = await setupTestEnvironment({ styleConfig: goodStyleConfig({ banned_chars: ["🚀"] }) });
      const promptStore = makePromptStore();
      const rocketCopy = copyWith(`${goodCopyOutput().slides[0]!.body} Growth incoming 🚀`);
      const router = fakeRouterSequence([
        finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
        finalTurn(rocketCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(rocketCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(rocketCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
      ]);
      const workflowFn = createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore,
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: false,
      });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      const runId = "instagram_run_brand_gate_unregulated_gate";
      const result = await engine.run(workflowFn, { ...params, runId });

      expect(result.status).toBe("awaiting_gate");
      const selfCheck3 = (await durableStore.getStep(runId, "07-self-check-attempt-3")) as { output: { ok: boolean; kind?: string } };
      expect(selfCheck3.output.ok).toBe(false);
      expect(selfCheck3.output.kind).toBe("banned-term");

      const gate = await durableStore.getGate(`${runId}__09a-batch-review-r0`);
      expect(gate!.timeout).toEqual({ duration: "1h", onTimeout: "auto_approve" });
      const payload = gate!.payload as { selfCheck?: { checks: Array<Record<string, unknown>> } };
      expect(payload.selfCheck?.checks.some((c) => c["severity"] === "blocking")).toBe(false);
      expect(payload.selfCheck?.checks.some((c) => c["kind"] === "banned-term")).toBe(true);
    }, 60000);
  });
});
