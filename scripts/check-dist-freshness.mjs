/**
 * Rebuilds any workspace package whose `dist/` is older than its `src/`
 * (AU54 / SCRUM-351).
 *
 * ## The failure this removes
 *
 * Workspace packages resolve each other through `dist/`, not source
 * (`package.json` `"main": "dist/index.js"`). A package's own tests run against
 * its source via vitest's transform, but every CROSS-package import in a test
 * loads compiled output. So an edit to `packages/tools/karos-video/src` is
 * invisible to `packages/tools/__tests__` until someone rebuilds.
 *
 * It fails silently and in BOTH directions, which is what makes it expensive:
 * a test that should fail passes because it ran the old compiled code, and a
 * test that should pass fails because the fix only exists in source. Neither
 * error message mentions `dist` — during AU8 a behavioural test kept asserting
 * the pre-fix behaviour for a fix that was already written, and the suite
 * looked like it was disagreeing with the code.
 *
 * ## Why rebuild rather than just report
 *
 * Measured on this repo (39 workspace packages):
 *
 *   - full `npm run build`, nothing changed ......... 2m38s
 *   - full `npm run build`, cold .................... 3m40s
 *   - rebuilding ONE stale package .................. 7s warm / 27s cold
 *   - this check when nothing is stale .............. 0.4s
 *
 * Building everything before every test run would add minutes to a command
 * people run constantly, and a check people route around is worse than no
 * check. Building only what is actually stale costs nothing in the common case
 * and seconds in the case that matters — so this removes the failure mode
 * instead of reporting it, which a pure staleness *warning* would not.
 *
 * `tsc` has no incremental win to give here: enabling `incremental: true`
 * repo-wide was measured and left the warm build at 3m30s, because the cost is
 * 39 sequential `npm run build` process spawns, not compilation.
 *
 *   node scripts/check-dist-freshness.mjs           # rebuild whatever is stale
 *   node scripts/check-dist-freshness.mjs --check   # report and exit 1, build nothing
 *
 * KNOWN LIMIT: this is wired as the ROOT `pretest`, so it guards `npm test`
 * from the repo root (and therefore CI). Running `vitest` inside a single
 * package directly still bypasses it.
 */
import { execSync } from "node:child_process";
import { readdirSync, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, loadGraph, buildOrder } from "./workspace-graph.mjs";

const CHECK_ONLY = process.argv.includes("--check");

/** Newest mtime under `dir`, or 0 when the directory does not exist. Skips nothing: a changed `.json` fixture matters as much as a `.ts` file. */
function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        stack.push(full);
        continue;
      }
      const { mtimeMs } = statSync(full);
      if (mtimeMs > newest) newest = mtimeMs;
    }
  }
  return newest;
}

const graph = loadGraph();
const stale = [];

for (const name of buildOrder(graph)) {
  const { dir } = graph.get(name);
  const srcDir = path.join(dir, "src");
  const distDir = path.join(dir, "dist");

  // No src/ means nothing to compare (a package that builds some other way).
  if (!existsSync(srcDir)) continue;

  const srcNewest = newestMtime(srcDir);
  const distNewest = newestMtime(distDir);

  // A missing dist is stale by definition — that is the first-clone case, and
  // the one where cross-package imports fail outright rather than subtly.
  if (distNewest === 0 || srcNewest > distNewest) {
    stale.push({ name, dir, reason: distNewest === 0 ? "no dist/ — never built" : "src/ is newer than dist/" });
  }
}

if (stale.length === 0) {
  process.exit(0);
}

if (CHECK_ONLY) {
  console.error(`\nstale dist/ in ${stale.length} package(s) — cross-package imports would load OLD compiled code:\n`);
  for (const { name, reason } of stale) console.error(`  ${name}  (${reason})`);
  console.error(`\nfix: npm run build:stale\n`);
  process.exit(1);
}

console.log(`rebuilding ${stale.length} package(s) with a stale dist/ (dependency order):`);
for (const { name, reason } of stale) {
  console.log(`  ${name}  (${reason})`);
  // Same quoting note as build-workspaces.mjs: one command string, because
  // Node >= 24 refuses to spawn `npm.cmd` without a shell and an args array
  // *with* a shell is deprecated. Names come from package.json, not input.
  execSync(`npm run build --workspace "${name}" --silent`, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
}
console.log("dist/ is current");
