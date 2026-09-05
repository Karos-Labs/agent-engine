import { describe, expect, it } from "vitest";
import { assemblePage } from "../src/page/assemble.js";
import { checkPage, createCheckPage, extractFigures, figureIsSourced } from "../src/page/check-page.js";
import { sampleBlueprint, sampleParts, testCtx } from "./fixtures.js";

const CORPUS = ["Twelve agents run in production today. 100M+ impressions per month. Driving +$50M in sales. 2M+ followers."];

function pageWith(mutate: (parts: ReturnType<typeof sampleParts>) => void, blueprint = sampleBlueprint()) {
  const parts = sampleParts();
  mutate(parts);
  return checkPage({ html: assemblePage(blueprint, parts), blueprint, corpus: CORPUS, allowedImageHosts: ["karoslabs.com"] });
}

describe("checkPage", () => {
  it("passes the sample page, with the sourced figure recorded", () => {
    const report = pageWith(() => undefined);
    expect(report.hard).toEqual([]);
    expect(report.pass).toBe(true);
  });

  // Each guard below is exercised by breaking the page and watching it refuse.
  it("refuses a page missing a blueprint section", () => {
    const report = pageWith((p) => (p.sections = p.sections.filter((s) => s.id !== "how-it-works")));
    expect(report.hard.map((v) => v.check)).toContain("structure");
    expect(report.hard.some((v) => /how-it-works/.test(v.message))).toBe(true);
  });

  it("refuses two <h1> elements and a dangling anchor", () => {
    const report = pageWith((p) => (p.sections[3]!.html = `<section id="contact"><h1>Twice</h1><a href="#nowhere">x</a></section>`));
    expect(report.hard.some((v) => /exactly one <h1>, found 2/.test(v.message))).toBe(true);
    expect(report.hard.some((v) => /#nowhere/.test(v.message))).toBe(true);
  });

  it("refuses token drift: a palette colour absent from the CSS", () => {
    const report = pageWith((p) => (p.css = p.css.replace("#ff6b2c", "#ff0000")));
    expect(report.hard.some((v) => v.check === "token-drift" && /accent/.test(v.message))).toBe(true);
  });

  it("refuses a blueprint font the CSS never names", () => {
    const report = pageWith((p) => (p.css = p.css.replace(/"Space Grotesk",/g, "")));
    expect(report.hard.some((v) => v.check === "font-fidelity" && /Space Grotesk/.test(v.message))).toBe(true);
  });

  it("refuses an unsourced figure and accepts sourced ones in any spacing", () => {
    const report = pageWith((p) => (p.sections[1]!.html = p.sections[1]!.html.replace("Twelve agents", "Trusted by 400+ teams, 100 M+ impressions, +$50M in sales, twelve agents")));
    expect(report.hard.filter((v) => v.check === "numbers-sourced").map((v) => v.message)).toEqual([expect.stringContaining('"400+"')]);
    expect(report.numbersSeen).toEqual(expect.arrayContaining(["100m+", "$50m"]));
  });

  it("ignores years, step indices and single digits when checking figures", () => {
    expect(extractFigures("© 2026 Northwind. Step 01, 02. One of 3 moves. 24/7 coverage.")).toEqual(["24/7"]);
    expect(figureIsSourced("24/7", "aroundtheclock24/7")).toBe(true);
    expect(figureIsSourced("35%", "grewby35percent")).toBe(true);
    expect(figureIsSourced("35%", "grewby350percent")).toBe(false);
  });

  it("refuses banned phrases, placeholders and the brand's glyph bans", () => {
    const blueprint = sampleBlueprint();
    const parts = sampleParts();
    parts.sections[1]!.html = `<section id="hero"><h1>We replace your marketing team! Lorem ipsum. Contact John Doe — today</h1></section>`;
    const report = checkPage({ html: assemblePage(blueprint, parts), blueprint, corpus: CORPUS, lint: { forbidEmDash: true, forbidExclamation: true } });
    const checks = report.hard.map((v) => v.check);
    expect(checks).toContain("banned-phrase");
    expect(checks.filter((c) => c === "placeholder").length).toBeGreaterThanOrEqual(2);
    expect(report.hard.filter((v) => v.check === "brand-lint")).toHaveLength(2);
  });

  it("refuses external scripts/stylesheets, @import, and an image from an unknown host", () => {
    const report = pageWith((p) => {
      p.css = `@import url(x.css);\n${p.css}`;
      p.sections[4]!.html = `<footer id="footer"><script src="https://cdn.example/x.js"></script><link rel="stylesheet" href="https://cdn.example/x.css"><img src="https://stranger.example/photo.jpg" alt="x"><p>Northwind</p></footer>`;
    });
    const resources = report.hard.filter((v) => v.check === "resources").map((v) => v.message);
    expect(resources).toHaveLength(4);
  });

  it("accepts an image from the client's own domain or a declared asset, and refuses a missing alt or an empty link", () => {
    const report = pageWith((p) => (p.sections[4]!.html = `<footer id="footer"><img src="https://www.karoslabs.com/art/kairos.jpg"><a href="#hero"></a><p>Northwind</p></footer>`));
    expect(report.hard.filter((v) => v.check === "resources")).toEqual([]);
    expect(report.hard.filter((v) => v.check === "a11y")).toHaveLength(2);
  });

  it("warns, never fails, on marketing filler words", () => {
    const report = pageWith((p) => (p.sections[1]!.html = p.sections[1]!.html.replace("A person approves", "Elevate seamlessly. A person approves")));
    expect(report.pass).toBe(true);
    expect(report.warnings.some((w) => /elevate, seamlessly/.test(w.message))).toBe(true);
  });

  it("the tool returns the report as success even when the page fails, so the fix step sees the violations", async () => {
    const blueprint = sampleBlueprint();
    const parts = sampleParts();
    parts.sections = parts.sections.slice(0, 3);
    const outcome = await createCheckPage().execute({ html: assemblePage(blueprint, parts), blueprint, corpus: CORPUS, allowedImageHosts: [] }, { ctx: testCtx() });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.pass).toBe(false);
    expect(outcome.result.hard.length).toBeGreaterThan(0);
  });
});
