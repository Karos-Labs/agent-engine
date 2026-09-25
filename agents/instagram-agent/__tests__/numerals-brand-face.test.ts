import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deviceCssBlock } from "../src/workflow/slide-devices.js";

/** Owner feedback round 2026-09-24 (C, A): numbers in the brand's face; no unloaded mono painting DejaVu. */
const DIR = path.resolve(__dirname, "..", "assets", "templates", "default");
const rulesOf = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, "");

describe("labels and numerals use faces the brand actually loads", () => {
  it("declares no default mono and never falls back to the system mono in a rule", () => {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".html") || f.endsWith(".css"))) {
      const rules = rulesOf(readFileSync(path.join(DIR, file), "utf8"));
      expect(rules, file).not.toMatch(/--f-mono:\s*'IBM Plex Mono'/u);
      expect(rules, file).not.toMatch(/var\(--f-mono,\s*ui-monospace/u);
    }
  });

  it("sets chart values and timeline dates in the display face", () => {
    const css = typeof deviceCssBlock === "function" ? (deviceCssBlock as () => string)() : "";
    const src = css.length > 0 ? css : readFileSync(path.resolve(__dirname, "..", "src", "workflow", "slide-devices.ts"), "utf8");
    expect(src).toContain(".dv-bar-value { font-family: var(--f-num, var(--f-display));");
    expect(src).toContain(".dv-tl-at { display: block; font-family: var(--f-num, var(--f-display));");
    expect(src).not.toMatch(/font-family: var\(--f-mono\);/u);
  });
});
