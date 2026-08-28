import { describe, expect, it } from "vitest";
import { applyStageModelOverride } from "../src/router/step-model-policy.js";
import type { ModelPolicy } from "../src/types/model-policy.js";

/**
 * The decision layer AU33 (SCRUM-311) added on top of the switching
 * mechanism: `applyStageModelOverride` used to accept any string as a
 * Studio-chosen model — no check that the id names a real model, and no
 * check that it belongs to the vendor the step is already wired to. Both
 * holes are exercised here directly, against the pure function, alongside
 * the end-to-end version of the same claim in
 * `apps/agent-server/__tests__/stage-model-override.test.ts`.
 */
describe("applyStageModelOverride — model-capability catalog validation", () => {
  const defaultPolicy: ModelPolicy = { policy: "pinned", model: "claude-sonnet-4-6" };

  it("returns the policy unchanged when no override names this stage", () => {
    expect(applyStageModelOverride("draft", defaultPolicy, undefined)).toBe(defaultPolicy);
    expect(applyStageModelOverride("draft", defaultPolicy, { "other-stage": "claude-opus-4-8" })).toBe(defaultPolicy);
  });

  it("applies a catalogued, same-vendor override", () => {
    const resolved = applyStageModelOverride("draft", defaultPolicy, { draft: "claude-opus-4-8" });
    expect(resolved).toEqual({ policy: "pinned", model: "claude-opus-4-8" });
  });

  it("rejects an override naming a model absent from the capability catalog (a Studio typo)", () => {
    expect(() => applyStageModelOverride("draft", defaultPolicy, { draft: "claude-sonnet-4-fake-typo" })).toThrow(
      /not in the model-capability catalog/,
    );
  });

  it("rejects an override naming a real, catalogued model from a different vendor than this step's policy", () => {
    // gemini-2.5-pro is genuinely in the catalog — just under "gemini", and
    // this step's policy resolves to "anthropic" (vendor unset).
    expect(() => applyStageModelOverride("draft", defaultPolicy, { draft: "gemini-2.5-pro" })).toThrow(
      /catalogued under vendor "gemini".*policy resolves to vendor "anthropic"/s,
    );
  });

  it("allows a cross-vendor-looking override once the step's own policy already declares that vendor", () => {
    const geminiPolicy: ModelPolicy = { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" };
    const resolved = applyStageModelOverride("draft", geminiPolicy, { draft: "gemini-2.5-pro" });
    expect(resolved).toEqual({ policy: "pinned", model: "gemini-2.5-pro", vendor: "gemini" });
  });
});
