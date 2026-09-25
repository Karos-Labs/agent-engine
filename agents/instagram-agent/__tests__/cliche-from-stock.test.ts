import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { prescribesClicheScene } from "../src/workflow/visual-direction.js";

/** 2026-09-25: the owner's banned scene is released whatever tier brought it in. */
describe("the banned screen scene, from stock", () => {
  it("recognises the vet reason KAROS shipped, and not a negated one", () => {
    expect(prescribesClicheScene("Candidate shows a large wall-mounted monitor displaying financial graphs in an office setting. It serves the need for an enterprise data dashboard on a large screen.")).toBe(true);
    expect(prescribesClicheScene("A founder walks through a corridor at first light, no laptop or screen in frame.")).toBe(false);
  });

  it("is wired at 06f4, after the one-picture rule and before the floor, and spares a client's own upload", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "workflow", "create-instagram-agent-workflow.ts"), "utf8");
    const at = src.indexOf("06f4-release-cliche-scenes-attempt-");
    expect(at).toBeGreaterThan(src.indexOf("06f2-one-picture-one-slide-attempt-"));
    expect(at).toBeLessThan(src.indexOf("06h-imagery-floor-check-attempt-"));
    expect(src.slice(at, at + 400)).toContain("!/client|upload/iu.test(sel.license");
  });
});
