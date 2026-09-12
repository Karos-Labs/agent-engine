import { loadGoldenRunFixture } from "@agent-engine/evals";
import { TikTokGoldenRunSchema, type TikTokGoldenRun } from "./types.js";

/**
 * The fixed briefs and their endorsed scripts. Two came off prep runs on
 * 2026-09-10 (the first day the pipeline produced a short a person would
 * post) with one correction each noted in the fixture; the Hebrew one exists
 * so an English script shipped to a Hebrew client is a measurable failure.
 */
export const TIKTOK_GOLDEN_RUNS: TikTokGoldenRun[] = [
  loadGoldenRunFixture(import.meta.url, "tiktok-short-plan-before-retainer.json", TikTokGoldenRunSchema),
  loadGoldenRunFixture(import.meta.url, "tiktok-short-two-dollar-cap.json", TikTokGoldenRunSchema),
  loadGoldenRunFixture(import.meta.url, "tiktok-short-first-hire-he.json", TikTokGoldenRunSchema),
];

export function tikTokGoldenRunsFor(language: TikTokGoldenRun["language"]): TikTokGoldenRun[] {
  return TIKTOK_GOLDEN_RUNS.filter((run) => run.language === language);
}
