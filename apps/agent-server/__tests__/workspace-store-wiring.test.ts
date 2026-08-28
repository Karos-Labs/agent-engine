import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import request from "supertest";
import type { Application } from "express";
import { GcsWorkspaceStore, WorkspaceStore } from "@agent-engine/tools";
import { createApp } from "../src/app.js";
import { createServerWorkspaceStore } from "../src/wiring/workspace-store.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8");

/**
 * T-P0b (SCRUM-263): a deployed environment must never silently fall back to
 * the local file store. `createKarosClientTools()`'s default parameter IS the
 * local file store (`createWorkspaceStore()` — not env-aware), so the only
 * thing standing between Cloud Run and "every client tool reads an empty
 * disk" is this wiring chain:
 *
 *   GitHub var → deploy workflow substitution → cloudbuild env var
 *   → createServerWorkspaceStore → createServerTools(store) [required param]
 *
 * These tests pin every link that lives in this repo. The one link that
 * doesn't — the GitHub repository variable actually holding a bucket name —
 * is guarded by the substitution-shape tests below referencing `vars.*`.
 */
describe("T-P0b: workspace store injection (SCRUM-263)", () => {
  describe("createServerWorkspaceStore env selection", () => {
    it("selects the GCS store when GCS_WORKSPACE_BUCKET is set", () => {
      const store = createServerWorkspaceStore({ GCS_WORKSPACE_BUCKET: "some-bucket" });
      expect(store).toBeInstanceOf(GcsWorkspaceStore);
      expect(store).not.toBeInstanceOf(WorkspaceStore);
    });

    it("falls back to the local file store only when GCS_WORKSPACE_BUCKET is unset (local dev)", () => {
      const store = createServerWorkspaceStore({});
      expect(store).toBeInstanceOf(WorkspaceStore);
    });

    it("treats an EMPTY GCS_WORKSPACE_BUCKET as unset — the exact hazard an empty cloudbuild substitution produces", () => {
      // cloudbuild.yaml / cloudbuild.promote.yaml both declare
      // `_GCS_WORKSPACE_BUCKET: ""` as the substitution default. If a deploy
      // ever ran without the workflow supplying the substitution, the env var
      // would be set-but-empty, readEnv() would treat it as absent, and Cloud
      // Run would silently read/write local instance disk. This test
      // documents that behavior; the deploy-config tests below guard the
      // substitution actually being supplied.
      const store = createServerWorkspaceStore({ GCS_WORKSPACE_BUCKET: "" });
      expect(store).toBeInstanceOf(WorkspaceStore);
    });
  });

  describe("deploy config keeps the GCS substitution wired end to end", () => {
    it("deploy-prep supplies _GCS_WORKSPACE_BUCKET from a GitHub var (never the empty cloudbuild default)", () => {
      const yml = read(".github/workflows/deploy-prep.yml");
      expect(yml).toMatch(/_GCS_WORKSPACE_BUCKET="\$\{\{ vars\.[A-Z_]+ \}\}"/);
    });

    it("deploy-prod supplies _GCS_WORKSPACE_BUCKET from a GitHub var (never the empty cloudbuild default)", () => {
      const yml = read(".github/workflows/deploy-prod.yml");
      expect(yml).toMatch(/_GCS_WORKSPACE_BUCKET="\$\{\{ vars\.[A-Z_]+ \}\}"/);
    });

    it("both cloudbuild files forward GCS_WORKSPACE_BUCKET to every service's env", () => {
      for (const file of ["cloudbuild.yaml", "cloudbuild.promote.yaml"]) {
        const yml = read(file);
        const forwards = yml.match(/GCS_WORKSPACE_BUCKET=\$\{_GCS_WORKSPACE_BUCKET\}/g) ?? [];
        // one HTTP service + one worker service per file
        expect(forwards.length, `${file} must forward GCS_WORKSPACE_BUCKET to both services`).toBeGreaterThanOrEqual(2);
      }
    });
  });

  /**
   * SCRUM-327 (AU43) / Tomer decision record, SCRUM-333, ruling 14: the
   * workspace store gets ITS OWN DEDICATED BUCKET — no more sharing retention
   * policy between durable tenant state and 7-day disposable renders.
   *
   * The suite above ("supplies _GCS_WORKSPACE_BUCKET from a GitHub var") is
   * structurally incapable of catching a regression here: it only asserts the
   * substitution comes from *some* `vars.*` name, and
   * `vars.PREP_GCS_ARTIFACTS_BUCKET` satisfies that regex just as well as a
   * dedicated `vars.PREP_GCS_WORKSPACE_BUCKET` would. That is exactly the
   * failure T-P0b found live: `_GCS_WORKSPACE_BUCKET` was wired to the SAME
   * GitHub variable as `_GCS_ARTIFACTS_BUCKET` in both environments, so the
   * two prior tests were green the entire time the bug existed. This test
   * asserts the two substitutions read from two DIFFERENT variable names.
   */
  describe("SCRUM-327: workspace bucket is dedicated, never the artifacts bucket variable", () => {
    const workspaceAndArtifactsVars = (yml: string): { workspaceVar: string; artifactsVar: string } => {
      const workspace = /_GCS_WORKSPACE_BUCKET="\$\{\{ vars\.([A-Z_]+) \}\}"/.exec(yml);
      const artifacts = /_GCS_ARTIFACTS_BUCKET="\$\{\{ vars\.([A-Z_]+) \}\}"/.exec(yml);
      if (!workspace || !artifacts) throw new Error("expected both _GCS_WORKSPACE_BUCKET and _GCS_ARTIFACTS_BUCKET substitutions to be present");
      return { workspaceVar: workspace[1]!, artifactsVar: artifacts[1]! };
    };

    it("deploy-prep: _GCS_WORKSPACE_BUCKET is not fed from the artifacts-bucket variable", () => {
      const { workspaceVar, artifactsVar } = workspaceAndArtifactsVars(read(".github/workflows/deploy-prep.yml"));
      expect(workspaceVar).not.toBe(artifactsVar);
      expect(workspaceVar).toBe("PREP_GCS_WORKSPACE_BUCKET");
    });

    it("deploy-prod: _GCS_WORKSPACE_BUCKET is not fed from the artifacts-bucket variable", () => {
      const { workspaceVar, artifactsVar } = workspaceAndArtifactsVars(read(".github/workflows/deploy-prod.yml"));
      expect(workspaceVar).not.toBe(artifactsVar);
      expect(workspaceVar).toBe("PROD_GCS_WORKSPACE_BUCKET");
    });

    it("deploy-prep validates the new PREP_GCS_WORKSPACE_BUCKET repo variable is present before deploying", () => {
      const yml = read(".github/workflows/deploy-prep.yml");
      expect(yml).toMatch(/for v in [^\n]*\bPREP_GCS_WORKSPACE_BUCKET\b/);
    });

    it("deploy-prod validates the new PROD_GCS_WORKSPACE_BUCKET repo variable is present before deploying", () => {
      const yml = read(".github/workflows/deploy-prod.yml");
      expect(yml).toMatch(/for v in [^\n]*\bPROD_GCS_WORKSPACE_BUCKET\b/);
    });
  });
});

