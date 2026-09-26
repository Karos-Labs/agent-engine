import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleSlidesData, FIGURE_INK_MIN_CONTRAST } from "../src/workflow/slides-data.js";
import { LAYOUT_FIELD_KEYS } from "../src/workflow/visual-qa-pre-checks.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";

/**
 * Re-rendered prep batch 8 (2026-09-26): the stat panel read as a placeholder,
 * a grey box stretched to fill the plate with its figure and label at the top.
 * The owner's references set the key number in the brand colour.
 */
const statCopy = (): InstagramCopyOutput =>
  ({
    format: "carousel",
    caption: "c",
    slides: [
      { n: 1, headline: "A headline for the cover of this post", body: "A deck line.", visualNeed: "v", sourceRef: "s", layout: "cover" },
      { n: 2, headline: "The share that matters", body: "Self-purchase is the majority.", visualNeed: "v", sourceRef: "s", layout: "stat_callout", stat: { figure: "62%", subLabel: "of luxury lingerie purchases are self-buys" } },
    ],
  }) as unknown as InstagramCopyOutput;

const assemble = (ground: string, fg: string, accent: string) =>
  assembleSlidesData({
    clientSlug: "k", postId: "p", repoRoot: "/r",
    brandTokens: { templateDir: "t", slideTemplate: "slide.html", accentColor: accent } as never,
    copy: statCopy(),
    selections: [1, 2].map((n) => ({ n, imagePath: null, reason: "r", license: "x", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" })),
    canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
    paletteSeed: "k", groundHex: ground, foregroundHex: fg, brandAccentFallback: accent, accentRing: [accent],
  }).slides.find((s) => s.n === 2)!;

describe("the stat card (2026-09-26)", () => {
  it("sets the figure in the accent where the accent reads as large type on the ground", () => {
    expect(assemble("#1a1a1a", "#f2f1ec", "#ff6b2c").fields["figureInk"]).toBe("accent");
  });

  it("keeps the ink colour where it would not (a violet on its own purple ground)", () => {
    expect(assemble("#1f1446", "#ffffff", "#4b2bbf").fields["figureInk"]).toBeUndefined();
    expect(FIGURE_INK_MIN_CONTRAST).toBe(3);
  });

  it("figureInk is layout metadata, and the plate distributes its panel and reads the field", () => {
    expect(LAYOUT_FIELD_KEYS.has("figureInk")).toBe(true);
    const html = readFileSync(path.join(__dirname, "..", "assets", "templates", "default", "stat-callout.html"), "utf8");
    expect(html).toContain(".num-zone { justify-content: space-between; }");
    expect(html).toContain('body[data-figure-ink="accent"] .num-figure { color: var(--accent, currentColor); }');
    expect(html).toContain('data-figure-ink="{{figureInk}}"');
  });
});
