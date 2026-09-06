import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promises as fs, existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { GateVerdict } from "@agent-engine/core";
import { toGateVerdictFromBullets, toGateVerdictFromPrefixedLines } from "../src/gate-helpers.js";
import { createSelfEvalGate } from "../src/tools/self-eval-gate.js";
import type { ProcessResult } from "../src/process/runner.js";
import { ctx } from "./test-helpers.js";

/**
 * Note for the CLI-contract tests in this package's OTHER files: they pin
 * `pythonBin: "python3"` explicitly. They assert the exact argv a tool builds,
 * and `resolveRuntime` reads KAROS_VIDEO_PYTHON_BIN from the ambient
 * environment — so once that variable is documented for local dev (and this
 * file's own runtime honours it), an exported `python` silently rewrote the
 * argv those tests were asserting. A contract test must not depend on the
 * shell that launched it.
 */

/** Narrows to a verdict that carries evidence (pass or content_fail); a tooling_error here means the script crashed, and its reason is the assertion message. */
function evidenceOf(verdict: GateVerdict, context: string): string[] {
  if (verdict.verdict === "tooling_error") throw new Error(`${context}\n→ tooling_error: ${verdict.reason}`);
  return verdict.evidence;
}

/** Narrows to a failing verdict's reason. */
function reasonOf(verdict: GateVerdict): string {
  if (verdict.verdict === "pass") throw new Error(`expected a failing verdict, got a pass: ${verdict.evidence.join(" | ")}`);
  return verdict.reason ?? "";
}

