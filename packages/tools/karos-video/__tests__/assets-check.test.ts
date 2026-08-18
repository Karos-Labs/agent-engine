import { describe, expect, it } from "vitest";
import { createAssetsCheck } from "../src/tools/assets-check.js";
import { ctx, fakeRunner } from "./test-helpers.js";

describe("video.assetsCheck", () => {
  it("builds the exact brand_assets_check.py CLI contract", async () => {
    const { runner, calls } = fakeRunner({ stdout: "12/12 asset paths resolve and open\nBRAND ASSETS: PASS", stderr: "", exitCode: 0 });
    const tool = createAssetsCheck({ runner, engineDir: "/engine" });
    await tool.execute({ profilePath: "/clients/acme/brand-profile.json" }, { ctx });

    expect(calls).toEqual([{ command: "python3", args: ["/engine/brand_assets_check.py", "--profile", "/clients/acme/brand-profile.json"] }]);
  });

  it("reports the ZERO-BYTE font incident as a content_fail, never a silent pass", async () => {
    const stdout = [
      "8/12 asset paths resolve and open",
      "",
      "BRAND ASSETS: FAIL (4)",
      "  - ZERO-BYTE Spectral-SemiBold.ttf  (referenced by video_captions_v2.body.font_file) — exists but is empty; a path check would have passed this",
      "  - MISSING   brand/logos/wordmark.svg  (referenced by endcard.wordmark)",
    ].join("\n");
    const { runner } = fakeRunner({ stdout, stderr: "", exitCode: 1 });
    const tool = createAssetsCheck({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json" }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("content_fail");
    expect(outcome.result).toMatchObject({
      evidence: [
        "ZERO-BYTE Spectral-SemiBold.ttf  (referenced by video_captions_v2.body.font_file) — exists but is empty; a path check would have passed this",
        "MISSING   brand/logos/wordmark.svg  (referenced by endcard.wordmark)",
      ],
    });
  });

  it("preserves WARN lines (e.g. a fully-transparent alpha channel) in evidence on a PASS, never silently dropped", async () => {
    const stdout = [
      "12/12 asset paths resolve and open",
      "  WARN  brand/logos/mark.png  alpha channel is fully transparent — nothing will render",
      "BRAND ASSETS: PASS",
    ].join("\n");
    const { runner } = fakeRunner({ stdout, stderr: "", exitCode: 0 });
    const tool = createAssetsCheck({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json" }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "pass") throw new Error("expected a pass verdict");
    expect(outcome.result.evidence).toEqual([
      "BRAND ASSETS: PASS",
      "WARNING: brand/logos/mark.png  alpha channel is fully transparent — nothing will render",
    ]);
  });

  it("preserves WARN lines alongside a content_fail too", async () => {
    const stdout = [
      "  WARN  brand/logos/mark.png  alpha is fully opaque everywhere — probably a flattened export",
      "BRAND ASSETS: FAIL (1)",
      "  - MISSING   brand/logos/wordmark.svg  (referenced by endcard.wordmark)",
    ].join("\n");
    const { runner } = fakeRunner({ stdout, stderr: "", exitCode: 1 });
    const tool = createAssetsCheck({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json" }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "content_fail") throw new Error("expected a content_fail verdict");
    expect(outcome.result.evidence).toEqual([
      "MISSING   brand/logos/wordmark.svg  (referenced by endcard.wordmark)",
      "WARNING: brand/logos/mark.png  alpha is fully opaque everywhere — probably a flattened export",
    ]);
  });
});
