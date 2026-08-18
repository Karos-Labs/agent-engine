import { describe, expect, it } from "vitest";
import { createBrandGate } from "../src/tools/brand-gate.js";
import { ctx, fakeRunner } from "./test-helpers.js";

describe("video.brandGate", () => {
  it("builds the exact brand_check.py CLI contract with multiple images", async () => {
    const { runner, calls } = fakeRunner({ stdout: "PASS  chart.png  off-palette 0.00%\nPASS  clock.png  off-palette 0.40%", stderr: "", exitCode: 0 });
    const tool = createBrandGate({ runner, engineDir: "/engine" });
    await tool.execute({ profilePath: "/p.json", imagePaths: ["/a/chart.png", "/a/clock.png"] }, { ctx });

    expect(calls).toEqual([{ command: "python3", args: ["/engine/brand_check.py", "--profile", "/p.json", "/a/chart.png", "/a/clock.png"] }]);
  });

  it("maps the zero-tolerance RED detector's FAIL line to content_fail", async () => {
    const stdout = "FAIL  cutaway_plate.png  off-palette 1.00%  offenders: RED/BRICK PIXELS: 340 (zero tolerance)";
    const { runner } = fakeRunner({ stdout, stderr: "", exitCode: 1 });
    const tool = createBrandGate({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json", imagePaths: ["/a/cutaway_plate.png"] }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("content_fail");
    expect(outcome.result).toMatchObject({ evidence: [stdout] });
  });

  it("passes when every image passes, with each PASS line kept as evidence", async () => {
    const { runner } = fakeRunner({ stdout: "PASS  mark.png  off-palette 0.00%", stderr: "", exitCode: 0 });
    const tool = createBrandGate({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json", imagePaths: ["/a/mark.png"] }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result).toEqual({ verdict: "pass", evidence: ["PASS  mark.png  off-palette 0.00%"], toolVersion: "1.0.0" });
  });
});
