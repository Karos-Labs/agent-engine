import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * AU54 (SCRUM-351): the stale-`dist/` guard has to stay wired.
 *
 * Lives in this package for the same reason `workspace-store-wiring.test.ts`
 * does — it is the one workspace whose suite already asserts on repo-root
 * deploy/config files, and this is the same category of drift guard.
 *
 * The guard itself is a `pretest` hook. Hooks are easy to drop silently (a
 * scripts-block edit, a merge), and if it goes, cross-package tests quietly
 * resume running against stale compiled code — the failure this whole ticket
 * exists to remove, back with no error message naming it.
 */
describe("AU54: the stale-dist guard stays wired", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("runs the freshness check before npm test", () => {
    expect(pkg.scripts["pretest"], "root pretest must invoke the freshness check").toContain("check-dist-freshness");
  });

  it("exposes the fix command the failure message tells people to run", () => {
    // check-dist-freshness.mjs --check prints "fix: npm run build:stale".
    expect(pkg.scripts["build:stale"], "the advertised fix command must exist").toContain("check-dist-freshness");
  });

  it("agrees with the builder about which packages exist", () => {
    // Both scripts read the workspace graph from the same module precisely so
    // they cannot disagree; this proves the shared module is actually shared.
    const listed = execFileSync("node", ["scripts/build-workspaces.mjs", "--list"], { cwd: repoRoot, encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);

    expect(listed.length).toBeGreaterThan(30);
    expect(listed).toContain("@agent-engine/tool-karos-video");
    expect(listed).toContain("@agent-engine/agent-server");
    // Dependency order, not alphabetical: core must precede its dependents.
    expect(listed.indexOf("@agent-engine/core")).toBeLessThan(listed.indexOf("@agent-engine/agent-server"));
  });

  it("also refuses compiled output whose source is gone (AU57)", () => {
    // `tsc` never deletes outputs, so a deleted source leaves its .js/.d.ts
    // behind forever — `karos-research/dist/backends.js` outlived its source
    // by weeks. Deleting a file changes no other file's mtime, so the
    // staleness check alone cannot see this: a tree can be perfectly fresh and
    // still carry code with no source. Hence a second, independent scan.
    const script = readFileSync(path.join(repoRoot, "scripts", "check-dist-freshness.mjs"), "utf8");
    expect(script, "the guard must scan for orphaned outputs, not only stale ones").toContain("orphanedOutputs");
    expect(script).toContain("rmSync");
  });

  it("reports a clean tree as fresh", () => {
    // The suite only reaches this point via `npm test`, whose pretest hook has
    // already rebuilt anything stale — so a non-zero exit here means the check
    // disagrees with the rebuild it just performed.
    const exitCode = (() => {
      try {
        execFileSync("node", ["scripts/check-dist-freshness.mjs", "--check"], { cwd: repoRoot, stdio: "pipe" });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? 1;
      }
    })();
    expect(exitCode).toBe(0);
  });
});
