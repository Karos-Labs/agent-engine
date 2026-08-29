import { loadGoldenRunFixture } from "@agent-engine/evals";
import { RedditGoldenRunSchema, type RedditGoldenRun } from "./types.js";

/** Every Reddit-agent golden run, validated against `RedditGoldenRunSchema` at load time. */
export const REDDIT_GOLDEN_RUNS: RedditGoldenRun[] = [loadGoldenRunFixture(import.meta.url, "reddit-post-four-day-week.json", RedditGoldenRunSchema)];
