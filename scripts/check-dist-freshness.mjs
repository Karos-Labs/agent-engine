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
 * WHERE THIS IS WIRED (the KNOWN LIMIT this used to carry is now closed):
 *
 *   - the ROOT `pretest`, guarding `npm test` from the repo root, and therefore
 *     CI (`.github/workflows/quality.yml` runs `npm test`);
 *   - EVERY workspace's own `pretest`, so `npm test --workspace <pkg>` and
 *     `npm test` inside a package directory are guarded too. That is the local
 *     run where debugging actually happens, and it used to bypass this
 *     entirely. Warm cost measured at ~0.12s per invocation, ~4.7s across all
 *     39 (AU54/SCRUM-351).
 *
 * A bare `npx vitest run` inside a package still does not fire any npm
 * lifecycle hook, and nothing can make it. That path is covered from the other
 * side instead: `scripts/vitest-source-resolution.mjs` removes `dist/` from
 * vitest's resolution altogether, so there is no stale build for it to read.
 * Between the two, no test path resolves through an out-of-date `dist/`.
 */
import { execSync } from "node:child_process";
import { readdirSync, existsSync, statSync, rmSync } from "node:fs";
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

/**
 * Compiled files with no corresponding source (AU57 / SCRUM-356).
 *
 * `tsc` never deletes outputs, so removing a source file leaves its `.js` and
 * `.d.ts` behind forever. `karos-research/dist/backends.js` was found this way
 * — the pre-migration research backend, still present as compiled output long
 * after its source was deleted.
 *
 * SCOPE, established rather than assumed: this is a LOCAL working-tree problem
 * only. `.dockerignore` excludes `**\/dist` from the build context and the
 * Dockerfile's builder stage compiles from source inside the container, so an
 * orphan cannot reach the image. CI checks out fresh and caches npm only, so
 * it cannot occur there either. What it does do is mislead a developer and
 * their local test run, in the same silent way a stale dist does.
 */
function orphanedOutputs(dir) {
  const srcDir = path.join(dir, "src");
  const distDir = path.join(dir, "dist");
  if (!existsSync(srcDir) || !existsSync(distDir)) return [];

  const orphans = [];
  const stack = [distDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") stack.push(full);
        continue;
      }
      const rel = path.relative(distDir, full);
      const base = rel.replace(/\.(d\.ts\.map|js\.map|d\.ts|js)$/, "");
      if (base === rel) continue; // not a compiled artefact
      // A .ts source, or a .tsx/.json the compiler may have emitted from.
      if (!existsSync(path.join(srcDir, `${base}.ts`))) orphans.push(rel.replace(/\\/g, "/"));
    }
  }
  return orphans;
}

const graph = loadGraph();
const stale = [];
const orphaned = [];

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

  const orphans = orphanedOutputs(dir);
  if (orphans.length > 0) orphaned.push({ name, dir, files: orphans });
}

// Orphans are removed even when nothing is stale: deleting a source file
// changes no other file's mtime, so a tree can be perfectly fresh and still
// carry compiled code that no longer has a source.
if (orphaned.length > 0) {
  const total = orphaned.reduce((n, p) => n + p.files.length, 0);
  if (CHECK_ONLY) {
    console.error(`\ncompiled output with no source in ${orphaned.length} package(s) — ${total} file(s):\n`);
    for (const { name, files } of orphaned) {
      console.error(`  ${name}`);
      for (const f of files) console.error(`      dist/${f}`);
    }
    console.error(`\ntsc never deletes outputs. fix: npm run build:stale\n`);
    process.exit(1);
  }
  console.log(`removing ${total} orphaned output file(s) — compiled code whose source is gone:`);
  for (const { name, dir, files } of orphaned) {
    console.log(`  ${name}`);
    for (const f of files) {
      console.log(`      dist/${f}`);
      rmSync(path.join(dir, "dist", f), { force: true });
    }
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
