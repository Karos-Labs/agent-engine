import { describe, expect, it } from "vitest";
import { assemblePage, googleFontsHref } from "../src/page/assemble.js";
import { sampleBlueprint, sampleParts } from "./fixtures.js";

describe("assemblePage", () => {
  it("owns the document shell: lang/dir, viewport, title, description, OG, theme-color, the Google Fonts link", () => {
    const html = assemblePage(sampleBlueprint(), sampleParts(), { canonicalUrl: "https://karos-northwind.web.app", ogImageUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/logo.png?alt=media" });
    expect(html.startsWith("<!doctype html>\n<html lang=\"en-US\" dir=\"ltr\">")).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain("<title>Northwind: AI marketing agents that draft on your brand rules</title>");
    expect(html).toMatch(/<meta name="description" content="Northwind builds and runs AI marketing agents/);
    expect(html).toContain('<link rel="canonical" href="https://karos-northwind.web.app">');
    expect(html).toContain('<meta property="og:image" content="https://firebasestorage.googleapis.com/v0/b/x/o/logo.png?alt=media">');
    expect(html).toContain('<meta name="theme-color" content="#f2f1ec">');
    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"');
  });

  it("places header before <main>, footer after it, everything else inside, in blueprint order regardless of the parts' order", () => {
    const parts = sampleParts();
    parts.sections = [...parts.sections].reverse();
    const html = assemblePage(sampleBlueprint(), parts);
    const order = ["<header id=\"nav\">", "<main id=\"main\">", "<section id=\"hero\">", "<section id=\"how-it-works\">", "<section id=\"contact\">", "</main>", "<footer id=\"footer\">"].map((needle) => html.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("escapes the meta copy, so a quote in a title cannot break the head", () => {
    const html = assemblePage(sampleBlueprint({ meta: { title: 'Northwind "quoted" <title>', description: "a & b" } }), sampleParts());
    expect(html).toContain("<title>Northwind &quot;quoted&quot; &lt;title&gt;</title>");
    expect(html).toContain('content="a &amp; b"');
  });

  it("adds a skip link and its style, and omits the script block when the build wrote none", () => {
    const html = assemblePage(sampleBlueprint(), sampleParts({ script: "  " }));
    expect(html).toContain('<a class="skip-link" href="#main">');
    expect(html).toContain(".skip-link{");
    expect(html).not.toContain("<script>");
  });

  it("mirrors an RTL blueprint on the html element", () => {
    const html = assemblePage(sampleBlueprint({ language: "he-IL", direction: "rtl" }), sampleParts());
    expect(html).toContain('<html lang="he-IL" dir="rtl">');
  });

  it("googleFontsHref de-duplicates a single family used for every role", () => {
    expect(googleFontsHref({ display: "Inter", body: "Inter" })).toBe("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap");
  });
});
