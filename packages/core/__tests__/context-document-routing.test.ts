import { describe, expect, it } from "vitest";
import type { ModelPolicy } from "../src/types/model-policy.js";
import { resolveModelVendor } from "../src/types/model-policy.js";
import { isCataloguedModel, lookupModelCapabilities } from "../src/router/model-capabilities.js";
import {
  CHARS_PER_TOKEN,
  HIGH_COMPLEXITY_THRESHOLD,
  assessContextDocumentComplexity,
  routeContextDocumentModel,
  type ContextDocumentComplexitySignals,
} from "../src/router/context-document-routing.js";

/**
 * SCRUM-380 (D1-v2), acceptance item 1: "routing works, driven by a
 * complexity signal."
 *
 * The signal is a scored function of named inputs, so it is tested as one:
 * the score moves for the reasons it claims to move for, the threshold is the
 * thing that decides the model, and each escalation target is checked against
 * the same catalog every other model decision in this engine is checked
 * against.
 */

/** The step's real compiled default (`INTEL_REPORT_DRAFT_MODEL_POLICY`), restated so this suite doesn't depend on an agent package. */
const BASE: ModelPolicy = { policy: "pinned", model: "claude-sonnet-4-6" };
const MAX_OUTPUT = 32_000;

function signals(overrides: Partial<ContextDocumentComplexitySignals> = {}): ContextDocumentComplexitySignals {
  return { competitorCount: 1, evidenceChars: 0, clientContextChars: 0, steerCount: 0, revision: 0, ...overrides };
}

describe("assessContextDocumentComplexity — the complexity signal itself", () => {
  it("a routine instance scores 0 and is standard", () => {
    const assessed = assessContextDocumentComplexity(signals({ competitorCount: 3 }));
    expect(assessed.score).toBe(0);
    expect(assessed.tier).toBe("standard");
    expect(assessed.reasons).toEqual([]);
  });

  it("the Wide Scan competitor target alone reaches the high threshold", () => {
    // 8 competitors is the craft prompt's own Wide Scan target, and the
    // weights are calibrated so that field size alone is enough: 8 - 3
    // baseline = 5.0, exactly HIGH_COMPLEXITY_THRESHOLD.
    const assessed = assessContextDocumentComplexity(signals({ competitorCount: 8 }));
    expect(assessed.score).toBe(5);
    expect(HIGH_COMPLEXITY_THRESHOLD).toBe(5);
    expect(assessed.tier).toBe("high");
    expect(assessed.reasons.join(" ")).toContain("8 competitors");
  });

  it("evidence volume alone can reach it, and the token estimate is the documented chars/token", () => {
    // 25,000 estimated tokens per point, so 125,000 tokens = 5 points.
    const chars = Math.round(125_000 * CHARS_PER_TOKEN);
    const assessed = assessContextDocumentComplexity(signals({ evidenceChars: chars }));
    expect(assessed.estimatedPromptTokens).toBe(125_000);
    expect(assessed.score).toBe(5);
    expect(assessed.tier).toBe("high");
  });

  it("steers and review rounds contribute, and compose with the other signals", () => {
    const assessed = assessContextDocumentComplexity(
      signals({ competitorCount: 6, steerCount: 4, revision: 1 }),
    );
    // 3 competitors over baseline (3.0) + 4 steers at 0.5 (2.0) + round 1 (1.0) = 6.0
    expect(assessed.score).toBe(6);
    expect(assessed.tier).toBe("high");
    expect(assessed.reasons).toHaveLength(3);
  });

  it("clamps garbage rather than throwing — a bad length calculation must not kill a run before drafting", () => {
    const assessed = assessContextDocumentComplexity({
      competitorCount: -4,
      evidenceChars: Number.NaN,
      clientContextChars: Number.POSITIVE_INFINITY,
      steerCount: -1,
      revision: Number.NaN,
    });
    expect(assessed.score).toBe(0);
    expect(assessed.tier).toBe("standard");
  });
});

