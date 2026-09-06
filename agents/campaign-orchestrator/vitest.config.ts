import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../scripts/vitest-source-resolution.mjs";

export default defineConfig({
  // AU54 (SCRUM-351): `@agent-engine/*` imports resolve to each package's src/, never to a
  // dist/ of unknown age. Without this a cross-package test asserts against compiled output.
  resolve: { alias: workspaceSourceAliases() },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "evals/**/*.test.ts"],
    // Every test here runs a real 5-channel fan-out over file-backed stores. Since
    // 2026-09-05 the newsletter slot alone performs four research pulls, an edition
    // plan, a draft, the editorial lint and an editor pass, and the whole tree sits
    // past vitest's 5s default whenever the machine is under load. 60s matches the
    // budget the newsletter and agent-server suites already give their own
    // whole-workflow tests.
    testTimeout: 60_000,
  },
});
