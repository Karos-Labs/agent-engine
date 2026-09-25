import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { carryImageKinds } from "../src/workflow/recovered-image-kinds.js";

describe("carryImageKinds", () => {
  it("a recovered mark stays a mark under its new path", () => {
    const marks = new Set(["n1-abc.png"]);
    carryImageKinds("n1-abc.png", "n1-client0.png", [marks]);
    expect(marks.has("n1-client0.png")).toBe(true);
  });

  it("a photograph recovered to a path a mark once held is not a mark (XO Digital, 2026-09-25)", () => {
    const marks = new Set(["n2-client0.png"]);
    const cutouts = new Set(["n2-client0.png"]);
    carryImageKinds("n2-stock.jpg", "n2-client0.png", [marks, cutouts]);
    expect(marks.has("n2-client0.png")).toBe(false);
    expect(cutouts.has("n2-client0.png")).toBe(false);
  });

  it("the workflow's recovery passes every path-keyed kind set", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/workflow/create-instagram-agent-workflow.ts"), "utf8");
    expect(src).toMatch(/carryImageKinds\(sel\.imagePath, back\.path, \[markImagePaths, clearMarkPaths, productCutoutPaths\]\)/u);
    expect(src).not.toMatch(/if \(markImagePaths\.has\(sel\.imagePath\)\) markImagePaths\.add\(back\.path\)/u);
  });
});
