import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forbidWithoutScreens, isRelatedScreenBrief, RELATED_SCREEN_STYLE, sceneNamesForbiddenSubject } from "../src/workflow/visual-direction.js";

/** Owner, 2026-09-26: a generated screen is welcome when the story is about that product; an unrelated screen stays banned. */
const entities = [
  { name: "ChatGPT", kind: "product" },
  { name: "LinkedIn", kind: "company" },
  { name: "Sam Altman", kind: "person" },
];
const karosForbid = ["laptop, desktop monitor, or any illuminated screen", "stock handshakes"];

describe("a screen that belongs to the story", () => {
  it("qualifies an interface brief that names a product the post is about", () => {
    expect(isRelatedScreenBrief("ChatGPT interface on a dark desktop screen", entities)).toBe(true);
    expect(isRelatedScreenBrief("a LinkedIn feed showing a founder's post", entities)).toBe(true);
  });

  it("never an unrelated screen, a screen with no named product, or a person", () => {
    expect(isRelatedScreenBrief("a glowing laptop screen in a dark room", entities)).toBe(false);
    expect(isRelatedScreenBrief("Sam Altman on stage", entities)).toBe(false);
    expect(isRelatedScreenBrief("a ChatGPT sticker on a notebook", entities)).toBe(false);
  });

  it("the batch drops only the screen family from its negatives, and the brief says how the screen must look", () => {
    expect(sceneNamesForbiddenSubject("ChatGPT interface on a dark desktop screen", karosForbid)).toBe(true);
    expect(forbidWithoutScreens(karosForbid)).toEqual(["stock handshakes"]);
    expect(RELATED_SCREEN_STYLE).toMatch(/very few short words, no real logos/u);
    const src = readFileSync(new URL("../src/workflow/create-instagram-agent-workflow.ts", import.meta.url), "utf8");
    expect(src).toContain("(sceneNamesForbiddenSubject(scene, directionForbid) && !relatedScreen(scene))");
  });
});
