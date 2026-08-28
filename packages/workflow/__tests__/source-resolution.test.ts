/**
 * AU54 / SCRUM-351 — cross-package imports must resolve to SOURCE, not `dist/`.
 *
 * The ticket's failure: workspace packages declare `"main": "dist/index.js"`,
 * so every CROSS-package import inside a test loaded compiled output of
 * whatever age happened to be on disk. A test that should fail passed because
 * it ran last week's build; a test that should pass failed because the fix
 * only existed in source. Neither error message ever said `dist`.
 *
 * These two tests are the standing guard. They are deliberately built to be
 * capable of failing:
 *
 *   - `resolves … to the same module as its source file` fails the moment
 *     `resolve.alias` is dropped from this package's `vitest.config.ts` —
 *     `@agent-engine/core` then resolves to `packages/core/dist/index.js`, a
 *     DIFFERENT file from `packages/core/src/index.ts`, so the two namespace
 *     objects are two distinct module instances and `toBe` rejects them.
 *     Confirmed by deleting the line and watching it fail, not by reasoning.
 *   - `every workspace vitest.config.ts wires` fails the moment a new package
 *     is added with a config that forgets the alias. Modelled on the repo's
 *     existing repo-wide static sweep in `fanout-slot-outcomes.test.ts`.
 *
 * Note on instruments (this cost an hour): `import.meta.resolve()` inside
 * vitest reports NODE's resolution, not vite's, so it answers
 * `…/packages/core/dist/index.js` even when the alias is working and the test
 * is demonstrably running source. It is the wrong instrument for this
 * question. Module identity is the right one, because it is the property the
 * bug actually violates.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import * as coreViaPackage from "@agent-engine/core";
import * as telemetryViaPackage from "@agent-engine/telemetry";
import * as toolsViaPackage from "@agent-engine/tools";

import * as coreViaSource from "../../core/src/index.js";
import * as telemetryViaSource from "../../telemetry/src/index.js";
import * as toolsViaSource from "../../tools/src/index.js";

import { workspaceSourceAliases } from "../../../scripts/vitest-source-resolution.mjs";
import { loadGraph, REPO_ROOT } from "../../../scripts/workspace-graph.mjs";

describe("cross-package imports resolve through source (AU54)", () => {
  it.each([
    ["@agent-engine/core", coreViaPackage, coreViaSource],
    ["@agent-engine/telemetry", telemetryViaPackage, telemetryViaSource],
    ["@agent-engine/tools", toolsViaPackage, toolsViaSource],
  ])("resolves %s to the same module as its source file, not to a separate dist/ copy", (name, viaPackage, viaSource) => {
    // Same module instance <=> the bare specifier and the source path resolved
    // to the same file. Through dist/ these are two files and two instances.
    //
    // The message matters as much as the assertion. The ticket's core complaint
    // is that this failure "produces no error message that mentions dist/", so
    // the one produced here says it outright.
    expect(
      viaPackage,
      `${name} resolved to a DIFFERENT module object than its own src/index.ts, which means the bare ` +
        `specifier went through this package's "main": "dist/index.js" and the test is asserting against ` +
        `COMPILED OUTPUT of unknown age. Check resolve.alias in this package's vitest.config.ts (AU54).`,
    ).toBe(viaSource);
  });

  it("every workspace vitest.config.ts wires the shared source aliases", () => {
    const missing: string[] = [];

    for (const [name, { dir }] of loadGraph()) {
      const config = path.join(dir, "vitest.config.ts");
      let text: string;
      try {
        text = readFileSync(config, "utf8");
      } catch {
        continue; // a workspace with no vitest config runs no tests
      }
      if (!text.includes("workspaceSourceAliases()")) {
        missing.push(`${name} (${path.relative(REPO_ROOT, config)})`);
      }
    }

    expect(missing, "these packages' tests would silently resolve @agent-engine/* through dist/").toEqual([]);
  });

  it("every workspace package.json runs the staleness guard as its own pretest", () => {
    // The alias covers vitest's RUNTIME resolution. The other half of every
    // `npm test` is `tsc -p tsconfig.test.json`, which reads a dependency's
    // dist/*.d.ts and had exactly the same staleness hole — demonstrated by
    // adding a required parameter to a core export, not rebuilding, and
    // watching `npm test --workspace @agent-engine/workflow` pass.
    //
    // A per-workspace `pretest` closes it for ~0.12s (see
    // scripts/vitest-source-resolution.mjs for the rejected alternative and
    // its measured cost). This test is what stops a new package shipping
    // without it.
    const missing: string[] = [];

    for (const [name, { dir }] of loadGraph()) {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (!manifest.scripts?.["test"]) continue; // nothing to guard
      if (!manifest.scripts["pretest"]?.includes("check-dist-freshness.mjs")) missing.push(name);
    }

    expect(missing, "these packages' `npm test` would type-check against a stale dist/*.d.ts").toEqual([]);
  });

  it("aliases every workspace package that has a src/index.ts", () => {
    const aliased = new Set(workspaceSourceAliases().map((a) => a.replacement));
    // Sanity on the generator itself: an empty alias list would make the two
    // tests above pass for the wrong reason on a tree where nothing is built.
    expect(aliased.size).toBeGreaterThan(30);
    for (const replacement of aliased) {
      expect(replacement.endsWith(`${path.sep}src${path.sep}index.ts`)).toBe(true);
    }
  });
});
