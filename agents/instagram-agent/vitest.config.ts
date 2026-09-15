import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../scripts/vitest-source-resolution.mjs";

export default defineConfig({
  // AU54 (SCRUM-351): `@agent-engine/*` imports resolve to each package's src/, never to a
  // dist/ of unknown age. Without this a cross-package test asserts against compiled output.
  resolve: { alias: workspaceSourceAliases() },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "evals/**/*.test.ts"],
    testTimeout: 30000,
    // ── THREAD CAP: THIS WORKSPACE HOLDS THE HEAVIEST SUITES IN THE REPO. ──
    //
    // Vitest runs test FILES in parallel, one worker per core by default. Most
    // of the ~2,200 cases here are microseconds, but a handful are not, and
    // they are not merely slow — they are slow in a way that makes each other
    // slow:
    //
    //   * every `interest-floor-*` render suite drives a REAL Chromium through
    //     `publish.renderCarousel`, one browser per file;
    //   * `ground-material.test.ts` paints six 2160x2880 plates and holds each
    //     as a decoded RGBA buffer (~25 MB) while it measures two readings off
    //     it;
    //   * `emphasis-marks.test.ts` sweeps ~4,000 synthetic kits.
    //
    // Uncapped, those land on the same wall clock and starve each other.
    // MEASURED on this machine: `ground-material`'s "BREAK THE GUARD" case
    // takes about 12 seconds of real work and completed in **184,610 ms**
    // against its own 120,000 ms budget — a 15x contention multiplier — and
    // `emphasis-marks` failed beside it. Both pass in isolation, every time,
    // and neither has ever failed on CI.
    //
    // **A timeout that only fires under load is not a slow test, it is a
    // resource bug, and raising the budget would hide it rather than fix it.**
    // RFC-20 §5.7's own posture about thresholds applies to time as well as to
    // pixels: the number is not moved to make something pass.
    //
    // 4 rather than 1: file parallelism is still what makes the fast 99% of
    // this suite finish in a couple of minutes, and four in flight is roughly
    // four browsers plus ~100 MB of buffers, which is inside what a CI runner
    // and a dev box both hold comfortably. Serialising everything would trade
    // a rare flake for a permanent five-minute wait on every run.
    poolOptions: { threads: { maxThreads: 4 } },
  },
});
