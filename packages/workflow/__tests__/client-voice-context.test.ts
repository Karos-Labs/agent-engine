import { describe, expect, it } from "vitest";
import { buildClientVoiceContext } from "../src/primitives/client-voice-context.js";

/**
 * SCRUM-309 (AU31). Root cause 1 of the geektime incident: no language
 * dimension existed anywhere in the QA chain — the only way a language
 * requirement ever reached a drafting prompt was if a client's own
 * `profile.description` happened to mention it in free prose (e.g. "Israel's
 * largest Hebrew-language technology site"). A brand kit with a structured
 * `language` field and NO such prose sentence produced no language signal at
 * all, and a Hebrew-voice client with an English-only profile blurb got
 * silently-English copy that passed every check.
 *
 * These tests assert the fix: `buildClientVoiceContext` takes the BrandKit's
 * `language` field as an explicit third argument and — independent of
 * whatever prose is or isn't in profile/voiceRules — emits an unambiguous,
 * structured directive naming it. A prose-free brand kit that only sets
 * `language` must still produce a non-empty, language-naming context.
 */
describe("buildClientVoiceContext — AU31 structured language field", () => {
  it("emits a language directive from brand.language even when profile/voiceRules carry no prose at all", () => {
    const profile = {}; // no `description` — the old failure mode
    const voiceRules = {}; // no `guidelines` — the old failure mode
    const brand = { language: "Hebrew" };

    const context = buildClientVoiceContext(profile, voiceRules, brand);

    expect(context).toBeDefined();
    expect(context).toContain("Hebrew");
  });

  it("keeps the language directive independent of unrelated profile prose", () => {
    const profile = { description: "A boutique consultancy for founders." };
    const voiceRules = {};
    const brand = { language: "Japanese" };

    const context = buildClientVoiceContext(profile, voiceRules, brand);

    expect(context).toBeDefined();
    expect(context).toContain("Japanese");
  });

  it("places the language directive first, ahead of profile/voiceRules prose", () => {
    const profile = { description: "A boutique consultancy for founders." };
    const voiceRules = { guidelines: "Always second person." };
    const brand = { language: "Hebrew" };

    const context = buildClientVoiceContext(profile, voiceRules, brand);

    expect(context).toBeDefined();
    expect(context!.indexOf("Hebrew")).toBeLessThan(context!.indexOf("boutique consultancy"));
  });

  it("returns undefined when neither prose nor a structured language field is present (unchanged behavior for a client with no brand kit set up)", () => {
    const context = buildClientVoiceContext(undefined, undefined, undefined);
    expect(context).toBeUndefined();
  });

  it("ignores a brand kit with a blank/whitespace-only language field", () => {
    const context = buildClientVoiceContext({}, {}, { language: "   " });
    expect(context).toBeUndefined();
  });
});