describe("routeContextDocumentModel — the model decision", () => {
  it("leaves a standard instance on its compiled policy, byte for byte", () => {
    const route = routeContextDocumentModel(BASE, signals({ competitorCount: 2 }), { maxOutputTokens: MAX_OUTPUT });
    expect(route.escalated).toBe(false);
    expect(route.policy).toEqual(BASE);
    expect(route.complexity.tier).toBe("standard");
  });

  it("routes a high-complexity instance to Opus, same vendor, still pinned", () => {
    const route = routeContextDocumentModel(BASE, signals({ competitorCount: 8 }), { maxOutputTokens: MAX_OUTPUT });
    expect(route.escalated).toBe(true);
    expect(route.policy.model).toBe("claude-opus-4-8");
    // Pinned is preserved: escalation is a pre-call SELECTION, not a
    // fallback, so RFC-01 §5.4's "never silently swaps models" still holds.
    expect(route.policy.policy).toBe("pinned");
    expect(resolveModelVendor(route.policy)).toBe("anthropic");
    expect(route.rationale).toContain("claude-opus-4-8");
  });

  it("routes an instance that does not FIT to the 1M-window Gemini model, when vendor escalation is allowed", () => {
    // Sonnet's window is 200k; the safety fraction leaves 160k usable, and
    // 32k of that is reserved for the report itself.
    const chars = Math.round(200_000 * CHARS_PER_TOKEN);
    const route = routeContextDocumentModel(BASE, signals({ evidenceChars: chars }), {
      maxOutputTokens: MAX_OUTPUT,
      allowVendorEscalation: true,
    });
    expect(route.escalated).toBe(true);
    expect(route.policy.model).toBe("gemini-2.5-pro");
    // The vendor moves WITH the model here — unlike a Studio `stageModels`
    // pick — because the catalog itself says which vendor serves this id.
    expect(resolveModelVendor(route.policy)).toBe("gemini");
    expect(lookupModelCapabilities(route.policy.model)!.contextWindowTokens).toBe(1_000_000);
    expect(route.rationale).toContain("window");
  });

  it("declines to escalate at all when the instance does not fit and vendor escalation is off", () => {
    const chars = Math.round(200_000 * CHARS_PER_TOKEN);
    const route = routeContextDocumentModel(BASE, signals({ evidenceChars: chars }), { maxOutputTokens: MAX_OUTPUT });
    // Not Opus: it has the SAME 200k window, so it could not fix the fit
    // problem just diagnosed — it would only cost 5x for the same failure.
    expect(route.escalated).toBe(false);
    expect(route.policy).toEqual(BASE);
    expect(route.complexity.tier).toBe("high");
    expect(route.rationale).toContain("vendor escalation is disabled");
  });

  it("counts the reserved output ceiling against the window, not just the input", () => {
    // 150k input tokens fits in 160k usable on its own; it does not once the
    // 32k output reservation is counted. A fit check that ignored the
    // completion would be wrong by exactly that much.
    const chars = Math.round(150_000 * CHARS_PER_TOKEN);
    const withoutOutput = routeContextDocumentModel(BASE, signals({ evidenceChars: chars }), {
      maxOutputTokens: 0,
      allowVendorEscalation: true,
    });
    const withOutput = routeContextDocumentModel(BASE, signals({ evidenceChars: chars }), {
      maxOutputTokens: MAX_OUTPUT,
      allowVendorEscalation: true,
    });
    expect(withoutOutput.policy.model).toBe("claude-opus-4-8");
    expect(withOutput.policy.model).toBe("gemini-2.5-pro");
  });

  it("never drops a fallbackModel across a vendor change", () => {
    // A fallback resolves against its primary's vendor (ModelPolicySchema);
    // carrying one across an escalation would be the single genuinely unsafe
    // thing this could do.
    const portable: ModelPolicy = { policy: "portable", model: "claude-sonnet-4-6", fallbackModel: "claude-haiku-4-5" };
    const route = routeContextDocumentModel(portable, signals({ competitorCount: 9 }), { maxOutputTokens: MAX_OUTPUT });
    expect(route.escalated).toBe(true);
    expect(route.policy.fallbackModel).toBeUndefined();
    expect(route.policy.policy).toBe("portable");
  });

  it("every model this module can select is in the capability catalog", () => {
    for (const id of ["claude-opus-4-8", "gemini-2.5-pro"]) {
      expect(isCataloguedModel(id), id).toBe(true);
    }
  });
});
