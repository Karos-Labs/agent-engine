import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GcsWorkspaceStore, WorkspaceStore } from "@agent-engine/tools";
import { createServerWorkspaceStore } from "../src/wiring/workspace-store.js";

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
});
