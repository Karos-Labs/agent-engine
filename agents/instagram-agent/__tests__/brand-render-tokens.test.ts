import { describe, expect, it } from "vitest";
import { buildBrandHeadHtml, contrastRatio, deriveBrandRenderTokens } from "../src/workflow/brand-render-tokens.js";
import type { BrandTokens } from "../src/workflow/types.js";

const baseTokens: BrandTokens = { templateDir: "t", slideTemplate: "slide.html" };

/** A brand.json in the exact shape agent-middleware's seed script writes. */
function geektimeishBrand(): Record<string, unknown> {
  return {
    name: "Geektime",
    accent: "#A5E82B",
    colors: { primaryAccent: "#A5E82B", neutralDark: "#272A35", neutralLight: "#F4F2EC" },
    dominantColors: [
      { hex: "#272A35", dominanceRank: 1, role: "ground" },
      { hex: "#A5E82B", dominanceRank: 2, role: "accent" },
    ],
    fonts: { heading: "Space Grotesk", body: "Open Sans" },
    visualStyle: "Dark Mode",
    logoUrl: "https://firebasestorage.example/logos/geektime.svg",
    handle: "geektimecoil",
  };
}

describe("deriveBrandRenderTokens: the derivation ladder", () => {
  it("structural rule: the neutral nearest the rank-1 dominant color is the ground", () => {
    const tokens = deriveBrandRenderTokens(geektimeishBrand(), baseTokens)!;
    expect(tokens.cssVars["--bg"]).toBe("#272A35");
    expect(tokens.cssVars["--fg"]).toBe("#F4F2EC");
  });

  it("structural rule flips for a light-dominant brand (the cream Pitch-style case)", () => {
    const brand = {
      colors: { neutralDark: "#0E1530", neutralLight: "#F5F0E4" },
      dominantColors: [{ hex: "#F5F0E4", dominanceRank: 1 }],
    };
    const tokens = deriveBrandRenderTokens(brand, baseTokens)!;
    expect(tokens.cssVars["--bg"]).toBe("#F5F0E4");
    expect(tokens.cssVars["--fg"]).toBe("#0E1530");
  });

  it("lexical fallback fires only on an unambiguous word-boundary signal", () => {
    const neutrals = { colors: { neutralDark: "#111111", neutralLight: "#FAFAFA" } };
    const dark = deriveBrandRenderTokens({ ...neutrals, visualStyle: "Dark Mode" }, baseTokens)!;
    expect(dark.cssVars["--bg"]).toBe("#111111");
    const light = deriveBrandRenderTokens({ ...neutrals, visualStyle: "Minimalist" }, baseTokens)!;
    expect(light.cssVars["--bg"]).toBe("#FAFAFA");
    // BOTH directions matching is no signal, not a dark signal — the exact
    // "clean light aesthetic with dark accents" trap.
    const conflicted = deriveBrandRenderTokens({ ...neutrals, visualStyle: "clean light aesthetic with dark accents" }, baseTokens);
    expect(conflicted?.cssVars["--bg"]).toBeUndefined();
  });

  it("refuses ground/fg when neither neutral exists — accent/fonts still apply", () => {
    const tokens = deriveBrandRenderTokens({ accent: "#FF5B5F", fonts: { heading: "Fraunces" } }, baseTokens)!;
    expect(tokens.cssVars["--bg"]).toBeUndefined();
    expect(tokens.brandAccent).toBe("#FF5B5F");
    expect(tokens.fontFamilies).toEqual(["Fraunces"]);
  });

  it("drops a ground/fg pair below the WCAG 4.5:1 contrast floor rather than shipping unreadable slides", () => {
    const brand = {
      colors: { neutralDark: "#777777", neutralLight: "#888888" },
      visualStyle: "Dark Mode",
    };
    expect(contrastRatio("#777777", "#888888")).toBeLessThan(4.5);
    const tokens = deriveBrandRenderTokens(brand, baseTokens);
    expect(tokens?.cssVars["--bg"]).toBeUndefined();
    expect(tokens?.cssVars["--fg"]).toBeUndefined();
  });

  it("the contrast floor also protects the explicit renderTokens path against a portal typo", () => {
    const withOverride: BrandTokens = { ...baseTokens, renderTokens: { ground: "#101010", fg: "#181818" } };
    const tokens = deriveBrandRenderTokens({}, withOverride);
    expect(tokens?.cssVars["--bg"]).toBeUndefined();
  });

  it("explicit renderTokens beat every derivation", () => {
    const withOverride: BrandTokens = {
      ...baseTokens,
      renderTokens: { ground: "#FFF8D6", fg: "#8A3B42", fontDisplay: "Gaegu", badgeStyle: "underline" },
    };
    const tokens = deriveBrandRenderTokens(geektimeishBrand(), withOverride)!;
    expect(tokens.cssVars["--bg"]).toBe("#FFF8D6");
    expect(tokens.cssVars["--fg"]).toBe("#8A3B42");
    expect(tokens.cssVars["--f-display"]).toContain("'Gaegu'");
    expect(tokens.badgeStyle).toBe("underline");
  });

  it("drops malformed hexes and font names instead of fixing them", () => {
    const brand = {
      colors: { neutralDark: "#12345", neutralLight: "#F4F2EC" }, // 5 digits: invalid
      fonts: { heading: "Fraunces'); @import url(evil" },
      accent: "not-a-color",
    };
    const tokens = deriveBrandRenderTokens(brand, baseTokens);
    // Nothing derivable survived, so the whole kit is absent — the caller
    // renders exactly as before brand kits existed.
    expect(tokens).toBeUndefined();
  });

  it("normalizes the handle to exactly one leading @", () => {
    expect(deriveBrandRenderTokens({ handle: "geektimecoil" }, baseTokens)?.handle).toBe("@geektimecoil");
    expect(deriveBrandRenderTokens({ handle: "@geektimecoil" }, baseTokens)?.handle).toBe("@geektimecoil");
    expect(deriveBrandRenderTokens({ handle: "bad handle!" }, baseTokens)?.handle).toBeUndefined();
  });

  it("accepts only https/gs logo urls", () => {
    expect(deriveBrandRenderTokens({ logoUrl: "https://x.example/logo.png" }, baseTokens)?.logoUrl).toBeDefined();
    expect(deriveBrandRenderTokens({ logoUrl: "javascript:alert(1)" }, baseTokens)).toBeUndefined();
    expect(deriveBrandRenderTokens({ logoUrl: "file:///etc/passwd" }, baseTokens)).toBeUndefined();
  });
});

