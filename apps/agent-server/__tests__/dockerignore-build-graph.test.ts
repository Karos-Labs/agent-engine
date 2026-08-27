import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The Docker build context must contain every module the image build runs.
 *
 * ## The category, not the anecdote
 *
 * This codebase exists in FIVE copies, and only the first is ever read in
 * review:
 *
 *   1. source          — what people read, typecheck and test
 *   2. dist/           — compiled output; cross-package imports resolve HERE
 *   3. build context   — what .dockerignore lets into `docker build`
 *   4. the image       — what actually runs in Cloud Run
 *   5. the environment — which commit a given service is actually serving
 *
 * Copy 5 is the reason prep is only ever deployed from `main` and never by
 * `workflow_dispatch` on a branch: after a dispatch, "what is running in prep"
 * cannot be answered from git. The others are at least derivable from a commit;
 * that one would not be.
 *
 * Each can disagree with source, silently, and each disagreement has its own
 * failure mode with no local signal. AU54 (SCRUM-351) closed copy 2 in both
 * directions — stale output, and orphaned output whose source was deleted —
 * and was then broken by copy 3: the split that fixed the stale-dist problem
 * left `workspace-graph.mjs` outside the build context, so the image build
 * died on a file that exists, typechecks, and runs fine from a checkout.
 *
 * The lesson is not "remember the carve-out". It is that a change touching the
 * FILE LAYOUT of anything the build runs has to be checked against every copy,
 * because four of the five are invisible to review. Guards for these belong
 * with the thing they protect and must DERIVE what they check rather than
 * restate it — a hand-maintained list is one more copy with the same problem.
 *
 * `.dockerignore` excludes all of `scripts/` and then carves back the few files
 * the builder stage needs. AU54 split `build-workspaces.mjs`'s discovery and
 * topological sort into `workspace-graph.mjs` and did not add the second
 * carve-out, so the prep image build died with:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/app/scripts/workspace-graph.mjs'
 *       imported from /app/scripts/build-workspaces.mjs
 *
 * Nothing local could catch it. The file exists, typechecks, and both scripts
 * run correctly from a checkout — the build CONTEXT is the only place it is
 * missing, and the only feedback is a failed deploy several minutes later.
 *
 * So this derives the required set from the imports themselves rather than
 * restating it: add an import to the build graph and forget the carve-out, and
 * this fails in the repo instead of in Cloud Build.
 */
describe("the Docker build context carries the whole build graph", () => {
  const dockerignore = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
  const unignored = new Set(
    dockerignore
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("!"))
      .map((l) => l.slice(1)),
  );

  /** Local `./x.mjs` imports of a script, resolved to repo-relative paths. */
  function localImports(scriptRelPath: string): string[] {
    const src = readFileSync(path.join(repoRoot, scriptRelPath), "utf8");
    const dir = path.posix.dirname(scriptRelPath.replace(/\\/g, "/"));
    return [...src.matchAll(/from\s+["'](\.\/[^"']+\.mjs)["']/g)].map((m) => path.posix.join(dir, m[1]!.slice(2)));
  }

  it("excludes scripts/ but carves back the build entrypoint", () => {
    // If this ever stops being true the rest of the file is moot, so assert the
    // premise rather than assuming it.
    expect(dockerignore).toMatch(/^scripts$/m);
    expect(unignored).toContain("scripts/build-workspaces.mjs");
  });

  it("carves back every module the build entrypoint imports", () => {
    const missing = localImports("scripts/build-workspaces.mjs").filter((imported) => !unignored.has(imported));
    expect(
      missing,
      `these are imported by scripts/build-workspaces.mjs but excluded from the Docker build context — ` +
        `the image build will fail with ERR_MODULE_NOT_FOUND: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("carves back nothing that does not exist", () => {
    // The other direction: a stale carve-out for a deleted file is harmless at
    // build time but tells the next reader the build graph is bigger than it is.
    const phantom = [...unignored].filter((f) => f.startsWith("scripts/") && !existsSync(path.join(repoRoot, f)));
    expect(phantom, `carved out but absent: ${phantom.join(", ")}`).toEqual([]);
  });
});
