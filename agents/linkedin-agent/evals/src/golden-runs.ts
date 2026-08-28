import { loadGoldenRunFixture } from "@agent-engine/evals";
import { LinkedInGoldenRunSchema, type LinkedInGoldenRun } from "./types.js";

/** Every LinkedIn-agent golden run, validated against `LinkedInGoldenRunSchema` at load time. */
export const LINKEDIN_GOLDEN_RUNS: LinkedInGoldenRun[] = [
  loadGoldenRunFixture(import.meta.url, "linkedin-post-hybrid-teams.json", LinkedInGoldenRunSchema),
];
