import { describe, expect, it } from "vitest";
import { deriveBrandRenderTokens } from "../src/workflow/brand-render-tokens.js";
import type { BrandTokens } from "../src/workflow/types.js";

/**
 * ── EVERY CLIENT RENDERED ON THE BUNDLED DEFAULT, AND NOBODY NOTICED. ──
 *
 * The owner, 2026-09-20, on thepitchbydeel's carousel: *"the colours and the
 * whole brand voice are a scandal — you took KAROS LABS' colours, but every
 * client has its own branding."*
 *
 * The mechanism is worse than that reading. It is not that Deel got Karos's
 * colours: `02c-load-brand-kit` returned `palette: []` on BOTH runs that day,
 * Karos's included. Karos only looked right because the bundled default
 * resembles it.
 *
 * `deriveGroundAndFg` read `brand.colors.neutralDark` / `.neutralLight`. Every
 * real kit ships `colors` as an ARRAY of hexes — the shape
 * `ClientBrand.colors?: string[]` documents — so it returned at its first
 * line, before the `dominantColors` limb written for exactly this data. With
 * no ground, `buildAccentRing` returns empty however many hexes the kit has.
 *
 * ## The kits below are REAL
 *
 * Copied from `gs://karoscmo-prep-agent-workspace/clients/<slug>/client/brand.json`
 * as they stood on 2026-09-20. That matters: the previous read passed its own
 * unit tests against a shape no client stores, which is how it survived this
 * long. A fixture invented here would repeat that mistake exactly.
 */

const NO_OVERRIDES = { renderTokens: {} } as unknown as BrandTokens;

/** `clients/thepitchbydeel/client/brand.json`, 2026-09-20. */
const DEEL = {
  voice: "Founder-side and direct.",
  colors: ["#5938b7", "#201547", "#ffcf25"],
  fonts: { heading: "Space Grotesk", body: "Inter" },
  dominantColors: [
    { hex: "#5938b7", role: "Brand purple - primary accent", dominanceRank: 1 },
    { hex: "#201547", role: "Deep navy", dominanceRank: 2 },
    { hex: "#ffcf25", role: "Signal yellow", dominanceRank: 3 },
  ],
};

/** `clients/karoslabs/client/brand.json`-shaped: the roled `dominantColors` form. */
const KAROS = {
  colors: ["#ff6b2c", "#1a1a1a", "#faf7f2"],
  dominantColors: [
    { hex: "#ff6b2c", role: "Primary accent, CTA buttons, brand highlight", dominanceRank: 1 },
    { hex: "#1a1a1a", role: "Background, primary text", dominanceRank: 2 },
  ],
};

describe("a client's own colours reach the render", () => {
  it("gives thepitchbydeel a ground, a text colour and a palette — it had none of the three", () => {
    const tokens = deriveBrandRenderTokens(DEEL, NO_OVERRIDES);
    expect(tokens).toBeDefined();
    // The defect, stated as the assertion that would have caught it: the
    // shipped run recorded `palette: []`.
    expect(tokens!.palette.length).toBeGreaterThan(0);
    expect(tokens!.cssVars["--bg"]).toBeDefined();
    expect(tokens!.cssVars["--fg"]).toBeDefined();
  });

  it("paints Deel's OWN hexes, not a default and not another client's", () => {
    const tokens = deriveBrandRenderTokens(DEEL, NO_OVERRIDES);
    const painted = [...tokens!.palette, tokens!.cssVars["--bg"], tokens!.cssVars["--fg"]]
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.toLowerCase());
    // Every colour that reaches the plate comes from Deel's kit.
    for (const hex of painted) expect(DEEL.colors.map((c) => c.toLowerCase())).toContain(hex);
    // And Karos's signature orange is nowhere near it.
    expect(painted).not.toContain("#ff6b2c");
  });

  it("still honours a kit that NAMES its neutrals, which must beat a derived guess", () => {
    const named = { ...DEEL, colors: { neutralDark: "#101014", neutralLight: "#fefefe", primaryAccent: "#5938b7" } };
    const tokens = deriveBrandRenderTokens(named, NO_OVERRIDES);
    expect([tokens!.cssVars["--bg"], tokens!.cssVars["--fg"]].map((v) => v?.toLowerCase())).toEqual(
      expect.arrayContaining(["#101014", "#fefefe"]),
    );
  });

  it("reads the portal's own brandingGuidelines spelling", () => {
    const portalShape = { brandNeutralDark: "#201547", brandNeutralLight: "#faf4ee", primaryAccent: "#5938b7" };
    const tokens = deriveBrandRenderTokens(portalShape, NO_OVERRIDES);
    expect([tokens!.cssVars["--bg"], tokens!.cssVars["--fg"]].map((v) => v?.toLowerCase())).toEqual(
      expect.arrayContaining(["#201547", "#faf4ee"]),
    );
  });

  it("gives two DIFFERENT clients two different grounds — the whole complaint, as one assertion", () => {
    const deel = deriveBrandRenderTokens(DEEL, NO_OVERRIDES)!;
    const karos = deriveBrandRenderTokens(KAROS, NO_OVERRIDES)!;
    expect(deel.cssVars["--bg"]).toBeDefined();
    expect(karos.cssVars["--bg"]).toBeDefined();
    expect(deel.palette).not.toEqual(karos.palette);
  });

  it("abstains rather than inventing a palette when the kit ships fewer than two hexes", () => {
    // A kit with nothing in it must still render, on the bundled stack, with
    // no ground override — the pre-existing refuse-to-guess posture.
    for (const thin of [{}, { colors: [] }, { colors: ["#123456"] }, { colors: ["#123456", "#123456"] }]) {
      const tokens = deriveBrandRenderTokens(thin, NO_OVERRIDES);
      expect(tokens?.cssVars["--bg"]).toBeUndefined();
    }
  });
});
