import { describe, expect, it } from "vitest";
import { deriveDefaultPromptSet } from "../src/workflow/prompt-set.js";

/**
 * The portal files `brand` AND `navigational` prompts under "When buyers ask
 * about you by name" (its `BRANDED_INTENTS`). Found 2026-09-06 on prep: that
 * heading listed "How do I find a good AI Digital Marketing provider near me?"
 * — a navigational template that named nobody. A prompt shown under that
 * heading must actually contain the client's name, in every language the
 * templates exist in; and a category prompt must not, or the category/branded
 * comparison the portal draws stops being like-for-like.
 */
describe("default prompt set — branded intents name the client, category intents do not", () => {
  const BRANDED = new Set(["brand", "navigational"]);
  const BRAND = "Acme Corp";

  for (const language of ["en", "es"]) {
    it(`${language}: every brand/navigational prompt names ${BRAND}; no other prompt does`, () => {
      const { prompts, languageFallbackApplied } = deriveDefaultPromptSet("B2B SaaS", language, BRAND);
      expect(languageFallbackApplied).toBe(false);
      expect(prompts.length).toBeGreaterThan(0);

      const branded = prompts.filter((p) => BRANDED.has(p.intentType));
      const category = prompts.filter((p) => !BRANDED.has(p.intentType));
      expect(branded.length).toBeGreaterThan(0);
      expect(category.length).toBeGreaterThan(0);

      for (const p of branded) expect(p.promptText, `${p.intentType}: ${p.promptText}`).toContain(BRAND);
      for (const p of category) expect(p.promptText, `${p.intentType}: ${p.promptText}`).not.toContain(BRAND);
    });
  }

  it("a brand with an apostrophe-taking name still reads as a question about that brand", () => {
    // Possessive templates ("${b}'s official website") must not mangle a name.
    const { prompts } = deriveDefaultPromptSet("B2B SaaS", "en", "The Pitch by Deel");
    const navigational = prompts.filter((p) => p.intentType === "navigational");
    expect(navigational.every((p) => p.promptText.includes("The Pitch by Deel"))).toBe(true);
  });
});
