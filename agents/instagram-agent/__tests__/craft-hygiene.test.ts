import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { checkCraftHygiene, checkSentenceCase } from "../src/workflow/craft-hygiene.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
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

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };
const params = { runId: "instagram_run_craft", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

function copyWith(overrideBody: string, slideIndex = 0): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return {
    slides: copy.slides.map((s, i) => (i === slideIndex ? { ...s, body: overrideBody } : s)),
  };
}

describe("Fix 3: unconditional mechanical craft-hygiene gate (em dash / exclamation / sentence case)", () => {
  describe("checkSentenceCase (unit)", () => {
    it("passes ordinary sentence-case text", () => {
      expect(checkSentenceCase("Teams that automated their weekly reporting saved time.").ok).toBe(true);
    });

    /**
     * The allowlist has to cover the vocabulary these agents actually write in.
     * A live prep run rejected two good drafts over "DTC" and held having
     * produced nothing — each miss costs a whole run, not one flagged word.
     */
    it.each(["DTC", "ROAS", "CPA", "CTR", "CAC", "LTV", "UGC", "CRM", "KPI", "CMO"])(
      "accepts %s, which a marketing agent writes constantly",
      (acronym) => {
        expect(checkSentenceCase(`Our ${acronym} improved every quarter.`).ok).toBe(true);
      },
    );

    it("passes a term with digits because the tokeniser never yields one whole", () => {
      // Not a claim that "GA4" is allowlisted — it cannot be. The word regex
      // yields "GA", so the allowlist entry has to be "GA", and an entry
      // spelled "GA4" would be unreachable protection. Pinned so the next
      // person editing that list sees which shape actually works.
      expect(checkSentenceCase("Our GA4 property tracks it.").ok).toBe(true);
      expect(checkSentenceCase("Our A/B test won.").ok).toBe(true);
    });

    it("flags an ALL-CAPS word outside the acronym allowlist", () => {
      const result = checkSentenceCase("This is AMAZING news for the team.");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/ALL-CAPS/);
    });

    it("does not flag a short list of common acronyms", () => {
      expect(checkSentenceCase("Our AI tool saved the CEO four hours a week.").ok).toBe(true);
    });

    it("flags Title Case spam", () => {
      const result = checkSentenceCase("Five Amazing Ways To Grow Your Team This Quarter Fast");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/Title Case/);
    });
  });

  describe("checkCraftHygiene (unit, via the real gate.lintPost tool)", () => {
    let env: TestEnvironment;

    beforeEach(async () => {
      env = await setupTestEnvironment();
    });

    afterEach(async () => {
      await env.cleanup();
    });

    it("catches an em dash", async () => {
      const copy = copyWith("Teams saved time — a lot of it, every single week.");
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/slide 1/);
    });

    it("catches a double-hyphen em-dash stand-in", async () => {
      const copy = copyWith("Teams saved time -- a lot of it, every week.");
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok).toBe(false);
    });

    it("catches an exclamation mark", async () => {
      const copy = copyWith("Teams saved four hours a week!");
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/slide 1/);
    });

    it("passes clean, ordinary slide copy", async () => {
      const result = await checkCraftHygiene(env.tools, ctx, goodCopyOutput());
      expect(result.ok).toBe(true);
    });
  });

  describe("wired into the workflow's retry loop (integration)", () => {
    let env: TestEnvironment;

    beforeEach(async () => {
      env = await setupTestEnvironment();
    });

    afterEach(async () => {
      await env.cleanup();
    });

    it("blocks a draft with an em dash on attempt 1, then succeeds on attempt 2 with a clean revision", async () => {
      const promptStore = makePromptStore();
      const emDashCopy = copyWith("Teams saved time — every single week, without fail.");
      const cleanCopy = goodCopyOutput();
      const router = fakeRouterSequence([
        finalTurn(goodResearchOutput()),
        finalTurn(emDashCopy),
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
      const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
      expect(stepIds).toContain("07b-craft-hygiene-attempt-1");
      expect(stepIds).toContain("05-write-copy-attempt-2");
      expect(stepIds).toContain("07b-craft-hygiene-attempt-2");

      const hygiene1 = (await durableStore.getStep(params.runId, "07b-craft-hygiene-attempt-1")) as { output: { ok: boolean } };
      expect(hygiene1.output.ok).toBe(false);
    }, 60000);

    it("blocks a draft with an exclamation mark, holding the whole post after exhausting all attempts if never fixed", async () => {
      const promptStore = makePromptStore();
      const shoutyCopy = copyWith("Four hours back every week!");
      const router = fakeRouterSequence([
        finalTurn(goodResearchOutput()),
        finalTurn(shoutyCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(shoutyCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(shoutyCopy),
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
      const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_craft_exhausted" });

      expect(result.status).toBe("held");
      if (result.status !== "held") throw new Error("unreachable");
      expect(result.reason).toMatch(/self-check never passed after 3 attempt/i);

      const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "instagram_run_craft_exhausted", "_"]);
      expect(deliverables).toHaveLength(0);
    }, 60000);

    it("is unconditional: a client style config with NO banned_chars still blocks an em dash", async () => {
      // goodStyleConfig()'s default banned_chars is [] -- if craft hygiene were
      // driven by client config instead of unconditional, this em dash would
      // sail through untouched.
      const promptStore = makePromptStore();
      const emDashCopy = copyWith("Teams saved time — every week, reliably.");
      const router = fakeRouterSequence([
        finalTurn(goodResearchOutput()),
        finalTurn(emDashCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(emDashCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(emDashCopy),
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
      const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_craft_unconditional" });

      expect(result.status).toBe("held");
    }, 60000);
  });
});
