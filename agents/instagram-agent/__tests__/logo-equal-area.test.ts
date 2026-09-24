import { describe, expect, it } from "vitest";
import { BRAND_MARK_MIN_HEIGHT_PX, brandMarkBox, brandMarkZone, logoAspectRatio } from "../src/workflow/brand-render-tokens.js";
import { BRAND_MARK_ZONE } from "../src/workflow/visual-system.js";

/** Owner feedback round 2026-09-24 (E, WS-05): one visual area per logo, by rule. */

const placement = (aspect?: number) => ({ decision: "place", corner: "top-start", insetBlockPx: 44, insetInlinePx: 44, widthPx: 150, ...(aspect !== undefined ? { aspect } : {}) }) as never;
const svg = (attrs: string) => ({ bytes: new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><path d="M0 0"/></svg>`), mime: "image/svg+xml" });
function png(w: number, h: number) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return { bytes: b, mime: "image/png" };
}

describe("a logo is sized by its own shape", () => {
  it("reads the aspect ratio from an SVG viewBox, SVG width/height and a PNG header", () => {
    expect(logoAspectRatio(svg('viewBox="0 0 864 157"'))).toBeCloseTo(5.5, 1);
    expect(logoAspectRatio(svg('width="200" height="100"'))).toBe(2);
    expect(logoAspectRatio(png(512, 512))).toBe(1);
    expect(logoAspectRatio({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mime: "image/jpeg" })).toBeUndefined();
  });

  it("gives Hanky Panky's wide wordmark a readable height instead of 64x12", () => {
    const box = brandMarkBox(placement(864 / 157));
    expect(box.h).toBeGreaterThanOrEqual(BRAND_MARK_MIN_HEIGHT_PX);
    expect(box.w).toBeLessThanOrEqual(200);
    // and its reserved corner widens to hold it
    expect(brandMarkZone(placement(864 / 157)).w).toBeGreaterThan(BRAND_MARK_ZONE.size);
  });

  it("keeps a square mark near 70x70, a tall mark within 76px, and an unreadable one on the old square", () => {
    expect(brandMarkBox(placement(1))).toEqual({ w: 70, h: 70 });
    expect(brandMarkBox(placement(0.5)).h).toBeLessThanOrEqual(76);
    expect(brandMarkBox(placement())).toEqual({ w: 65, h: 65 });
    expect(brandMarkZone(placement(1))).toEqual({ w: BRAND_MARK_ZONE.size, h: BRAND_MARK_ZONE.size });
  });
});