/**
 * SCRUM-328 (AU45): the two silent workspace-store fallbacks T-P0b found while
 * fixing the headline one.
 *
 *  1. `src/app.ts` — the deliverables router carried its own
 *     `deps.runtimeDeps.workspaceStore ?? createWorkspaceStore()`.
 *  2. `agents/reputation-agent/.../create-reputation-pulse-workflow.ts` —
 *     `options.store ?? createWorkspaceStore()`.
 *
 * Both were dormant only because every real composition root happens to pass a
 * store. Neither `??` could ever announce itself: the fallback is a VALID
 * store, so a run that hit one read and wrote a completely different, empty,
 * instance-local location and reported success. The fix is not deleting two
 * `??` — it is making `AgentRuntimeDeps.workspaceStore` required, so the
 * compiler carries the invariant instead of a convention.
 *
 * Two kinds of test below, because the fix has two halves:
 *
 *  - a BEHAVIOURAL test, which fails on the pre-fix tree by reading an
 *    unrelated store and 404ing; and
 *  - TYPE-ENFORCEMENT tests, which compile fixtures with `tsc` and assert the
 *    omissions are now rejected. A type is not observable at runtime, so the
 *    only honest way to test it is to actually run the compiler. The third
 *    fixture is a positive control: it must COMPILE, which is what stops a
 *    misconfigured `tsc` invocation (one that errors on everything) from
 *    making the other two assertions pass for the wrong reason.
 */
