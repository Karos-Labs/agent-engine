import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../scripts/vitest-source-resolution.mjs";

export default defineConfig({
  // AU54 (SCRUM-351): `@agent-engine/*` imports resolve to each package's src/, never to a
  // dist/ of unknown age. Without this a cross-package test asserts against compiled output.
  resolve: { alias: workspaceSourceAliases() },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "evals/**/*.test.ts"],
    // Each test here runs the full 5-channel fan-out (five real channel workflows with fake models).
    // Since the social agents gained their vision/trend/self-critique steps (PR #50/#52) a run takes
    // 4-6s on a loaded machine, right on vitest's 5s default, and which test times out is luck.
    testTimeout: 30000,
  },
});