/**
 * The REAL engine, driven end to end — the one place both halves of the
 * adapter/engine contract execute together.
 *
 * Every other test in this package cans the scripts' stdout. That proves the
 * TypeScript parses what it EXPECTS the scripts to print, and nothing about
 * what they actually print: RFC-06 §5 records that the adapters were written
 * against docstrings before any script ran here, and the vendoring found
 * exactly the kind of drift that produces — `graphic_qa.py` skipping every
 * overlay the job builder wrote, `build_short.py` reading a profile block v2
 * profiles no longer carry, an import from a directory that existed nowhere.
 *
 * So this runs the scripts in `../engine` against generated fixtures and
 * feeds their real stdout through the real `gate-helpers.ts` parsers.
 *
 * Environment: python3 with numpy + Pillow for the gates and the renderer;
 * ffmpeg/ffprobe additionally for the build, the graphics gate and the
 * self-eval. Locally, a missing dependency SKIPS the affected block (a laptop
 * without ffmpeg is normal). In CI, `KAROS_ENGINE_TESTS=required` turns that
 * skip into a failure, because there the dependencies are installed on
 * purpose (quality.yml) and a skip would be a silent pass — the failure mode
 * this repo keeps finding.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, "..", "engine");
const FIXTURE_SCRIPT = path.join(HERE, "fixtures", "engine", "make_fixtures.py");
const PY = process.env.KAROS_VIDEO_PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
const FFMPEG = process.env.KAROS_VIDEO_FFMPEG_BIN ?? "ffmpeg";
const REQUIRED = process.env.KAROS_ENGINE_TESTS === "required";

function probe(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const havePython = probe(PY, ["-c", "import numpy, PIL"]);
const haveFfmpeg = havePython && probe(FFMPEG, ["-version"]);
if (REQUIRED && !havePython) throw new Error(`KAROS_ENGINE_TESTS=required but "${PY}" with numpy + Pillow is not available`);
if (REQUIRED && !haveFfmpeg) throw new Error(`KAROS_ENGINE_TESTS=required but "${FFMPEG}" is not available`);

const describePython = havePython ? describe : describe.skip;
const describeFfmpeg = haveFfmpeg ? describe : describe.skip;

function run(script: string, args: string[], cwd?: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      PY,
      [path.join(ENGINE, script), ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 300_000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code as number) : error ? 1 : 0;
        resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function py(code: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(PY, ["-c", code], { cwd: ENGINE, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let root: string;

describePython("the vendored engine, driven by its real CLI contracts", () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "karos-engine-"));
    const made = await run("../__tests__/fixtures/engine/make_fixtures.py", [root, ...(haveFfmpeg ? ["--with-source"] : [])]);
    if (made.exitCode !== 0) throw new Error(`fixture generation failed: ${made.stderr || made.stdout}`);
    void FIXTURE_SCRIPT;
  }, 120_000);

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const V = "1.0.0";

  describe("cut_check.py (video.cutGate)", () => {
    it("passes a crop-the-ends, filler-only cut list, with the summary line the adapter reads", async () => {
      const result = await run("cut_check.py", ["--job", path.join(root, "job-cut-pass.json"), "--transcript", path.join(root, "transcript.json")]);
      const verdict = toGateVerdictFromBullets(result, "cut_check.py", V);
      expect(verdict.verdict, result.stdout + result.stderr).toBe("pass");
      expect(evidenceOf(verdict, result.stdout + result.stderr)[0]).toMatch(/^CUT GATE: PASS \(2 segments, 1 cuts, /);
    });

    it("fails a silent content cut with a HONESTY bullet the adapter turns into a content_fail", async () => {
      const result = await run("cut_check.py", ["--job", path.join(root, "job-cut-fail.json"), "--transcript", path.join(root, "transcript.json")]);
      const verdict = toGateVerdictFromBullets(result, "cut_check.py", V);
      expect(verdict.verdict).toBe("content_fail");
      expect(reasonOf(verdict)).toContain("HONESTY");
      expect(reasonOf(verdict)).toMatch(/removes content, not filler: 'tripled um revenue'/);
    });
  });

  describe("cutaway_check.py (video.cutawayGate)", () => {
    it("passes four cutaways that each lead their word by 100ms and exit on a boundary", async () => {
      const result = await run("cutaway_check.py", ["--job", path.join(root, "job-cutaways-pass.json"), "--transcript", path.join(root, "transcript.json")]);
      const verdict = toGateVerdictFromBullets(result, "cutaway_check.py", V);
      expect(verdict.verdict, result.stdout + result.stderr).toBe("pass");
      expect(evidenceOf(verdict, result.stdout + result.stderr)[0]).toBe("CUTAWAY GATE: PASS (4 cutaways, 0 graphics, no conflicts)");
    });

    it("fails a cutaway that enters after its word — the TIMING law", async () => {
      const result = await run("cutaway_check.py", ["--job", path.join(root, "job-cutaways-fail.json"), "--transcript", path.join(root, "transcript.json")]);
      const verdict = toGateVerdictFromBullets(result, "cutaway_check.py", V);
      expect(verdict.verdict).toBe("content_fail");
      expect(reasonOf(verdict)).toMatch(/TIMING: enters \d+ms AFTER the word/);
    });
  });

  describe("brand_check.py (video.brandGate)", () => {
    it("passes a graphic whose every visible pixel is on-palette", async () => {
      const result = await run("brand_check.py", ["--profile", path.join(root, "brand-profile.json"), path.join(root, "graphics", "clean.png")]);
      const verdict = toGateVerdictFromPrefixedLines(result, "brand_check.py", V);
      expect(verdict.verdict, result.stdout + result.stderr).toBe("pass");
      expect(evidenceOf(verdict, result.stdout + result.stderr)[0]).toMatch(/^PASS {2}clean\.png {2}off-palette 0\.00%/);
    });

    it("fails a graphic with brick-red pixels outright — zero tolerance (Lola 2026-07-06)", async () => {
      const result = await run("brand_check.py", ["--profile", path.join(root, "brand-profile.json"), path.join(root, "graphics", "red.png")]);
      const verdict = toGateVerdictFromPrefixedLines(result, "brand_check.py", V);
      expect(verdict.verdict).toBe("content_fail");
      expect(reasonOf(verdict)).toContain("RED/BRICK PIXELS");
    });
  });

  describe("brand_assets_check.py (video.assetsCheck)", () => {
    it("opens every font and image the profile references and reports the summary the adapter reads", async () => {
      const result = await run("brand_assets_check.py", ["--profile", path.join(root, "brand-profile.json")]);
      const verdict = toGateVerdictFromBullets(result, "brand_assets_check.py", V);
      expect(verdict.verdict, result.stdout + result.stderr).toBe("pass");
      expect(evidenceOf(verdict, result.stdout + result.stderr)[0]).toBe("BRAND ASSETS: PASS");
    });

    it("fails a profile whose font exists as a zero-byte file — the check a path check cannot make", async () => {
      const result = await run("brand_assets_check.py", ["--profile", path.join(root, "zero-byte", "brand-profile.json")]);
      const verdict = toGateVerdictFromBullets(result, "brand_assets_check.py", V);
      expect(verdict.verdict).toBe("content_fail");
      expect(reasonOf(verdict)).toContain("ZERO-BYTE");
      expect(reasonOf(verdict)).toContain("Body.ttf");
    });
  });

  describe("render_overlays.py (video.renderOverlays)", () => {
    it("renders every planned overlay to its %04d.png sequence covering the whole window, from an empty first frame", async () => {
      const result = await run("render_overlays.py", ["--profile", path.join(root, "brand-profile.json"), "--job", path.join(root, "job-overlays.json")]);
      const verdict = toGateVerdictFromBullets(result, "render_overlays.py", V);
      expect(verdict.verdict, result.stdout + result.stderr).toBe("pass");
      expect(evidenceOf(verdict, result.stdout + result.stderr)[0]).toBe("OVERLAYS: PASS (2 rendered)");

      const chart = path.join(root, "edit", "overlays", "anim-growth_chart-0");
      const callout = path.join(root, "edit", "overlays", "anim-callout-1");
      expect(readdirSync(chart).filter((f) => f.endsWith(".png"))).toHaveLength(Math.ceil(1.6 * 30));
      expect(readdirSync(callout).filter((f) => f.endsWith(".png"))).toHaveLength(Math.ceil(0.9 * 30));
      expect(existsSync(path.join(chart, "0000.png"))).toBe(true);

      // graphic_qa.py's MOTION law, measured directly: the first frame is (near) empty, the last holds content.
      const density = await py(
        `import sys, numpy as np; from PIL import Image
def d(p): return int((np.asarray(Image.open(p).convert("RGBA"))[..., 3] > 24).sum())
print(d(r"${path.join(chart, "0000.png").replace(/\\/g, "\\\\")}"), d(r"${path.join(chart, "0047.png").replace(/\\/g, "\\\\")}"))`,
      );
      const [first, last] = density.stdout.trim().split(/\s+/).map(Number);
      expect(first!, density.stderr).toBeLessThan(0.05 * last!);
      expect(last!).toBeGreaterThan(2000);
    }, 120_000);

    it("renders frames that pass the brand palette gate — premultiplied downscale leaves no dim brick edge", async () => {
      const lastChart = path.join(root, "edit", "overlays", "anim-growth_chart-0", "0047.png");
      const lastCallout = path.join(root, "edit", "overlays", "anim-callout-1", "0026.png");
      const result = await run("brand_check.py", ["--profile", path.join(root, "brand-profile.json"), lastChart, lastCallout]);
      const verdict = toGateVerdictFromPrefixedLines(result, "brand_check.py", V);
      expect(verdict.verdict, result.stdout + result.stderr).toBe("pass");
    }, 60_000);

    it("fails, with a bullet naming the archetype, when the plan names one with no renderer — a content_fail the plan can fix", async () => {
      const job = JSON.parse(await fs.readFile(path.join(root, "job-overlays.json"), "utf8")) as { overlays: Array<Record<string, unknown>> };
      job.overlays[0] = { ...job.overlays[0], archetype: "Sparkle Burst", file: String(job.overlays[0]!["file"]).replace("anim-growth_chart-0", "anim-sparkle_burst-0") };
      const bad = path.join(root, "job-overlays-bad.json");
      await fs.writeFile(bad, JSON.stringify(job), "utf8");
      const result = await run("render_overlays.py", ["--profile", path.join(root, "brand-profile.json"), "--job", bad]);
      const verdict = toGateVerdictFromBullets(result, "render_overlays.py", V);
      expect(verdict.verdict).toBe("content_fail");
      expect(reasonOf(verdict)).toContain("no renderer for archetype 'Sparkle Burst'");
    }, 120_000);
  });

  describe("grade.py (the `auto` analyzer build_short.py imports)", () => {
    it("is a no-op on correctly exposed footage and never exceeds the ±8% cap on bad footage", async () => {
      const result = await py(
        "import json; from grade import decide\n" +
          "clean = decide({'frames': 3, 'luma_mean': 0.45, 'luma_p99': 0.92, 'sat_mean': 0.25})\n" +
          "hot = decide({'frames': 3, 'luma_mean': 0.85, 'luma_p99': 0.999, 'sat_mean': 0.02})\n" +
          "dark = decide({'frames': 3, 'luma_mean': 0.10, 'luma_p99': 0.40, 'sat_mean': 0.70})\n" +
          "print(json.dumps([clean[0], hot[0], hot[1], dark[0], dark[1]]))",
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const [clean, hot, hotStats, dark, darkStats] = JSON.parse(result.stdout) as [string, string, Record<string, number>, string, Record<string, number>];
      expect(clean).toBe("");
      expect(hot).toMatch(/^eq=brightness=-0\.0\d\d:contrast=0\.9\d\d:saturation=1\.0\d\d$/);
      expect(Math.abs(hotStats["brightness"]!)).toBeLessThanOrEqual(0.08);
      expect(Math.abs(hotStats["contrast"]! - 1)).toBeLessThanOrEqual(0.08);
      expect(dark).toMatch(/^eq=brightness=0\.0\d\d:saturation=0\.9\d\d$/);
      expect(Math.abs(darkStats["saturation"]! - 1)).toBeLessThanOrEqual(0.08);
    });
  });

  describe("self_eval.py's flash scan (pure part)", () => {
    it("flags a single-frame spike that reverts, and ignores a hard cut that persists", async () => {
      const result = await py(
        "import json, numpy as np; from self_eval import find_flashes\n" +
          "series = np.array([0.2]*20 + [0.9] + [0.2]*20 + [0.7]*20, dtype='float32')\n" +
          "print(json.dumps(find_flashes(series, 30.0)))",
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const flashes = JSON.parse(result.stdout) as number[];
      expect(flashes).toHaveLength(1);
      expect(flashes[0]).toBeCloseTo(20 / 30, 3);
    });
  });

  describe("unpack_bundle.py (video.materializeInputs)", () => {
    it("unpacks a zip into the destination and refuses one whose member escapes it", async () => {
      const made = await py(
        `import zipfile, io
root = r"${root.replace(/\\/g, "\\\\")}"
with zipfile.ZipFile(root + "/bundle.zip", "w") as z:
    z.writestr("brand-profile.json", "{}")
    z.writestr("brand/fonts/Body.ttf", "font bytes")
with zipfile.ZipFile(root + "/evil.zip", "w") as z:
    z.writestr("../outside.txt", "nope")
print("ok")`,
      );
      expect(made.exitCode, made.stderr).toBe(0);
      const good = await run("unpack_bundle.py", ["--archive", path.join(root, "bundle.zip"), "--dest", path.join(root, "unpacked")]);
      expect(good.exitCode, good.stderr).toBe(0);
      expect(good.stdout.trim()).toMatch(/^unpacked 2 files -> /);
      expect(existsSync(path.join(root, "unpacked", "brand", "fonts", "Body.ttf"))).toBe(true);

      const evil = await run("unpack_bundle.py", ["--archive", path.join(root, "evil.zip"), "--dest", path.join(root, "unpacked-evil")]);
      expect(evil.exitCode).toBe(1);
      expect(evil.stderr).toContain("escapes the destination");
      expect(existsSync(path.join(root, "outside.txt"))).toBe(false);
    });
  });

  describeFfmpeg("with ffmpeg: build_short.py, graphic_qa.py and self_eval.py on a real file", () => {
    beforeAll(async () => {
      // A 6s synthetic talking-head stand-in: a dark, evenly lit frame (so the
      // caption legibility gate measures what it would on a real charcoal set)
      // with a tone for audio. 720x1280 portrait, 30fps.
      await new Promise<void>((resolve, reject) => {
        execFile(
          FFMPEG,
          ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x2a2a2e:s=720x1280:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
           "-t", "6", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", path.join(root, "src.mp4")],
          { timeout: 120_000 },
          (error, _stdout, stderr) => (error ? reject(new Error(`ffmpeg source generation failed: ${stderr}`)) : resolve()),
        );
      });
    }, 150_000);

    it("--until base stops after base.mp4 and prints the line video.render parses", async () => {
      const result = await run("build_short.py", ["--profile", path.join(root, "brand-profile.json"), "--job", path.join(root, "job-build.json"), "--until", "base"]);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toMatch(/^base: .*base\.mp4$/m);
      expect(existsSync(path.join(root, "edit", "base.mp4"))).toBe(true);
    }, 240_000);

    it("graphic_qa.py passes the rendered overlays over the real footage timeline", async () => {
      const result = await run("graphic_qa.py", ["--profile", path.join(root, "brand-profile.json"), "--video", path.join(root, "edit", "base.mp4"), "--job", path.join(root, "job-overlays.json")]);
      const verdict = toGateVerdictFromPrefixedLines(result, "graphic_qa.py", V);
      expect(verdict.verdict, result.stdout + result.stderr).toBe("pass");
      expect(evidenceOf(verdict, result.stdout + result.stderr)).toEqual(expect.arrayContaining(["PASS  anim-growth_chart-0", "PASS  anim-callout-1"]));
    }, 240_000);

    it("builds the finished short — captions, overlays, a plate cutaway, the endcard — and prints the done line", async () => {
      const result = await run("build_short.py", ["--profile", path.join(root, "brand-profile.json"), "--job", path.join(root, "job-build.json")]);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      const done = /done:\s*(\S.*?)\s{2,}duration=([\d.]*)s/.exec(result.stdout);
      expect(done, result.stdout).not.toBeNull();
      expect(done![1]).toBe(path.join(root, "edit", "final.mp4"));
      // 0.885s + 4.135s kept + a 2.0s endcard
      expect(Number.parseFloat(done![2]!)).toBeGreaterThan(6.6);
      expect(Number.parseFloat(done![2]!)).toBeLessThan(7.5);
      expect(result.stdout).toContain("caption gate: PASS");
      expect(result.stdout).toContain("post-render caption check: PASS");
    }, 300_000);

    it("self_eval.py passes the finished file, and video.selfEvalGate reaches the same verdict through the real ffprobe + engine", async () => {
      const result = await run("self_eval.py", ["--video", path.join(root, "edit", "final.mp4"), "--profile", path.join(root, "brand-profile.json"), "--job", path.join(root, "job-build.json")]);
      const verdict = toGateVerdictFromBullets(result, "self_eval.py", V);
      expect(verdict.verdict, result.stdout + result.stderr).toBe("pass");
      expect(evidenceOf(verdict, result.stdout + result.stderr)[0]).toMatch(/^SELF-EVAL GATE: PASS \(/);

      const gate = createSelfEvalGate({ engineDir: ENGINE, pythonBin: PY, env: process.env });
      const outcome = await gate.execute(
        { videoPath: path.join(root, "edit", "final.mp4"), renderWarnings: [], profilePath: path.join(root, "brand-profile.json"), jobPath: path.join(root, "job-build.json") },
        { ctx },
      );
      if (outcome.status !== "success") throw new Error(`selfEvalGate: ${outcome.status}: ${(outcome as { reason?: string }).reason}`);
      if (outcome.result.verdict !== "pass") throw new Error(`selfEvalGate verdict ${outcome.result.verdict}: ${outcome.result.reason}`);
      expect(outcome.result.evidence[0]).toContain("post-encode SDR tags confirmed");
    }, 240_000);
  });
});
