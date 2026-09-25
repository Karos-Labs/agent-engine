import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import type { ImageSelection, InstagramCopyOutput } from "../src/workflow/types.js";

/**
 * A picture on the vet's middle rung (compatible with the slide, not OF its
 * subject) is placed INSIDE the plate on a cover or photo slide, never refused.
 * KAROS' prep run pubsub-21536461577789691 (2026-09-25) shipped one picture:
 * the floor generated a cover frame three times, the vet placed it `bounded`
 * three times, and a cover refused every bounded picture as a would-be ground.
 */
describe("bounded pictures on a cover or photo slide", () => {
  const copy = {
    format: "carousel",
    caption: "c",
    slides: [
      { n: 1, headline: "42% of CMOs are still on task-level AI", body: "Short.", visualNeed: "v", sourceRef: "c", layout: "cover" },
      { n: 2, headline: "An interior photo slide", body: "b", visualNeed: "v", sourceRef: "c", layout: "photo" },
      { n: 3, headline: "Close", body: "What does your stack share?", visualNeed: "v", sourceRef: "c", layout: "closer" },
    ],
  } as InstagramCopyOutput;
  const sel = (n: number, imagePath: string | null): ImageSelection => ({ n, imagePath, reason: "r", license: "CC0", rightsUsable: true, watermarkFree: true, claimMatch: 3, subjectMatch: 3, claimMatchReason: "r" });
  const run = (bounded?: Set<string>) =>
    assembleSlidesData({
      clientSlug: "k",
      postId: "p",
      repoRoot: "/r",
      brandTokens: { templateDir: "t", slideTemplate: "slide.html" },
      copy,
      selections: [sel(1, "media/cover-frame.png"), sel(2, "media/setting.png"), sel(3, null)],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      paletteSeed: "bounded",
      ...(bounded !== undefined ? { boundedPicturePaths: bounded } : {}),
    });

  it("frames a bounded cover picture and sets a bounded interior photo as an inset block", () => {
    const data = run(new Set(["media/cover-frame.png", "media/setting.png"]));
    const byN = new Map(data.slides.map((s) => [s.n, s]));
    expect(byN.get(1)!.images.hero).toBe("media/cover-frame.png");
    expect(byN.get(1)!.fields.heroKind).toBe("framed");
    expect(byN.get(2)!.fields.figurePlacement).toBe("inset");
  });

  it("leaves a full-bleed-worthy cover as the poster (the premise)", () => {
    const data = run();
    expect(data.slides.find((s) => s.n === 1)!.fields.heroKind).not.toBe("framed");
  });

  it("the workflow collects the middle-rung pictures instead of refusing them", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/workflow/create-instagram-agent-workflow.ts"), "utf8");
    expect(src).toContain('&& s.imagePath !== null) boundedPicturePaths.add(s.imagePath);');
    expect(src).toContain("boundedPicturePaths,");
  });
});
