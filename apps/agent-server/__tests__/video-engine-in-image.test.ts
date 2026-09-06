import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENGINE_DIR_IN_IMAGE = "/app/packages/tools/karos-video/engine";
const engineDir = path.join(repoRoot, "packages", "tools", "karos-video", "engine");
const toolsDir = path.join(repoRoot, "packages", "tools", "karos-video", "src", "tools");

/**
 * The Branded Shorts engine the `video.*` adapters shell out to must be IN
 * the image the adapters run in — same reasoning as
 * `dockerignore-build-graph.test.ts`: the build context and the image are
 * two of the five copies of this codebase that review never reads, and a
 * file that exists in the checkout can still be missing from both.
 *
 * SPEC-AU63 named this exact hazard for the engine ("whatever path the
 * engine lands at needs ... a test that lists the vendored directory's real
 * files and asserts none of them are .dockerignore-excluded, not a comment
 * promising they aren't"). Three derived checks, none hand-maintained:
 *
 *   1. every `SCRIPT_NAME = "<x>.py"` an adapter declares is a real file in
 *      the engine directory — the adapters were written against docstrings
 *      before the scripts existed here, so this is the contract's first half;
 *   2. no engine file is excluded by `.dockerignore` — the directory sits
 *      under `packages/`, which the Dockerfile COPYs whole, but a future
 *      `*.cube` ignore rule or a renamed directory would silently drop it;
 *   3. the Dockerfile pins `BRANDED_SHORTS_ENGINE_DIR` at the path the COPY
 *      actually produces, so the variable and the layout cannot drift apart.
 */
describe("the Branded Shorts engine ships inside the agent-server image", () => {
  const engineFiles = readdirSync(engineDir).filter((f) => !f.startsWith("."));

  it("has every script the video.* adapters name", () => {
    const declared = new Set<string>();
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(path.join(toolsDir, file), "utf8");
      for (const m of src.matchAll(/const\s+\w*SCRIPT\w*\s*=\s*"([^"]+\.py)"/g)) declared.add(m[1]!);
    }
    expect(declared.size).toBeGreaterThanOrEqual(8);
    const missing = [...declared].filter((s) => !existsSync(path.join(engineDir, s)));
    expect(missing, `adapters name these scripts but the engine directory has no such file: ${missing.join(", ")}`).toEqual([]);
  });

  it("ships the HLG tonemap LUT and the vendored grade analyzer the scripts import", () => {
    // build_short.py's TONEMAP filter and its `from grade import ...` are the
    // two runtime dependencies that live beside it rather than in pip.
    expect(engineFiles).toContain("hlg709_N.cube");
    expect(engineFiles).toContain("grade.py");
    expect(engineFiles).toContain("ffbin.py");
  });

  it("is excluded from the Docker build context by no .dockerignore rule", () => {
    const rules = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"));
    const relDir = "packages/tools/karos-video/engine";
    const excluded = engineFiles.filter((f) => {
      const rel = `${relDir}/${f}`;
      return rules.some((rule) => {
        // .dockerignore semantics, the subset this file uses: a leading `/`
        // anchors the rule to the context ROOT (so `/*.md` is root-level docs
        // only, never this directory's README); a rule without a slash matches
        // a path segment at any depth; `**/x` likewise. Otherwise deliberately
        // conservative — a false "excluded" here is a review question, a false
        // "included" would be the very failure this test exists to catch.
        const anchored = rule.startsWith("/");
        const bare = rule.replace(/^\*\*\//, "").replace(/^\//, "");
        const toRegExp = (glob: string) => new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
        if (anchored) {
          return bare.includes("*") ? toRegExp(bare).test(rel) : rel === bare || rel.startsWith(bare + "/");
        }
        if (bare.includes("*")) {
          const re = toRegExp(bare);
          return rel.split("/").some((seg) => re.test(seg));
        }
        return rel.split("/").includes(bare) || rel.startsWith(bare + "/") || rel === bare;
      });
    });
    expect(excluded, `these engine files would be dropped from the build context: ${excluded.join(", ")}`).toEqual([]);
  });

  it("pins BRANDED_SHORTS_ENGINE_DIR in the Dockerfile at the path the packages COPY produces", () => {
    const dockerfile = readFileSync(path.join(repoRoot, "apps", "agent-server", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(new RegExp(`^ENV BRANDED_SHORTS_ENGINE_DIR=${ENGINE_DIR_IN_IMAGE.replace(/\//g, "\\/")}$`, "m"));
    // The runtime stage copies the whole packages tree to /app/packages — the
    // pinned path is that copy's location of this repo's engine directory.
    expect(dockerfile).toMatch(/^COPY --from=builder \/app\/packages \.\/packages$/m);
    expect(existsSync(engineDir)).toBe(true);
    // And the Python runtime the engine imports is installed in that same stage.
    for (const dep of ["numpy", "pillow", "opencv-python-headless"]) expect(dockerfile).toContain(dep);
  });
});
