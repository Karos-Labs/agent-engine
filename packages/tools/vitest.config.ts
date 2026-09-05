import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../scripts/vitest-source-resolution.mjs";

export default defineConfig({
  // AU54 (SCRUM-351): `@agent-engine/*` imports resolve to each package's src/, never to a
  // dist/ of unknown age. Without this a cross-package test asserts against compiled output.
  resolve: { alias: workspaceSourceAliases() },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // `outcome-contract.test.ts` walks the whole `packages/tools` source tree
    // (it asserts on >50 files by design — a scan that found nothing would
    // otherwise pass vacuously). That is disk-bound, and under `npm test`'s
    // 41-workspace parallel run on a busy machine it crossed vitest's 5s
    // default at 5054ms and failed the run. The scan is doing exactly what it
    // should; the bound was just too tight to survive contention. Same value
    // and same reason as `instagram-agent` and `seo-geo-agent`.
    testTimeout: 30000,
  },
});
