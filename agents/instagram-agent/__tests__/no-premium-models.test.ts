import { describe, expect, it, vi } from "vitest";
import {
  applyClientLanguagePolicy,
  selectModelForContentLanguage,
  CONTENT_LANGUAGE_MAX_COST_TIER,
  type AgentStepConfig,
  type BaseAgent,
  type BaseAgentRuntime,
  type ModelPolicy,
  type ModelRouter,
} from "@agent-engine/core";
// The REAL catalog, off the package's public surface. Reading the real catalog is the whole point: a test
// that restated the cost tiers would pass against a table that had drifted underneath it, which is precisely
// the failure this suite exists to catch. (This was briefly a deep import into `dist/` because
// `model-capabilities.js` was not on `router/index.ts`'s barrel; it is now, so the deep import is gone.)
import { MODEL_CAPABILITIES, MODEL_PRICING } from "@agent-engine/core";
import {
  InstagramAngleAgent,
  InstagramArtDirectorAgent,
  InstagramBriefAgent,
  InstagramCopyAgent,
  InstagramDesignBriefAgent,
  InstagramImageVettingAgent,
  InstagramNativeEditorAgent,
  InstagramResearchAgent,
  InstagramTemplateDesignerAgent,
  InstagramTemplateSetReviewAgent,
  InstagramVisualQaAgent,
} from "../src/agent/index.js";

/**
 * RFC-15 §8 — **no premium-tier model in an Instagram run**, proved against every agent this package ships
 * rather than against the one the phase happens to be about.
 *
 * ## The trap, and why a test that only reads the five flags would have missed it
 *
 * Five Instagram steps carry `contentLanguageSensitive: true` on a pinned `claude-sonnet-4-6`. That flag says
 * something true — this step writes reader-facing copy — and the mechanism behind it,
 * `applyClientLanguagePolicy`, re-points such a step to the CHEAPEST same-vendor model rated
 * `multilingual-strong`. In the Anthropic half of `MODEL_CAPABILITIES` the only rows with that rating are
 * `claude-opus-4-8` and `claude-opus-4-7`, and both are `costTier: "premium"` — `claude-sonnet-4-6` is rated
 * `strong`, which does not satisfy the requirement. So for these five steps, "cheapest capable" and "Opus"
 * were the same answer.
 *
 * Nothing had fired only because `loadClientContentLanguage` reads `client/brand.json`'s `language` field and
 * nothing else, and that field is null for exactly the clients Phase 4 targets. **Phase 4 is the phase in
 * which somebody sets `brand.language: "Hebrew"` for geektime in the portal** — and at that moment, with no
 * code change and no warning, `copyAttempt` goes 0.161 -> 0.60, `angle` 0.036 -> 0.13, `brief` 0.113 -> 0.42,
 * and a 3-attempt Hebrew run costs ~$2.9 against a $1.50 hard max.
 *
 * This file walks the COMPILED `modelPolicy` of every agent — the object the router is actually handed, not
 * a re-derivation of it — puts each through the real policy with a real client language, and asserts nothing
 * lands on a premium row. The anti-tautology at the bottom is what makes that worth anything.
 */

const noopRuntime: BaseAgentRuntime = {
  router: { complete: vi.fn(), completeAlias: vi.fn() } as unknown as ModelRouter,
  tools: {},
};

/** The compiled step config, read off a real instance. `config` is `protected`, and reading it here is the point: this suite asserts what the router is handed. */
function policyOf(agent: BaseAgent<unknown>): { id: string; policy: ModelPolicy } {
  const config = (agent as unknown as { config: AgentStepConfig<unknown> }).config;
  return { id: config.id, policy: config.modelPolicy ?? { policy: "pinned" } };
}

