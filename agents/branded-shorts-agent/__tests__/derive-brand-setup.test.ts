import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { brandFontFamilies, deriveBrandColors, deriveDefaultStyle, deriveGraphicsLanguage, luminance, resolveBrandFonts } from "../src/workflow/derive-brand-setup.js";
import { fakeFontAndLogoFetch } from "./test-helpers.js";

/** The karoslabs brand kit as prep holds it (client/brand.json, 2026-09-07). */
const KAROS = {
  accent: "#d95f2b",
  colors: { neutralDark: "#242429", neutralLight: "#ff6b2c", primaryAccent: "#d95f2b", secondaryAccent: "#242429" },
  dominantColors: [{ dominanceRank: 1, hex: "#d95f2b" }, { dominanceRank: 2, hex: "#242429" }],
  fonts: { body: "Inter", heading: "Inter" },
  name: "Karos Labs",
  handle: "karoslabs",
  visualStyle: "Minimalist",
};

describe("deriveBrandColors", () => {
  it("maps the kit's palette onto the engine's roles, and refuses to call an orange a light neutral", () => {
    const colors = deriveBrandColors(KAROS)!;
    expect(colors.accent).toBe("#d95f2b");
    expect(colors.ink).toBe("#242429");
    expect(colors.background).toBe("#242429");
    // "neutralLight" in this kit is the CTA orange (#ff6b2c); the engine's paper stands in.
    expect(colors.foreground).toBe("#f5f5f5");
    expect(luminance(colors.foreground)).toBeGreaterThan(0.8);
  });

  it("works from a single accent (the style-exploration test kit), picking the most saturated colour as accent", () => {
    const colors = deriveBrandColors({ palette: { accent: "#FF6B2C" } })!;
    expect(colors.accent).toBe("#ff6b2c");
    expect(colors.ink).toBe("#141414");
    expect(colors.foreground).toBe("#f5f5f5");
  });

  it("is undefined for a kit with no colour anywhere", () => {
    expect(deriveBrandColors({ name: "Nobody" })).toBeUndefined();
  });
});

describe("brandFontFamilies", () => {
  it("reads the portal's {heading, body} shape and a plain list alike", () => {
    expect(brandFontFamilies(KAROS)).toEqual({ display: "Inter", body: "Inter" });
    expect(brandFontFamilies({ fonts: ["Spectral", "Inter"] })).toEqual({ display: "Spectral", body: "Inter" });
    expect(brandFontFamilies({ fonts: ["Spectral"] })).toEqual({ display: "Spectral", body: "Spectral" });
    expect(brandFontFamilies({})).toEqual({ display: "Inter", body: "Inter" });
  });
});

describe("resolveBrandFonts", () => {
  it("downloads the family from Google Fonts into <profile>/fonts as the two weights the caption system wants", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "derive-fonts-"));
    const fonts = await resolveBrandFonts(dir, { display: "Inter", body: "Inter" }, { fetchImpl: fakeFontAndLogoFetch() });
    expect(fonts).toMatchObject({ displayFile: "fonts/Inter-700.ttf", bodyFile: "fonts/Inter-500.ttf", source: "google-fonts" });
    await expect(fs.stat(path.join(dir, "fonts", "Inter-700.ttf"))).resolves.toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("falls back to a system face when the family is not served, and says so", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "derive-fonts-"));
    const systemFont = path.join(dir, "Fallback.ttf");
    await fs.writeFile(systemFont, new Uint8Array(4096).fill(1));
    const notServed = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const fonts = await resolveBrandFonts(dir, { display: "Nonexistent Face", body: "Nonexistent Face" }, { fetchImpl: notServed, systemFontCandidates: { display: [systemFont], body: [systemFont] } });
    expect(fonts).toMatchObject({ displayFile: "fonts/display-system.ttf", bodyFile: "fonts/body-system.ttf", source: "system" });
    expect(fonts!.notes.join(" ")).toContain("not served by Google Fonts");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is undefined when neither Google Fonts nor the system has a face, the one thing a derived profile cannot do without", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "derive-fonts-"));
    const notServed = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const fonts = await resolveBrandFonts(dir, { display: "X", body: "X" }, { fetchImpl: notServed, systemFontCandidates: { display: [path.join(dir, "missing.ttf")], body: [] } });
    expect(fonts).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("derived style and graphics language", () => {
  it("names itself as derived and quotes the brand's own colours and faces, so the reviewer knows what was assumed", () => {
    const colors = deriveBrandColors(KAROS)!;
    const style = deriveDefaultStyle(KAROS, colors);
    expect(style.name).toContain("derived");
    expect(style.paletteTokensUsed).toEqual(["#242429", "#f5f5f5", "#d95f2b"]);
    const language = deriveGraphicsLanguage({ ...KAROS, guidelines: "## Brand Voice\nClarity." }, style, colors, brandFontFamilies(KAROS));
    expect(language).toContain("## Vocabulary");
    expect(language).toContain("#d95f2b");
    expect(language).toContain("Inter for display");
    expect(language).toContain("## Brand guidelines (from the kit)");
  });
});
