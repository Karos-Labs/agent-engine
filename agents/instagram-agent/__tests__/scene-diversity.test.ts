import { describe, expect, it } from "vitest";
import {
  SCENE_SIMILARITY_CEILING,
  VARIATION_CLAUSES,
  diversifySceneBriefs,
  findNearDuplicateFrames,
  sceneSimilarity,
} from "../src/workflow/scene-diversity.js";

/**
 * # SCENE DIVERSITY
 *
 * prep run `pubsub-21909275109642063` (thepitchbydeel, 2026-09-20) shipped two
 * pictures and the owner said both looked the same. They did — the vet's own
 * acceptance notes on the frames read "a founder at a desk reviewing a pitch
 * deck on a laptop", "the act of reviewing a pitch deck", "a founder mid-review
 * looking at a pitch deck on a laptop screen". Three slides, one picture.
 *
 * Nothing had malfunctioned: each frame honestly rendered the brief it was
 * given, and `06f2-one-picture-one-slide` passed them because it compares FILE
 * PATHS and two separately generated frames have different paths.
 *
 * The owner's two conditions on the fix, 2026-09-20:
 *
 *   1. only generic GENERATED assets — never a branded or user-provided one;
 *   2. it must force variety, never drop the image, because a dropped image
 *      becomes a text-heavy slide and that is the complaint underneath.
 *
 * Both are tested below, and the second one twice.
 */

// The real briefs, as close as prose gets to what that run generated from.
const PITCH_A = "A founder at a desk reviewing a pitch deck on a laptop, natural lighting, clean composition";
const PITCH_B = "A founder mid-review looking at a pitch deck on a laptop screen, realistic photography";
const SKYLINE = "A city skyline at dusk seen from a rooftop, long exposure";

describe("what counts as the same picture", () => {
  it("catches the two briefs that produced the look-alike pair", () => {
    expect(sceneSimilarity(PITCH_A, PITCH_B)).toBeGreaterThan(SCENE_SIMILARITY_CEILING);
  });

  it("leaves genuinely different scenes alone", () => {
    expect(sceneSimilarity(PITCH_A, SKYLINE)).toBeLessThan(SCENE_SIMILARITY_CEILING);
  });

  it("is not fooled by the art direction every brief carries", () => {
    // Two different subjects, identical treatment language. If the shared
    // boilerplate counted, every brief in a run would match every other and
    // the check would steer everything — which is its own kind of broken.
    const one = "A warehouse shelf of unsold inventory, natural lighting, clean composition, realistic photography";
    const two = "A queue of customers outside a shop, natural lighting, clean composition, realistic photography";
    expect(sceneSimilarity(one, two)).toBeLessThan(SCENE_SIMILARITY_CEILING);
  });
});

describe("steering briefs apart, before anything is paid for", () => {
  it("steers the second of a converging pair and leaves the first as written", () => {
    const { scenes, variations } = diversifySceneBriefs(
      [
        { n: 1, prompt: PITCH_A },
        { n: 3, prompt: PITCH_B },
      ],
      { seed: "run-a" },
    );
    expect(variations.map((v) => v.n)).toEqual([3]);
    expect(scenes.find((s) => s.n === 1)!.prompt, "the first occurrence of a scene should be untouched").toBe(PITCH_A);
    expect(scenes.find((s) => s.n === 3)!.prompt).toContain(PITCH_B);
    expect(VARIATION_CLAUSES.some((c) => scenes.find((s) => s.n === 3)!.prompt.includes(c))).toBe(true);
  });

  it("NEVER drops a slide — every brief that went in comes out asking for a picture", () => {
    // The condition the owner set, and the one that matters most: an image
    // lost to this check would become a text plate at `07a`, which is the
    // complaint this whole change sits underneath.
    const gaps = [
      { n: 1, prompt: PITCH_A },
      { n: 2, prompt: PITCH_B },
      { n: 3, prompt: PITCH_A },
      { n: 4, prompt: PITCH_B },
    ];
    const { scenes } = diversifySceneBriefs(gaps, { seed: "run-a" });
    expect(scenes).toHaveLength(gaps.length);
    expect(scenes.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    for (const scene of scenes) expect(scene.prompt.length).toBeGreaterThan(0);
  });

  it("gives two slides steered in the same batch DIFFERENT instructions", () => {
    // Otherwise the fix manufactures its own matching pair.
    const { scenes } = diversifySceneBriefs(
      [
        { n: 1, prompt: PITCH_A },
        { n: 2, prompt: PITCH_B },
        { n: 3, prompt: PITCH_A },
      ],
      { seed: "run-a" },
    );
    const clauses = [2, 3].map((n) => VARIATION_CLAUSES.find((c) => scenes.find((s) => s.n === n)!.prompt.includes(c)));
    expect(clauses[0]).toBeDefined();
    expect(clauses[1]).toBeDefined();
    expect(clauses[0]).not.toBe(clauses[1]);
  });

  it("steers away from frames the run already ACCEPTED, not just from this batch", () => {
    // A second attempt must not re-ask for the picture attempt one already got.
    const { variations } = diversifySceneBriefs([{ n: 4, prompt: PITCH_B }], {
      alreadyChosenBriefs: [PITCH_A],
      seed: "run-a",
    });
    expect(variations).toHaveLength(1);
    expect(variations[0]!.tooCloseTo).toBe("an image already chosen for this post");
  });

  it("is deterministic, because these briefs are step inputs and a resume must rebuild them exactly", () => {
    const gaps = [
      { n: 1, prompt: PITCH_A },
      { n: 3, prompt: PITCH_B },
    ];
    expect(diversifySceneBriefs(gaps, { seed: "run-a" }).scenes).toEqual(diversifySceneBriefs(gaps, { seed: "run-a" }).scenes);
  });

  it("varies the instruction across runs, so one client's posts do not all take the same vantage", () => {
    const gaps = [
      { n: 1, prompt: PITCH_A },
      { n: 3, prompt: PITCH_B },
    ];
    const seen = new Set(
      ["pubsub-21909275109642063", "pubsub-21911435865040886", "pubsub-21904879061334183", "pubsub-21896063218741941"].map(
        (seed) => diversifySceneBriefs(gaps, { seed }).scenes.find((s) => s.n === 3)!.prompt,
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("only generated frames are ever compared", () => {
  it("ignores a client upload or an entity photograph, however alike they look", () => {
    // No `generatedBrief` means the frame is something somebody chose — a
    // client's own asset, a library frame, a photograph of a named brand.
    // Two of those resembling each other is not this check's business.
    expect(findNearDuplicateFrames([{ n: 1 }, { n: 2 }, { n: 3 }])).toEqual([]);
  });

  it("reports a generated near-duplicate against the EARLIER slide, and keeps both", () => {
    const found = findNearDuplicateFrames([
      { n: 1, generatedBrief: PITCH_A },
      { n: 3, generatedBrief: PITCH_B },
      { n: 5, generatedBrief: SKYLINE },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ n: 3, matches: 1 });
    // A report, never a removal: nothing in the returned shape can take a
    // slide's picture away, and slide 5 is not in it at all.
    expect(found.map((f) => f.n)).not.toContain(5);
  });

  it("does not compare a generated frame against a client-supplied one", () => {
    const found = findNearDuplicateFrames([
      { n: 1 },
      { n: 3, generatedBrief: PITCH_A },
    ]);
    expect(found, "a generated frame was compared against an asset the client chose").toEqual([]);
  });
});
