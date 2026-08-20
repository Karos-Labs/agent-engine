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
 * Plain `.mjs` with no dependencies so it runs before anything is compiled,
 * including inside the Docker builder stage.
 *
 *   node scripts/build-workspaces.mjs           # build everything, in order
 *   node scripts/build-workspaces.mjs --list    # print the order, build nothing
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "@agent-engine/";

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Expands the root package.json's workspace globs. Only the trailing-`/*` and literal-path forms this repo uses are supported. */
function workspaceDirs() {
  const { workspaces } = readJson(path.join(REPO_ROOT, "package.json"));
  const dirs = [];

  for (const pattern of workspaces ?? []) {
    if (!pattern.endsWith("/*")) {
      dirs.push(path.join(REPO_ROOT, pattern));
      continue;
    }
    const parent = path.join(REPO_ROOT, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(parent, entry.name));
    }
  }

  return dirs.filter((dir) => existsSync(path.join(dir, "package.json")));
}

/** name -> { deps: internal dependency names, buildable: has its own build script }. */
function loadGraph() {
  const graph = new Map();

  for (const dir of workspaceDirs()) {
    const pkg = readJson(path.join(dir, "package.json"));
    if (!pkg.name) continue;
    graph.set(pkg.name, {
      deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith(SCOPE)),
      buildable: Boolean(pkg.scripts?.build),
    });
  }

  return graph;
}

/** Depth-first topological sort. Throws on a dependency cycle rather than emitting an order that cannot work. */
function topoSort(graph) {
  const ordered = [];
  const state = new Map(); // name -> "visiting" | "done"

  function visit(name, trail) {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      throw new Error(`build-workspaces: dependency cycle detected — ${[...trail, name].join(" -> ")}`);
    }
    // A dependency outside the workspace set (a published package) is not ours to build.
    if (!graph.has(name)) return;

    state.set(name, "visiting");
    for (const dep of graph.get(name).deps) visit(dep, [...trail, name]);
    state.set(name, "done");
    ordered.push(name);
  }

  for (const name of [...graph.keys()].sort()) visit(name, []);
  return ordered;
}

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
