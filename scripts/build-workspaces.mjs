/**
 * Builds every workspace package in dependency order.
 *
 * Each package compiles to its own `dist/` and its dependents resolve that
 * `dist/` through the workspace symlink, so a package built before its
 * dependencies fails with `TS2307: Cannot find module`. npm offers no
 * topological `run --workspaces`, so the order is computed here from the
 * actual `@agent-engine/*` dependency edges rather than hardcoded — a
 * hardcoded list silently goes stale the moment a package is added, which is
 * exactly what happened twice while this repo was being built out.
 *
 * Workspace discovery and the topological sort live in
 * `./workspace-graph.mjs`, shared with `check-dist-freshness.mjs` so the two
 * can never disagree about which packages exist.
 *
 * Plain `.mjs` with no dependencies so it runs before anything is compiled,
 * including inside the Docker builder stage.
 *
 *   node scripts/build-workspaces.mjs           # build everything, in order
 *   node scripts/build-workspaces.mjs --list    # print the order, build nothing
 */
import { execSync } from "node:child_process";
import { REPO_ROOT, loadGraph, topoSort } from "./workspace-graph.mjs";

const graph = loadGraph();
const order = topoSort(graph).filter((name) => graph.get(name).buildable);

if (process.argv.includes("--list")) {
  console.log(order.join("\n"));
  process.exit(0);
}

console.log(`building ${order.length} workspace packages in dependency order`);
for (const [index, name] of order.entries()) {
  console.log(`  [${String(index + 1).padStart(2)}/${order.length}] ${name}`);
  // One quoted command string rather than an args array: Node >= 24 refuses to
  // spawn `npm.cmd` without a shell (EINVAL), and passing an args array *with*
  // a shell is deprecated (DEP0190). Package names come from package.json and
  // are quoted, so there is nothing user-supplied to escape here.
  execSync(`npm run build --workspace "${name}" --silent`, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
}
console.log("all packages built");
