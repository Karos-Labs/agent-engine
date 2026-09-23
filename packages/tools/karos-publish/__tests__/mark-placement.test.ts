import { existsSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARK_AUTO_CANDIDATES, rotatedCandidates } from "../src/mark-placement.js";
import { createRenderCarousel, type RenderCarouselResult } from "../src/render-carousel.js";

// 2026-09-23, the owner: a logo can go at the side too, and on some pictures
// it belongs somewhere other than where it looks good on another. The
// renderer looks at the slide and keeps the quietest placement that no copy
// is near. These renders are the proof that it follows the PICTURE.

function isChromiumInstalled(): boolean {
  const cache = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? path.join(os.homedir(), process.platform === "win32" ? "AppData/Local/ms-playwright" : ".cache/ms-playwright");
  try {
    return existsSync(cache) && readdirSync(cache).some((d) => d.startsWith("chromium"));
  } catch {
    return false;
  }
}

const ROOT = path.resolve(__dirname, "..");
const TEMPLATE_DIR = ".tmp-mark-placement-templates";
const OUT_DIR = ".tmp-mark-placement-out";

/** A dark photograph with one skin-toned "face" on the given side, top half. */
const photo = (faceOn: "start" | "end") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440"><rect width="1080" height="1440" fill="#15171c"/>` +
  `<ellipse cx="${faceOn === "start" ? 270 : 810}" cy="360" rx="260" ry="300" fill="#e0ac8a"/></svg>`;
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="#111"/></svg>`;

const TEMPLATE = `<!doctype html><html lang="en" dir="ltr"><head><style>
  html, body { margin: 0; }
  body { width: 1080px; height: 1440px; position: relative; overflow: hidden; background: #15171c; --mx: 64px; --zone-mark: 100px; --sp: 16px; }
  .hero { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .plate { position: relative; z-index: 3; box-sizing: border-box; height: 100%; padding: 100px 64px 80px; display: flex; flex-direction: column; justify-content: flex-end; }
  h2 { margin: 0; font: 700 88px/1.05 sans-serif; color: #fff; }
  .mark-badge { display: inline-flex; order: -1; align-self: flex-start; box-sizing: border-box; height: 104px; padding: 18px 26px; background: #fff; border-radius: 22px; position: relative; z-index: 4; }
  .mark-badge img { max-height: 100%; }
  .mark-badge[data-at^="tail"] { order: 99; }
  .mark-badge[data-at$="-end"] { align-self: flex-end; }
  .mark-badge[data-at^="corner-"], .mark-badge[data-at^="side-"] { position: absolute; margin: 0; }
  .mark-badge[data-at="corner-top-end"] { top: 116px; right: 64px; }
  .mark-badge[data-at="corner-top-start"] { top: 116px; left: 64px; }
  .mark-badge[data-at="side-end"] { top: 36%; right: 64px; }
  .mark-badge[data-at="side-start"] { top: 36%; left: 64px; }
</style></head><body>
  <img class="hero" src="{{image:hero}}" alt="" />
  <div class="plate">
    <div class="mark-badge" data-at="auto"><img src="{{image:mark}}" alt="" /></div>
    <h2>{{headline}}</h2>
  </div>
  <script>window.__READY__ = true;</script>
</body></html>`;

async function render(faceOn: "start" | "end"): Promise<RenderCarouselResult["rendered"][number]> {
  const out = await createRenderCarousel().execute(
    {
      client: "smoke-test",
      postId: `mark-${faceOn}`,
      templateDir: TEMPLATE_DIR,
      outDir: OUT_DIR,
      repoRoot: ROOT,
      slides: [{ n: 1, template: "badge.html", fields: { headline: "Anthropic hit this problem first, and the retry layer is why" }, images: { hero: `${TEMPLATE_DIR}/face-${faceOn}.svg`, mark: `${TEMPLATE_DIR}/logo.svg` }, htmlFragments: {} }],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      readyFlag: "__READY__",
    } as never,
    { ctx: { runId: "r", clientSlug: "smoke-test", productId: "x", runKind: "setup", metadata: {} } },
  );
  if (out.status !== "success") throw new Error(JSON.stringify(out));
  return (out.result as RenderCarouselResult).rendered[0]!;
}

describe("rotatedCandidates", () => {
  it("is every placement, in a seeded order", () => {
    expect(new Set(rotatedCandidates("x:1"))).toEqual(new Set(MARK_AUTO_CANDIDATES));
    expect(rotatedCandidates("x:1")).toEqual(rotatedCandidates("x:1"));
  });
});

describe.skipIf(!isChromiumInstalled())("auto mark placement on a real render", () => {
  beforeAll(async () => {
    const dir = path.join(ROOT, TEMPLATE_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "badge.html"), TEMPLATE, "utf8");
    await fs.writeFile(path.join(dir, "face-start.svg"), photo("start"), "utf8");
    await fs.writeFile(path.join(dir, "face-end.svg"), photo("end"), "utf8");
    await fs.writeFile(path.join(dir, "logo.svg"), LOGO, "utf8");
  }, 60_000);
  afterAll(async () => {
    await fs.rm(path.join(ROOT, TEMPLATE_DIR), { recursive: true, force: true });
    await fs.rm(path.join(ROOT, OUT_DIR), { recursive: true, force: true });
  });

  it(
    "keeps the badge off the face, whichever side the face is on, and never next to the copy",
    async () => {
      const faceEnd = await render("end");
      const faceStart = await render("start");
      for (const r of [faceEnd, faceStart]) {
        expect(r.markPlacement, "the renderer reported no placement").toBeDefined();
        const chosen = r.markPlacement!.chosen;
        // Whatever it chose was measured, not refused.
        expect(typeof r.markPlacement!.costs[chosen]).toBe("number");
      }
      // The face is at the top END: the badge goes to the start side.
      expect(faceEnd.markPlacement!.chosen).toMatch(/-start$/u);
      expect(faceStart.markPlacement!.chosen).toMatch(/-end$/u);
      // The premise: the upper placement over the face was measured dearer.
      const over = faceEnd.markPlacement!.costs["corner-top-end"];
      const clear = faceEnd.markPlacement!.costs["corner-top-start"];
      if (typeof over === "number" && typeof clear === "number") expect(over).toBeGreaterThan(clear);
    },
    120_000,
  );
});
