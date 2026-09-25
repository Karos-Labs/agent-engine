import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createCaptureDesignLanguage, deriveDesignLanguage, type MeasuredBox } from "../src/capture-design-language.js";

const ctx = { runId: "r1", clientSlug: "acme", productId: "instagram-agent", runKind: "setup", metadata: {} } as never;
const card = (over: Partial<MeasuredBox> = {}): MeasuredBox => ({ kind: "card", width: 400, height: 300, radius: 6, borderWidth: 1, borderColor: "rgb(52, 52, 59)", background: "rgba(0, 0, 0, 0)", ground: "rgb(20, 20, 22)", hasShadow: false, hasGradient: false, ...over });
const button = (over: Partial<MeasuredBox> = {}): MeasuredBox => ({ kind: "button", width: 160, height: 48, radius: 24, borderWidth: 0, background: "rgb(255, 107, 44)", ground: "rgb(20, 20, 22)", hasShadow: false, hasGradient: false, ...over });

describe("deriveDesignLanguage", () => {
  it("reads a hairline language (KAROS: transparent boxes, #34343b hairlines, radius 6)", () => {
    const { tokens } = deriveDesignLanguage([card(), card(), card({ radius: 8 }), button({ radius: 6 })]);
    expect(tokens).toMatchObject({ boxStyle: "hairline", boxRadius: 6, lineColor: "rgb(52, 52, 59)", pillButtons: false, shadowShare: 0, gradientShare: 0 });
  });

  it("reads a filled language with pill buttons (Sitti-like: cream cards, radius 16, pills)", () => {
    const filled = (r: number) => card({ borderWidth: 0, borderColor: undefined, background: "rgb(255, 242, 191)", ground: "rgb(255, 255, 255)", radius: r });
    const { tokens } = deriveDesignLanguage([filled(16), filled(16), filled(18), button(), button()]);
    expect(tokens).toMatchObject({ boxStyle: "fill", boxRadius: 16, fillColor: "rgb(255, 242, 191)", pillButtons: true });
  });

  it("says none when the site draws no boxes at all", () => {
    const { tokens } = deriveDesignLanguage([button({ radius: 0 })]);
    expect(tokens.boxStyle).toBe("none");
    expect(tokens.boxRadius).toBeUndefined();
  });
});

describe("media.captureDesignLanguage", () => {
  it("is not available without a launcher, and refuses to read a language off too few boxes", async () => {
    expect((await createCaptureDesignLanguage({ launcher: null }).execute({ url: "https://example.com" }, { ctx })).status).toBe("not_available");
    const thin = createCaptureDesignLanguage({ launcher: async () => ({ measure: async () => [card()], close: async () => undefined }) });
    expect((await thin.execute({ url: "https://example.com" }, { ctx })).status).toBe("not_available");
  });

  it("measures a real page in Chromium (skipped where no browser is installed)", async () => {
    let playwright: typeof import("playwright") | undefined;
    try {
      playwright = await import("playwright");
      const probe = await playwright.chromium.launch();
      await probe.close();
    } catch {
      return;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "dl-"));
    try {
      const file = path.join(dir, "site.html");
      await writeFile(
        file,
        `<!doctype html><html><body style="margin:0;background:#141416;font-family:sans-serif">
        <section style="display:flex;gap:24px;padding:40px">
          ${[1, 2, 3].map((i) => `<div style="width:380px;height:320px;border:1px solid #34343b;border-radius:6px">card ${i}</div>`).join("")}
        </section>
        <a href="#" style="display:inline-block;padding:14px 28px;border-radius:999px;background:#ff6b2c;color:#fff">Book a call</a>
        </body></html>`,
      );
      const outcome = await createCaptureDesignLanguage().execute({ url: pathToFileURL(file).href }, { ctx });
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") return;
      expect(outcome.result.tokens).toMatchObject({ boxStyle: "hairline", boxRadius: 6, pillButtons: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
