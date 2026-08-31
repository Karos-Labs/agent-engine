import { describe, expect, it } from "vitest";
import { MODEL_CAPABILITIES } from "../src/router/model-capabilities.js";
import {
  recommendModelsForStep,
  type ModelRecommendation,
  type RecommenderBudgetTier,
  type RecommenderTaskType,
} from "../src/router/model-recommender.js";

/**
 * AU35 / SCRUM-313 — per-step model recommender.
 *
 * A pure function over AU33's catalog (`model-capabilities.ts`) plus a task
 * type, a content language, and a budget tier — no fixtures, no network, no
 * I/O. Every assertion below either reads `MODEL_CAPABILITIES` directly (so
 * a future catalog row never silently rots a hardcoded count) or pins the
 * ticket's own worked example verbatim: "copy step, Hebrew client →
 * gemini-2.5-pro or claude-opus-4-8; not the Sonnet default."
 */

const ALL_TASK_TYPES: readonly RecommenderTaskType[] = ["copy", "extraction", "qa", "narrative"];
const CATALOG_SIZE = Object.keys(MODEL_CAPABILITIES).length;

function ids(recs: readonly ModelRecommendation[]): string[] {
  return recs.map((r) => r.modelId);
}

describe("recommendModelsForStep (AU35 / SCRUM-313)", () => {
  describe("the honesty requirement: every recommendation is heuristic, never presented as measured", () => {
    it.each(ALL_TASK_TYPES)("every entry for taskType=%s carries basis \"heuristic\"", (taskType) => {
      const result = recommendModelsForStep({ taskType, language: "English", budgetTier: "standard" });
      expect(result.length).toBeGreaterThan(0);
      for (const rec of result) {
        expect(rec.basis).toBe("heuristic");
      }
    });

    it("never returns \"measured\" for any task type, language, or budget tier — that branch is reserved for AU25's future corpus", () => {
      const languages = ["English", "Hebrew", "Arabic", "Japanese", ""];
      const budgetTiers: RecommenderBudgetTier[] = ["budget", "standard", "premium"];
      for (const taskType of ALL_TASK_TYPES) {
        for (const language of languages) {
          for (const budgetTier of budgetTiers) {
            const result = recommendModelsForStep({ taskType, language, budgetTier });
            expect(result.every((r) => r.basis === "heuristic"), `${taskType}/${language}/${budgetTier}`).toBe(true);
          }
        }
      }
    });
  });

  describe("shape: a complete, sequentially-ranked list with a reason per entry", () => {
    it.each(ALL_TASK_TYPES)("ranks every catalogued model exactly once for taskType=%s, with 1-based sequential ranks", (taskType) => {
      const result = recommendModelsForStep({ taskType, language: "English", budgetTier: "standard" });
      expect(result).toHaveLength(CATALOG_SIZE);
      expect(new Set(ids(result)).size).toBe(CATALOG_SIZE);
      result.forEach((rec, index) => {
        expect(rec.rank).toBe(index + 1);
        expect(rec.reasons.length).toBeGreaterThan(0);
        expect(rec.vendor).toBe(MODEL_CAPABILITIES[rec.modelId]?.vendor);
      });
    });

    it("is a pure function: identical inputs produce an identical result, called twice", () => {
      const input = { taskType: "copy" as const, language: "Hebrew", budgetTier: "premium" as const };
      expect(recommendModelsForStep(input)).toEqual(recommendModelsForStep(input));
    });

    it("narrows to one vendor's models on request, without changing their relative order", () => {
      const full = recommendModelsForStep({ taskType: "narrative", language: "Hebrew", budgetTier: "budget" });
      const geminiOnly = recommendModelsForStep({ taskType: "narrative", language: "Hebrew", budgetTier: "budget", vendor: "gemini" });
      const geminiIdsInFullOrder = ids(full).filter((id) => MODEL_CAPABILITIES[id]?.vendor === "gemini");
      expect(ids(geminiOnly)).toEqual(geminiIdsInFullOrder);
      expect(geminiOnly.every((r) => r.vendor === "gemini")).toBe(true);
      expect(geminiOnly.map((r) => r.rank)).toEqual(geminiOnly.map((_, i) => i + 1));
    });
  });

  /**
   * The core acceptance table: four task types × two languages × two budget
   * tiers, sixteen combinations, each asserting a property that traces back
   * to a specific design decision rather than merely restating the
   * implementation.
   */
  interface Case {
    readonly taskType: RecommenderTaskType;
    readonly language: string;
    readonly budgetTier: RecommenderBudgetTier;
    readonly expectedTop: string;
    readonly note: string;
  }

  const cases: readonly Case[] = [
    // ---- copy: client-facing, language-gated ----
    {
      taskType: "copy",
      language: "English",
      budgetTier: "budget",
      expectedTop: "gemini-2.5-flash",
      note: "no special language need + budget tier → a cheap, capable model, not the priciest one",
    },
    {
      taskType: "copy",
      language: "English",
      budgetTier: "premium",
      expectedTop: "claude-opus-4-8",
      note: "no special language need but premium tier → willing to spend for the strongest model",
    },
    {
      taskType: "copy",
      language: "Hebrew",
      budgetTier: "budget",
      expectedTop: "claude-opus-4-8",
      note: "the ticket's own worked example: Hebrew copy must not land on the Sonnet default, budget tier or not",
    },
    {
      taskType: "copy",
      language: "Hebrew",
      budgetTier: "premium",
      expectedTop: "claude-opus-4-8",
      note: "the ticket's own worked example: Hebrew copy must not land on the Sonnet default",
    },
    // ---- narrative: client-facing, language-gated, context-window-sensitive ----
    {
      taskType: "narrative",
      language: "English",
      budgetTier: "budget",
      expectedTop: "gemini-2.5-flash",
      note: "no special language need + budget tier → cheap and capable beats premium",
    },
    {
      taskType: "narrative",
      language: "English",
      budgetTier: "premium",
      expectedTop: "claude-opus-4-8",
      note: "premium tier with no language gate → the strongest model",
    },
    {
      taskType: "narrative",
      language: "Hebrew",
      budgetTier: "budget",
      expectedTop: "gemini-2.5-pro",
      note: "Hebrew narrative must clear the multilingual-strong + rtl-strong bar — gemini-2.5-pro, never Sonnet",
    },
    {
      taskType: "narrative",
      language: "Hebrew",
      budgetTier: "premium",
      expectedTop: "claude-opus-4-8",
      note: "Hebrew narrative, premium tier → the strongest RTL-capable model",
    },
    // ---- extraction: internal, structured-output-gated, language-blind ----
    {
      taskType: "extraction",
      language: "English",
      budgetTier: "budget",
      expectedTop: "gemini-2.5-flash",
      note: "internal step, budget tier → cheapest model with good-enough structured output",
    },
    {
      taskType: "extraction",
      language: "English",
      budgetTier: "premium",
      expectedTop: "claude-opus-4-8",
      note: "internal step, premium tier → native structured-output reliability wins",
    },
    {
      taskType: "extraction",
      language: "Hebrew",
      budgetTier: "budget",
      expectedTop: "gemini-2.5-flash",
      note: "extraction does not read the client's language at all — identical to the English/budget case",
    },
    {
      taskType: "extraction",
      language: "Hebrew",
      budgetTier: "premium",
      expectedTop: "claude-opus-4-8",
      note: "extraction does not read the client's language at all — identical to the English/premium case",
    },
    // ---- qa: internal, structured-output-gated, language-blind ----
    {
      taskType: "qa",
      language: "English",
      budgetTier: "budget",
      expectedTop: "claude-haiku-4-5-20251001",
      note: "internal verdict, budget tier → cheapest model with good structured output",
    },
    {
      taskType: "qa",
      language: "English",
      budgetTier: "premium",
      expectedTop: "claude-opus-4-8",
      note: "internal verdict, premium tier → native structured-output reliability wins",
    },
    {
      taskType: "qa",
      language: "Hebrew",
      budgetTier: "budget",
      expectedTop: "claude-haiku-4-5-20251001",
      note: "qa does not read the client's language at all — identical to the English/budget case",
    },
    {
      taskType: "qa",
      language: "Hebrew",
      budgetTier: "premium",
      expectedTop: "claude-opus-4-8",
      note: "qa does not read the client's language at all — identical to the English/premium case",
    },
  ];

  it.each(cases)("$taskType / $language / $budgetTier — $note", ({ taskType, language, budgetTier, expectedTop }) => {
    const result = recommendModelsForStep({ taskType, language, budgetTier });
    expect(result[0]?.modelId).toBe(expectedTop);
    expect(result[0]?.rank).toBe(1);
    expect(result[0]?.basis).toBe("heuristic");
    expect(result[0]?.reasons.length).toBeGreaterThan(0);
    // Never Sonnet on top for a non-English client-facing step — the ticket's
    // own phrasing, checked directly rather than only via the pinned id above.
    if ((taskType === "copy" || taskType === "narrative") && language === "Hebrew") {
      expect(result[0]?.modelId).not.toBe("claude-sonnet-4-6");
    }
  });

  describe("client-facing vs internal task types read the language input differently", () => {
    it("copy and narrative change their ranking between an English and a Hebrew client", () => {
      for (const taskType of ["copy", "narrative"] as const) {
        const english = recommendModelsForStep({ taskType, language: "English", budgetTier: "budget" });
        const hebrew = recommendModelsForStep({ taskType, language: "Hebrew", budgetTier: "budget" });
        expect(ids(english)).not.toEqual(ids(hebrew));
      }
    });

    it("extraction and qa give the identical ranking to an English and a Hebrew client — internal steps are not re-tiered by content language, mirroring AU34's own rule", () => {
      for (const taskType of ["extraction", "qa"] as const) {
        for (const budgetTier of ["budget", "premium"] as const) {
          const english = recommendModelsForStep({ taskType, language: "English", budgetTier });
          const hebrew = recommendModelsForStep({ taskType, language: "Hebrew", budgetTier });
          expect(ids(hebrew)).toEqual(ids(english));
        }
      }
    });

    it("an unstated language (absent field) behaves exactly like English — the same 'no requirement' branch AU34 uses", () => {
      const unstated = recommendModelsForStep({ taskType: "copy", budgetTier: "budget" });
      const english = recommendModelsForStep({ taskType: "copy", language: "English", budgetTier: "budget" });
      expect(ids(unstated)).toEqual(ids(english));
    });
  });

  describe("reasons are legible and trace to the actual capability row", () => {
    it("explains why a language-incapable model ranks low for a Hebrew copy step", () => {
      const result = recommendModelsForStep({ taskType: "copy", language: "Hebrew", budgetTier: "premium" });
      const sonnet = result.find((r) => r.modelId === "claude-sonnet-4-6");
      expect(sonnet).toBeDefined();
      expect(sonnet?.reasons.some((r) => /multilingual-strong/.test(r))).toBe(true);
      // Ranked below the top pick, not merely present somewhere in the list.
      expect(sonnet!.rank).toBeGreaterThan(1);
    });

    it("explains a budget-tier mismatch on a premium model recommended for a budget-tier request", () => {
      const result = recommendModelsForStep({ taskType: "extraction", language: "English", budgetTier: "budget" });
      const opus = result.find((r) => r.modelId === "claude-opus-4-8");
      expect(opus?.reasons.some((r) => /exceeds the requested "budget" budget tier/.test(r))).toBe(true);
    });

    it("mentions structured-output reliability for extraction and qa, and omits it (as a scored factor) for copy", () => {
      const extraction = recommendModelsForStep({ taskType: "extraction", language: "English", budgetTier: "standard" });
      expect(extraction.every((r) => r.reasons.some((reason) => /structured-output/.test(reason)))).toBe(true);

      const copy = recommendModelsForStep({ taskType: "copy", language: "English", budgetTier: "standard" });
      expect(copy.every((r) => !r.reasons.some((reason) => /structured-output/.test(reason)))).toBe(true);
    });
  });
});
