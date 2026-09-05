import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../scripts/vitest-source-resolution.mjs";

export default defineConfig({
  // AU54 (SCRUM-351): `@agent-engine/*` imports resolve to each package's src/, never to a
  // dist/ of unknown age. Without this a cross-package test asserts against compiled output.
  resolve: { alias: workspaceSourceAliases() },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "evals/**/*.test.ts"],
    // Matching `instagram-agent`, and for the same reason: these tests drive a
    // whole workflow, and this one's capture phase fans out 25 prompts across 5
    // engines and writes a file per cell. That is seconds of real work even
    // against fake adapters, so vitest's 5s default was always marginal here —
    // it just never lost until `npm test` drove 41 workspaces at once, where
    // two of these tipped over at ~5.8s and took the run with them. A timeout
    // this suite can exceed on a busy machine reports load as a defect.
    testTimeout: 30000,
  },
});
