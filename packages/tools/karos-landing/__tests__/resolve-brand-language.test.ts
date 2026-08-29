import { describe, expect, it } from "vitest";
import { BrandJsonSchema, resolveBrandLanguage } from "../src/types.js";

/**
 * SCRUM-309 (AU31). Landing's `brand.json` never had a structured place to
 * put a client's required language — the only route was the model reading a
 * free-text `voice.lang` key out of an entirely unvalidated `.passthrough()`
 * bag (`landing-copy-agent.ts`'s own doc comment: `lang` ... "from
 * `brand.voice.lang`"). A brand.json with the language stated anywhere else
 * (or under a differently-named key, since nothing enforced `voice.lang`
 * specifically) produced no signal at all — the same "language dimension
 * doesn't exist anywhere in the QA chain" defect the other six copy channels
 * had, just with landing's own shape of it.
 *
 * `resolveBrandLanguage` is the fix: a structured, top-level `language`
 * field on `BrandJsonSchema` (same field name as `ClientBrand.language`) that
 * wins whenever present, with the legacy `voice.lang` path kept only as a
 * fallback for a brand.json authored before the field existed.
 */
describe("resolveBrandLanguage / BrandJsonSchema.language — AU31", () => {
  const baseBrand = {
    client: "geektime",
    tokens: { colors: {} },
    fonts: { display: "Inter", body: "Inter" },
  };

  it("BrandJsonSchema accepts and preserves a structured top-level language field", () => {
    const parsed = BrandJsonSchema.parse({ ...baseBrand, language: "Hebrew" });
    expect(parsed.language).toBe("Hebrew");
  });

  it("resolveBrandLanguage prefers the structured field over legacy voice.lang", () => {
    const brand = BrandJsonSchema.parse({ ...baseBrand, language: "Hebrew", voice: { lang: "en-US" } });
    expect(resolveBrandLanguage(brand)).toBe("Hebrew");
  });

  it("resolveBrandLanguage falls back to legacy voice.lang for a brand.json with no structured field", () => {
    const brand = BrandJsonSchema.parse({ ...baseBrand, voice: { lang: "he" } });
    expect(resolveBrandLanguage(brand)).toBe("he");
  });

  it("resolveBrandLanguage returns undefined when neither is set — never guesses", () => {
    const brand = BrandJsonSchema.parse({ ...baseBrand });
    expect(resolveBrandLanguage(brand)).toBeUndefined();
  });

  it("resolveBrandLanguage ignores a blank structured field and falls back", () => {
    const brand = BrandJsonSchema.parse({ ...baseBrand, language: "   ", voice: { lang: "ja" } });
    expect(resolveBrandLanguage(brand)).toBe("ja");
  });
});