describe("SCRUM-328 (AU45): no silent workspace-store fallback survives", () => {
  describe("behaviour: the deliverables route reads the store the run actually wrote to", () => {
    let env: TestEnvironment;
    let app: Application;

    beforeEach(async () => {
      env = await setupTestEnvironment();
      // Deliberately NOT `{ ...env.runtimeDeps, workspaceStore: env.store }`.
      // Passing runtimeDeps through untouched is what every other app test and
      // both real composition roots do; if `createApp` can still substitute a
      // store of its own choosing behind that, this read goes somewhere else.
      app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
    });

    afterEach(async () => {
      await env.cleanup();
    });

    it("serves a deliverable written through runtimeDeps.tools, with no per-test store override", async () => {
      await env.durableStore.createRunIfNotExists({
        runId: "scrum-328-run",
        clientSlug: "acme",
        productId: "seo-geo-agent",
        runKind: "recurring",
        status: "completed",
        createdAt: 1000,
        updatedAt: 1000,
      });
      const outcome = await env.runtimeDeps.tools["ledger.writeDeliverable"]!.execute(
        { runId: "scrum-328-run", kind: "seo-geo-report", deliverable: { seoScore: 91, narrative: "no fallback" } },
        { ctx: { runId: "scrum-328-run", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring", metadata: {} } },
      );
      expect(outcome.status).toBe("success");

      // Pre-fix this is 404: app.ts built its own `createWorkspaceStore()` over
      // `$PWD/.karos-workspace` and read an empty directory, reporting "no such
      // deliverable" for a deliverable that was written successfully.
      const res = await request(app).get("/api/v1/runs/scrum-328-run/deliverables/seo-geo-report");
      expect(res.status).toBe(200);
      expect(res.body.deliverable).toEqual({ seoScore: 91, narrative: "no fallback" });
    });
  });

  describe("type enforcement: the invariant is carried by the compiler, not a convention", () => {
    const testsDir = path.dirname(fileURLToPath(import.meta.url));

    /**
     * Compiles one fixture in place under `__tests__/` (so its relative
     * `../src/...` imports and its `@agent-engine/*` resolution are the real
     * ones) and returns tsc's exit status and output.
     *
     * `--ignoreConfig` plus explicit flags rather than `-p tsconfig.test.json`:
     * a fixture that must NOT compile cannot be a member of the project the
     * repo's own `npm run typecheck` compiles. The flags mirror the root
     * tsconfig's compilerOptions.
     */
    const compileFixture = (fixture: string): { status: number; output: string } => {
      const scratch = path.join(testsDir, `.scrum-328-${fixture.replace(/\W+/g, "-")}.ts`);
      writeFileSync(scratch, readFileSync(path.join(testsDir, "type-fixtures", fixture), "utf8"));
      try {
        const result = spawnSync(
          process.execPath,
          [
            path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
            "--ignoreConfig",
            "--noEmit",
            "--strict",
            "--exactOptionalPropertyTypes",
            "--noUncheckedIndexedAccess",
            "--module", "nodenext",
            "--moduleResolution", "nodenext",
            "--target", "ES2023",
            "--skipLibCheck",
            scratch,
          ],
          { cwd: path.join(repoRoot, "apps", "agent-server"), encoding: "utf8" },
        );
        return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
      } finally {
        rmSync(scratch, { force: true });
      }
    };

    it("CONTROL: a fixture supplying both stores compiles cleanly (proves this tsc invocation can succeed)", () => {
      const { status, output } = compileFixture("control-with-store.ts.txt");
      expect(output).toBe("");
      expect(status).toBe(0);
    }, 120_000);

    it("rejects an AgentRuntimeDeps built without a workspaceStore", () => {
      const { status, output } = compileFixture("runtime-deps-without-store.ts.txt");
      expect(output).toMatch(/workspaceStore/);
      expect(status).not.toBe(0);
    }, 120_000);

    it("rejects createReputationPulseWorkflow() called without a store", () => {
      const { status, output } = compileFixture("pulse-options-without-store.ts.txt");
      expect(output).toMatch(/store/);
      expect(status).not.toBe(0);
    }, 120_000);
  });
});
