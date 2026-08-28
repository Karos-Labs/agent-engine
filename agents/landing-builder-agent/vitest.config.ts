import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../scripts/vitest-source-resolution.mjs";

export default defineConfig({
  // AU54 (SCRUM-351): `@agent-engine/*` imports resolve to each package's src/, never to a
  // dist/ of unknown age. Without this a cross-package test asserts against compiled output.
  resolve: { alias: workspaceSourceAliases() },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // These tests do real filesystem I/O (copying a template kit, writing a generated site) across
    // several temp directories per test file; under concurrent file-parallel workers on Windows
    // that occasionally exceeds vitest's 5s default, as pure I/O contention rather than a hang.
    testTimeout: 20000,
  },
});
