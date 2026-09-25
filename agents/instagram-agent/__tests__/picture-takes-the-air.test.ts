import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { isChromiumInstalled } from "./test-helpers.js";
import { syntheticPhotograph } from "./synthetic-photograph.js";

/**
 * Job PCjzJDH10gQW7peazB5n (karoslabs, 2026-09-25): the framed cover set its
 * photograph as a 540px block and anchored a short title to the foot, leaving a
 * ~330px empty band between them; the owner called the post boring and a step
 * back. Kindly Yours slide 2 was the same shape on the inset photo plate (600px
 * block, "a quarter picture at the top and the rest empty"). `_ds-fit.js` now
 * gives the air the copy leaves to the picture, and never pushes the copy past
 * the field's foot.
 */
describe.skipIf(!isChromiumInstalled())("a framed picture takes the air the copy leaves", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let outDir = "";
  afterEach(async () => {
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  });

  it("short copy under a framed cover picture: the block grows past its 540px floor, and nothing overflows", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-picture-air-"));
    const heroPath = path.join(outDir, "hero.png");
    await fs.writeFile(heroPath, syntheticPhotograph(1600, 1000));
    const hero = path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/");
    const base = { accentColor: "#ff6b2c", groundTone: "dark", brandHandle: "@karoslabs", coverForm: "figure", figurePlacement: "band" };
    const outcome = await createRenderCarousel().execute(
      {
        client: "picture-air",
        postId: "look",
        templateDir: "agents/instagram-agent/assets/templates/default",
        outDir: path.relative(REPO_ROOT, outDir).replaceAll("\\", "/"),
        repoRoot: REPO_ROOT,
        slides: [
          { n: 1, template: "cover.html", fields: { ...base, title: "Your defaults were never calibrated", subtitle: "Most stacks ship with the threshold untouched.", heroKind: "framed" }, images: { hero }, htmlFragments: {} },
        ],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
        probe: true,
      },
      { ctx: { runId: "pa", clientSlug: "picture-air", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome).slice(0, 600));
    const slide = outcome.result.rendered[0]!;
    // 912 x 540 of 1080 x 1440 is 0.317 of the canvas: the fixed block before this change.
    expect(slide.geometry?.subjectBoxes.hero ?? 0).toBeGreaterThan(0.36);
    expect(slide.probe?.overflowing ?? []).toEqual([]);
    expect(slide.probe?.offscreen ?? []).toEqual([]);
  }, 60_000);
});
