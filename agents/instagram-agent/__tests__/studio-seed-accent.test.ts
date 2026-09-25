import { describe, expect, it } from "vitest";
import { studioSeedAccent } from "../src/workflow/template-studio.js";
import { contrastRatio } from "../src/workflow/brand-render-tokens.js";

/**
 * Gate 7 refused every Sitti template on every setup (prep, 2026-09-18 and
 * 2026-09-24): its accent #ff5b5f measures 2.84:1 on its ground. The studio
 * now designs with the first colour of the client's own ring that reads.
 */
describe("studioSeedAccent", () => {
  const sitti = { cssVars: { "--bg": "#fff2bf", "--fg": "#5a1a2b", "--accent": "#ff5b5f" }, palette: ["#ff5b5f", "#7a1f35", "#fff2bf"] };

  it("walks past an accent under 3:1 to the first ring colour that clears it, never the ground or the ink", () => {
    expect(contrastRatio("#ff5b5f", "#fff2bf")).toBeLessThan(3);
    const got = studioSeedAccent(sitti);
    expect(got).toBe("#7a1f35");
    expect(contrastRatio(got, "#fff2bf")).toBeGreaterThanOrEqual(3);
  });

  it("keeps a readable accent, and the kit's accent when nothing in the ring reads", () => {
    expect(studioSeedAccent({ cssVars: { "--bg": "#1a1a1a", "--fg": "#f2f1ec", "--accent": "#ff6b2c" } })).toBe("#ff6b2c");
    expect(studioSeedAccent({ cssVars: { "--bg": "#ffffff", "--fg": "#111111", "--accent": "#ffe066" }, palette: ["#fff4c2"] })).toBe("#ffe066");
    expect(studioSeedAccent(undefined)).toBe("#C8FF4D");
  });
});
