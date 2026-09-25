import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { withCoverBudget } from "../src/workflow/slides-data.js";
import { isChromiumInstalled } from "./test-helpers.js";
import { syntheticPhotograph } from "./synthetic-photograph.js";

/**
 * KAROS' cover, prep batches 2 and 5 (pubsub-21538707143676165): `portrait`
 * cover form with a framed picture set the title as a narrow column of small
 * type, because `portrait` measures its title in `ch` with no frame floor, and
 * `ch` shrinks with every step the fit ladder takes beside the picture.
 */
describe("withCoverBudget: the deck yields to the title (decision 20)", () => {
  it("cuts the deck to whole sentences within what the title leaves of 20, keeps its first sentence, and never cuts the title", () => {
    const kept = withCoverBudget({ headline: "Three clocks run your marketing today", body: "Only one of them matches your buyer. The other two schedule your content by the calendar." });
    expect(kept.body).toBe("Only one of them matches your buyer.");
    const dropped = withCoverBudget({ headline: "AI discovery does not reward the biggest budget. It rewards the fastest signal.", body: "The scale advantage does not transfer. The window is open." });
    expect(dropped.headline).toContain("It rewards the fastest signal.");
    expect(dropped.body).toBe("The scale advantage does not transfer.");
    const within = { headline: "Short title", body: "A short deck." };
    expect(withCoverBudget(within)).toBe(within);
  });
});

describe.skipIf(!isChromiumInstalled())("a portrait cover's title keeps a frame-width measure", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let outDir = "";
  afterEach(async () => {
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  });

  it("with the deck yielding to the title, the title sets at a display step, not in fine print", async () => {
    const budgeted = withCoverBudget({
      headline: "AI discovery does not reward the biggest budget. It rewards the fastest signal.",
      body: "The scale advantage that protected incumbents does not transfer to AI-indexed discovery. The window is open. Here is how to move through it.",
    });
    expect(budgeted.headline).toContain("It rewards the fastest signal.");
    expect(budgeted.body).toBe("The scale advantage that protected incumbents does not transfer to AI-indexed discovery.");
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-portrait-measure-"));
    const heroPath = path.join(outDir, "hero.png");
    await fs.writeFile(heroPath, syntheticPhotograph(1080, 1440));
    const hero = path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/");
    const outcome = await createRenderCarousel().execute(
      {
        client: "portrait-measure",
        postId: "look",
        templateDir: "agents/instagram-agent/assets/templates/default",
        outDir: path.relative(REPO_ROOT, outDir).replaceAll("\\", "/"),
        repoRoot: REPO_ROOT,
        slides: [
          {
            n: 1,
            template: "cover.html",
            fields: {
              title: budgeted.headline,
              subtitle: budgeted.body,
              accentColor: "#ff6b2c",
              coverForm: "portrait",
              heroKind: "framed",
              groundTone: "dark",
              brandHandle: "@karoslabs",
            },
            images: { hero },
            htmlFragments: {},
          },
        ],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
        probe: true,
      },
      { ctx: { runId: "pm", clientSlug: "portrait-measure", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome).slice(0, 600));
    const steps = outcome.result.rendered[0]?.geometry?.fontSizeSteps ?? [];
    // Before: title 46px (lead) in a column about 40% of the plate wide, over a 24-word deck.
    expect(steps[0]).toBeGreaterThanOrEqual(66);
  }, 60_000);
});
