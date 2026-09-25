import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { buildListRows } from "../src/workflow/slides-data.js";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * Job PCjzJDH10gQW7peazB5n (karoslabs, 2026-09-25), slide 2: at the fit
 * ladder's last rung the list's title fell to the rows' own size, and the
 * display serif read smaller than the four grotesk rows under it. The title
 * holds one step above its rows.
 */
describe.skipIf(!isChromiumInstalled())("a list's title stays above its rows", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let outDir = "";
  afterEach(async () => {
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  });

  it("the job's own four-row list: the title is set larger than any row title", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-list-head-"));
    const rows = buildListRows([
      { title: "Map every task to inline or sub-agent", note: "If the answer is unclear, that task has no threshold set." },
      { title: "Assign a score floor to each agent role", note: "Tasks below the floor stay inline. Tasks above route out." },
      { title: "Block sensitive keywords from auto-delegation", note: "Deploy, production, and password must never route autonomously." },
      { title: "Cap delegation hops per session, then audit", note: "Most frameworks default to 3 hops. Verify yours before trusting it." },
    ]);
    const outcome = await createRenderCarousel().execute(
      {
        client: "list-head",
        postId: "look",
        templateDir: "agents/instagram-agent/assets/templates/default",
        outDir: path.relative(REPO_ROOT, outDir).replaceAll("\\", "/"),
        repoRoot: REPO_ROOT,
        slides: [
          {
            n: 2,
            template: "list-takeaway.html",
            fields: { accentColor: "#ff6b2c", groundTone: "dark", brandHandle: "@karoslabs", headline: "Four moves to calibrate your delegation threshold before it costs you" },
            images: {},
            htmlFragments: { itemRows: rows },
          },
        ],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
        probe: true,
      },
      { ctx: { runId: "lh", clientSlug: "list-head", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome).slice(0, 600));
    const slide = outcome.result.rendered[0]!;
    const steps = slide.geometry?.fontSizeSteps ?? [];
    // Sizes, largest first: the title is the largest text on the plate and strictly above the next size down.
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0]!).toBeGreaterThanOrEqual(46);
    expect(steps[0]!).toBeGreaterThan(steps[1]!);
    // The ladder shrinks the whole set together, so a plate reporting step 0 has its title at the
    // statement's own size. Before, the title alone dropped to 46px while the ladder reported 0.
    const fit = slide.probe?.fitStep ?? 0;
    expect(fit > 0 || steps[0]! >= 66).toBe(true);
    expect(slide.probe?.overflowing ?? []).toEqual([]);
  }, 60_000);
});
