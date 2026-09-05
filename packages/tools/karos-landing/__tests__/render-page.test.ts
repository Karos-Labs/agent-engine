import { describe, expect, it } from "vitest";
import { createRenderPage } from "../src/render/render-page-tool.js";
import { assemblePage } from "../src/page/assemble.js";
import { MemoryArtifactStore, sampleBlueprint, sampleParts, testCtx } from "./fixtures.js";

/**
 * Real Chromium: CI installs it (`npx playwright install --with-deps chromium`
 * in quality.yml) and the runtime image ships it. A machine without it skips
 * these rather than failing on an environment fact; the tool's own
 * `tooling_error` for that case is asserted separately below.
 */
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const haveChromium = await chromiumAvailable();

// Fonts are linked from Google; the `fontFamilies` check is skipped here so the
// test does not depend on network access, and asserted only for shape.
const BASE = { runId: "r1", clientSlug: "acme", fontFamilies: [] as string[], breakpoints: [{ label: "mobile", width: 390, height: 844 }, { label: "desktop", width: 1280, height: 800 }], minOpenerLuminance: 20, minContrast: 4.5, variant: "v1" };

describe.skipIf(!haveChromium)("landing.renderPage (real Chromium)", () => {
  it("passes the sample page and uploads one full-page screenshot per breakpoint", async () => {
    const store = new MemoryArtifactStore();
    const tool = createRenderPage({ artifactStore: store });
    const html = assemblePage(sampleBlueprint(), sampleParts());
    const outcome = await tool.execute({ ...BASE, html }, { ctx: testCtx() });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.violations).toEqual([]);
    expect(outcome.result.pass).toBe(true);
    expect(outcome.result.breakpoints.map((b) => b.label)).toEqual(["mobile", "desktop"]);
    for (const bp of outcome.result.breakpoints) {
      expect(bp.h1Count).toBe(1);
      expect(bp.horizontalOverflow).toBe(false);
      expect(bp.openerLuminance).toBeGreaterThan(200); // cream ground
      expect(bp.minContrast).toBeGreaterThan(4.5);
      expect(bp.screenshot?.url).toMatch(/render-v1-(mobile|desktop)\.png$/);
    }
    expect([...store.objects.keys()]).toEqual(["landing/acme/r1/render-v1-mobile.png", "landing/acme/r1/render-v1-desktop.png"]);
  }, 60_000);

  it("catches horizontal overflow, a near-black opener, a runtime error and low contrast", async () => {
    const tool = createRenderPage({});
    const parts = sampleParts();
    parts.css += `\nhtml,body{background:#050505}.wide{width:1600px;height:10px}.faint{color:#8a8a8a;background:#a0a0a0;font-size:16px}`;
    parts.sections[1]!.html = `<section id="hero"><h1>AI agents</h1><div class="wide"></div><p class="faint">Low contrast body text that a reader would struggle with.</p></section>`;
    parts.script = `throw new Error("boom");`;
    const html = assemblePage(sampleBlueprint(), parts);
    const outcome = await tool.execute({ ...BASE, html }, { ctx: testCtx() });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.pass).toBe(false);
    const v = outcome.result.violations.join("\n");
    expect(v).toMatch(/horizontal overflow/);
    expect(v).toMatch(/near-black opener/);
    expect(v).toMatch(/console error/);
    expect(v).toMatch(/low text contrast/);
    expect(outcome.result.breakpoints[0]!.screenshot).toBeUndefined(); // no artifact store => no upload
  }, 60_000);
});

describe("landing.renderPage without a browser", () => {
  it("is a tooling_error, not a pass", async () => {
    const tool = createRenderPage({ loadChromium: async () => null });
    const outcome = await tool.execute({ ...BASE, html: "<html></html>" }, { ctx: testCtx() });
    expect(outcome.status).toBe("tooling_error");
  });
});
