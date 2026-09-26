import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import { isChromiumInstalled } from "./test-helpers.js";
import { syntheticPhotograph } from "./synthetic-photograph.js";

/** 2026-09-26, the owner's grapes reference: labels with an arrow into the slide's picture. */
describe("callouts reach the plate", () => {
  it("emits the located callouts only for a slide with a picture", () => {
    const copy = { format: "carousel", caption: "c", slides: [
      { n: 1, headline: "A cover headline for the post", body: "A deck line.", visualNeed: "v", sourceRef: "s", layout: "cover" },
      { n: 2, headline: "How to tell them apart", body: "One is ripe.", visualNeed: "v", sourceRef: "s", layout: "photo" },
    ] } as unknown as InstagramCopyOutput;
    const callouts = new Map([[2, [{ label: "sweet, ripe", box: { x0: 0.55, y0: 0.2, x1: 0.9, y1: 0.8 } }]], [1, [{ label: "nothing", box: { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 } }]]]);
    const data = assembleSlidesData({
      clientSlug: "k", postId: "p", repoRoot: "/r", brandTokens: { templateDir: "t", slideTemplate: "slide.html" }, copy,
      selections: [{ n: 1, imagePath: null, reason: "r", license: "x", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" }, { n: 2, imagePath: "media/grapes.jpg", reason: "r", license: "x", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" }],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 }, paletteSeed: "k", callouts,
    });
    expect(data.slides[0]!.fields["callouts"]).toBeUndefined();
    expect(JSON.parse(data.slides[1]!.fields["callouts"]!)).toEqual([{ label: "sweet, ripe", box: { x0: 0.55, y0: 0.2, x1: 0.9, y1: 0.8 } }]);
  });
});

describe.skipIf(!isChromiumInstalled())("the plate draws each callout as a label and an arrow", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let outDir = "";
  afterEach(async () => {
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  });

  it("draws two callouts into a picture", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-callouts-"));
    const heroPath = path.join(outDir, "hero.png");
    await fs.writeFile(heroPath, syntheticPhotograph(1080, 1440));
    const hero = path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/");
    const outcome = await createRenderCarousel().execute(
      {
        client: "callouts", postId: "look",
        templateDir: "agents/instagram-agent/assets/templates/default",
        outDir: path.relative(REPO_ROOT, outDir).replaceAll("\\", "/"),
        repoRoot: REPO_ROOT,
        slides: [
          { n: 1, template: "slide.html", fields: { headline: "How to tell them apart", body: "One is ripe.", accentColor: "#ff6b2c", callouts: JSON.stringify([{ label: "sour, unripe", box: { x0: 0.08, y0: 0.35, x1: 0.45, y1: 0.85 } }, { label: "sweet, ripe", box: { x0: 0.55, y0: 0.35, x1: 0.92, y1: 0.85 } }]) }, images: { hero }, htmlFragments: {} },
          { n: 2, template: "slide.html", fields: { headline: "How to tell them apart", body: "One is ripe.", accentColor: "#ff6b2c" }, images: { hero }, htmlFragments: {} },
        ],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
        probe: true,
      },
      { ctx: { runId: "callouts", clientSlug: "callouts", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome).slice(0, 600));
    const withCallouts = outcome.result.rendered[0]!.probe as { overflow?: boolean; elementCount?: number };
    const without = outcome.result.rendered[1]!.probe as { overflow?: boolean; elementCount?: number };
    expect(withCallouts.overflow).toBe(false);
    // Two labels, two arrows with their heads, the layer and its SVG: the plate grew by the drawing.
    expect((withCallouts.elementCount ?? 0) - (without.elementCount ?? 0)).toBeGreaterThanOrEqual(4);
    const html = await fs.readFile(path.join(REPO_ROOT, "agents/instagram-agent/assets/templates/default/slide.html"), "utf8");
    expect(html).toContain("function placeCallouts(then)");
    expect(html).toContain('data-callouts="{{callouts}}"');
  }, 90_000);
});
