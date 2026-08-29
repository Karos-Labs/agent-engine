import { describe, expect, it } from "vitest";
import {
  MODEL_CAPABILITIES,
  assertModelCatalogued,
  isCataloguedModel,
  lookupModelCapabilities,
} from "../src/router/model-capabilities.js";

describe("model-capabilities catalog (AU33 / SCRUM-311)", () => {
  it("every agent-config default model id used in this repo is catalogued", () => {
    // These are the models every shipped agent actually compiles against
    // today (agents/*/src/agent/*.ts) plus router/aliases.ts's alias table —
    // the floor this catalog can never fall short of.
    for (const id of ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"]) {
      expect(isCataloguedModel(id), id).toBe(true);
    }
  });

  it("resolves an Agent-Platform @-dated id to the same row as the canonical -dated spelling", () => {
    const canonical = lookupModelCapabilities("claude-haiku-4-5-20251001");
    const platformDated = lookupModelCapabilities("claude-haiku-4-5@20251001");
    expect(platformDated).toEqual(canonical);
    expect(canonical?.vendor).toBe("anthropic");
  });

  it("resolves a Model-Garden id whether or not it carries its publisher prefix", () => {
    const prefixed = lookupModelCapabilities("meta/llama-3.3-70b-instruct-maas");
    const unprefixed = lookupModelCapabilities("llama-3.3-70b-instruct-maas");
    expect(prefixed).toEqual(unprefixed);
    expect(prefixed?.vendor).toBe("model-garden");
  });

  it("returns undefined, not a default, for an id nobody has catalogued", () => {
    expect(lookupModelCapabilities("definitely-not-a-model")).toBeUndefined();
    expect(isCataloguedModel("definitely-not-a-model")).toBe(false);
  });

  it("every catalogued row is internally consistent: known modality/tier/reliability values, at least one modality, a positive context window", () => {
    for (const [id, row] of Object.entries(MODEL_CAPABILITIES)) {
      expect(row.modality.length, `${id}.modality`).toBeGreaterThan(0);
      expect(row.contextWindowTokens, `${id}.contextWindowTokens`).toBeGreaterThan(0);
      expect(row.regions.length, `${id}.regions`).toBeGreaterThan(0);
      expect(["budget", "standard", "premium"], `${id}.costTier`).toContain(row.costTier);
      expect(["native", "high", "best-effort"], `${id}.structuredOutputReliability`).toContain(
        row.structuredOutputReliability,
      );
      expect(["basic", "strong", "multilingual-strong"], `${id}.languageStrength`).toContain(row.languageStrength);
      expect(["none", "basic", "strong"], `${id}.rtlSupport`).toContain(row.rtlSupport);
    }
  });

  it("assertModelCatalogued returns the row for a matching vendor and model", () => {
    const row = assertModelCatalogued("claude-sonnet-4-6", "anthropic", "test");
    expect(row.vendor).toBe("anthropic");
  });

  it("assertModelCatalogued throws naming the model when it isn't catalogued", () => {
    expect(() => assertModelCatalogued("nope-not-real", "anthropic", "myContext")).toThrow(
      /myContext.*not in the model-capability catalog/s,
    );
  });

  it("assertModelCatalogued throws naming both vendors on a mismatch", () => {
    expect(() => assertModelCatalogued("gemini-2.5-pro", "anthropic", "myContext")).toThrow(
      /catalogued under vendor "gemini".*vendor "anthropic"/s,
    );
  });
});
