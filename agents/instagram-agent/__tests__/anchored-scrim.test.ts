import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/** Owner feedback round 2026-09-24 (H, WS-08): the shade under text on a photograph follows the text. */
const DIR = path.resolve(__dirname, "..", "assets", "templates", "default");

describe("the scrim is anchored to the measured copy", () => {
  it("keeps today's stops as the default and reads the measured band when the script sets it", () => {
    const css = readFileSync(path.join(DIR, "_design-system.css"), "utf8");
    expect(css).toContain("86%, transparent) var(--scrim-dense, 22%)");
    expect(css).toContain("calc(var(--scrim-dense, 22%) + 40%)");
  });

  it("measures after the last fit pass and before the ready flag, never below 22%", () => {
    const js = readFileSync(path.join(DIR, "_ds-fit.js"), "utf8");
    expect(js).toContain("var done = function () { resetPicture(); pass(); fillPicture(); placeSandwich(); anchorScrim(); window.__CAROUSEL_READY__ = true; };");
    expect(js).toContain("Math.max(22, Math.min(80, fromBottom))");
    for (const plate of ["cover.html", "slide.html"]) expect(readFileSync(path.join(DIR, plate), "utf8")).toContain("anchorScrim");
  });
});
