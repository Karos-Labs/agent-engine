import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { framedHeroFor } from "../src/workflow/slides-data.js";
import { isChromiumInstalled } from "./test-helpers.js";
import { syntheticPhotograph } from "./synthetic-photograph.js";

/**
 * A PHOTOGRAPH IS A BLOCK WHEN THERE ARE WORDS TO PUT UNDER IT.
 *
 * The owner, 2026-09-24, on two live covers whose headline AND deck were laid
 * across a face and a body: *"it would have been nicer if the picture were
 * like slide 3 of XO Digital, where the picture is not over the whole screen
 * — it is a bit more aesthetic"*. Slide 3 is the centred block they had
 * already picked out of the shape rotation.
 *
 * Two halves, and the second is why this file renders rather than only
 * asserting a boolean: the RULE decides which covers change, and the PIXELS
 * decide whether the change is the one that was asked for. A rule that fires
 * correctly onto CSS that still paints a wall is the defect with a test
 * beside it.
 */

describe("which covers stop being a wall", () => {
  const base = { layout: "cover" as const, headline: "By August, the spotlights had real names", hasPicture: true, heroIsMark: false, isCutout: false };

  it("frames a cover that carries a deck — those words would land on the subject", () => {
    expect(framedHeroFor({ ...base, body: "Alix Earle's map. Matt Peterson's NYC picks. Local knowledge, sold by the person who knows." })).toBe(true);
  });

  it("leaves a headline-only or short-line cover as the poster it is", () => {
    // The composition the owner has NOT objected to: a few words over a strong
    // photograph. Additive, never a regression of what already looks good.
    expect(framedHeroFor({ ...base, body: "" })).toBe(false);
    expect(framedHeroFor({ ...base, body: "   " })).toBe(false);
    // 2026-09-24: the copy schema requires a body, so a SHORT line is the real
    // "headline alone" case: under `FRAMED_DECK_MIN_WORDS` it keeps the poster.
    expect(framedHeroFor({ ...base, body: "Local knowledge, sold by the people who know." })).toBe(false);
  });

  it("applies to the `photo` plate too, not only the cover", () => {
    expect(framedHeroFor({ ...base, layout: "photo", body: "Alix Earle's map. Matt Peterson's NYC picks. Local knowledge, sold by the person who knows." })).toBe(true);
  });

  it("leaves the panel archetypes alone — their picture is already bounded", () => {
    for (const layout of ["quote_card", "stat_callout", "list_takeaway", "comparison_card"] as const) {
      expect(framedHeroFor({ ...base, layout, body: "A deck." })).toBe(false);
    }
  });

  it("never touches a mark or a product cutout, which have their own treatments", () => {
    expect(framedHeroFor({ ...base, body: "A deck.", heroIsMark: true })).toBe(false);
    expect(framedHeroFor({ ...base, body: "A deck.", isCutout: true })).toBe(false);
  });

  it("says nothing about a plate with no picture", () => {
    expect(framedHeroFor({ ...base, body: "A deck.", hasPicture: false })).toBe(false);
  });
});

// Real Chromium, same guard as the sibling render suites: an absent optional
// browser must read as a skip, not as a broken build.
describe.skipIf(!isChromiumInstalled())("what the two covers actually paint", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let outDir = "";

  afterEach(async () => {
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  });

  it("paints the picture as a bounded block, and the full-bleed cover as the whole plate", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-framed-hero-"));
    const heroPath = path.join(outDir, "hero.png");
    await fs.writeFile(heroPath, syntheticPhotograph(1080, 1440));
    const hero = path.relative(REPO_ROOT, heroPath).replaceAll("\\", "/");
    const fields = {
      title: "By August, the spotlights had real names",
      subtitle: "Alix Earle's map. Matt Peterson's NYC picks. Local knowledge, sold by the person who actually knows the city.",
      accentColor: "#C4552F",
      brandHandle: "@sitti.app",
      eyebrow: "CREATOR ECONOMY",
      heroScrimStrength: "strong",
    };

    const outcome = await createRenderCarousel().execute(
      {
        client: "framed-hero",
        postId: "look",
        templateDir: "agents/instagram-agent/assets/templates/default",
        outDir: path.relative(REPO_ROOT, outDir).replaceAll("\\", "/"),
        repoRoot: REPO_ROOT,
        slides: [
          { n: 1, template: "cover.html", fields: { ...fields, heroKind: "framed" }, images: { hero }, htmlFragments: {} },
          { n: 2, template: "cover.html", fields, images: { hero }, htmlFragments: {} },
        ],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
        probe: true,
      },
      { ctx: { runId: "framed", clientSlug: "framed-hero", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );

    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome).slice(0, 600));
    const [framed, bled] = outcome.result.rendered;
    const framedShare = framed?.geometry?.subjectBoxes.hero ?? 0;
    const bledShare = bled?.geometry?.subjectBoxes.hero ?? 0;

    // The premise: BOTH slides really rendered a photograph. `onerror` removes
    // a hero that failed to load, and a missing picture would report 0 on both
    // and pass a one-sided assertion.
    expect(bledShare).toBeGreaterThan(0.9);
    // And the framed one is a block on the plate, not the plate.
    expect(framedShare).toBeGreaterThan(0.2);
    expect(framedShare).toBeLessThan(0.55);
  }, 60_000);
});

describe("a lockup under a bounded picture starts below it (2026-09-25)", () => {
  it("never offsets the lockup with a percentage padding, which resolves against the WIDTH", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(path.resolve(__dirname, "..", "assets", "templates", "default", "_design-system.css"), "utf8");
    // Hanky Panky's framed cover: picture `block-size: 46%` (662px of 1440),
    // lockup `padding-block-start: … 46% …` (497px of 1080) — the headline sat
    // on the photograph. Comments may say "%", rules may not.
    const rules = css.replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(rules).not.toMatch(/padding-block-start:[^;]*\d%/u);
    expect(rules).toContain("block-size: var(--frame-h)");
    expect(rules).toContain("var(--frame-h) + var(--sp-2)");
    expect(rules).toContain("block-size: var(--cutout-h)");
  });
});
