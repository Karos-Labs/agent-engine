import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { buildDeviceFragment } from "../src/workflow/slide-devices.js";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * A LIST ITEM THAT CARRIES A FIGURE (owner, 2026-09-25).
 *
 * The Pitch by Deel slide 4 and KAROS slides 4-5 of the 2026-09-25 prep batch:
 * the item's number ("03") sat at the scale's top step, 200px, and never
 * stepped with the fit ladder, so the ladder shrank the figure instead, to
 * 66px over a 22px caption. The owner: the small text on top looks bad against
 * what is written below it. The figure is the display object of the plate;
 * the item number is a place marker and sits at the label step.
 */
describe.skipIf(!isChromiumInstalled())("a list item's figure is the display object", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let outDir = "";

  afterEach(async () => {
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  });

  const render = async (device: string, itemOrdinal: string) => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-list-item-figure-"));
    const outcome = await createRenderCarousel().execute(
      {
        client: "list-item-figure",
        postId: "look",
        templateDir: "agents/instagram-agent/assets/templates/default",
        outDir: path.relative(REPO_ROOT, outDir).replaceAll("\\", "/"),
        repoRoot: REPO_ROOT,
        slides: [
          {
            n: 4,
            template: "headline-focus.html",
            fields: {
              headline: "Think in shades of grey",
              body: "Founders who demonstrated nuanced, differentiated thinking secured significantly more funding across 547 pitches at TechCrunch Disrupt Startup Battlefield.",
              itemOrdinal,
              accentColor: "#7B5CFF",
              brandHandle: "@deelpitch",
              groundTone: "dark",
              slideIndex: "04",
            },
            images: {},
            htmlFragments: { device },
          },
        ],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
        probe: true,
      },
      { ctx: { runId: "lif", clientSlug: "list-item-figure", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome).slice(0, 600));
    const steps = outcome.result.rendered[0]?.geometry?.fontSizeSteps ?? [];
    await fs.rm(outDir, { recursive: true, force: true });
    return steps;
  };

  it("the item number adds no size of its own and costs the figure nothing", async () => {
    const device = buildDeviceFragment(
      { kind: "figure", value: "547", label: "Founders who demonstrated nuanced, differentiated thinking secured more funding", source: "Academy of Management Proceedings" },
      "ltr",
    );
    const without = await render(device, "");
    const withNumber = await render(device, "03");
    // The premise: the figure painted at the top step on the plain plate.
    expect(without[0]).toBe(200);
    // Before the fix: [200, 94, 66, 32, 22, 16] against [200, 94, 46, 32, 16] —
    // a 200px "03", the figure shrunk to 66px and its caption to 22px.
    expect(withNumber).toEqual(without);
  }, 60_000);
});
