import { afterEach, describe, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { isChromiumInstalled } from "./test-helpers.js";

/** THROWAWAY. Renders one plate at every figure placement so a human can look at them. */
describe.skipIf(!isChromiumInstalled())("figure placement probe", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let outDir: string;
  afterEach(async () => {
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  });

  it("renders every placement", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-figure-probe-"));
    const keep = path.join(REPO_ROOT, "..", "figure-probe");
    await fs.mkdir(keep, { recursive: true });

    // A real photograph for the band: a 1200x800 JPEG of noise is enough to
    // see WHERE the band sits and how big it is.
    const hero = path.join(outDir, "hero.png");
    const { realJpeg } = (await import("../../../packages/tools/karos-media/__tests__/image-fixtures.js")) as {
      realJpeg: (w: number, h: number) => Buffer;
    };
    await fs.writeFile(hero, realJpeg(1400, 900));

    const placements = ["band", "side", "inset", "tall", "side-end", "bleed"] as const;
    const tool = createRenderCarousel();
    const outcome = await tool.execute(
      {
        client: "probe",
        postId: "figures",
        templateDir: "agents/instagram-agent/assets/templates/default",
        outDir: path.relative(REPO_ROOT, outDir),
        repoRoot: REPO_ROOT,
        slides: placements.map((placement, i) => ({
          n: i + 1,
          template: "stat-callout.html",
          fields: {
            figure: "77%",
            subLabel: "of teams miss the window",
            body: "Trigger marketing fires on external actions. The buyer's readiness is internal.",
            sourceLine: "internal survey",
            accentColor: "#C4552F",
            figurePlacement: placement,
            brandHandle: "@karoslabs",
            slideIndex: String(i + 1),
          },
          images: { hero: path.relative(REPO_ROOT, hero) },
          htmlFragments: {},
        })),
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
      },
      { ctx: { runId: "r", clientSlug: "probe", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );
    if (outcome.status !== "success") console.error("PROBE FAILED:", JSON.stringify(outcome).slice(0, 900));
    for (let i = 0; i < placements.length; i++) {
      const src = path.join(outDir, `slide-${i + 1}.png`);
      await fs.copyFile(src, path.join(keep, `${placements[i]}.png`)).catch(() => undefined);
    }
  }, 180000);
});
