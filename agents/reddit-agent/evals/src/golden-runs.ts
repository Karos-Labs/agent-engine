import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { RedditGoldenRunSchema, type RedditGoldenRun } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadGoldenRun(filename: string): RedditGoldenRun {
  const raw = readFileSync(path.join(HERE, "..", "golden-runs", filename), "utf8");
  return RedditGoldenRunSchema.parse(JSON.parse(raw));
}

/** Every Reddit-agent golden run, validated against `RedditGoldenRunSchema` at load time. */
export const REDDIT_GOLDEN_RUNS: RedditGoldenRun[] = [loadGoldenRun("reddit-post-four-day-week.json")];
