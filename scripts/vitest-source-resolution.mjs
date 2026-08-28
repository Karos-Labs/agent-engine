/**
 * Makes vitest resolve `@agent-engine/*` imports to each package's SOURCE
 * rather than its compiled `dist/` (AU54 / SCRUM-351, the ticket's option 3 —
 * "consider whether tests should resolve to source at all in this repo").
 *
 * ## What was actually broken
 *
 * Every workspace package declares `"main": "dist/index.js"`. A package's own
 * tests run against its source, because vitest transforms the files it imports
 * relatively — but every CROSS-package import in a test went through node
 * resolution to `dist/`. So `packages/workflow/__tests__` was exercising a
 * COMPILED SNAPSHOT of `packages/core`, of whatever age happened to be on disk.
 *
 * Verified rather than assumed, on the unmodified tree at ac3876b:
 *
 *     import.meta.resolve("@agent-engine/core")   // from packages/workflow
 *     -> file:///…/packages/core/dist/index.js
 *
 * and with this module wired in:
 *
 *     -> file:///…/packages/core/src/index.ts
 *
 * That single hop is the whole ticket. It fails silently in both directions:
 * a regression passes because the test ran last week's compiled code, and a
 * finished fix fails because the test never saw it.
 *
 * ## Why an alias and not `exports` conditions
 *
 * A `"source"` export condition would have to be added to 39 `package.json`
 * files, and adding an `exports` field to a package that has none also CLOSES
 * subpath imports — a runtime-visible change made for a test-only reason. The
 * alias lives entirely inside vitest config: production resolution, the Docker
 * build and `tsc` emit are untouched. Checked before choosing: every
 * `@agent-engine/*` import in this repo is a bare package specifier (no
 * subpaths), so an exact-match alias per package is complete.
 *
 * ## Relationship to `check-dist-freshness.mjs`
 *
 * That script stays. The two cover different holes and neither subsumes the
 * other:
 *
 *   - this module removes dist/ from the TEST path, including for a bare
 *     `vitest` run inside one package — the "KNOWN LIMIT" that script names,
 *     and the local run where debugging actually happens;
 *   - that script keeps dist/ honest for everything that is NOT a test — the
 *     server, the demo scripts, `tsx`, and the per-package `tsc` typecheck,
 *     all of which still resolve through `dist/`.
 *
 * ## The `tsc` half, and why it is guarded rather than aliased
 *
 * Each workspace's `test` is `npm run typecheck && vitest run`, so half of
 * every `npm test` is a type check — and it had the identical defect. Measured
 * on the unmodified tree: give `computeToolCostUsd` a second required
 * parameter in `packages/core/src`, do not rebuild, and
 * `npm test --workspace @agent-engine/workflow` passes 164/164, because the
 * bare specifier resolved to `packages/core/dist/index.d.ts`.
 *
 * The obvious symmetric fix — a root `tsconfig.test-base.json` with a
 * generated `paths` map — was built and MEASURED, then rejected on its cost.
 * Across seven representative packages, `tsc -p tsconfig.test.json` went from
 * 17.3s total to 38.2s, +121%; extrapolated across all 39 that is roughly two
 * extra minutes on every `npm test`. The ticket's own instruction is explicit:
 * "If it adds minutes to every run, people will work around it, and a check
 * people route around is worse than option 2."
 *
 * So the type half is closed the cheap way instead: every workspace
 * `package.json` gained `"pretest": "node …/check-dist-freshness.mjs"`, which
 * rebuilds a stale dependency before `tsc` reads its `.d.ts`. Measured at
 * ~0.12s warm, ~4.7s across all 39. Same outcome, 25× cheaper.
 *
 * (Recording the rejected option matters: without the number, the next person
 * to notice the type hole re-derives the same design and re-discovers the same
 * two minutes.)
 *
 * The graph comes from `workspace-graph.mjs`, the same discovery the builder
 * and the freshness check use, so a package added tomorrow is aliased without
 * anybody remembering to.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { loadGraph } from "./workspace-graph.mjs";

/** Escapes a package name for use inside an exact-match `RegExp`. */
function exact(name) {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/**
 * Vite alias entries: one exact-match rule per workspace package that has a
 * `src/index.ts`, pointing at that file.
 *
 * Exact-match regexes, not bare strings: a string `find` in vite is a PREFIX
 * match, so `@agent-engine/tool-karos-intel` would also swallow a future
 * `@agent-engine/tool-karos-intel-x`. A prefix rule that silently captures the
 * wrong package is the same class of quiet wrongness this ticket is about.
 *
 * A package with no `src/index.ts` is skipped and keeps node resolution —
 * today that is only `@agent-engine/agent-server`, which is an application
 * entry point (`src/server.ts`) that nothing imports.
 */
export function workspaceSourceAliases() {
  const aliases = [];
  for (const [name, { dir }] of [...loadGraph()].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = path.join(dir, "src", "index.ts");
    if (!existsSync(entry)) continue;
    aliases.push({ find: exact(name), replacement: entry });
  }
  return aliases;
}
