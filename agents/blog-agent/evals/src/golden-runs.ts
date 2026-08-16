import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { BlogGoldenRunSchema, type BlogGoldenRun } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadGoldenRun(filename: string): BlogGoldenRun {
  const raw = readFileSync(path.join(HERE, "..", "golden-runs", filename), "utf8");
  return BlogGoldenRunSchema.parse(JSON.parse(raw));
}

/** Every Blog-agent golden run, validated against `BlogGoldenRunSchema` at load time. */
export const BLOG_GOLDEN_RUNS: BlogGoldenRun[] = [loadGoldenRun("blog-post-structured-onboarding.json")];
