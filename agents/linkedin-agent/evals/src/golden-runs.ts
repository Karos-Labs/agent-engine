import { loadGoldenRunFixture } from "@agent-engine/evals";
import { LinkedInGoldenRunSchema, type LinkedInGoldenRun } from "./types.js";

/**
 * Every LinkedIn-agent golden run, validated against `LinkedInGoldenRunSchema`
 * at load time.
 *
 * The two entries are the SAME brief in two languages (SCRUM-308 / AU25,
 * rung 4), deliberately: a suite with one English fixture per agent can only
 * ever report that English copy is fine, which is what it did while a Hebrew
 * client was being shipped English carousels. Pairing them means a
 * language-blind regression shows up as one run passing and its twin failing,
 * rather than as nothing at all.
 */
export const LINKEDIN_GOLDEN_RUNS: LinkedInGoldenRun[] = [
  loadGoldenRunFixture(import.meta.url, "linkedin-post-hybrid-teams.json", LinkedInGoldenRunSchema),
  loadGoldenRunFixture(import.meta.url, "linkedin-post-anchor-days-he.json", LinkedInGoldenRunSchema),
];

/** The golden runs for one language — the per-language slice the ladder actually iterates. */
export function linkedInGoldenRunsFor(language: LinkedInGoldenRun["language"]): LinkedInGoldenRun[] {
  return LINKEDIN_GOLDEN_RUNS.filter((run) => run.language === language);
}
