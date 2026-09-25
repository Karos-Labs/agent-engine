import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Owner feedback D (2026-09-24): no brown or pink boxes. #280 took the
 * client's accent out of the cover field, stat, quote and comparison panels;
 * the closer was left out and KAROS' closers in prep batch 3 (2026-09-25)
 * still shipped the brown gradient box. No closer panel mixes the accent.
 */
describe("the closer's panels carry no accent", () => {
  const css = readFileSync(path.resolve(__dirname, "../assets/templates/default/closer.html"), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
  const panelRules = rules.filter((r) => /\.cl-(panel|ask|recap)\b/u.test(r.selector) && /background-image\s*:\s*linear-gradient/u.test(r.body));

  it("finds the three closer forms' panels (the premise)", () => {
    expect(panelRules.length).toBeGreaterThanOrEqual(3);
  });

  it("paints every one of them from the text colour, never the accent", () => {
    for (const rule of panelRules) expect(rule.body, rule.selector).not.toContain("--accent");
  });
});
