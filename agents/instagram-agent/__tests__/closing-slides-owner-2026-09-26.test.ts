import { describe, expect, it } from "vitest";
import { buildMarkRing, ringIndexesFor } from "../src/workflow/emphasis-marks.js";
import { assembleSlidesData, OPENS_WITH_FIGURE, withoutRepeatedDevices } from "../src/workflow/slides-data.js";
import { LEADS_WITH_FIGURE } from "../src/workflow/visual-qa-pre-checks.js";
import type { InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";

/**
 * The owner on karoslabs prep batch 8 (2026-09-26): the last slides are boring
 * and repetitive, one of them "looks like two slides in one", and the orange
 * is missing. Two causes, both generic.
 */

const ORANGE = "#ff6b2c";
const GROUND = "#1a1a1a";
const INK = "#f2f0eb";

const slide = (n: number, extra: Partial<InstagramSlideCopy>): InstagramSlideCopy =>
  ({ n, headline: `Headline ${n}`, body: "A body sentence that says one thing.", visualNeed: "v", sourceRef: "s", layout: "headline_focus", ...extra }) as InstagramSlideCopy;

describe("a one-colour brand marks in its own colour", () => {
  it("keeps the only accent in the ring instead of emptying it", () => {
    const ring = buildMarkRing({ brandAccent: ORANGE, palette: [ORANGE] }, GROUND, INK, ORANGE);
    expect(ring.hexes.length).toBeGreaterThan(0);
    expect(ring.hexes[0]!.toLowerCase()).toBe(ORANGE);
    // The per-slide pass falls back too: the slide's accent is that same orange.
    expect(ringIndexesFor(ring, ORANGE, { groundHex: GROUND, fgHex: INK }).length).toBeGreaterThan(0);
  });

  it("leaves a kit with another legible colour exactly as it was: the accent stays out", () => {
    const ring = buildMarkRing({ brandAccent: ORANGE, palette: [ORANGE, "#ffd23f"] }, GROUND, INK, ORANGE);
    expect(ring.hexes.map((h) => h.toLowerCase())).not.toContain(ORANGE);
  });

  it("paints the copy's declared emphasis on a single-accent kit (prep batch 8 painted none)", () => {
    const copy = {
      format: "carousel",
      caption: "c",
      slides: [
        slide(1, { layout: "cover", headline: "The 3,000-agent CMO fallacy", emphasis: ["CMO fallacy"] }),
        slide(2, { headline: "Output was never the bottleneck.", emphasis: ["never the bottleneck"] }),
        slide(3, { layout: "closer", headline: "The 32% outperforms because of what it kept.", body: "How many of your agents have a human review point?", emphasis: ["what it kept"] }),
      ],
    } as unknown as InstagramCopyOutput;
    const data = assembleSlidesData({
      clientSlug: "karoslabs",
      postId: "p",
      repoRoot: "/r",
      brandTokens: { templateDir: "t", slideTemplate: "slide.html" },
      copy,
      selections: copy.slides.map((s) => ({ n: s.n, imagePath: null, reason: "r", license: "x", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" })),
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      paletteSeed: "karoslabs",
      groundHex: GROUND,
      foregroundHex: INK,
      brandAccentFallback: ORANGE,
      accentRing: [ORANGE],
    });
    const marked = data.slides.filter((s) => Object.entries(s.htmlFragments ?? {}).some(([k, v]) => k.endsWith("Runs") && typeof v === "string" && v.length > 0));
    expect(marked.length).toBeGreaterThan(0);
  });
});

describe("a device that only repeats a number is dropped", () => {
  const figure = (value: string) => ({ kind: "figure" as const, value, label: "of leading marketing organisations", source: "BCG CMO Survey 2026" });

  it("drops the karoslabs slide 7 device: 32% was slide 6's hero and is in its own headline", () => {
    const out = withoutRepeatedDevices([
      slide(6, { layout: "stat_callout", stat: { figure: "32%", subLabel: "pair agents with human oversight" } } as Partial<InstagramSlideCopy>),
      slide(7, { headline: "How the 32% actually builds it.", device: figure("32%") } as Partial<InstagramSlideCopy>),
    ]);
    expect(out[1]!.device).toBeUndefined();
    expect(out[1]!.headline).toBe("How the 32% actually builds it.");
  });

  it("drops a device whose number the headline already states, and keeps one with a new number", () => {
    const out = withoutRepeatedDevices([
      slide(2, { headline: "Most CMOs, 42%, still run AI as an assistant", device: figure("42%") } as Partial<InstagramSlideCopy>),
      slide(3, { headline: "What changed", device: figure("3,000") } as Partial<InstagramSlideCopy>),
      slide(4, { headline: "The same number again", device: figure("3000") } as Partial<InstagramSlideCopy>),
    ]);
    expect(out[0]!.device).toBeUndefined();
    expect(out[1]!.device).toBeDefined();
    // "3000" is "3,000": separators do not make a new number.
    expect(out[2]!.device).toBeUndefined();
  });
});

describe("a slide that opens with its figure keeps the device (default:numbers-are-devices)", () => {
  it("keeps it even when the headline states the number, and the two patterns are one source", () => {
    expect(OPENS_WITH_FIGURE.source).toBe(LEADS_WITH_FIGURE.source);
    const out = withoutRepeatedDevices([
      slide(2, { headline: "₪1,200 a month is the median", device: { kind: "figure", value: "₪1,200", label: "median monthly spend", source: "internal data, 2026" } } as Partial<InstagramSlideCopy>),
    ]);
    expect(out[0]!.device).toBeDefined();
  });
});
