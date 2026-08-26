/**
 * Workspace discovery and dependency ordering, shared by
 * `build-workspaces.mjs` and `check-dist-freshness.mjs`.
 *
 * Extracted rather than copied: `build-workspaces.mjs`'s own header records
 * that a hardcoded package list "silently goes stale the moment a package is
 * added, which is exactly what happened twice while this repo was being built
 * out." A second copy of the discovery logic would reintroduce that failure in
 * a new place — and a staleness checker that disagrees with the builder about
 * which packages exist is worse than no checker at all.
 *
 * Plain `.mjs` with no dependencies so it runs before anything is compiled,
 * including inside the Docker builder stage.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "@agent-engine/";

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Expands the root package.json's workspace globs. Only the trailing-`/*` and literal-path forms this repo uses are supported. */
export function workspaceDirs() {
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

/** name -> { dir, deps: internal dependency names, buildable: has its own build script }. */
export function loadGraph() {
  const graph = new Map();

  for (const dir of workspaceDirs()) {
    const pkg = readJson(path.join(dir, "package.json"));
    if (!pkg.name) continue;
    graph.set(pkg.name, {
      dir,
      deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith(SCOPE)),
      buildable: Boolean(pkg.scripts?.build),
    });
  }

  return graph;
}

/** Depth-first topological sort. Throws on a dependency cycle rather than emitting an order that cannot work. */
export function topoSort(graph) {
  const ordered = [];
  const state = new Map(); // name -> "visiting" | "done"

  function visit(name, trail) {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      throw new Error(`workspace-graph: dependency cycle detected — ${[...trail, name].join(" -> ")}`);
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

/** The buildable packages, in dependency order — what both scripts actually iterate. */
export function buildOrder(graph = loadGraph()) {
  return topoSort(graph).filter((name) => graph.get(name).buildable);
}