/** Every agent this package ships. A new agent that is not in this list is invisible to this guard, which is why the count is asserted below. */
function everyInstagramAgentPolicy(): Array<{ id: string; policy: ModelPolicy }> {
  return [
    new InstagramAngleAgent(noopRuntime),
    new InstagramArtDirectorAgent(noopRuntime),
    new InstagramBriefAgent(noopRuntime),
    new InstagramCopyAgent(noopRuntime),
    new InstagramDesignBriefAgent(noopRuntime),
    new InstagramImageVettingAgent(noopRuntime),
    new InstagramNativeEditorAgent(noopRuntime),
    new InstagramResearchAgent(noopRuntime),
    new InstagramTemplateDesignerAgent(noopRuntime),
    new InstagramTemplateSetReviewAgent(noopRuntime),
    new InstagramVisualQaAgent(noopRuntime),
  ].map((agent) => policyOf(agent as unknown as BaseAgent<unknown>));
}

const tierOf = (model: string | undefined): string | undefined => (model === undefined ? undefined : MODEL_CAPABILITIES[model]?.costTier);

describe("no Instagram step resolves to a premium model, in any language (RFC-15 §8)", () => {
  it("the premise: at least one Instagram step is contentLanguageSensitive on an Anthropic model, or this whole file is vacuous", () => {
    const policies = everyInstagramAgentPolicy();
    expect(policies.length).toBeGreaterThanOrEqual(11);
    const sensitive = policies.filter((p) => p.policy.contentLanguageSensitive === true);
    // Five of them, on `claude-sonnet-4-6`. If a future change deletes these flags, this assertion fails and
    // says so, rather than the suite quietly passing because there is nothing left to re-point.
    expect(sensitive.map((p) => p.id).sort()).toEqual(
      ["instagram-angle", "instagram-brief", "instagram-copy", "instagram-design-brief", "instagram-template-designer"].sort(),
    );
    expect(sensitive.every((p) => p.policy.model === "claude-sonnet-4-6")).toBe(true);
  });

  for (const language of ["Hebrew", "he-IL"]) {
    it(`nothing resolves to a premium model for a client whose content language is "${language}"`, () => {
      const logged = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        for (const { id, policy } of everyInstagramAgentPolicy()) {
          const resolved = applyClientLanguagePolicy(id, policy, language);
          expect(tierOf(resolved.model), `${id} resolved to ${resolved.model}`).not.toBe("premium");
          // Stronger than "not premium": the five Anthropic-pinned steps keep the model they were compiled
          // with. The cap declines to upgrade; it never downgrades and never moves a vendor.
          if (policy.contentLanguageSensitive === true && policy.vendor === undefined) {
            expect(resolved.model).toBe("claude-sonnet-4-6");
          }
          expect(resolved.vendor).toBe(policy.vendor);
        }
      } finally {
        logged.mockRestore();
      }
    });
  }

  it("the native editor is pinned to the model the requirement WOULD have chosen, so the policy cannot move it somewhere worse", () => {
    const judge = everyInstagramAgentPolicy().find((p) => p.id === "instagram-native-editor");
    expect(judge).toBeDefined();
    expect(judge!.policy.model).toBe("gemini-2.5-pro");
    expect(judge!.policy.vendor).toBe("gemini");
    // Not flagged: the step is already on the answer, and letting the policy re-point it could only move it
    // to something cheaper and less capable.
    expect(judge!.policy.contentLanguageSensitive).not.toBe(true);
    expect(MODEL_CAPABILITIES["gemini-2.5-pro"]?.languageStrength).toBe("multilingual-strong");
    expect(MODEL_CAPABILITIES["gemini-2.5-pro"]?.rtlSupport).toBe("strong");
    expect(MODEL_CAPABILITIES["gemini-2.5-pro"]?.costTier).toBe("standard");
  });

  /**
   * THE JUSTIFICATION, DERIVED — not restated.
   *
   * Four comments (`instagram-native-editor-agent.ts`,
   * `create-instagram-agent-workflow.ts`'s 07f block, `language-gate.ts` and
   * `run-budget.ts`'s `nativeJudge` key) defend the judge's $0.014 on the
   * claim that `gemini-2.5-pro` is the cheapest non-premium row rated
   * `multilingual-strong` + `rtlSupport: "strong"`. They previously said
   * "the ONLY" such row, which the catalog contradicted —
   * `gemini-3.1-pro-preview` qualifies too — and nothing failed, because the
   * test above asserts only 2.5-pro's own three attributes.
   *
   * This derives the ranking from `MODEL_CAPABILITIES` + `MODEL_PRICING`, so
   * a future row that is both capable and cheaper makes the guard speak
   * instead of leaving four comments quietly wrong. Break it by pricing any
   * qualifying non-premium row below 2.5-pro and it fails.
   */
  it("gemini-2.5-pro is the CHEAPEST non-premium row rated multilingual-strong + rtlSupport strong", () => {
    const qualifying = Object.entries(MODEL_CAPABILITIES)
      .filter(([, caps]) => caps.languageStrength === "multilingual-strong" && caps.rtlSupport === "strong")
      .filter(([, caps]) => caps.costTier !== "premium");

    // The premise: there is more than one, so "cheapest" is a real ranking
    // rather than a one-element list dressed up as one.
    expect(qualifying.length).toBeGreaterThan(1);
    expect(qualifying.map(([id]) => id)).toContain("gemini-3.1-pro-preview");

    // Ranked on the blended cost of THIS call's shape — ~6.0k in, ~0.65k out
    // (the arithmetic the four comments carry).
    const blended = (id: string): number => {
      const price = MODEL_PRICING[id];
      expect(price, `no pricing row for ${id}`).toBeDefined();
      return (price!.inputPer1M * 6000 + price!.outputPer1M * 650) / 1_000_000;
    };
    const cheapest = qualifying.map(([id]) => id).sort((a, b) => blended(a) - blended(b))[0];
    expect(cheapest).toBe("gemini-2.5-pro");

    // And the pinned model really is that row, so the comments and the code agree.
    const judge = everyInstagramAgentPolicy().find((p) => p.id === "instagram-native-editor");
    expect(judge!.policy.model).toBe(cheapest);
  });

  it("ANTI-TAUTOLOGY: lift the cap to premium and the SAME copy step's vendor DOES select claude-opus-4-8", () => {
    // Without this case the assertions above are worthless — they would pass identically against a
    // `selectModelForContentLanguage` that had simply stopped selecting anything, or against a catalog with
    // no Anthropic rows in it at all. This is the proof that the mechanism is live, the requirement is
    // satisfiable, and the ONLY thing standing between an Instagram run and a $2.9 bill is the cap.
    const uncapped = { multilingualStrong: true, rtlStrong: true, maxCostTier: "premium" as const };
    expect(selectModelForContentLanguage("anthropic", uncapped)).toBe("claude-opus-4-8");
    expect(tierOf(selectModelForContentLanguage("anthropic", uncapped))).toBe("premium");

    // And at the shipped cap, the same call finds nothing — which is why the step keeps its own model.
    expect(selectModelForContentLanguage("anthropic", { multilingualStrong: true, rtlStrong: true })).toBeUndefined();
    expect(CONTENT_LANGUAGE_MAX_COST_TIER).toBe("standard");
  });

  it("an English client is untouched: every step keeps the exact policy object it was compiled with", () => {
    for (const { id, policy } of everyInstagramAgentPolicy()) {
      // Identical REFERENCE, not merely an equal value: `applyClientLanguagePolicy` returns `policy` itself
      // for every case that is not a re-point, and an English client is every one of those cases.
      expect(applyClientLanguagePolicy(id, policy, "English")).toBe(policy);
      expect(applyClientLanguagePolicy(id, policy, "en-US")).toBe(policy);
      expect(applyClientLanguagePolicy(id, policy, undefined)).toBe(policy);
    }
  });

  it("no step is COMPILED onto a premium model either — the cap is the second line of defence, not the first", () => {
    for (const { id, policy } of everyInstagramAgentPolicy()) {
      expect(tierOf(policy.model), `${id} is pinned to ${policy.model}`).not.toBe("premium");
    }
  });
});
