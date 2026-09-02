import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { TOOL_SOURCE_GLOBS, extractToolVersions } from "../../../scripts/tool-registry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * SCRUM-296 (AU11): the TOOL_VERSION drift check's own regression test.
 *
 * `scripts/check-tool-versions.ts` diffs a base ref against the working
 * tree and flags any tool whose file changed while its declared
 * `TOOL_VERSION` did not — see that file and `scripts/tool-registry.ts` for
 * the mechanism. Each fixture below is its own throwaway git repo (not this
 * repo's own history), built fresh so a case can commit a "before" and then
 * dirty the working tree into an "after" without touching anything real.
 */

interface Problem {
  toolName: string;
  file: string;
  version: string;
  detail: string;
}
interface CheckResult {
  baseRef: string;
  filesChecked: number;
  problems: Problem[];
}

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Runs `scripts/check-tool-versions.ts --json` against `root`, diffing `baseRef`. */
function runCheck(root: string, baseRef: string): { result: CheckResult; exitCode: number } {
  let stdout: string;
  let exitCode = 0;
  try {
    stdout = execFileSync("npx", ["tsx", "scripts/check-tool-versions.ts", "--json", "--root", root, "--base", baseRef], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    exitCode = e.status ?? 1;
    stdout = e.stdout ?? "";
  }
  return { result: JSON.parse(stdout) as CheckResult, exitCode };
}

const toolSource = (dataLiteral: string, version: string): string => `import { defineTool } from "@agent-engine/tool-common";

const TOOL_VERSION = "${version}";

export const fixtureTool = defineTool({
  name: "fixture.thing",
  version: TOOL_VERSION,
  inputSchema: undefined as any,
  async execute() {
    return { status: "success", data: { value: ${dataLiteral} } };
  },
});
`;

const TOOL_REL_PATH = path.join("packages", "tools", "fixture-pkg", "src", "thing.ts");

/** A one-commit git repo containing a single fixture tool at TOOL_VERSION "1.0.0". */
function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tool-version-drift-"));
  tempRoots.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  mkdirSync(path.join(dir, path.dirname(TOOL_REL_PATH)), { recursive: true });
  writeFileSync(path.join(dir, TOOL_REL_PATH), toolSource("1", "1.0.0"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

/**
 * Explicit timeout, matching the precedent runs.test.ts set for the three
 * whole-workflow HTTP tests: every case in this file shells out to
 * `npx tsx scripts/check-tool-versions.ts`, which type-strips and runs a script that walks the whole
 * repo. That is 3-8s of real work on a quiet machine and more under load, against
 * vitest's 5s default — green in isolation, red the moment the rest of this
 * workspace's suite runs alongside it, which is the worst failure shape there is.
 *
 * Each case also seeds a real git repo and commits into it before running the
 * check, so it carries git's process cost on top of tsx's.
 *
 * Declared on the describe rather than raising the global: these are legitimately
 * slow and should say so here, while a genuinely hung 5s unit test elsewhere in
 * this workspace still fails fast.
 */
describe("SCRUM-296: TOOL_VERSION drift check", { timeout: 120_000 }, () => {
  it("passes on an untouched repo — nothing changed since the base ref", () => {
    const dir = fixtureRepo();
    const { result, exitCode } = runCheck(dir, "HEAD");
    expect(result.problems).toEqual([]);
    expect(result.filesChecked).toBe(0);
    expect(exitCode).toBe(0);
  });

  it("FAILS a tool file changed without a TOOL_VERSION bump — the exact defect this ticket describes", () => {
    const dir = fixtureRepo();
    // Real behavior change (the value the tool returns), version left at "1.0.0".
    writeFileSync(path.join(dir, TOOL_REL_PATH), toolSource("2", "1.0.0"));
    const { result, exitCode } = runCheck(dir, "HEAD");
    expect(result.problems.map((p) => p.toolName)).toContain("fixture.thing");
    expect(result.problems[0]?.detail).toContain("still TOOL_VERSION 1.0.0");
    expect(exitCode).toBe(1);
  });

  it("passes the same change once TOOL_VERSION is bumped alongside it", () => {
    const dir = fixtureRepo();
    writeFileSync(path.join(dir, TOOL_REL_PATH), toolSource("2", "1.0.1"));
    const { result, exitCode } = runCheck(dir, "HEAD");
    expect(result.problems).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("does not flag an unrelated file change under the same tree", () => {
    const dir = fixtureRepo();
    writeFileSync(path.join(dir, "packages", "tools", "fixture-pkg", "src", "README.md"), "unrelated note\n");
    const { result, exitCode } = runCheck(dir, "HEAD");
    // README.md is untracked and not a .ts tool file — git diff sees it as an
    // untracked addition to the working tree but this check only looks at
    // TRACKED changes (`git diff <ref> -- ...`), so it is invisible here by
    // design: the check's job is drift in already-tracked tool source.
    expect(result.problems).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("throws instead of silently passing when no base ref can be resolved", () => {
    // A single-commit repo with no origin/main and an explicit bad --base:
    // this is what a fetch-depth:1 checkout with no BASE_SHA looks like if
    // the origin/main fallback also fails. The check must error, not report
    // zero problems — the exact "structurally incapable of failing" shape
    // this repo has hit before.
    const dir = fixtureRepo();
    let stdout = "";
    let exitCode = 0;
    try {
      stdout = execFileSync("npx", ["tsx", "scripts/check-tool-versions.ts", "--json", "--root", dir, "--base", "does-not-exist-ref"], {
        cwd: repoRoot,
        encoding: "utf8",
        shell: true,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    expect(exitCode).toBe(1);
    // An unresolvable explicit --base surfaces as a real git error (non-zero
    // exit), never as valid `{ problems: [] }` JSON on stdout.
    expect(() => JSON.parse(stdout)).toThrow();
  });
});

/**
 * THE PREMISE, asserted against the real tree — added 2026-09-02.
 *
 * Every test above builds a throwaway repo and checks that the drift check
 * behaves correctly ON THAT FIXTURE. All of them passed for the whole life of
 * this check while it saw **zero of the 88 real tools** in this repo, because
 * `CALL_SITE` required `version` immediately after `name` and the fixtures
 * above were the only code in existence written that way. The check could not
 * fail, and its own regression suite could not tell.
 *
 * So these two assert the thing the fixtures cannot: that the extractor
 * actually resolves the call sites this repository really contains. A future
 * refactor that narrows the regex again fails HERE, on real source, rather than
 * going quietly green.
 */
describe("SCRUM-296 (AU11) — the check can see this repo's own tools", () => {
  const ANY_DEFINE_TOOL = /defineTool(?:<[\s\S]*?>)?\(\{\s*name:\s*"([^"]+)"/g;

  function realToolFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
    };
    for (const root of TOOL_SOURCE_GLOBS) walk(path.join(repoRoot, root));
    return out;
  }

  it("resolves a version for EVERY defineTool call site under TOOL_SOURCE_GLOBS", () => {
    const declared = new Set<string>();
    const resolved = new Set<string>();
    for (const file of realToolFiles()) {
      const content = readFileSync(file, "utf8");
      for (const m of content.matchAll(ANY_DEFINE_TOOL)) declared.add(m[1]!);
      for (const entry of extractToolVersions(content)) resolved.add(entry.toolName);
    }
    // Sanity: this repo really does have a large tool surface, so a passing
    // assertion below cannot mean "found nothing, compared nothing".
    expect(declared.size).toBeGreaterThan(50);
    const invisible = [...declared].filter((name) => !resolved.has(name)).sort();
    expect(invisible, "tool call sites the drift check cannot see").toEqual([]);
  });

  it("reads a version that is not adjacent to the name, and one named by a non-standard const", () => {
    // The two shapes the old regex missed, stated as their own case so the
    // reason each was invisible is not lost if the tree changes.
    const descriptionBetween = [
      'const TOOL_VERSION = "2.3.4";',
      'export const t = defineTool({',
      '  name: "real.shape",',
      '  description: "a description sits between name and version, as it does at all 88 real call sites",',
      "  version: TOOL_VERSION,",
      "});",
    ].join("\n");
    expect(extractToolVersions(descriptionBetween)).toEqual([{ toolName: "real.shape", version: "2.3.4" }]);

    const oddConst = [
      'const GET_TOOL_VERSION = "1.5.0";',
      'export const t = defineTool({',
      '  name: "media.getVisualPatterns",',
      '  description: "d",',
      "  version: GET_TOOL_VERSION,",
      "});",
    ].join("\n");
    expect(extractToolVersions(oddConst)).toEqual([{ toolName: "media.getVisualPatterns", version: "1.5.0" }]);
  });

  it("does not let a version-less tool borrow the next tool's version", () => {
    // The risk the tempered `(?!defineTool\()` exists to remove: without it a
    // lazy scan would run out of one object literal and into the next.
    const twoTools = [
      'export const a = defineTool({ name: "no.version", description: "d", inputSchema: undefined });',
      'export const b = defineTool({ name: "has.version", description: "d", version: "9.9.9" });',
    ].join("\n");
    expect(extractToolVersions(twoTools)).toEqual([{ toolName: "has.version", version: "9.9.9" }]);
  });
});