describe("deriveBrandRenderTokens: badge style, universal to every client", () => {
  it("mono/tech identity derives the brackets (terminal-tag) look", () => {
    const brand = { ...geektimeishBrand(), visualStyle: "High-Tech developer terminal" };
    expect(deriveBrandRenderTokens(brand, baseTokens)?.badgeStyle).toBe("brackets");
  });

  it("a light ground derives the solid pill", () => {
    const brand = {
      colors: { neutralDark: "#0E1530", neutralLight: "#F5F0E4" },
      dominantColors: [{ hex: "#F5F0E4", dominanceRank: 1 }],
    };
    expect(deriveBrandRenderTokens(brand, baseTokens)?.badgeStyle).toBe("pill");
  });

  it("a dark ground with no other signal derives plain — still branded via the client's own accent and mono face", () => {
    expect(deriveBrandRenderTokens(geektimeishBrand(), { ...baseTokens, renderTokens: {} })?.badgeStyle).toBe("plain");
  });
});

describe("buildBrandHeadHtml", () => {
  it("emits one Google Fonts link PER family, bare-named, plus the token sheet", () => {
    const tokens = deriveBrandRenderTokens(geektimeishBrand(), baseTokens)!;
    const head = buildBrandHeadHtml(tokens);
    expect(head).toContain("family=Space+Grotesk&display=swap");
    expect(head).toContain("family=Open+Sans&display=swap");
    // One link per family — a bad family in a batched request 400s the batch.
    expect(head.match(/<link /g)?.length).toBe(2);
    expect(head).not.toContain("wght@");
    expect(head).toContain("--bg: #272A35;");
  });

  it("never emits --accent — the accent has exactly one channel, the per-slide field", () => {
    const tokens = deriveBrandRenderTokens(geektimeishBrand(), baseTokens)!;
    tokens.cssVars["--accent"] = "#FF0000"; // even if a future edit sneaks one in
    expect(buildBrandHeadHtml(tokens)).not.toContain("--accent:");
  });

  it("stamps the badge variant css from brand vars only", () => {
    const tokens = deriveBrandRenderTokens(geektimeishBrand(), { ...baseTokens, renderTokens: { badgeStyle: "brackets" } })!;
    const head = buildBrandHeadHtml(tokens);
    expect(head).toContain('content: "{ "');
    expect(head).toContain("var(--accent)");
    expect(head).not.toMatch(/#(?!272A35|F4F2EC)[0-9a-fA-F]{6}/); // no foreign hardcoded hexes
  });
});
