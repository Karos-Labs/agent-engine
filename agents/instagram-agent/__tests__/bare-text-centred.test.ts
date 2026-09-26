import { describe, expect, it } from "vitest";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";

/** Re-rendered prep batch 8 (2026-09-26): a bare text plate anchored to the foot left the top 45% as flat ground. */
describe("a bare text plate is a centred block", () => {
  const run = (extra: Record<string, unknown>) =>
    assembleSlidesData({
      clientSlug: "k", postId: "p", repoRoot: "/r",
      brandTokens: { templateDir: "t", slideTemplate: "slide.html" },
      copy: {
        format: "carousel",
        caption: "c",
        slides: [
          { n: 1, headline: "A cover headline for the post", body: "A deck.", visualNeed: "v", sourceRef: "s", layout: "cover" },
          { n: 2, headline: "The judge panel is the credential.", body: "When a16z and J.P. Morgan score your pitch, that result travels.", visualNeed: "v", sourceRef: "s", layout: "headline_focus", ...extra },
        ],
      } as unknown as InstagramCopyOutput,
      selections: [1, 2].map((n) => ({ n, imagePath: null, reason: "r", license: "x", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" })),
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      paletteSeed: "k",
    }).slides.find((s) => s.n === 2)!.fields["compositionAnchor"];

  it("centres a headline_focus with no picture and no device", () => {
    expect(run({})).toBe("centre");
  });

  it("keeps the run's grammar when the plate carries a device", () => {
    expect(run({ device: { kind: "figure", value: "0.05%", label: "final selection rate", source: "Business Wire, 2026" } })).not.toBe("centre");
  });
});
