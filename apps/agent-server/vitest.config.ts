import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../scripts/vitest-source-resolution.mjs";

export default defineConfig({
  // AU54 (SCRUM-351): `@agent-engine/*` imports resolve to each package's src/, never to a
  // dist/ of unknown age. Without this a cross-package test asserts against compiled output.
  resolve: { alias: workspaceSourceAliases() },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // runs.test.ts drives whole workflows through the HTTP surface, including the five-channel
    // campaign fan-out, which takes 4-6s on a loaded machine since the social agents gained their
    // vision/trend/self-critique steps (PR #50/#52). 30s, like the other heavy suites.
    testTimeout: 30000,
  },
});
