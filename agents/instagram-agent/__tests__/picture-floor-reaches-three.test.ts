import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generationPromptFor, normaliseVisualNeed, vetSubjectFor, vetSubjectForGenerated } from "../src/workflow/scene-brief.js";
import { prescribesAbstractGraphic, prescribesClicheScene, styleIsNonPhotographic } from "../src/workflow/visual-direction.js";
import { FLOOR_RESERVE_FRAMES, GENERATED_IMAGES_PER_RUN_CAP } from "../src/workflow/run-budget.js";

/**
 * A CAROUSEL ALWAYS CARRIES ENOUGH PICTURES (the owner, 2026-09-24).
 *
 * Two prep carousels of that day shipped two pictures against a floor of
 * three, for two different reasons the floor could not repair:
 * - KAROS: the floor re-asked a diagram ("abstract editorial graphic ... line-
 *   weight illustration") under a documentary-35mm style, three frames came
 *   back as a man at a doorway, and the vet refused each against the brief.
 * - Sitti: a generated frame was graded against a Stripe slide's `entityRef`
 *   though every generation prompt forbids logos, and eight frames were spent.
 */

const KAROS_BRIEF =
  "Abstract editorial graphic suggesting two isolated data silos on the left and a single unified column on the right, minimal line-weight illustration, dark ground, no labels required.";
const KAROS_STYLE =
  "Documentary 35 mm, one warm off-axis source, deep shadow falloff into near-black #1a1a1a, warm ivory #f2f1ec highlights, fine grain, gentle desaturation — editorial not corporate.";

describe("a diagram brief under a photographic style is drawn as the slide's world", () => {
  it("recognises the KAROS brief and leaves photographic and negated briefs alone", () => {
    expect(prescribesAbstractGraphic(KAROS_BRIEF)).toBe(true);
    expect(prescribesAbstractGraphic("A photographic close-up of hands turning a printed proof")).toBe(false);
    expect(prescribesAbstractGraphic("A corridor at first light, no abstract graphics or icons")).toBe(false);
  });

  it("keeps an illustration brief as written when the client's own style is a drawing", () => {
    expect(styleIsNonPhotographic(KAROS_STYLE)).toBe(false);
    expect(styleIsNonPhotographic("Flat vector illustration, two-tone, thick outlines")).toBe(true);
    expect(styleIsNonPhotographic(undefined)).toBe(false);
  });

  it("rewrites the KAROS brief into a conceptual picture of the slide's words, never a generic scene", () => {
    const slide = {
      headline: "Two silos, one column",
      body: "The data lived in two systems. The rebuild made it one.",
      visualNeed: { subject: { noun: "data silos" }, scene: KAROS_BRIEF, why: "structure", source: "generate" },
    };
    const rewrite = (scene: string): boolean => prescribesClicheScene(scene) || (!styleIsNonPhotographic(KAROS_STYLE) && prescribesAbstractGraphic(scene));
    const prompt = generationPromptFor(normaliseVisualNeed(slide as never), slide, { rewrite });
    // 2026-09-25: "the real-world setting ... as a documentary photographer would" drew a man in a
    // dim workshop for a software idea (job PCjzJDH10gQW7peazB5n). One object that stands for the idea.
    expect(prompt).toMatch(/^A striking conceptual editorial photograph/u);
    expect(prompt).toContain("ONE concrete physical object");
    expect(prompt).not.toContain("real-world setting");
    // Prep batch 6: names in the slide words drew people at conferences; the frame is a still life.
    expect(prompt).toContain("A still life: no people");
    expect(prompt).toContain("Two silos, one column");
  });

  it("is wired into the workflow at every generation site", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "workflow", "create-instagram-agent-workflow.ts"), "utf8");
    expect(src).not.toContain("{ rewrite: prescribesClicheScene }");
    expect(src.match(/\{ rewrite: rewritesScene \}/gu)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("a drawn frame is not graded against the brand it was told not to draw", () => {
  it("drops entityRef and keeps subject, must-shows and scene", () => {
    const slide = {
      visualNeed: {
        subject: { noun: "a phone showing a payment confirmation", entityRef: "Stripe", mustShow: ["phone screen"] },
        scene: "A phone on a café table showing a payment confirmation",
        why: "creators get paid directly",
        source: "generate",
      },
    };
    const need = normaliseVisualNeed(slide as never);
    expect(vetSubjectFor(need).entityRef).toBe("Stripe");
    const drawn = vetSubjectForGenerated(need);
    expect("entityRef" in drawn).toBe(false);
    expect(drawn.subject).toBe("a phone showing a payment confirmation");
    expect(drawn.mustShow).toEqual(["phone screen"]);
  });
});

describe("under the floor the generation ceiling stretches, boundedly", () => {
  it("has a positive, bounded reserve used only below the floor", () => {
    expect(FLOOR_RESERVE_FRAMES).toBeGreaterThan(0);
    expect(FLOOR_RESERVE_FRAMES).toBeLessThanOrEqual(GENERATED_IMAGES_PER_RUN_CAP);
    const src = readFileSync(path.join(__dirname, "..", "src", "workflow", "create-instagram-agent-workflow.ts"), "utf8");
    expect(src).toContain("(withPicture < MIN_PICTURE_SLIDES ? FLOOR_RESERVE_FRAMES : 0)");
  });
});
